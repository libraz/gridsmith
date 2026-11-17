import type { Circle, Line, Vec } from './primitives.js';
import {
  add,
  centerOf,
  cross,
  distance,
  EPS,
  leftNormal,
  projectOnLine,
  SNAP,
  scale,
  signedDistance,
  sub,
} from './primitives.js';

export type CircleCircleResult =
  | { kind: 'none' }
  | { kind: 'coincident' }
  | { kind: 'tangent'; point: Vec }
  | { kind: 'two'; points: [Vec, Vec] };

export type CircleLineResult =
  | { kind: 'none' }
  | { kind: 'tangent'; point: Vec }
  | { kind: 'two'; points: [Vec, Vec] };

export type LineLineResult =
  | { kind: 'none' }
  | { kind: 'coincident' }
  | { kind: 'point'; point: Vec };

/** Intersect two circles; tangency is decided by centre distance within EPS. */
export function intersectCircleCircle(a: Circle, b: Circle): CircleCircleResult {
  const ca = centerOf(a);
  const cb = centerOf(b);
  const d = distance(ca, cb);
  if (d <= SNAP && Math.abs(a.r - b.r) <= SNAP) {
    return { kind: 'coincident' };
  }
  // Concentric with different radii has no direction to build points from.
  if (d <= EPS) {
    return { kind: 'none' };
  }
  const u = scale(sub(cb, ca), 1 / d);
  if (Math.abs(d - (a.r + b.r)) <= EPS) {
    return { kind: 'tangent', point: add(ca, scale(u, a.r)) };
  }
  if (Math.abs(d - Math.abs(a.r - b.r)) <= EPS) {
    const point = a.r > b.r ? add(ca, scale(u, a.r)) : sub(cb, scale(u, b.r));
    return { kind: 'tangent', point };
  }
  if (d > a.r + b.r || d < Math.abs(a.r - b.r)) {
    return { kind: 'none' };
  }
  const along = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
  const h = Math.sqrt(Math.max(0, a.r * a.r - along * along));
  const mid = add(ca, scale(u, along));
  const n = scale(leftNormal(u), h);
  return { kind: 'two', points: [add(mid, n), sub(mid, n)] };
}

/** Intersect a circle with an infinite line; tangency is decided by distance within EPS. */
export function intersectCircleLine(c: Circle, line: Line): CircleLineResult {
  const center = centerOf(c);
  const s = signedDistance(line, center);
  const foot = projectOnLine(line, center);
  if (Math.abs(Math.abs(s) - c.r) <= EPS) {
    return { kind: 'tangent', point: foot };
  }
  if (Math.abs(s) > c.r) {
    return { kind: 'none' };
  }
  const h = Math.sqrt(c.r * c.r - s * s);
  const along = scale(line.d, h);
  return { kind: 'two', points: [add(foot, along), sub(foot, along)] };
}

/** Intersect two infinite lines. */
export function intersectLineLine(a: Line, b: Line): LineLineResult {
  const q = add(a.p, a.d);
  if (Math.abs(signedDistance(b, a.p)) <= SNAP && Math.abs(signedDistance(b, q)) <= SNAP) {
    return { kind: 'coincident' };
  }
  const denom = cross(a.d, b.d);
  if (Math.abs(denom) <= EPS) {
    return { kind: 'none' };
  }
  const t = cross(sub(b.p, a.p), b.d) / denom;
  return { kind: 'point', point: add(a.p, scale(a.d, t)) };
}
