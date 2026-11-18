// Closed chains for axis-aligned rectangles (sharp, rounded, pill) and the four-arc oval.
// Pieces are laid out directly from closed forms rather than found by `buildChain`, so joint
// points are exact and shared by both pieces they join.

import type { Chain, ChainJoint, ChainPiece } from './chain.js';
import { areaOf, jointsOf } from './chain.js';
import type { Circle, Vec } from './primitives.js';
import { add, distance, leftNormal, lineThrough, SNAP, scale } from './primitives.js';

const line = (start: Vec, end: Vec): ChainPiece => ({
  kind: 'line',
  line: lineThrough(start, end),
  start,
  end,
});

/** Counter-clockwise arc piece with a known sweep. */
function arc(circle: Circle, start: Vec, end: Vec, sweep: number): ChainPiece {
  const from = Math.atan2(start.y - circle.cy, start.x - circle.cx);
  return {
    kind: 'arc',
    circle,
    start,
    end,
    ccw: true,
    from: from === -Math.PI ? Math.PI : from,
    sweep,
  };
}

function chainOf(pieces: ChainPiece[], kind: ChainJoint['kind']): Chain {
  return {
    pieces,
    joints: jointsOf(
      pieces,
      pieces.map(() => kind),
    ),
    area: areaOf(pieces),
  };
}

/**
 * Rectangle from its lower-left and upper-right corners with corner radius `r` (0 for sharp).
 * Starts at the bottom-left (the left end of the bottom line when rounded) along the bottom.
 * A side shorter than `SNAP` makes a pill of two lines and two semicircles; a pill whose lines
 * also vanish is a circle and throws.
 */
export function rectChain(min: Vec, max: Vec, r: number): Chain {
  const p = (x: number, y: number): Vec => ({ x, y });
  if (r === 0) {
    const corners = [p(min.x, min.y), p(max.x, min.y), p(max.x, max.y), p(min.x, max.y)];
    return chainOf(
      corners.map((a, k) => line(a, corners[(k + 1) % 4] as Vec)),
      'corner',
    );
  }
  const w = max.x - min.x;
  const h = max.y - min.y;
  const flatX = w - 2 * r <= SNAP;
  const flatY = h - 2 * r <= SNAP;
  if (flatX && flatY) {
    throw new Error('rectChain: a square with r = w / 2 is a circle');
  }
  const half = Math.PI / 2;
  if (flatY) {
    // Horizontal pill: bottom line, right semicircle, top line, left semicircle.
    const rr = h / 2;
    const cy = min.y + rr;
    const [a, b, c, d] = [
      p(min.x + rr, min.y),
      p(max.x - rr, min.y),
      p(max.x - rr, max.y),
      p(min.x + rr, max.y),
    ];
    return chainOf(
      [
        line(a, b),
        arc({ cx: max.x - rr, cy, r: rr }, b, c, Math.PI),
        line(c, d),
        arc({ cx: min.x + rr, cy, r: rr }, d, a, Math.PI),
      ],
      'tangent',
    );
  }
  if (flatX) {
    // Vertical pill: bottom semicircle, right line, top semicircle, left line.
    const rr = w / 2;
    const cx = min.x + rr;
    const [a, b, c, d] = [
      p(min.x, min.y + rr),
      p(max.x, min.y + rr),
      p(max.x, max.y - rr),
      p(min.x, max.y - rr),
    ];
    return chainOf(
      [
        arc({ cx, cy: min.y + rr, r: rr }, a, b, Math.PI),
        line(b, c),
        arc({ cx, cy: max.y - rr, r: rr }, c, d, Math.PI),
        line(d, a),
      ],
      'tangent',
    );
  }
  const x0 = min.x + r;
  const x1 = max.x - r;
  const y0 = min.y + r;
  const y1 = max.y - r;
  const pts = [
    p(x0, min.y),
    p(x1, min.y),
    p(max.x, y0),
    p(max.x, y1),
    p(x1, max.y),
    p(x0, max.y),
    p(min.x, y1),
    p(min.x, y0),
  ] as const;
  const at = (k: number): Vec => pts[k % 8] as Vec;
  const centres = [p(x1, y0), p(x1, y1), p(x0, y1), p(x0, y0)];
  const pieces: ChainPiece[] = [];
  centres.forEach((c, k) => {
    pieces.push(line(at(2 * k), at(2 * k + 1)));
    pieces.push(arc({ cx: c.x, cy: c.y, r }, at(2 * k + 1), at(2 * k + 2), half));
  });
  return chainOf(pieces, 'tangent');
}

