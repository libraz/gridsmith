/**
 * @file Converts a 24-unit icon stored as SVG path segments into an icon spec.
 *
 * Path data is read with the full SVG grammar, transforms are baked into the points, and each
 * subpath becomes one element (line, polyline, points, rect, circle, oval, arc) or a skip with a
 * reason. Coordinates map as x = x' - 12, y = 12 - y' and are rounded to 4 decimals without any
 * snapping to the grid. The arc-centre math lives here so this layer reads only `spec` types.
 * Bezier curves are fitted with lines and circular arcs (`fit.ts`); a fitted arc is never
 * recognised as part of a rect, and is part of a circle only when the whole closed subpath is.
 */

import type { Region, SpecInput } from '../spec/schema.js';
import { apply, parsePath, parseTransform, type Vec } from './path.js';
import {
  buildPieces,
  type Converted,
  closedShape,
  type FitStats,
  type ImportPiece,
  importPiece,
  isArc,
  openShape,
  polygonOf,
  pt,
  round4,
  type ShapeInput,
  toUp,
} from './shapes.js';

export type { ImportPiece } from './shapes.js';

/** One path of a 24-unit icon: SVG path data plus presentation attributes. */
export type ImportSegment = {
  d: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number | string;
  strokeLinecap?: string;
  strokeLinejoin?: string;
  strokeDasharray?: string;
  fillRule?: 'nonzero' | 'evenodd';
  transform?: string;
};

/**
 * A subpath that was not converted; `segment` and `subpath` are -1 for spec-wide limits.
 * A `mixed path` carries its parts: the filled ring for a filled subpath, else the stroked parts.
 */
export type ImportSkip = {
  segment: number;
  subpath: number;
  reason: string;
  pieces?: ImportPiece[];
};

/**
 * A conversion that approximated the source. A `curve fit` note gives the largest fitting
 * deviation, the number of Bezier commands and the number of pieces fitted to them.
 */
export type ImportNote = {
  segment: number;
  subpath: number;
  note: string;
  deviation?: number;
  curves?: number;
  arcs?: number;
};

/** Result of {@link importSegments}; `subpaths` counts every subpath that draws something. */
export type ImportResult = {
  spec: SpecInput | null;
  skipped: ImportSkip[];
  notes: ImportNote[];
  subpaths: number;
};

type PaintInput = SpecInput['paint'][number];

const MAX_SHAPES = 64;
const MAX_LAYERS = 16;
const MAX_OPERANDS = 16;
const MAX_D = 4096;

function inside(p: Vec, poly: readonly Vec[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Vec;
    const b = poly[j] as Vec;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      hit = !hit;
    }
  }
  return hit;
}

const unionOf = (items: Region[]): Region => {
  if (items.length === 1) {
    return items[0] as Region;
  }
  if (items.length <= MAX_OPERANDS) {
    return { union: items };
  }
  const groups: Region[] = [];
  for (let k = 0; k < items.length; k += MAX_OPERANDS) {
    groups.push(unionOf(items.slice(k, k + MAX_OPERANDS)));
  }
  return unionOf(groups);
};

/** Even-odd nesting as subtract trees; containment is tested on each leaf's first vertex. */
function evenOddRegion(leaves: readonly { id: string; poly: Vec[] }[]): Region {
  const holds = (i: number, j: number): boolean => {
    const probe = leaves[j]?.poly[0];
    return probe !== undefined && inside(probe, leaves[i]?.poly ?? []);
  };
  // Mutual containment (coincident outlines) keeps the earlier leaf outside.
  const contains = (i: number, j: number): boolean =>
    i !== j && holds(i, j) && (!holds(j, i) || i < j);
  const containers = leaves.map((_, j) => leaves.map((_, i) => i).filter((i) => contains(i, j)));
  const parent = containers.map((list) =>
    list.reduce<number>(
      (best, i) =>
        best < 0 || (containers[i]?.length ?? 0) > (containers[best]?.length ?? 0) ? i : best,
      -1,
    ),
  );
  const region = (node: number): Region => {
    const id = leaves[node]?.id ?? '';
    const children = parent.flatMap((p, k) => (p === node ? [region(k)] : []));
    if (children.length === 0) {
      return id;
    }
    return {
      subtract: children.length < MAX_OPERANDS ? [id, ...children] : [id, unionOf(children)],
    };
  };
  return unionOf(parent.flatMap((p, k) => (p < 0 ? [region(k)] : [])));
}

/** Lower-case `#rrggbb`, `null` for no paint, or `undefined` for an unsupported colour. */
const colour = (value: string): string | null | undefined => {
  const v = value.trim().toLowerCase();
  if (v === 'none') {
    return null;
  }
  if (/^#[0-9a-f]{6}$/.test(v)) {
    return v;
  }
  if (/^#[0-9a-f]{3}$/.test(v)) {
    return `#${[...v.slice(1)].map((h) => h + h).join('')}`;
  }
  return undefined;
};

