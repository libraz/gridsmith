/**
 * @file Turns a closed ring of lines and circular arcs into an `outline` plus one support shape per
 * piece (a `circle` per arc, a `line` per line). Joints are decided by the kernel's contact test on
 * the supports as written, and the result is built once with `buildChain`, so an accepted ring
 * resolves exactly as checked. A ring that fails may be cut at crossings of its lines or have a
 * cusp arc's circle subtracted; such a result is marked for the caller's fill check.
 */

import { buildChain, ChainError, type ChainInput, type ChainSupport, meet } from '../geom/chain.js';
import { lineThrough, SNAP, type Vec } from '../geom/primitives.js';
import { COORDINATE_MAX, LENGTH_MAX, LENGTH_MIN } from '../spec/schema.js';
import { isArc, type Piece, polygonOf, type ShapeInput } from './shapes.js';

type Pt = [number, number];
type OutlinePiece = { on: string; concave?: boolean; corner?: Pt };

/** Pieces an outline may hold. */
const MAX_PIECES = 64;
/** Rings whose area is at most this are not converted. */
const MIN_AREA = 1e-9;

const round12 = (v: number): number => {
  const r = Math.round(v * 1e12) / 1e12;
  return r === 0 ? 0 : r;
};
const pt12 = (p: Vec): Pt => [round12(p.x), round12(p.y)];
const vec = (p: Pt): Vec => ({ x: p[0], y: p[1] });

const signedArea = (poly: readonly Vec[]): number =>
  poly.reduce((s, p, k) => {
    const q = poly[(k + 1) % poly.length] as Vec;
    return s + (p.x * q.y - q.x * p.y) / 2;
  }, 0);

/** The same piece travelled the other way. */
const reversed = (p: Piece): Piece =>
  isArc(p) ? { ...p, a: p.b, b: p.a, t1: p.t1 + p.dt, dt: -p.dt } : { ...p, a: p.b, b: p.a };

/** A piece's support as the shape to write and as the kernel curve resolve builds from it. */
type Support = { shape: ShapeInput; curve: ChainSupport; inRange: boolean };

const inCanvas = (p: Pt): boolean =>
  Math.abs(p[0]) <= COORDINATE_MAX && Math.abs(p[1]) <= COORDINATE_MAX;

function supportOf(p: Piece, id: string): Support {
  if (isArc(p)) {
    const center = pt12(p.c);
    const r = round12(p.rx);
    return {
      shape: { id, type: 'circle', center, r },
      curve: { kind: 'circle', circle: { cx: center[0], cy: center[1], r } },
      inRange: inCanvas(center) && r >= LENGTH_MIN && r <= LENGTH_MAX,
    };
  }
  const from = pt12(p.a);
  const to = pt12(p.b);
  const [a, b] = [vec(from), vec(to)];
  return {
    shape: { id, type: 'line', from, to },
    curve: { kind: 'line', line: lineThrough(a, b) },
    inRange: inCanvas(from) && inCanvas(to) && Math.hypot(b.x - a.x, b.y - a.y) > SNAP,
  };
}

/** Two pieces on one support as one piece, or null when they run apart or close a full turn. */
function merged(p: Piece, q: Piece): Piece | null {
  if (isArc(p) && isArc(q)) {
    const dt = p.dt + q.dt;
    return Math.sign(p.dt) === Math.sign(q.dt) && Math.abs(dt) < 2 * Math.PI
      ? { ...p, b: q.b, dt }
      : null;
  }
  const along = (p.b.x - p.a.x) * (q.b.x - q.a.x) + (p.b.y - p.a.y) * (q.b.y - q.a.y);
  return along > 0 ? { ...p, b: q.b } : null;
}

