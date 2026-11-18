import type { ArcEdge, FillResult, Loop } from '../geom/arrangement.js';
import type { ChainPiece } from '../geom/chain.js';
import type { Vec } from '../geom/primitives.js';
import type {
  EraseShape,
  ResolvedErase,
  ResolvedModel,
  ResolvedStroke,
  StrokeItem,
} from '../resolve/resolve.js';
import { renderSegments, segmentPaths } from './segments.js';

/** Largest sweep of one emitted arc, in radians. */
const MAX_ARC_SWEEP = (2 * Math.PI) / 3;
const TWO_PI = 2 * Math.PI;

/** Rounds to 6 decimals and prints without a negative zero. */
export const num = (x: number): string => {
  const r = Number(x.toFixed(6));
  return String(r === 0 ? 0 : r);
};

// Math coordinates (y up) to SVG coordinates (y down).
const pt = (p: Vec): string => `${num(p.x)} ${num(-p.y)}`;

/** Equal parts of an arc, each at most 120 degrees, as the end point of each part. */
export function arcParts(edge: Pick<ArcEdge, 'cx' | 'cy' | 'r' | 'from' | 'to' | 'ccw'>): Vec[] {
  const a0 = Math.atan2(edge.from.y - edge.cy, edge.from.x - edge.cx);
  const a1 = Math.atan2(edge.to.y - edge.cy, edge.to.x - edge.cx);
  let delta = a1 - a0;
  if (edge.ccw) {
    while (delta <= 0) {
      delta += TWO_PI;
    }
  } else {
    while (delta >= 0) {
      delta -= TWO_PI;
    }
  }
  const parts = Math.max(1, Math.ceil(Math.abs(delta) / MAX_ARC_SWEEP - 1e-9));
  const ends: Vec[] = [];
  for (let k = 1; k < parts; k++) {
    const a = a0 + (delta * k) / parts;
    ends.push({ x: edge.cx + edge.r * Math.cos(a), y: edge.cy + edge.r * Math.sin(a) });
  }
  ends.push(edge.to);
  return ends;
}

/** SVG path data for closed loops: one `L` or `A` per atomic edge, y flipped. */
export function loopsToPathData(loops: readonly Loop[]): string {
  const out: string[] = [];
  for (const loop of loops) {
    const first = loop[0];
    if (first === undefined) {
      continue;
    }
    out.push(`M ${pt(first.from)}`);
    for (const edge of loop) {
      if (edge.kind === 'segment') {
        out.push(`L ${pt(edge.to)}`);
        continue;
      }
      // A counter-clockwise sweep in y-up coordinates is sweep-flag 0 after the flip.
      const sweep = edge.ccw ? 0 : 1;
      for (const end of arcParts(edge)) {
        out.push(`A ${num(edge.r)} ${num(edge.r)} 0 0 ${sweep} ${pt(end)}`);
      }
    }
    out.push('Z');
  }
  return out.join(' ');
}

/**
 * One path through chain pieces: `M`, `L`, `A` (at most 120 degrees each) and, when `closed`, `Z`.
 * `place` maps a module point to output coordinates (default: y flipped) and `scale` is the
 * module-to-output length factor, so the construction sheet reuses it in its own frame.
 */
export function chainPathData(
  pieces: readonly ChainPiece[],
  place: (p: Vec) => Vec = (p) => ({ x: p.x, y: -p.y }),
  scale = 1,
  closed = true,
): string {
  const first = pieces[0];
  if (first === undefined) {
    return '';
  }
  const at = (p: Vec): string => {
    const q = place(p);
    return `${num(q.x)} ${num(q.y)}`;
  };
  const out: string[] = [`M ${at(first.start)}`];
  for (const piece of pieces) {
    if (piece.kind === 'line') {
      out.push(`L ${at(piece.end)}`);
      continue;
    }
    const { cx, cy, r } = piece.circle;
    const sweep = piece.ccw ? 0 : 1;
    const parts = arcParts({ cx, cy, r, from: piece.start, to: piece.end, ccw: piece.ccw });
    for (const end of parts) {
      out.push(`A ${num(r * scale)} ${num(r * scale)} 0 0 ${sweep} ${at(end)}`);
    }
  }
  if (closed) {
    out.push('Z');
  }
  return out.join(' ');
}

