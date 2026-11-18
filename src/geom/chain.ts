// Closed outlines chained from arcs of declared circles and stretches of declared lines.
// Pieces run counter-clockwise (the inside is on the left); joint k joins piece k to piece k + 1.
// Building checks the joints, then the pieces, then simplicity and orientation, and throws the
// first failure as a `ChainError`.

import { intersectCircleCircle, intersectCircleLine, intersectLineLine } from './intersect.js';
import type { Circle, Line, Vec } from './primitives.js';
import {
  add,
  centerOf,
  cross,
  distance,
  dot,
  EPS,
  leftNormal,
  length,
  projectOnLine,
  SNAP,
  scale,
  signedDistance,
  sub,
} from './primitives.js';

/** One piece; `from` is the angle of `start` in (-pi, pi], `sweep` in (0, 2pi) radians. */
export type ChainPiece =
  | { kind: 'arc'; circle: Circle; start: Vec; end: Vec; ccw: boolean; from: number; sweep: number }
  | { kind: 'line'; line: Line; start: Vec; end: Vec };
/** Joint between piece k and piece k + 1; `turn` in degrees, left positive, in (-180, 180]. */
export type ChainJoint = { at: Vec; kind: 'tangent' | 'corner'; turn: number };
export type Chain = { pieces: ChainPiece[]; joints: ChainJoint[]; area: number };

export type ChainSupport = { kind: 'circle'; circle: Circle } | { kind: 'line'; line: Line };
/** A piece to build: its support, whether an arc runs clockwise, and the hint for its exit joint. */
export type ChainInput = { support: ChainSupport; concave: boolean; corner?: Vec };

export type ChainErrorCode =
  | 'same_curve'
  | 'no_contact'
  | 'corner_required'
  | 'corner_not_needed'
  | 'corner_tie'
  | 'zero_length'
  | 'direction_mismatch'
  | 'self_intersection'
  | 'clockwise';

/** Relation of two supports: circles apart or nested, circle and line, parallel lines. */
export type ChainContact = 'external' | 'internal' | 'line' | 'parallel';

/**
 * A chain that cannot be built.
 *
 * - `pieces`: input indices involved (the two pieces of a joint, one piece, or a pair).
 * - `points`: candidate intersections, the degenerate piece's point, the tangent or contact point.
 * - `amount`: the gap for `no_contact` (null for parallel lines), the signed area for `clockwise`.
 * - `contact`: the supports' relation for `no_contact` and `direction_mismatch`.
 */
export class ChainError extends Error {
  readonly code: ChainErrorCode;
  readonly pieces: readonly number[];
  readonly points: readonly Vec[];
  readonly amount: number | null;
  readonly contact: ChainContact | null;

  constructor(
    code: ChainErrorCode,
    detail: { pieces: number[]; points?: Vec[]; amount?: number | null; contact?: ChainContact },
  ) {
    super(`chain: ${code} at pieces ${detail.pieces.join(', ')}`);
    this.name = 'ChainError';
    this.code = code;
    this.pieces = detail.pieces;
    this.points = detail.points ?? [];
    this.amount = detail.amount ?? null;
    this.contact = detail.contact ?? null;
  }
}

// Two candidate joints closer than this to the corner hint are a tie.
const TIE = 1e-6;
// Pieces whose entry and exit are this close are rejected.
const MIN_LENGTH = 1e-6;

const TWO_PI = 2 * Math.PI;

type Meeting =
  | { kind: 'same' }
  | { kind: 'none'; amount: number | null; contact: ChainContact }
  | { kind: 'tangent'; point: Vec; contact: ChainContact }
  | { kind: 'two'; points: [Vec, Vec] }
  | { kind: 'point'; point: Vec };