/** Merges neighbours on the same support, the last and first included; null on a merge refused. */
function mergeRuns(ring: readonly Piece[]): Piece[] | null {
  const out = [...ring];
  let k = 0;
  while (out.length >= 2 && k < out.length) {
    const j = (k + 1) % out.length;
    const p = out[k] as Piece;
    const q = out[j] as Piece;
    if (meet(supportOf(p, '').curve, supportOf(q, '').curve).kind !== 'same') {
      k++;
      continue;
    }
    const m = merged(p, q);
    if (m === null) {
      return null;
    }
    out[k] = m;
    out.splice(j, 1);
    if (j < k) {
      k--;
    }
  }
  return out;
}

/**
 * A closed ring of lines and circular arcs (y-up) as support shapes `<id>p<k>` followed by the
 * `outline` `<id>` with the built chain's area, or the reason it cannot be one: a {@link ChainError} code, `ellipse`,
 * `too many pieces`, `out of range` or `degenerate`.
 */
export function outlineOf(
  ring: readonly Piece[],
  id: string,
): { shapes: ShapeInput[]; area: number } | { detail: string } {
  if (ring.some((p) => isArc(p) && !p.circular)) {
    return { detail: 'ellipse' };
  }
  const area = signedArea(polygonOf(ring));
  if (Math.abs(area) <= MIN_AREA) {
    return { detail: 'degenerate' };
  }
  const ccw = area > 0 ? [...ring] : [...ring].reverse().map(reversed);
  const pieces = mergeRuns(ccw);
  if (pieces === null || pieces.length < 2) {
    return { detail: 'degenerate' };
  }
  if (pieces.length > MAX_PIECES) {
    return { detail: 'too many pieces' };
  }
  const supports = pieces.map((p, k) => supportOf(p, `${id}p${k}`));
  if (supports.some((s) => !s.inRange)) {
    return { detail: 'out of range' };
  }
  const through: OutlinePiece[] = [];
  const input: ChainInput[] = [];
  for (const [k, p] of pieces.entries()) {
    const here = supports[k] as Support;
    const next = supports[(k + 1) % supports.length] as Support;
    const m = meet(here.curve, next.curve);
    if (m.kind === 'none') {
      return { detail: 'no_contact' };
    }
    if (m.kind === 'same') {
      return { detail: 'same_curve' };
    }
    const concave = isArc(p) && p.dt < 0;
    const corner = m.kind === 'two' ? pt12(p.b) : undefined;
    if (corner !== undefined && !inCanvas(corner)) {
      return { detail: 'out of range' };
    }
    through.push({
      on: here.shape.id,
      ...(concave ? { concave } : {}),
      ...(corner === undefined ? {} : { corner }),
    });
    input.push({
      support: here.curve,
      concave,
      ...(corner === undefined ? {} : { corner: vec(corner) }),
    });
  }
  let built: number;
  try {
    built = buildChain(input).area;
  } catch (error) {
    if (error instanceof ChainError) {
      return { detail: error.code };
    }
    throw error;
  }
  return {
    shapes: [...supports.map((s) => s.shape), { id, type: 'outline', through }],
    area: built,
  };
}

/** Tolerance of the source data, rounded to 0.01. */
const TIDY = 0.02;

const dist = (p: Vec, q: Vec): number => Math.hypot(p.x - q.x, p.y - q.y);

/** Length of a ring's boundary. */
const perimeter = (ring: readonly Piece[]): number =>
  ring.reduce((s, p) => s + (isArc(p) ? p.rx * Math.abs(p.dt) : dist(p.a, p.b)), 0);

/** Signed area of a closed ring: the chords' shoelace plus each arc's segment. */
const ringArea = (ring: readonly Piece[]): number =>
  ring.reduce(
    (s, p) =>
      s +
      (p.a.x * p.b.y - p.b.x * p.a.y) / 2 +
      (isArc(p) ? (p.rx * p.ry * (p.dt - Math.sin(p.dt))) / 2 : 0),
    0,
  );
const angleAt = (c: Vec, p: Vec): number => Math.atan2(p.y - c.y, p.x - c.x);

