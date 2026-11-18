// Closed chains for axis-aligned rectangles (sharp, rounded, pill) and the oval, a G1 chain of
// circular arcs that follows a true ellipse. Pieces are laid out directly from closed forms rather
// than found by `buildChain`, so joint points are exact and shared by both pieces they join.

import type { Chain, ChainJoint, ChainPiece } from './chain.js';
import { areaOf, jointsOf } from './chain.js';
import type { Circle, Vec } from './primitives.js';
import {
  add,
  cross,
  distance,
  dot,
  leftNormal,
  length,
  lineThrough,
  SNAP,
  scale,
  sub,
} from './primitives.js';

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

/** Number of biarcs (arc pairs) per quarter of the oval. */
export const OVAL_BIARCS = 4;

const TWO_PI = 2 * Math.PI;

type OvalArc = { c: Vec; r: number; s: Vec; e: Vec };

/** Counter-clockwise angle in (0, 2 pi) from `s` to `e` around `c`. */
function ccwSweep(c: Vec, s: Vec, e: Vec): number {
  const raw = Math.atan2(e.y - c.y, e.x - c.x) - Math.atan2(s.y - c.y, s.x - c.x);
  return ((raw % TWO_PI) + TWO_PI) % TWO_PI;
}

/** Ellipse parameters 0 = t_0 < ... < t_K = pi / 2 that split the integral of |kappa'|^(1/3) ds evenly. */
function ovalSplits(a: number, b: number): number[] {
  const steps = 2000;
  const weight = (t: number): number =>
    Math.abs(Math.sin(2 * t)) ** (1 / 3) / Math.hypot(a * Math.sin(t), b * Math.cos(t));
  const ts: number[] = [];
  const cum: number[] = [0];
  for (let i = 0; i <= steps; i++) {
    ts.push((i * Math.PI) / 2 / steps);
  }
  for (let i = 1; i <= steps; i++) {
    const h = (ts[i] as number) - (ts[i - 1] as number);
    const mean = (weight(ts[i - 1] as number) + weight(ts[i] as number)) / 2;
    cum.push((cum[i - 1] as number) + mean * h);
  }
  const total = cum[steps] as number;
  const out = [0];
  let i = 1;
  for (let k = 1; k < OVAL_BIARCS; k++) {
    const target = (k * total) / OVAL_BIARCS;
    while ((cum[i] as number) < target) {
      i++;
    }
    const f = (target - (cum[i - 1] as number)) / ((cum[i] as number) - (cum[i - 1] as number));
    out.push((ts[i - 1] as number) + f * ((ts[i] as number) - (ts[i - 1] as number)));
  }
  out.push(Math.PI / 2);
  return out;
}

/** Two arcs from `p0` (unit tangent `t0`) to `p1` (unit tangent `t1`) meeting with a common tangent. */
function ovalBiarc(p0: Vec, t0: Vec, p1: Vec, t1: Vec): [OvalArc, OvalArc] {
  const w = sub(p1, p0);
  const c = 1 - dot(t0, t1);
  const d2Of = (d1: number): number =>
    (dot(w, w) - 2 * d1 * dot(w, t0)) / (2 * dot(w, t1) + 2 * d1 * c);
  // Zero when the tangent at the joint is parallel to the chord.
  const skew = (d1: number): number => cross(w, sub(sub(w, scale(t0, d1)), scale(t1, d2Of(d1))));
  const reach = 2 * length(w);
  let lo = 0;
  let hi = 0;
  let found = false;
  let prev: { d1: number; v: number } | null = null;
  for (let i = 1; i <= 64 && !found; i++) {
    const d1 = (i * reach) / 64;
    const v = d2Of(d1) > 0 ? skew(d1) : null;
    if (prev !== null && v !== null && Math.sign(prev.v) !== Math.sign(v)) {
      lo = prev.d1;
      hi = d1;
      found = true;
    }
    prev = v === null ? null : { d1, v };
  }
  if (!found) {
    throw new Error('ovalChain: no biarc joint found; semi-axes must differ');
  }
  let flo = skew(lo);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const fm = skew(mid);
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = mid;
      flo = fm;
    } else {
      hi = mid;
    }
  }
  const d1 = (lo + hi) / 2;
  const d2 = d2Of(d1);
  const q0 = add(p0, scale(t0, d1));
  const q1 = sub(p1, scale(t1, d2));
  const joint = scale(add(scale(q0, d2), scale(q1, d1)), 1 / (d1 + d2));
  const circleAt = (p: Vec, t: Vec): { c: Vec; r: number } => {
    const n = leftNormal(t);
    const d = sub(joint, p);
    const s = dot(d, d) / (2 * dot(d, n));
    return { c: add(p, scale(n, s)), r: Math.abs(s) };
  };
  const first = circleAt(p0, t0);
  const second = circleAt(p1, scale(t1, -1));
  // Rebuild the joint from the centres so the two circles touch within the kernel's tolerance.
  const gap = sub(second.c, first.c);
  const j = sub(first.c, scale(gap, first.r / length(gap)));
  return [
    { c: first.c, r: first.r, s: p0, e: j },
    { c: second.c, r: second.r, s: j, e: p1 },
  ];
}

