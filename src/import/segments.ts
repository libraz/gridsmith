/**
 * @file Converts a 24-unit icon stored as SVG path segments into an icon spec.
 *
 * Path data is read with the full SVG grammar, transforms are baked into the points, and each
 * subpath becomes one element (line, polyline, points, rect, circle, oval, arc) or a skip with a
 * reason. Coordinates map as x = x' - 12, y = 12 - y' and are rounded to 4 decimals without any
 * snapping to the grid. The arc-centre math lives here; this layer reads `spec` types and `geom`.
 * Bezier curves are fitted with lines and circular arcs (`fit.ts`); a fitted arc is never
 * recognised as part of a rect, and is part of a circle only when the whole closed subpath is.
 * Filled rings with elliptical arcs become regions over ovals (`compose.ts`), and rings cut at
 * crossing lines or less a cusp arc's circle become several outlines (`outline.ts`), only when the
 * element's whole fill still matches; otherwise each such ring is skipped. A fill of several
 * rings is checked the same way and, when it does not match, kept with a `fill differs` note.
 */

import { type Region, SHAPES_MAX, type SpecInput } from '../spec/schema.js';
import {
  type Composed,
  composeRing,
  fillMatches,
  type InsideTest,
  polygonTest,
  strokeParts,
  trace,
} from './compose.js';
import { FIT_TOLERANCE } from './fit.js';
import { type OutlineLeaf, outlinesOf } from './outline.js';
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
  type Piece,
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
  /** Why a filled ring of lines and arcs could not become an outline. */
  detail?: string;
  pieces?: ImportPiece[];
};

/**
 * A conversion that approximated the source. A `curve fit` note gives the largest fitting
 * deviation, the number of Bezier commands and the number of pieces fitted to them. A note on
 * the fill of a whole segment, such as `fill differs`, has `subpath` -1.
 */
export type ImportNote = {
  segment: number;
  subpath: number;
  note: string;
  deviation?: number;
  curves?: number;
  arcs?: number;
};

/** Options of {@link importSegments}. */
export type ImportOptions = {
  /** Largest distance of a fitted line or arc from its Bezier curve, in modules. */
  fitTolerance?: number;
};

/** Result of {@link importSegments}; `subpaths` counts every subpath that draws something. */
export type ImportResult = {
  spec: SpecInput | null;
  skipped: ImportSkip[];
  notes: ImportNote[];
  subpaths: number;
};

type PaintInput = SpecInput['paint'][number];

const MAX_SHAPES = SHAPES_MAX;
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

/** A fill leaf: its region and the boundary polygon nesting is decided on. */
type Leaf = { region: Region; poly: Vec[] };

const BOUNDARY = 1e-6;

/** Whether `p` lies within `BOUNDARY` of an edge of `poly`. */
function onBoundary(p: Vec, poly: readonly Vec[]): boolean {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j] as Vec;
    const b = poly[i] as Vec;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t =
      len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    if (Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) <= BOUNDARY) {
      return true;
    }
  }
  return false;
}

/**
 * Containers and innermost parent of each leaf. Leaf j sits in leaf i when it has at least one
 * vertex off i's boundary and every such vertex is inside i.
 */