/** Arcs `p` then `q` (with `between` lying on the circle) as one arc on the wider one, or null. */
function joinNear(p: Piece, q: Piece, between?: Piece): Piece | null {
  if (!isArc(p) || !isArc(q) || !p.circular || !q.circular) {
    return null;
  }
  if (
    dist(p.c, q.c) > TIDY ||
    Math.abs(p.rx - q.rx) > TIDY ||
    Math.sign(p.dt) !== Math.sign(q.dt)
  ) {
    return null;
  }
  const on = Math.abs(p.dt) >= Math.abs(q.dt) ? p : q;
  if (
    between !== undefined &&
    (isArc(between) || [between.a, between.b].some((e) => Math.abs(dist(e, on.c) - on.rx) > TIDY))
  ) {
    return null;
  }
  // The turn from p's start to q's end, nearest the summed sweeps.
  const hint = p.dt + q.dt;
  const raw = angleAt(on.c, q.b) - angleAt(on.c, p.a);
  const dt = raw + 2 * Math.PI * Math.round((hint - raw) / (2 * Math.PI));
  if (Math.sign(dt) !== Math.sign(hint) || Math.abs(dt) >= 2 * Math.PI) {
    return null;
  }
  return { ...on, a: p.a, b: q.b, phi: 0, t1: angleAt(on.c, p.a), dt };
}

/** Joins neighbouring arcs that differ by fit noise, the last and first included. */
function joinNearArcs(ring: readonly Piece[]): Piece[] {
  const out = [...ring];
  let k = 0;
  while (out.length >= 2 && k < out.length) {
    const n = out.length;
    const p = out[k] as Piece;
    let span = 1;
    let m = joinNear(p, out[(k + 1) % n] as Piece);
    if (m === null && n >= 3) {
      span = 2;
      m = joinNear(p, out[(k + 2) % n] as Piece, out[(k + 1) % n] as Piece);
    }
    // The joined arc must still reach the pieces on either side.
    const before = out[(k + n - 1) % n] as Piece;
    const after = out[(k + span + 1) % n] as Piece;
    const reaches = (q: Piece): boolean =>
      n <= span + 1 ||
      meet(supportOf(m as Piece, '').curve, supportOf(q, '').curve).kind !== 'none';
    if (m === null || !reaches(before) || !reaches(after)) {
      k++;
      continue;
    }
    for (let s = 0; s < span; s++) {
      const at = (k + 1) % out.length;
      out.splice(at, 1);
      if (at < k) {
        k--;
      }
    }
    out[k] = m;
  }
  return out;
}

/** Cuts a ring at every joint it passes twice; pieces keep their order and direction. */
function splitAtRepeats(ring: readonly Piece[]): Piece[][] {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if ((i === 0 && j === n - 1) || dist((ring[i] as Piece).b, (ring[j] as Piece).b) > TIDY) {
        continue;
      }
      const inner = ring.slice(i + 1, j + 1);
      const rest = [...ring.slice(j + 1), ...ring.slice(0, i + 1)];
      return [...splitAtRepeats(inner), ...splitAtRepeats(rest)];
    }
  }
  return [[...ring]];
}

type Line = Extract<Piece, { kind: 'line' }>;

/** Where two lines cross farther than {@link TIDY} from each end of both, or null. */
function crossing(p: Line, q: Line): Vec | null {
  const d = { x: p.b.x - p.a.x, y: p.b.y - p.a.y };
  const e = { x: q.b.x - q.a.x, y: q.b.y - q.a.y };
  const den = d.x * e.y - d.y * e.x;
  if (Math.abs(den) <= SNAP * Math.hypot(d.x, d.y) * Math.hypot(e.x, e.y)) {
    return null;
  }
  const w = { x: q.a.x - p.a.x, y: q.a.y - p.a.y };
  const t = (w.x * e.y - w.y * e.x) / den;
  const u = (w.x * d.y - w.y * d.x) / den;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) {
    return null;
  }
  const x = { x: p.a.x + t * d.x, y: p.a.y + t * d.y };
  return [p.a, p.b, q.a, q.b].every((end) => dist(end, x) > TIDY) ? x : null;
}

