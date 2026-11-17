/** Distance comparison tolerance. */
export const EPS = 1e-9;
/** Vertex identification and coincidence tolerance. */
export const SNAP = 1e-7;

export type Vec = { x: number; y: number };
export type Circle = { cx: number; cy: number; r: number };
/** Infinite directed line: a point on it and a unit direction. */
export type Line = { p: Vec; d: Vec };

export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const length = (a: Vec): number => Math.hypot(a.x, a.y);
export const distance = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Left normal of a vector. */
export const leftNormal = (a: Vec): Vec => ({ x: -a.y, y: a.x });

/** Centre of a circle as a vector. */
export const centerOf = (c: Circle): Vec => ({ x: c.cx, y: c.cy });

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Line through two distinct points, directed from `a` to `b`. */
export function lineThrough(a: Vec, b: Vec): Line {
  const v = sub(b, a);
  const len = length(v);
  return { p: { x: a.x, y: a.y }, d: { x: v.x / len, y: v.y / len } };
}

/** Signed distance from a point to a line; positive on the left of the direction. */
export function signedDistance(line: Line, p: Vec): number {
  return cross(line.d, sub(p, line.p));
}

/** Foot of the perpendicular from a point to a line. */
export function projectOnLine(line: Line, p: Vec): Vec {
  return add(line.p, scale(line.d, dot(line.d, sub(p, line.p))));
}

/** Point on a circle at an angle in degrees, counter-clockwise from +x. */
export function pointOnCircle(c: Circle, deg: number): Vec {
  const a = toRad(deg);
  return { x: c.cx + c.r * Math.cos(a), y: c.cy + c.r * Math.sin(a) };
}

/** Rotate a point counter-clockwise about a centre by an angle in degrees. */
export function rotateAbout(p: Vec, center: Vec, deg: number): Vec {
  const a = toRad(deg);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const v = sub(p, center);
  return { x: center.x + v.x * cos - v.y * sin, y: center.y + v.x * sin + v.y * cos };
}

/** Mirror a point across the line through `center` at `axisDeg` from +x. */
export function mirrorAcross(p: Vec, center: Vec, axisDeg: number): Vec {
  const a = toRad(2 * axisDeg);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const v = sub(p, center);
  return { x: center.x + v.x * cos + v.y * sin, y: center.y + v.x * sin - v.y * cos };
}
