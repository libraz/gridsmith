/**
 * @file Approximates a cubic Bezier with lines and circular arcs.
 *
 * The curve is cut at its inflection points (cusps included); each section becomes its chord, or
 * the arc through its endpoints and its midpoint, when every sample lies within the tolerance,
 * and is otherwise halved. Tangent continuity between pieces is not enforced: the pieces are
 * drawn with round joins. Pure math on y-up module coordinates; imports nothing.
 */

/** A point or vector. */
export type Vec = { x: number; y: number };

/** One fitted piece; an arc runs from `a` to `b` around centre `c`. */
export type FitPiece =
  | { kind: 'line'; a: Vec; b: Vec }
  | { kind: 'arc'; a: Vec; b: Vec; c: Vec; r: number; ccw: boolean };

/** Fitted pieces in curve order and the largest sample distance from them. */
export type Fit = { pieces: FitPiece[]; deviation: number };

/** Largest allowed sample distance, in modules (0.1 px at 24 px). */
export const FIT_TOLERANCE = 0.1;
/** Intervals sampled per section. */
export const FIT_SAMPLES = 16;
/** Halvings allowed below each inflection-free section. */
export const FIT_DEPTH = 3;
/** Largest arc radius; flatter sections are halved until their chords fit. */
export const FIT_RADIUS_MAX = 32;
/** Largest centre coordinate of a fitted arc. */
const CENTRE_MAX = 64;
const TINY = 1e-9;
/** Inflection roots this close to either end do not split the curve. */
const END_MARGIN = 0.02;

type Cubic = [Vec, Vec, Vec, Vec];

const lerp = (p: Vec, q: Vec, t: number): Vec => ({
  x: p.x + (q.x - p.x) * t,
  y: p.y + (q.y - p.y) * t,
});
const sub = (p: Vec, q: Vec): Vec => ({ x: p.x - q.x, y: p.y - q.y });
const cross = (u: Vec, v: Vec): number => u.x * v.y - u.y * v.x;
const dist = (p: Vec, q: Vec): number => Math.hypot(p.x - q.x, p.y - q.y);

/** de Casteljau split at `t`. */
function split(c: Cubic, t: number): [Cubic, Cubic] {
  const [p0, p1, p2, p3] = c;
  const a = lerp(p0, p1, t);
  const b = lerp(p1, p2, t);
  const d = lerp(p2, p3, t);
  const ab = lerp(a, b, t);
  const bd = lerp(b, d, t);
  const m = lerp(ab, bd, t);
  return [
    [p0, a, ab, m],
    [m, bd, d, p3],
  ];
}

const at = (c: Cubic, t: number): Vec => split(c, t)[0][3];

/** Roots of cross(B', B'') in (END_MARGIN, 1 - END_MARGIN), ascending. */
function inflections(c: Cubic): number[] {
  const [p0, p1, p2, p3] = c;
  const a = sub(p1, p0);
  const b = sub(p2, p1);
  const d = sub(p3, p2);
  // B'/3 = A t^2 + B t + C and B''/6 = A t + B/2.
  const A = { x: a.x - 2 * b.x + d.x, y: a.y - 2 * b.y + d.y };
  const B = { x: 2 * (b.x - a.x), y: 2 * (b.y - a.y) };
  const qa = -cross(A, B) / 2;
  const qb = cross(a, A);
  const qc = cross(a, B) / 2;
  const scale = Math.max(Math.abs(qa), Math.abs(qb), Math.abs(qc));
  let roots: number[];
  if (Math.abs(qa) <= TINY * scale) {
    roots = Math.abs(qb) <= TINY * scale ? [] : [-qc / qb];
  } else {
    const disc = qb * qb - 4 * qa * qc;
    // A cusp is a double root that rounding may push just below zero.
    if (disc < -TINY * scale * scale) {
      roots = [];
    } else {
      const q = -(qb + (qb < 0 ? -1 : 1) * Math.sqrt(Math.max(0, disc))) / 2;
      roots = q === 0 ? [0] : [q / qa, qc / q];
    }
  }
  return roots
    .filter((t) => t > END_MARGIN && t < 1 - END_MARGIN)
    .sort((x, y) => x - y)
    .filter((t, k, all) => k === 0 || t - (all[k - 1] as number) > TINY);
}

/** Distance from `p` to segment `ab`. */
function toSegment(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a);
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / (ab.x ** 2 + ab.y ** 2)),
  );
  return dist(p, lerp(a, b, t));
}