/** The ring with each crossing of two of its lines cut into both lines, or null when none cross. */
function crossLines(ring: readonly Piece[]): Piece[] | null {
  const cuts = ring.map((): Vec[] => []);
  for (let i = 0; i < ring.length; i++) {
    for (let j = i + 1; j < ring.length; j++) {
      const p = ring[i] as Piece;
      const q = ring[j] as Piece;
      const x = isArc(p) || isArc(q) ? null : crossing(p, q);
      if (x !== null) {
        cuts[i]?.push(x);
        cuts[j]?.push(x);
      }
    }
  }
  if (cuts.every((c) => c.length === 0)) {
    return null;
  }
  return ring.flatMap((p, i): Piece[] => {
    const at = (cuts[i] ?? []).sort((u, v) => dist(p.a, u) - dist(p.a, v));
    const verts = [p.a, ...at, p.b];
    return at.length === 0
      ? [p]
      : verts.slice(1).map((b, k) => ({ kind: 'line', a: verts[k] as Vec, b }));
  });
}

/** Cosine of the largest turn away from a full reversal that still reads as a cusp (1 degree). */
const CUSP = Math.cos(Math.PI / 180);

/** Unit direction of a line or circular arc at its start (`end` false) or end, along the ring. */
function heading(p: Piece, end: boolean): Vec {
  if (!isArc(p)) {
    const len = dist(p.a, p.b);
    return { x: (p.b.x - p.a.x) / len, y: (p.b.y - p.a.y) / len };
  }
  const at = end ? p.b : p.a;
  const s = Math.sign(p.dt) / dist(at, p.c);
  return { x: -(at.y - p.c.y) * s, y: (at.x - p.c.x) * s };
}

const reverses = (u: Vec, v: Vec): boolean => u.x * v.x + u.y * v.y <= -CUSP;

/** A circle subtracted from an outline: its id, centre and radius as written. */
export type Minus = { id: string; center: Pt; r: number };

/** One converted ring: its shapes, its signed area and its fill leaf. */
type Made = { shapes: ShapeInput[]; area: number; leaf: OutlineLeaf };

/**
 * A ring holding one circular arc that turns back against both neighbours (a cusp) and carves
 * in, as its ring with that arc replaced by the chord less the arc's circle `<id>cap`; or null.
 */
function lessCap(part: readonly Piece[], id: string): Made | null {
  const n = part.length;
  const caps = part.flatMap((p, k) =>
    isArc(p) &&
    p.circular &&
    reverses(heading(part[(k + n - 1) % n] as Piece, true), heading(p, false)) &&
    reverses(heading(p, true), heading(part[(k + 1) % n] as Piece, false))
      ? [k]
      : [],
  );
  const [k] = caps;
  const cap = k === undefined ? undefined : part[k];
  if (caps.length !== 1 || cap === undefined || !isArc(cap)) {
    return null;
  }
  const chords = part.map((p, j): Piece => (j === k ? { kind: 'line', a: p.a, b: p.b } : p));
  const chordArea = ringArea(chords);
  const circle = supportOf(cap, `${id}cap`);
  // A carving cap leaves the rest of its circle outside the chord ring.
  if (Math.sign(cap.dt) === Math.sign(chordArea) || !circle.inRange) {
    return null;
  }
  const made = outlineOf(chords, id);
  const { shape } = circle;
  if (!('shapes' in made) || shape.type !== 'circle') {
    return null;
  }
  const minus: Minus = { id: shape.id, center: shape.center as Pt, r: shape.r as number };
  return {
    shapes: [...made.shapes, shape],
    area: Math.sign(chordArea) * made.area + ringArea(part) - chordArea,
    leaf: { id, poly: polygonOf(chords), minus },
  };
}