/** Build a chain from pieces listed counter-clockwise. */
export function buildChain(input: readonly ChainInput[]): Chain {
  const n = input.length;
  const at: Vec[] = [];
  const kinds: ChainJoint['kind'][] = [];
  const contacts: (ChainContact | undefined)[] = [];
  for (let k = 0; k < n; k++) {
    const a = item(input, k);
    const b = item(input, k + 1);
    const pair = [k, (k + 1) % n];
    const m = meet(a.support, b.support);
    switch (m.kind) {
      case 'same':
        throw new ChainError('same_curve', { pieces: pair });
      case 'none':
        throw new ChainError('no_contact', { pieces: pair, amount: m.amount, contact: m.contact });
      case 'two': {
        if (a.corner === undefined) {
          throw new ChainError('corner_required', { pieces: pair, points: m.points });
        }
        const [p, q] = m.points;
        const dp = distance(p, a.corner);
        const dq = distance(q, a.corner);
        if (Math.abs(dp - dq) <= TIE) {
          throw new ChainError('corner_tie', { pieces: pair, points: m.points });
        }
        at.push(dp < dq ? p : q);
        kinds.push('corner');
        contacts.push(undefined);
        break;
      }
      case 'tangent':
      case 'point':
        if (a.corner !== undefined) {
          throw new ChainError('corner_not_needed', { pieces: pair, points: [m.point] });
        }
        at.push(m.point);
        kinds.push(m.kind === 'tangent' ? 'tangent' : 'corner');
        contacts.push(m.kind === 'tangent' ? m.contact : undefined);
        break;
    }
  }

  const pieces: ChainPiece[] = [];
  for (let k = 0; k < n; k++) {
    const start = item(at, k - 1);
    const end = item(at, k);
    if (distance(start, end) <= MIN_LENGTH) {
      throw new ChainError('zero_length', { pieces: [k], points: [start] });
    }
    const { support, concave } = item(input, k);
    pieces.push(
      support.kind === 'line'
        ? { kind: 'line', line: support.line, start, end }
        : arcPiece(support.circle, start, end, !concave),
    );
  }

  const joints = jointsOf(pieces, kinds);
  for (let k = 0; k < n; k++) {
    const joint = item(joints, k);
    if (joint.kind === 'tangent') {
      const tin = travel(item(pieces, k), joint.at);
      const tout = travel(item(pieces, k + 1), joint.at);
      if (dot(tin, tout) <= 0) {
        throw new ChainError('direction_mismatch', {
          pieces: [k, (k + 1) % n],
          points: [joint.at],
          contact: item(contacts, k),
        });
      }
    }
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const hit = contactBetween(pieces, i, j);
      if (hit !== null) {
        throw new ChainError('self_intersection', { pieces: [i, j], points: [hit] });
      }
    }
  }

  const area = areaOf(pieces);
  if (area <= 0) {
    throw new ChainError('clockwise', { pieces: [], amount: area });
  }
  return { pieces, joints, area };
}

/**
 * Move a chain by a point map. A mirroring map reverses the piece order and each piece's travel,
 * so the result runs counter-clockwise with the same turns.
 */
export function transformChain(chain: Chain, map: (v: Vec) => Vec, mirrored: boolean): Chain {
  const n = chain.pieces.length;
  const moved = chain.pieces.map((p) => movePiece(p, map));
  const pieces = mirrored ? moved.reverse().map(reversePiece) : moved;
  // Under a mirror, new joint i sits where old joint n - 2 - i was.
  const kinds = chain.joints.map((j, i) =>
    mirrored ? item(chain.joints, n - 2 - i).kind : j.kind,
  );
  return { pieces, joints: jointsOf(pieces, kinds), area: areaOf(pieces) };
}

/** Same pieces up to a cyclic shift: supports, ends and arc direction agree within SNAP. */
export function sameChain(a: Chain, b: Chain): boolean {
  const n = a.pieces.length;
  if (n !== b.pieces.length) {
    return false;
  }
  for (let s = 0; s < n; s++) {
    if (a.pieces.every((p, i) => samePiece(p, item(b.pieces, i + s)))) {
      return true;
    }
  }
  return false;
}

function item<T>(xs: readonly T[], i: number): T {
  const n = xs.length;
  return xs[((i % n) + n) % n] as T;
}

function angleOf(c: Circle, p: Vec): number {
  const a = Math.atan2(p.y - c.cy, p.x - c.cx);
  return a === -Math.PI ? Math.PI : a;
}

/** Angle reduced to [0, 2pi). */
function wrap(a: number): number {
  const r = a % TWO_PI;
  return r < 0 ? r + TWO_PI : r;
}

function unit(v: Vec): Vec {
  return scale(v, 1 / length(v));
}

function meet(a: ChainSupport, b: ChainSupport): Meeting {
  if (a.kind === 'circle') {
    return b.kind === 'circle' ? meetCircles(a.circle, b.circle) : meetCircleLine(a.circle, b.line);
  }
  return b.kind === 'circle' ? meetCircleLine(b.circle, a.line) : meetLines(a.line, b.line);
}