const STRING_KEYS = [
  'fill',
  'stroke',
  'strokeLinecap',
  'strokeLinejoin',
  'strokeDasharray',
  'transform',
] as const;

/** Checks the input shape; positions are reported as `segments[i]`. */
function validate(segments: unknown): ImportSegment[] {
  if (!Array.isArray(segments)) {
    throw new Error(`segments must be an array (received: ${typeof segments})`);
  }
  segments.forEach((s: unknown, i) => {
    if (typeof s !== 'object' || s === null || typeof (s as { d?: unknown }).d !== 'string') {
      throw new Error(`segments[${i}].d must be a string`);
    }
    const seg = s as Record<string, unknown>;
    const length = (seg.d as string).length;
    if (length > MAX_D) {
      throw new Error(`segments[${i}].d must be at most ${MAX_D} characters (received: ${length})`);
    }
    for (const key of STRING_KEYS) {
      if (seg[key] !== undefined && typeof seg[key] !== 'string') {
        throw new Error(`segments[${i}].${key} must be a string`);
      }
    }
    if (seg.fillRule !== undefined && seg.fillRule !== 'nonzero' && seg.fillRule !== 'evenodd') {
      throw new Error(`segments[${i}].fillRule must be "nonzero" or "evenodd"`);
    }
    if (
      seg.strokeLinecap !== undefined &&
      !['round', 'butt', 'square'].includes(seg.strokeLinecap as string)
    ) {
      throw new Error(`segments[${i}].strokeLinecap must be "round", "butt" or "square"`);
    }
    if (
      seg.strokeLinejoin !== undefined &&
      !['round', 'miter', 'bevel', 'arcs', 'miter-clip'].includes(seg.strokeLinejoin as string)
    ) {
      throw new Error(
        `segments[${i}].strokeLinejoin must be "round", "miter", "bevel", "arcs" or "miter-clip"`,
      );
    }
    const width = seg.strokeWidth;
    if (width !== undefined) {
      const v =
        typeof width === 'number' ? width : typeof width === 'string' ? Number(width) : Number.NaN;
      if (!Number.isFinite(v) || v <= 0 || (typeof width === 'string' && width.trim() === '')) {
        throw new Error(
          `segments[${i}].strokeWidth must be a positive number (received: ${JSON.stringify(width)})`,
        );
      }
    }
  });
  return segments as ImportSegment[];
}

/**
 * Converts one icon's segments into an icon spec.
 *
 * Subpaths that cannot be expressed are listed in `skipped` with a reason; the rest still
 * convert. `spec` is `null` when nothing converted or a spec-wide limit is exceeded.
 * Throws on malformed input or path data, naming the segment and character position.
 */