const samples = (c: Cubic): Vec[] =>
  Array.from({ length: FIT_SAMPLES + 1 }, (_, k) => at(c, k / FIT_SAMPLES));

/** One piece for an inflection-free section, or null when it must be halved. */
function fitSection(c: Cubic): { piece: FitPiece; deviation: number } | null {
  const [p0, , , p3] = c;
  const pts = samples(c);
  if (dist(p0, p3) < TINY) {
    return null;
  }
  const flat = Math.max(...pts.map((p) => toSegment(p, p0, p3)));
  if (flat <= FIT_TOLERANCE) {
    return { piece: { kind: 'line', a: p0, b: p3 }, deviation: flat };
  }
  const m = at(c, 0.5);
  const turn = cross(sub(m, p0), sub(p3, p0));
  if (Math.abs(turn) < TINY) {
    return null;
  }
  // Circumcentre of p0, m, p3.
  const u = sub(m, p0);
  const v = sub(p3, p0);
  const uu = u.x ** 2 + u.y ** 2;
  const vv = v.x ** 2 + v.y ** 2;
  const centre = {
    x: p0.x + (v.y * uu - u.y * vv) / (2 * turn),
    y: p0.y + (u.x * vv - v.x * uu) / (2 * turn),
  };
  const r = dist(centre, p0);
  if (r > FIT_RADIUS_MAX || Math.abs(centre.x) > CENTRE_MAX || Math.abs(centre.y) > CENTRE_MAX) {
    return null;
  }
  const ccw = turn > 0;
  const from = Math.atan2(p0.y - centre.y, p0.x - centre.x);
  const to = Math.atan2(p3.y - centre.y, p3.x - centre.x);
  const full = 2 * Math.PI;
  const sweep = (((ccw ? to - from : from - to) % full) + full) % full;
  if (sweep >= Math.PI) {
    return null;
  }
  const deviation = Math.max(...pts.map((p) => Math.abs(dist(p, centre) - r)));
  if (deviation > FIT_TOLERANCE) {
    return null;
  }
  return { piece: { kind: 'arc', a: p0, b: p3, c: centre, r, ccw }, deviation };
}

/** Fits a section, halving it up to {@link FIT_DEPTH} times; null when that runs out. */
function fitRecursive(c: Cubic, depth: number): Fit | null {
  const one = fitSection(c);
  if (one !== null) {
    return { pieces: [one.piece], deviation: one.deviation };
  }
  if (depth >= FIT_DEPTH) {
    return null;
  }
  const [left, right] = split(c, 0.5);
  const l = fitRecursive(left, depth + 1);
  const r = l === null ? null : fitRecursive(right, depth + 1);
  if (l === null || r === null) {
    return null;
  }
  return { pieces: [...l.pieces, ...r.pieces], deviation: Math.max(l.deviation, r.deviation) };
}

/**
 * Approximates the cubic Bezier p0..p3 with lines and arcs of less than 180 degrees, each
 * within {@link FIT_TOLERANCE} of 17 samples of its section.
 *
 * @returns The pieces in curve order (none for a curve collapsed to a point), or null when a
 *   section still fails after {@link FIT_DEPTH} halvings.
 */
export function fitCubic(p0: Vec, p1: Vec, p2: Vec, p3: Vec): Fit | null {
  if ([p1, p2, p3].every((p) => dist(p, p0) <= TINY)) {
    return { pieces: [], deviation: 0 };
  }
  const sections: Cubic[] = [];
  let rest: Cubic = [p0, p1, p2, p3];
  let done = 0;
  for (const t of inflections(rest)) {
    const [head, tail] = split(rest, (t - done) / (1 - done));
    sections.push(head);
    rest = tail;
    done = t;
  }
  sections.push(rest);
  const pieces: FitPiece[] = [];
  let deviation = 0;
  for (const section of sections) {
    const fit = fitRecursive(section, 0);
    if (fit === null) {
      return null;
    }
    pieces.push(...fit.pieces);
    deviation = Math.max(deviation, fit.deviation);
  }
  return { pieces, deviation };
}

/** Raises a quadratic Bezier to the cubic with the same curve. */
export function elevate(q0: Vec, q1: Vec, q2: Vec): [Vec, Vec, Vec, Vec] {
  return [
    q0,
    { x: (q0.x + 2 * q1.x) / 3, y: (q0.y + 2 * q1.y) / 3 },
    { x: (2 * q1.x + q2.x) / 3, y: (2 * q1.y + q2.y) / 3 },
    q2,
  ];
}