function meetCircles(a: Circle, b: Circle): Meeting {
  const res = intersectCircleCircle(a, b);
  const d = distance(centerOf(a), centerOf(b));
  const sum = a.r + b.r;
  switch (res.kind) {
    case 'coincident':
      return { kind: 'same' };
    case 'two':
      return res;
    case 'tangent':
      return {
        kind: 'tangent',
        point: res.point,
        contact: Math.abs(d - sum) <= EPS ? 'external' : 'internal',
      };
    case 'none':
      return d > sum
        ? { kind: 'none', amount: d - sum, contact: 'external' }
        : { kind: 'none', amount: Math.abs(a.r - b.r) - d, contact: 'internal' };
  }
}

function meetLines(a: Line, b: Line): Meeting {
  const res = intersectLineLine(a, b);
  if (res.kind === 'coincident') {
    return { kind: 'same' };
  }
  return res.kind === 'none'
    ? { kind: 'none', amount: null, contact: 'parallel' }
    : { kind: 'point', point: res.point };
}

function meetCircleLine(circle: Circle, line: Line): Meeting {
  const res = intersectCircleLine(circle, line);
  switch (res.kind) {
    case 'two':
      return res;
    case 'tangent':
      return { kind: 'tangent', point: res.point, contact: 'line' };
    case 'none':
      return {
        kind: 'none',
        amount: Math.abs(signedDistance(line, centerOf(circle))) - circle.r,
        contact: 'line',
      };
  }
}

function arcPiece(circle: Circle, start: Vec, end: Vec, ccw: boolean): ChainPiece {
  const from = angleOf(circle, start);
  const to = angleOf(circle, end);
  return { kind: 'arc', circle, start, end, ccw, from, sweep: wrap(ccw ? to - from : from - to) };
}

/** Unit travel direction of a piece at a point on it. */
function travel(piece: ChainPiece, p: Vec): Vec {
  if (piece.kind === 'line') {
    return unit(sub(piece.end, piece.start));
  }
  const t = leftNormal(unit(sub(p, centerOf(piece.circle))));
  return piece.ccw ? t : scale(t, -1);
}

/** Joints of consecutive pieces with the given kinds; turns follow from the travel directions. */
export function jointsOf(
  pieces: readonly ChainPiece[],
  kinds: readonly ChainJoint['kind'][],
): ChainJoint[] {
  return pieces.map((piece, k) => {
    const tin = travel(piece, piece.end);
    const tout = travel(item(pieces, k + 1), piece.end);
    const turn = (Math.atan2(cross(tin, tout), dot(tin, tout)) * 180) / Math.PI;
    return { at: piece.end, kind: item(kinds, k), turn: turn === -180 ? 180 : turn };
  });
}

/** Shoelace over the joints plus the signed circular segment of every arc. */
export function areaOf(pieces: readonly ChainPiece[]): number {
  let chords = 0;
  let segments = 0;
  for (const p of pieces) {
    chords += cross(p.start, p.end) / 2;
    if (p.kind === 'arc') {
      const sweep = p.ccw ? p.sweep : -p.sweep;
      segments += (p.circle.r * p.circle.r * (sweep - Math.sin(sweep))) / 2;
    }
  }
  return chords + segments;
}

/** Whether a point on a piece's support lies within the piece's range, ends included. */
function inRange(piece: ChainPiece, p: Vec): boolean {
  if (piece.kind === 'line') {
    const v = sub(piece.end, piece.start);
    const t = dot(sub(p, piece.start), v);
    return t >= 0 && t <= dot(v, v);
  }
  const a = angleOf(piece.circle, p);
  return wrap(piece.ccw ? a - piece.from : piece.from - a) <= piece.sweep;
}

/** Closest point of a piece to a point. */
function closestOn(piece: ChainPiece, p: Vec): Vec {
  if (piece.kind === 'line') {
    const v = sub(piece.end, piece.start);
    const t = Math.min(1, Math.max(0, dot(sub(p, piece.start), v) / dot(v, v)));
    return add(piece.start, scale(v, t));
  }
  const c = centerOf(piece.circle);
  const r = sub(p, c);
  if (length(r) > 0) {
    const q = add(c, scale(r, piece.circle.r / length(r)));
    if (inRange(piece, q)) {
      return q;
    }
  }
  return distance(p, piece.start) <= distance(p, piece.end) ? piece.start : piece.end;
}