/** The eight arcs of the first quarter, from the major-axis end (a, 0) to the minor-axis end (0, b). */
function ovalQuarter(a: number, b: number): OvalArc[] {
  const ts = ovalSplits(a, b);
  const frame = (k: number): { p: Vec; t: Vec } => {
    if (k === OVAL_BIARCS) {
      return { p: { x: 0, y: b }, t: { x: -1, y: 0 } };
    }
    const t = ts[k] as number;
    const tangent = { x: -a * Math.sin(t), y: b * Math.cos(t) };
    return {
      p: { x: a * Math.cos(t), y: b * Math.sin(t) },
      t: scale(tangent, 1 / length(tangent)),
    };
  };
  const out: OvalArc[] = [];
  for (let k = 0; k < OVAL_BIARCS; k++) {
    const from = frame(k);
    const to = frame(k + 1);
    out.push(...ovalBiarc(from.p, from.t, to.p, to.t));
  }
  return out;
}

/**
 * Oval with semi-axes `rx`, `ry`, turned counter-clockwise by `rotate` radians: 28 circular arcs
 * (`OVAL_BIARCS` biarcs per quarter, the two arcs on each axis end merged) that stay within
 * 0.06% of the longer semi-axis of the true ellipse and join tangentially.
 * Starts at the lower joint of the arc on the positive major-axis end.
 * Requires `|rx - ry|` of at least 0.05; equal semi-axes throw.
 */
export function ovalChain(center: Vec, rx: number, ry: number, rotate: number): Chain {
  if (rx === ry) {
    throw new Error('ovalChain: rx and ry are equal');
  }
  const a = Math.max(rx, ry);
  const b = Math.min(rx, ry);
  const q1 = ovalQuarter(a, b);
  const last = q1.length - 1;
  const acrossY = (p: Vec): Vec => ({ x: -p.x, y: p.y });
  const acrossX = (p: Vec): Vec => ({ x: p.x, y: -p.y });
  const through = (p: Vec): Vec => ({ x: -p.x, y: -p.y });
  // A mirror reverses travel, so the mirrored arc runs from the image of its end to that of its start.
  const mirrored = (m: (p: Vec) => Vec): OvalArc[] =>
    [...q1].reverse().map((x) => ({ c: m(x.c), r: x.r, s: m(x.e), e: m(x.s) }));
  const q2 = mirrored(acrossY);
  const q3 = q1.map((x) => ({ c: through(x.c), r: x.r, s: through(x.s), e: through(x.e) }));
  const q4 = mirrored(acrossX);
  // The two arcs meeting on an axis lie on one circle; join them with its centre placed on the axis.
  const merge = (x: OvalArc, y: OvalArc, c: Vec): OvalArc => ({ c, r: x.r, s: x.s, e: y.e });
  const end = (q1[0] as OvalArc).r;
  const side = (q1[last] as OvalArc).r;
  const arcs = [
    merge(q4[last] as OvalArc, q1[0] as OvalArc, { x: a - end, y: 0 }),
    ...q1.slice(1, last),
    merge(q1[last] as OvalArc, q2[0] as OvalArc, { x: 0, y: b - side }),
    ...q2.slice(1, last),
    merge(q2[last] as OvalArc, q3[0] as OvalArc, { x: end - a, y: 0 }),
    ...q3.slice(1, last),
    merge(q3[last] as OvalArc, q4[0] as OvalArc, { x: 0, y: side - b }),
    ...q4.slice(1, last),
  ];
  const turn = rx >= ry ? rotate : rotate + Math.PI / 2;
  const m = { x: Math.cos(turn), y: Math.sin(turn) };
  const n = leftNormal(m);
  const to = (p: Vec): Vec => add(center, add(scale(m, p.x), scale(n, p.y)));
  const pieces = arcs.map((x) => {
    const c = to(x.c);
    return arc({ cx: c.x, cy: c.y, r: x.r }, to(x.s), to(x.e), ccwSweep(x.c, x.s, x.e));
  });
  return chainOf(pieces, 'tangent');
}