export function importSegments(segments: unknown): ImportResult {
  const list = validate(segments);
  const shapes: ShapeInput[] = [];
  const paint: PaintInput[] = [];
  const skipped: ImportSkip[] = [];
  const notes: ImportNote[] = [];
  let count = 0;

  list.forEach((seg, i) => {
    const subpaths = parsePath(seg.d, i).filter((s) => s.cmds.length > 0 || s.closed);
    count += subpaths.length;
    const skipAll = (reason: string) => {
      for (const s of subpaths) {
        skipped.push({ segment: i, subpath: s.index, reason });
      }
    };
    const m = seg.transform === undefined ? parseTransform('') : parseTransform(seg.transform);
    if (typeof m === 'string') {
      skipAll(m);
      return;
    }
    const strokeColor = seg.stroke === undefined ? null : colour(seg.stroke);
    const fillColor = seg.fill === undefined ? null : colour(seg.fill);
    if (fillColor === undefined || strokeColor === undefined) {
      skipAll('colour');
      return;
    }
    if (seg.strokeLinejoin === 'arcs' || seg.strokeLinejoin === 'miter-clip') {
      skipAll('stroke join');
      return;
    }
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    let dash: [number, number] | undefined;
    if (seg.strokeDasharray !== undefined) {
      const values = seg.strokeDasharray
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      const [on, off] = values;
      if (
        values.length !== 2 ||
        on === undefined ||
        off === undefined ||
        !values.every((v) => Number.isFinite(v) && v > 0)
      ) {
        skipAll('dash pattern');
        return;
      }
      dash = [round4(on * scale), round4(off * scale)];
    }
    const width = round4(Number(seg.strokeWidth ?? 1) * scale);
    const cap = (seg.strokeLinecap ?? 'butt') as 'round' | 'butt' | 'square';
    const join = (seg.strokeLinejoin ?? 'miter') as 'round' | 'miter' | 'bevel';
    const splittable =
      cap === 'round' && join === 'round' && dash === undefined && fillColor === null;

    const fillLeaves: { id: string; poly: Vec[] }[] = [];
    const strokeIds: string[] = [];
    const dotIds: string[] = [];
    for (const sub of subpaths) {
      const id = `s${i}_${sub.index}`;
      const skip = (reason: string) => {
        skipped.push({ segment: i, subpath: sub.index, reason });
      };
      const built = buildPieces(sub, m);
      if (built === null) {
        skip('bezier');
        continue;
      }
      const { pieces, ring, closed } = built;
      const fitNote = (extra?: FitStats) => {
        const curves = built.curves + (extra?.curves ?? 0);
        if (curves > 0) {
          notes.push({
            segment: i,
            subpath: sub.index,
            note: 'curve fit',
            deviation: round4(Math.max(built.deviation, extra?.deviation ?? 0)),
            curves,
            arcs: built.fitted + (extra?.fitted ?? 0),
          });
        }
      };
      if (pieces.length === 0) {
        fitNote();
        if (strokeColor === null || cap === 'butt') {
          continue;
        }
        if (cap === 'square') {
          skip('dot');
          continue;
        }
        const center = pt(toUp(apply(m, sub.start)));
        shapes.push({ id: `${id}d`, type: 'circle', center, r: round4(width / 2) });
        dotIds.push(`${id}d`);
        continue;
      }
      const fill = fillColor === null ? null : closedShape(ring, id);
      let stroke: Converted | string | null = null;
      if (strokeColor !== null) {
        if (closed) {
          stroke = fill ?? closedShape(pieces, id);
          // A round, unfilled ring draws the same when split into parts.
          if (stroke === 'mixed path' && splittable) {
            stroke = openShape(pieces, id, true, built.fitted);
          }
        } else if (fill !== null && pieces.some(isArc)) {
          stroke = 'mixed path';
        } else {
          stroke = openShape(pieces, id, splittable, built.fitted);
        }
      }
      fitNote(typeof stroke === 'string' ? undefined : stroke?.fit);
      if (typeof fill === 'string' || typeof stroke === 'string') {
        const reason = typeof fill === 'string' ? fill : (stroke as string);
        if (reason === 'mixed path') {
          const drawn = (fillColor === null ? pieces : ring).map(importPiece);
          skipped.push({ segment: i, subpath: sub.index, reason, pieces: drawn });
        } else {
          skip(reason);
        }
        continue;
      }
      // An open stroked polyline that is also filled is filled as its closed polygon.
      const separate = fill !== null && stroke !== null && fill !== stroke;
      if (stroke !== null) {
        shapes.push(...stroke.shapes);
        strokeIds.push(...stroke.ids);
      }
      if (fill?.area) {
        const fillId = separate ? `${id}f` : id;
        if (separate) {
          shapes.push(...fill.shapes.map((s) => ({ ...s, id: fillId })));
        } else if (stroke === null) {
          shapes.push(...fill.shapes);
        }
        fillLeaves.push({ id: fillId, poly: polygonOf(ring) });
      }
      const note = (fill ?? stroke)?.note;
      if (note !== undefined) {
        notes.push({ segment: i, subpath: sub.index, note });
      }
    }

    if (fillColor !== null && fillLeaves.length > 0) {
      const region =
        seg.fillRule === 'evenodd'
          ? evenOddRegion(fillLeaves)
          : unionOf(fillLeaves.map((l) => l.id));
      paint.push({ fill: region, color: fillColor });
    }
    if (strokeColor !== null && strokeIds.length > 0) {
      paint.push({
        stroke: strokeIds,
        width,
        color: strokeColor,
        cap,
        join,
        ...(dash === undefined ? {} : { dash }),
      });
    }
    if (strokeColor !== null && dotIds.length > 0) {
      paint.push({ fill: unionOf(dotIds), color: strokeColor });
    }
  });

  let spec: SpecInput | null =
    shapes.length === 0
      ? null
      : { version: 1, mode: 'icon', grid: { divisions: 12 }, shapes, paint };
  if (shapes.length > MAX_SHAPES) {
    skipped.push({ segment: -1, subpath: -1, reason: 'too many shapes' });
    spec = null;
  }
  if (paint.length > MAX_LAYERS) {
    skipped.push({ segment: -1, subpath: -1, reason: 'too many layers' });
    spec = null;
  }
  return { spec, skipped, notes, subpaths: count };
}

const escapeAttr = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Draws segments as the consumer does: viewBox 0 0 24 24, one `path` per segment, attributes
 * only when present, `transform` passed through. A missing `fill` is `none`.
 */
export function segmentsToSvg(segments: readonly ImportSegment[]): string {
  const paths = segments.map((s) => {
    const fill = s.fill ?? 'none';
    const attrs: [string, string | number | undefined][] = [
      ['d', s.d],
      ['fill', fill],
      ['stroke', s.stroke],
      ['stroke-width', s.strokeWidth],
      ['stroke-linecap', s.strokeLinecap],
      ['stroke-linejoin', s.strokeLinejoin],
      ['stroke-dasharray', s.strokeDasharray],
      ['fill-rule', s.fillRule],
      ['transform', s.transform],
    ];
    const text = attrs
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
      .join('');
    return `<path${text}/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${paths.join('')}</svg>`;
}