/** Pairs of points, one per piece, where the distance between the two pieces can be smallest. */
function approaches(a: ChainPiece, b: ChainPiece): [Vec, Vec][] {
  const out: [Vec, Vec][] = [];
  for (const p of [a.start, a.end]) {
    out.push([p, closestOn(b, p)]);
  }
  for (const q of [b.start, b.end]) {
    out.push([closestOn(a, q), q]);
  }
  const both = (p: Vec, q: Vec): void => {
    if (inRange(a, p) && inRange(b, q)) {
      out.push([p, q]);
    }
  };
  const m = meet(supportOf(a), supportOf(b));
  if (m.kind === 'two') {
    both(m.points[0], m.points[0]);
    both(m.points[1], m.points[1]);
  } else if (m.kind === 'tangent' || m.kind === 'point') {
    both(m.point, m.point);
  }
  if (a.kind === 'arc' && b.kind === 'arc') {
    const ca = centerOf(a.circle);
    const cb = centerOf(b.circle);
    if (distance(ca, cb) > EPS) {
      // Interior closest points of two circles lie on the line of centres.
      const u = unit(sub(cb, ca));
      for (const sa of [1, -1]) {
        for (const sb of [1, -1]) {
          both(add(ca, scale(u, sa * a.circle.r)), add(cb, scale(u, sb * b.circle.r)));
        }
      }
    }
  } else if (a.kind === 'arc' || b.kind === 'arc') {
    const arc = a.kind === 'arc' ? a : b;
    const seg = a.kind === 'line' ? a : b;
    if (arc.kind === 'arc' && seg.kind === 'line') {
      const c = centerOf(arc.circle);
      const foot = projectOnLine(seg.line, c);
      const v = sub(foot, c);
      if (length(v) > EPS) {
        for (const s of [1, -1]) {
          const onArc = add(c, scale(v, (s * arc.circle.r) / length(v)));
          if (arc === a) {
            both(onArc, foot);
          } else {
            both(foot, onArc);
          }
        }
      }
    }
  }
  return out;
}

function supportOf(piece: ChainPiece): ChainSupport {
  return piece.kind === 'arc'
    ? { kind: 'circle', circle: piece.circle }
    : { kind: 'line', line: piece.line };
}

/** A point where pieces i < j come within SNAP, other than the joints they share. */
function contactBetween(pieces: readonly ChainPiece[], i: number, j: number): Vec | null {
  const n = pieces.length;
  const a = item(pieces, i);
  const b = item(pieces, j);
  const shared: Vec[] = [];
  if (j === i + 1) {
    shared.push(a.end);
  }
  if (i === 0 && j === n - 1) {
    shared.push(b.end);
  }
  const nearShared = (p: Vec): boolean => shared.some((s) => distance(p, s) <= SNAP);
  let best: Vec | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [p, q] of approaches(a, b)) {
    const d = distance(p, q);
    if (d <= SNAP && d < bestDistance && !nearShared(p) && !nearShared(q)) {
      best = p;
      bestDistance = d;
    }
  }
  return best;
}

function movePiece(piece: ChainPiece, map: (v: Vec) => Vec): ChainPiece {
  const start = map(piece.start);
  const end = map(piece.end);
  if (piece.kind === 'line') {
    const p = map(piece.line.p);
    const d = unit(sub(map(add(piece.line.p, piece.line.d)), p));
    return { kind: 'line', line: { p, d }, start, end };
  }
  const c = map(centerOf(piece.circle));
  const circle = { cx: c.x, cy: c.y, r: piece.circle.r };
  return { ...piece, circle, start, end, from: angleOf(circle, start) };
}

function reversePiece(piece: ChainPiece): ChainPiece {
  if (piece.kind === 'line') {
    return { ...piece, start: piece.end, end: piece.start };
  }
  return { ...piece, start: piece.end, end: piece.start, from: angleOf(piece.circle, piece.end) };
}

function samePiece(p: ChainPiece, q: ChainPiece): boolean {
  if (distance(p.start, q.start) > SNAP || distance(p.end, q.end) > SNAP) {
    return false;
  }
  if (p.kind === 'arc' && q.kind === 'arc') {
    return p.ccw === q.ccw && intersectCircleCircle(p.circle, q.circle).kind === 'coincident';
  }
  if (p.kind === 'line' && q.kind === 'line') {
    return intersectLineLine(p.line, q.line).kind === 'coincident';
  }
  return false;
}