// Every element starts where, and runs the way, the icon's segment path does, so dashes line up.
function strokeItemMarkup(item: StrokeItem, layer: ResolvedStroke): string[] {
  const dash =
    layer.dash === null ? '' : ` stroke-dasharray="${num(layer.dash[0])} ${num(layer.dash[1])}"`;
  const style = `fill="none" stroke-linejoin="${layer.join}" stroke-linecap="${layer.cap}" stroke="${layer.color}" stroke-width="${num(layer.width)}"${dash}`;
  switch (item.kind) {
    case 'circle':
      return [
        `<circle cx="${num(item.circle.cx)}" cy="${num(-item.circle.cy)}" r="${num(item.circle.r)}" ${style}/>`,
      ];
    case 'segment':
      return [
        `<line x1="${num(item.from.x)}" y1="${num(-item.from.y)}" x2="${num(item.to.x)}" y2="${num(-item.to.y)}" ${style}/>`,
      ];
    case 'arc': {
      const { cx, cy, r } = item.circle;
      const parts = arcParts({ cx, cy, r, from: item.start, to: item.end, ccw: true });
      const d = [
        `M ${pt(item.start)}`,
        ...parts.map((end) => `A ${num(r)} ${num(r)} 0 0 0 ${pt(end)}`),
      ];
      return [`<path d="${d.join(' ')}" ${style}/>`];
    }
    case 'polygon':
      return item.loops.map((loop) => `<polygon points="${loop.map(pt).join(' ')}" ${style}/>`);
    case 'chain':
      return [`<path d="${chainPathData(item.pieces, undefined, 1, item.closed)}" ${style}/>`];
    case 'polyline':
      return [`<polyline points="${item.points.map(pt).join(' ')}" ${style}/>`];
  }
}

/** Largest extent, in module units, of the masks' region: every coordinate and radius is at most 64. */
const MASK_EXTENT = 256;

const eraseShapeMarkup = (shape: EraseShape): string[] => {
  const style = 'fill="#000000"';
  if (shape.kind === 'circle') {
    return [
      `<circle cx="${num(shape.circle.cx)}" cy="${num(-shape.circle.cy)}" r="${num(shape.circle.r)}" ${style}/>`,
    ];
  }
  if (shape.kind === 'chain') {
    return [`<path d="${chainPathData(shape.pieces)}" ${style}/>`];
  }
  return shape.loops.map((loop) => `<polygon points="${loop.map(pt).join(' ')}" ${style}/>`);
};

/** Mask that is opaque everywhere except inside the erased shapes. */
function eraseMask(id: string, erase: ResolvedErase): string {
  const half = MASK_EXTENT / 2;
  return [
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="${-half}" y="${-half}" width="${MASK_EXTENT}" height="${MASK_EXTENT}">`,
    `<rect x="${-half}" y="${-half}" width="${MASK_EXTENT}" height="${MASK_EXTENT}" fill="#ffffff"/>`,
    ...erase.shapes.flatMap(eraseShapeMarkup),
    '</mask>',
  ].join('\n');
}

export type FinalMarkupOptions = {
  /** Opacity of a mark's filled layers. */
  fillOpacity?: number;
  /** Prefix of the mask ids, so two copies of the drawing can share one document. */
  idPrefix?: string;
};

/**
 * Body of the final drawing in SVG coordinates (y down, origin at the canvas centre).
 * An erase layer wraps everything drawn before it in a masked group.
 * An icon is the exception: its segment paths, in the 0..canvas frame with the origin at the
 * top-left corner, so a caller placing it in a centred frame translates by minus `canvasHalf`.
 * Options do not apply to an icon.
 */
export function finalMarkup(
  model: ResolvedModel,
  fills: readonly FillResult[],
  options: FinalMarkupOptions = {},
): string {
  const { fillOpacity = 1, idPrefix = '' } = options;
  if (model.mode === 'icon') {
    return segmentPaths(renderSegments(model, fills));
  }
  if (model.mode === 'mark') {
    return model.fills
      .flatMap((layer, i) => {
        const d = loopsToPathData(fills[i]?.loops ?? []);
        if (d === '') {
          return [];
        }
        const opacity = fillOpacity === 1 ? '' : ` fill-opacity="${num(fillOpacity)}"`;
        return [`<path fill-rule="evenodd" fill="${layer.color}"${opacity} d="${d}"/>`];
      })
      .join('\n');
  }
  const layers = [
    ...model.strokes.map((layer) => ({ index: layer.index, stroke: layer })),
    ...model.erases.map((layer) => ({ index: layer.index, erase: layer })),
  ].sort((a, b) => a.index - b.index);
  const defs: string[] = [];
  let body = '';
  for (const layer of layers) {
    if ('stroke' in layer) {
      const markup = layer.stroke.items
        .flatMap((item) => strokeItemMarkup(item, layer.stroke))
        .join('\n');
      body = body === '' ? markup : `${body}\n${markup}`;
    } else {
      const id = `${idPrefix}erase-${layer.index}`;
      defs.push(eraseMask(id, layer.erase));
      body = `<g mask="url(#${id})">\n${body}\n</g>`;
    }
  }
  return defs.length === 0 ? body : `<defs>\n${defs.join('\n')}\n</defs>\n${body}`;
}

/**
 * The final drawing as a standalone SVG: viewBox is the canvas, background transparent.
 * An icon's viewBox starts at 0 0, the frame of its segments.
 */
export function renderFinalSvg(model: ResolvedModel, fills: readonly FillResult[]): string {
  const h = model.canvasHalf;
  const side = num(2 * h);
  const origin = model.mode === 'icon' ? '0 0' : `${num(-h)} ${num(-h)}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${origin} ${side} ${side}">`,
    finalMarkup(model, fills),
    '</svg>',
  ].join('\n');
}