type OvalHit = { index: number; point: Vec; offset: number };

/** Where the ray from `center` at `angle` leaves each arc piece, using the farther circle root. */
function ovalHits(pieces: readonly ChainPiece[], center: Vec, angle: number): OvalHit[] {
  const d = { x: Math.cos(angle), y: Math.sin(angle) };
  const hits: OvalHit[] = [];
  pieces.forEach((piece, index) => {
    if (piece.kind !== 'arc') {
      return;
    }
    const { cx, cy, r } = piece.circle;
    const w = { x: center.x - cx, y: center.y - cy };
    const b = w.x * d.x + w.y * d.y;
    const disc = b * b - (w.x * w.x + w.y * w.y - r * r);
    if (disc < 0) {
      return;
    }
    const t = -b + Math.sqrt(disc);
    if (t <= 0) {
      return;
    }
    const point = { x: center.x + t * d.x, y: center.y + t * d.y };
    const raw = Math.atan2(point.y - cy, point.x - cx) - piece.from;
    const o = ((raw % TWO_PI) + TWO_PI) % TWO_PI;
    const tol = SNAP / r;
    if (o > piece.sweep + tol && o < TWO_PI - tol) {
      return;
    }
    hits.push({ index, point, offset: o >= TWO_PI - tol ? 0 : Math.min(o, piece.sweep) });
  });
  return hits;
}

/**
 * Pieces of the oval (see `ovalChain`) from the point seen from the centre at angle
 * `from` to the point seen at angle `to`, counter-clockwise; angles in radians from +x.
 * A direction through a joint starts on the next piece and ends on the previous one; pieces no
 * longer than `SNAP` are dropped. `from` and `to` must not differ by a multiple of a full turn.
 */
export function ovalArc(
  center: Vec,
  rx: number,
  ry: number,
  rotate: number,
  from: number,
  to: number,
): ChainPiece[] {
  const base = ovalChain(center, rx, ry, rotate).pieces;
  const first = ovalHits(base, center, from);
  const last = ovalHits(base, center, to);
  const s = first.find((h) => distance(h.point, (base[h.index] as ChainPiece).end) > SNAP);
  const e = last.find((h) => distance(h.point, (base[h.index] as ChainPiece).start) > SNAP);
  const a = s ?? first[0];
  const b = e ?? last[0];
  if (a === undefined || b === undefined) {
    throw new Error('ovalArc: the direction does not meet the oval');
  }
  const out: ChainPiece[] = [];
  const part = (k: number, p: Vec, q: Vec, sweep: number): void => {
    const piece = base[k] as ChainPiece;
    if (piece.kind === 'arc' && distance(p, q) > SNAP) {
      out.push(arc(piece.circle, p, q, sweep));
    }
  };
  const sweepOf = (k: number): number => {
    const piece = base[k] as ChainPiece;
    return piece.kind === 'arc' ? piece.sweep : 0;
  };
  if (a.index === b.index && b.offset > a.offset) {
    part(a.index, a.point, b.point, b.offset - a.offset);
    return out;
  }
  part(a.index, a.point, (base[a.index] as ChainPiece).end, sweepOf(a.index) - a.offset);
  for (let k = (a.index + 1) % base.length; k !== b.index; k = (k + 1) % base.length) {
    out.push(base[k] as ChainPiece);
  }
  part(b.index, (base[b.index] as ChainPiece).start, b.point, b.offset);
  return out;
}

/** Distance from a point to an arc of the oval construction. */
function arcDistance(p: Vec, x: OvalArc): number {
  if (ccwSweep(x.c, x.s, p) <= ccwSweep(x.c, x.s, x.e)) {
    return Math.abs(distance(p, x.c) - x.r);
  }
  return Math.min(distance(p, x.s), distance(p, x.e));
}

/**
 * Largest distance from the true ellipse to the oval, over 720 points of the first quadrant at
 * equal steps of the parametric angle.
 */
export function ovalDeviation(rx: number, ry: number): number {
  const a = Math.max(rx, ry);
  const b = Math.min(rx, ry);
  const arcs = ovalQuarter(a, b);
  const count = 720;
  let worst = 0;
  for (let i = 0; i < count; i++) {
    const t = (i * Math.PI) / 2 / (count - 1);
    const p = { x: a * Math.cos(t), y: b * Math.sin(t) };
    worst = Math.max(worst, Math.min(...arcs.map((x) => arcDistance(p, x))));
  }
  return worst;
}