function nesting(leaves: readonly Leaf[]): { containers: number[][]; parent: number[] } {
  const holds = (i: number, j: number): boolean => {
    const outer = leaves[i]?.poly ?? [];
    const free = (leaves[j]?.poly ?? []).filter((v) => !onBoundary(v, outer));
    return free.length > 0 && free.every((v) => inside(v, outer));
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
  return { containers, parent };
}

const subtractOf = (base: Region, children: Region[]): Region =>
  children.length === 0
    ? base
    : {
        subtract: children.length < MAX_OPERANDS ? [base, ...children] : [base, unionOf(children)],
      };

/** A filled leaf no other filled leaf contains, and its region with the holes inside it. */
type Root = { leaf: number; region: Region };

/** Even-odd nesting as subtract trees, one per root. */
function evenOddRoots(leaves: readonly Leaf[]): Root[] {
  const { parent } = nesting(leaves);
  const region = (node: number): Region =>
    subtractOf(
      leaves[node]?.region ?? '',
      parent.flatMap((p, k) => (p === node ? [region(k)] : [])),
    );
  return parent.flatMap((p, k) => (p < 0 ? [{ leaf: k, region: region(k) }] : []));
}

/** Signed area of a y-up polygon: positive when counter-clockwise. */
function signedArea(poly: readonly Vec[]): number {
  let sum = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j] as Vec;
    const b = poly[i] as Vec;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

/** Nonzero fill: leaves with a non-zero winding number are filled, the rest are holes. */
function nonZeroRoots(leaves: readonly Leaf[]): Root[] {
  const { containers, parent } = nesting(leaves);
  const sign = leaves.map((l) => (signedArea(l.poly) < 0 ? -1 : 1));
  const filled = leaves.map(
    (_, j) =>
      (sign[j] ?? 0) + (containers[j] ?? []).reduce((sum, i) => sum + (sign[i] ?? 0), 0) !== 0,
  );
  const isRoot = (k: number): boolean => filled[k] === true && !filled[parent[k] ?? -1];
  const holes = new Map<number, Region[]>();
  leaves.forEach((leaf, h) => {
    if (filled[h]) {
      return;
    }
    let k = parent[h] ?? -1;
    while (k >= 0 && filled[k] && !isRoot(k)) {
      k = parent[k] ?? -1;
    }
    if (k >= 0 && filled[k]) {
      holes.set(k, [...(holes.get(k) ?? []), leaf.region]);
    }
  });
  return leaves.flatMap((leaf, k) =>
    isRoot(k) ? [{ leaf: k, region: subtractOf(leaf.region, holes.get(k) ?? []) }] : [],
  );
}

/**
 * The symmetric difference of two roots, which is the fill when they partly overlap and their
 * windings cancel in the overlap: under evenodd always, under nonzero when they run opposite
 * ways. Null for any other number of roots or for nonzero roots running the same way.
 */
function overlapXor(
  leaves: readonly Leaf[],
  roots: readonly Root[],
  evenOdd: boolean,
): Region | null {
  const [a, b] = roots;
  if (roots.length !== 2 || a === undefined || b === undefined) {
    return null;
  }
  const turn = (r: Root): number => Math.sign(signedArea(leaves[r.leaf]?.poly ?? []));
  if (!evenOdd && turn(a) === turn(b)) {
    return null;
  }
  return { subtract: [{ union: [a.region, b.region] }, { intersect: [a.region, b.region] }] };
}

/** Whether a stroked shape is a closed curve whose start the grammar fixes. */
const curvedRing = (s: ShapeInput): boolean =>
  s.type === 'circle' || s.type === 'oval' || (s.type === 'rect' && s.r !== undefined);

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
 * Bezier curves are fitted within `options.fitTolerance` ({@link FIT_TOLERANCE} by default).
 */
export function importSegments(segments: unknown, options: ImportOptions = {}): ImportResult {
  const list = validate(segments);
  const tolerance = options.fitTolerance ?? FIT_TOLERANCE;
  if (!(tolerance > 0 && Number.isFinite(tolerance))) {
    throw new Error(`fitTolerance must be a positive number (received: ${tolerance})`);
  }
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
    const dashed = dash !== undefined && strokeColor !== null;

    const evenOdd = seg.fillRule === 'evenodd';
    // One pass over the subpaths; `compose` lets filled rings with elliptical arcs become regions
    // and lets an unstroked filled ring be cut at its crossings or less a cusp arc's circle.
    const convert = (compose: boolean) => {
      const out = {
        shapes: [] as ShapeInput[],
        paint: [] as PaintInput[],
        skipped: [] as ImportSkip[],
        notes: [] as ImportNote[],
        mismatch: false,
      };
      const fillLeaves: Leaf[] = [];
      const fillRings: Piece[][] = [];
      const tests = new Map<string, InsideTest>();
      let composedAny = false;
      let checkedAny = false;
      const strokeIds: string[] = [];
      const dotIds: string[] = [];
      for (const sub of subpaths) {
        const id = `s${i}_${sub.index}`;
        const skip = (reason: string) => {
          out.skipped.push({ segment: i, subpath: sub.index, reason });
        };
        const built = buildPieces(sub, m, tolerance);
        if (built === null) {
          skip('bezier');
          continue;
        }
        const { pieces, ring, closed } = built;
        const fitNote = (extra?: FitStats) => {
          const curves = built.curves + (extra?.curves ?? 0);
          if (curves > 0) {
            out.notes.push({
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
          out.shapes.push({ id: `${id}d`, type: 'circle', center, r: round4(width / 2) });
          dotIds.push(`${id}d`);
          continue;
        }
        let fill: Converted | string | null =
          fillColor === null ? null : closedShape(ring, id, dashed);
        let outlineDetail: string | undefined;
        let outlineLeaves: OutlineLeaf[] | undefined;
        let composed: Composed | null = null;
        if (fill === 'mixed path') {
          // A stroke would follow the cut rings and the chord of a cap, not the source path.
          const made = outlinesOf(ring, id, compose && strokeColor === null);
          if ('shapes' in made) {
            fill = { shapes: made.shapes, ids: made.outlines.map((o) => o.id), area: true };
            outlineLeaves = made.outlines;
            checkedAny ||= made.checked === true;
          } else {
            composed = compose && made.detail === 'ellipse' ? composeRing(ring, id) : null;
            if (composed === null) {
              outlineDetail = made.detail;
            } else {
              fill = { shapes: composed.shapes, ids: [], area: true };
            }
          }
        }
        let stroke: Converted | string | null = null;
        if (strokeColor !== null) {
          if (composed !== null) {
            stroke = 'mixed path';
          } else if (closed) {
            stroke = fill ?? closedShape(pieces, id, dashed);
            // A round, unfilled ring draws the same when split into parts.
            if (stroke === 'mixed path' && splittable) {
              stroke = openShape(pieces, id, true, built.fitted, tolerance);
            }
          } else if (fill !== null && pieces.some(isArc)) {
            stroke = 'mixed path';
          } else {
            stroke = openShape(pieces, id, splittable, built.fitted, tolerance);
          }
          // Elliptical arcs nothing else could draw become arcs on ovals.
          if (stroke === 'mixed path' && dash === undefined) {
            const round = cap === 'round' && join === 'round';
            stroke = strokeParts(pieces, id, closed, round, composed?.ovals) ?? stroke;
          }
        }
        fitNote(typeof stroke === 'string' ? undefined : stroke?.fit);
        if (typeof fill === 'string' || typeof stroke === 'string') {
          const reason = typeof fill === 'string' ? fill : (stroke as string);
          if (reason === 'mixed path') {
            const drawn = (fillColor === null ? pieces : ring).map(importPiece);
            out.skipped.push({
              segment: i,
              subpath: sub.index,
              reason,
              ...(outlineDetail === undefined ? {} : { detail: outlineDetail }),
              pieces: drawn,
            });
          } else {
            skip(reason);
          }
          continue;
        }
        if (composed !== null) {
          // The ovals precede the arcs of the stroke drawn on them.
          out.shapes.push(...composed.shapes);
          fillLeaves.push({ region: composed.region, poly: polygonOf(ring) });
          fillRings.push(ring);
          for (const [k, test] of composed.tests) {
            tests.set(k, test);
          }
          composedAny = true;
        }
        // An open stroked polyline that is also filled is filled as its closed polygon.
        const separate = fill !== null && stroke !== null && fill !== stroke;
        if (stroke !== null) {
          out.shapes.push(...stroke.shapes);
          strokeIds.push(...stroke.ids);
        }
        if (fill?.area && composed === null) {
          const fillId = separate ? `${id}f` : id;
          if (separate) {
            out.shapes.push(...fill.shapes.map((s) => ({ ...s, id: fillId })));
          } else if (stroke === null) {
            out.shapes.push(...fill.shapes);
          }
          if (outlineLeaves === undefined) {
            fillLeaves.push({ region: fillId, poly: polygonOf(ring) });
            tests.set(fillId, polygonTest(trace(ring)));
          } else {
            for (const o of outlineLeaves) {
              tests.set(o.id, polygonTest(o.poly));
              if (o.minus === undefined) {
                fillLeaves.push({ region: o.id, poly: o.poly });
                continue;
              }
              const { id: cap, center, r } = o.minus;
              tests.set(cap, (p) => Math.hypot(p.x - center[0], p.y - center[1]) < r);
              fillLeaves.push({ region: { subtract: [o.id, cap] }, poly: o.poly });
            }
          }
          fillRings.push(ring);
        }
        const note = (fill ?? stroke)?.note;
        if (note !== undefined) {
          out.notes.push({ segment: i, subpath: sub.index, note });
        }
        // A dashed closed curve starts its pattern where the shape starts, not where the path did.
        if (dashed && stroke?.shapes.some((s) => stroke.ids.includes(s.id) && curvedRing(s))) {
          out.notes.push({ segment: i, subpath: sub.index, note: 'dash phase' });
        }
      }

      if (fillColor !== null && fillLeaves.length > 0) {
        const roots = evenOdd ? evenOddRoots(fillLeaves) : nonZeroRoots(fillLeaves);
        let region = unionOf(roots.map((r) => r.region));
        // Composed rings stand in whole ovals for their arcs, a cap its whole circle, and nesting
        // is decided on vertices: the element's fill must still match the source.
        if (
          (composedAny || checkedAny || fillRings.length > 1) &&
          !fillMatches(fillRings, evenOdd, region, tests)
        ) {
          if (composedAny || checkedAny) {
            out.mismatch = true;
            return out;
          }
          const xor = overlapXor(fillLeaves, roots, evenOdd);
          if (xor !== null && fillMatches(fillRings, evenOdd, xor, tests)) {
            region = xor;
          } else {
            out.notes.push({ segment: i, subpath: -1, note: 'fill differs' });
          }
        }
        out.paint.push({ fill: region, color: fillColor });
      }
      if (strokeColor !== null && strokeIds.length > 0) {
        out.paint.push({
          stroke: strokeIds,
          width,
          color: strokeColor,
          cap,
          join,
          ...(dash === undefined ? {} : { dash }),
        });
      }
      if (strokeColor !== null && dotIds.length > 0) {
        out.paint.push({ fill: unionOf(dotIds), color: strokeColor });
      }
      return out;
    };

    let done = convert(true);
    if (done.mismatch) {
      done = convert(false);
    }
    shapes.push(...done.shapes);
    paint.push(...done.paint);
    skipped.push(...done.skipped);
    notes.push(...done.notes);
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
