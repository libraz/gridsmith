import type { FillResult, Loop } from '../geom/arrangement.js';
import type { ChainPiece } from '../geom/chain.js';
import type { Circle, Vec } from '../geom/primitives.js';
import type { ResolvedModel, ResolvedStroke, StrokeItem } from '../resolve/resolve.js';

/** One filled layer: its boundary loops, filled even-odd. */
export type FillSegment = { d: string; fill: string; fillRule: 'evenodd' };

/** One stroked layer: every element of the layer in one path, never filled. */
export type StrokeSegment = {
  d: string;
  stroke: string;
  strokeWidth: number;
  strokeLinecap: ResolvedStroke['cap'];
  strokeLinejoin: ResolvedStroke['join'];
  /** `"dash gap"`, present only for a dashed layer. */
  strokeDasharray?: string;
};

/** Path data in the 0..canvas, y-down frame with absolute `M`, `L`, `A` and `Z` only. */
export type Segment = FillSegment | StrokeSegment;

/** An icon as one segment per paint layer, in paint order. */
export type SegmentSet = { canvas: number; segments: Segment[] };

const TWO_PI = 2 * Math.PI;
/** Largest sweep of one `A`, as in the figure writer: the rasteriser flattens equal arcs alike. */
const MAX_ARC_SWEEP = TWO_PI / 3;

/** Rounds to 4 decimals; drops trailing zeros, the dot and a negative zero. */
const fmt = (x: number): string => {
  const r = Number(x.toFixed(4));
  return String(r === 0 ? 0 : r);
};

/** Path data writer for one model frame: y-up, origin at the centre, to y-down from the corner. */
function pathWriter(half: number) {
  const at = (p: Vec): string => `${fmt(p.x + half)} ${fmt(half - p.y)}`;
  // Equal parts of at most 120 degrees; `ccw` in y-up space is sweep-flag 0 after the flip.
  const arc = (c: Circle, from: Vec, to: Vec, ccw: boolean): string => {
    const a0 = Math.atan2(from.y - c.cy, from.x - c.cx);
    let delta = Math.atan2(to.y - c.cy, to.x - c.cx) - a0;
    if (ccw) {
      while (delta <= 0) {
        delta += TWO_PI;
      }
    } else {
      while (delta >= 0) {
        delta -= TWO_PI;
      }
    }
    const parts = Math.max(1, Math.ceil(Math.abs(delta) / MAX_ARC_SWEEP - 1e-9));
    const out: string[] = [];
    for (let k = 1; k <= parts; k++) {
      const a = a0 + (delta * k) / parts;
      const end = k === parts ? to : { x: c.cx + c.r * Math.cos(a), y: c.cy + c.r * Math.sin(a) };
      out.push(`A${fmt(c.r)} ${fmt(c.r)} 0 0 ${ccw ? 0 : 1} ${at(end)}`);
    }
    return out.join('');
  };
  const chain = (pieces: readonly ChainPiece[]): string => {
    const first = pieces[0];
    if (first === undefined) {
      return '';
    }
    const out = [`M${at(first.start)}`];
    pieces.forEach((piece, i) => {
      // `Z` draws a closing straight piece.
      if (piece.kind === 'line') {
        out.push(i === pieces.length - 1 ? '' : `L${at(piece.end)}`);
      } else {
        out.push(arc(piece.circle, piece.start, piece.end, piece.ccw));
      }
    });
    return `${out.join('')}Z`;
  };
  const open = (points: readonly Vec[], close: boolean): string =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${at(p)}`).join('') + (close ? 'Z' : '');
  // Start points and directions follow the SVG elements the figure writer emits.
  const item = (it: StrokeItem): string => {
    switch (it.kind) {
      case 'circle': {
        const { cx, cy, r } = it.circle;
        const start = { x: cx + r, y: cy };
        const opposite = { x: cx - r, y: cy };
        // Two half arcs, clockwise in y-up space like the SVG circle element.
        const halfArc = `A${fmt(r)} ${fmt(r)} 0 0 1`;
        return `M${at(start)}${halfArc} ${at(opposite)}${halfArc} ${at(start)}Z`;
      }
      case 'segment':
        return open([it.from, it.to], false);
      case 'arc':
        return `M${at(it.start)}${arc(it.circle, it.start, it.end, true)}`;
      case 'polygon':
        return it.loops.map((loop) => open(loop, true)).join('');
      case 'chain':
        return chain(it.pieces);
      case 'polyline':
        return open(it.points, false);
    }
  };
  const loops = (ls: readonly Loop[]): string =>
    ls
      .map((loop) => {
        const first = loop[0];
        if (first === undefined) {
          return '';
        }
        const edges = loop.map((e, i) => {
          if (e.kind === 'segment') {
            return i === loop.length - 1 ? '' : `L${at(e.to)}`;
          }
          return arc({ cx: e.cx, cy: e.cy, r: e.r }, e.from, e.to, e.ccw);
        });
        return `M${at(first.from)}${edges.join('')}Z`;
      })
      .join('');
  return { item, loops };
}

/**
 * Segments of an icon: one per paint layer in paint order, fills with an area only.
 *
 * @throws Error when the model is not an icon.
 */
export function renderSegments(model: ResolvedModel, fills: readonly FillResult[]): SegmentSet {
  if (model.mode !== 'icon') {
    throw new Error(`renderSegments: segments exist for an icon only (received: ${model.mode})`);
  }
  const half = model.canvasHalf;
  const write = pathWriter(half);
  const layers: { index: number; segment: Segment | null }[] = [
    ...model.fills.map((layer, i) => {
      const fill = fills[i];
      const d = fill === undefined || fill.area <= 0 ? '' : write.loops(fill.loops);
      const segment: FillSegment | null =
        d === '' ? null : { d, fill: layer.color.toLowerCase(), fillRule: 'evenodd' };
      return { index: layer.index, segment };
    }),
    ...model.strokes.map((layer) => {
      const segment: StrokeSegment = {
        d: layer.items.map(write.item).join(''),
        stroke: layer.color.toLowerCase(),
        strokeWidth: Number(fmt(layer.width)),
        strokeLinecap: layer.cap,
        strokeLinejoin: layer.join,
      };
      if (layer.dash !== null) {
        segment.strokeDasharray = `${fmt(layer.dash[0])} ${fmt(layer.dash[1])}`;
      }
      return { index: layer.index, segment };
    }),
  ];
  return {
    canvas: 2 * half,
    segments: layers
      .sort((a, b) => a.index - b.index)
      .flatMap((l) => (l.segment === null ? [] : [l.segment])),
  };
}

/** One `path` element per segment, newline-separated, without the enclosing `svg`. */
export function segmentPaths(set: SegmentSet): string {
  return set.segments
    .map((s) => {
      if ('fill' in s) {
        return `<path fill="${s.fill}" fill-rule="${s.fillRule}" d="${s.d}"/>`;
      }
      const dash =
        s.strokeDasharray === undefined ? '' : ` stroke-dasharray="${s.strokeDasharray}"`;
      return `<path fill="none" stroke="${s.stroke}" stroke-width="${fmt(s.strokeWidth)}" stroke-linecap="${s.strokeLinecap}" stroke-linejoin="${s.strokeLinejoin}"${dash} d="${s.d}"/>`;
    })
    .join('\n');
}