/**
 * One outline of a tidied ring: its id and its boundary polygon in the source direction. With
 * `minus`, the outline is the chord ring `poly` and the fill is that less the circle.
 */
export type OutlineLeaf = { id: string; poly: Vec[]; minus?: Minus };

type Outlines = { shapes: ShapeInput[]; outlines: OutlineLeaf[]; checked?: true };

const areaMatches = (area: number, expected: number): boolean =>
  Math.abs(area - expected) <= Math.max(0.02 * Math.abs(expected), 0.05);

/** The rings a tidied ring was cut into as outlines, or the first failing ring's detail. */
function partOutlines(
  parts: readonly Piece[][],
  whole: number,
  id: string,
  untangle: boolean,
): Outlines | { detail: string } {
  let expected = whole;
  const kept: Piece[][] = [];
  for (const part of parts) {
    const a = ringArea(part);
    // A split-off ring no wider than TIDY on average is a retraced line.
    if (Math.abs(a) <= (TIDY * perimeter(part)) / 2) {
      expected -= a;
    } else {
      kept.push(part);
    }
  }
  if (kept.length === 0) {
    return { detail: 'degenerate' };
  }
  const shapes: ShapeInput[] = [];
  const outlines: OutlineLeaf[] = [];
  let area = 0;
  let capped = false;
  for (const [k, part] of kept.entries()) {
    const oid = k === 0 ? id : `${id}${String.fromCharCode(97 + k)}`;
    const made = outlineOf(part, oid);
    let done: Made;
    if ('shapes' in made) {
      done = {
        shapes: made.shapes,
        area: Math.sign(ringArea(part)) * made.area,
        leaf: { id: oid, poly: polygonOf(part) },
      };
    } else {
      const less = untangle && made.detail === 'direction_mismatch' ? lessCap(part, oid) : null;
      if (less === null) {
        return made;
      }
      done = less;
      capped = true;
    }
    area += done.area;
    shapes.push(...done.shapes);
    outlines.push(done.leaf);
  }
  if (!areaMatches(area, expected)) {
    return { detail: 'area mismatch' };
  }
  return capped ? { shapes, outlines, checked: true } : { shapes, outlines };
}

/**
 * A closed ring of lines and circular arcs (y-up) as one or more outlines. A ring that converts
 * as given is kept whole; otherwise lines of at most 0.02 are dropped, neighbouring arcs differing
 * by fit noise are joined while the result still reaches its neighbours, and the ring is cut where
 * it passes a point twice; cut-off rings at most 0.02 wide on average are dropped. Outlines are
 * `<id>`, `<id>b`, `<id>c`, ... Fails as a whole, with the first failing ring's detail or
 * `area mismatch` when the outlines' area departs from the ring's.
 *
 * With `untangle`, a ring that still fails is cut where two of its lines cross (farther than 0.02
 * from their ends), and a ring failing on a carving arc that turns back at both ends becomes its
 * chord ring less the arc's circle (`minus`). `checked` marks a result that did either; the
 * caller compares its fill with the source.
 */
export function outlinesOf(
  ring: readonly Piece[],
  id: string,
  untangle = true,
): Outlines | { detail: string } {
  const whole = ringArea(ring);
  const untouched = outlineOf(ring, id);
  if ('shapes' in untouched && areaMatches(Math.sign(whole) * untouched.area, whole)) {
    return { shapes: untouched.shapes, outlines: [{ id, poly: polygonOf(ring) }] };
  }
  const tidy = joinNearArcs(ring.filter((p) => isArc(p) || dist(p.a, p.b) > TIDY));
  const plain = partOutlines(splitAtRepeats(tidy), whole, id, untangle);
  const crossed = 'shapes' in plain || !untangle ? null : crossLines(tidy);
  if (crossed === null) {
    return plain;
  }
  const cut = partOutlines(splitAtRepeats(crossed), whole, id, true);
  return 'shapes' in cut ? { ...cut, checked: true } : plain;
}