/**
 * Radii of the four-arc oval drawn from the chord between a major and a minor axis end:
 * `end` at the major-axis ends, `side` at the minor-axis ends.
 */
export function ovalRadii(rx: number, ry: number): { end: number; side: number } {
  const a = Math.max(rx, ry);
  const b = Math.min(rx, ry);
  const d = Math.hypot(a, b);
  return { end: (d * (d - a + b)) / (2 * a), side: (d * (d + a - b)) / (2 * b) };
}

/** Oval frame in major/minor coordinates: centre offsets, joint and half-sweep of the end arcs. */
function ovalFrame(rx: number, ry: number) {
  const a = Math.max(rx, ry);
  const b = Math.min(rx, ry);
  const { end, side } = ovalRadii(rx, ry);
  const e = a - end;
  const s = side - b;
  // The upper-right joint lies on the line from the top arc's centre (0, -s) through (e, 0).
  const k = side / Math.hypot(e, s);
  return { a, b, end, side, e, s, joint: { x: e * k, y: s * (k - 1) }, alpha: Math.atan2(s, e) };
}

/**
 * Four-arc oval with semi-axes `rx`, `ry`, turned counter-clockwise by `rotate` radians.
 * Starts at the lower joint of the arc on the positive major-axis end.
 */
export function ovalChain(center: Vec, rx: number, ry: number, rotate: number): Chain {
  const { end, side, e, s, joint, alpha } = ovalFrame(rx, ry);
  const turn = rx >= ry ? rotate : rotate + Math.PI / 2;
  const m = { x: Math.cos(turn), y: Math.sin(turn) };
  const n = leftNormal(m);
  const to = (u: number, v: number): Vec => add(center, add(scale(m, u), scale(n, v)));
  const circle = (u: number, v: number, r: number): Circle => {
    const c = to(u, v);
    return { cx: c.x, cy: c.y, r };
  };
  const j0 = to(joint.x, -joint.y);
  const j1 = to(joint.x, joint.y);
  const j2 = to(-joint.x, joint.y);
  const j3 = to(-joint.x, -joint.y);
  const endSweep = 2 * alpha;
  const sideSweep = Math.PI - 2 * alpha;
  return chainOf(
    [
      arc(circle(e, 0, end), j0, j1, endSweep),
      arc(circle(0, -s, side), j1, j2, sideSweep),
      arc(circle(-e, 0, end), j2, j3, endSweep),
      arc(circle(0, s, side), j3, j0, sideSweep),
    ],
    'tangent',
  );
}

/** Distance from a point to the arc of `circle` between polar angles `lo` and `hi`. */
function arcDistance(p: Vec, c: Vec, r: number, lo: number, hi: number): number {
  const t = Math.atan2(p.y - c.y, p.x - c.x);
  if (t >= lo && t <= hi) {
    return Math.abs(distance(p, c) - r);
  }
  const ends = [lo, hi].map((u) => ({ x: c.x + r * Math.cos(u), y: c.y + r * Math.sin(u) }));
  return Math.min(...ends.map((q) => distance(p, q)));
}

/**
 * Largest distance from the true ellipse to the four-arc oval, over 720 points of the first
 * quadrant at equal steps of the parametric angle.
 */
export function ovalDeviation(rx: number, ry: number): number {
  const { a, b, end, side, e, s, alpha } = ovalFrame(rx, ry);
  const count = 720;
  let worst = 0;
  for (let i = 0; i < count; i++) {
    const t = (i * Math.PI) / 2 / (count - 1);
    const p = { x: a * Math.cos(t), y: b * Math.sin(t) };
    const d = Math.min(
      arcDistance(p, { x: e, y: 0 }, end, 0, alpha),
      arcDistance(p, { x: 0, y: -s }, side, alpha, Math.PI / 2),
    );
    worst = Math.max(worst, d);
  }
  return worst;
}
