import { intersectCircleCircle, intersectCircleLine, intersectLineLine } from './intersect.js';
import type { Circle, Line, Vec } from './primitives.js';
import {
  add,
  centerOf,
  distance,
  EPS,
  leftNormal,
  projectOnLine,
  scale,
  sub,
} from './primitives.js';

export type TangentTarget = Circle | Line;
export type ContactKind = 'external' | 'internal' | 'line';
export type Contact = { kind: ContactKind; point: Vec };
export type TangentCandidate = { center: Vec; contacts: [Contact, Contact] };
export type TangentResult =
  | { kind: 'infinite' }
  | { kind: 'candidates'; items: TangentCandidate[] };

type Offset = { kind: ContactKind; curve: Circle | Line };

const isCircle = (t: TangentTarget): t is Circle => 'cx' in t;

// Candidates closer than this are one candidate.
const MERGE = 1e-7;

// Curves the centre of a radius-r tangent circle can lie on.
function offsets(target: TangentTarget, r: number): Offset[] {
  if (!isCircle(target)) {
    const n = scale(leftNormal(target.d), r);
    return [
      { kind: 'line', curve: { p: add(target.p, n), d: target.d } },
      { kind: 'line', curve: { p: sub(target.p, n), d: target.d } },
    ];
  }
  const out: Offset[] = [
    { kind: 'external', curve: { cx: target.cx, cy: target.cy, r: target.r + r } },
  ];
  const inner = Math.abs(target.r - r);
  if (inner > EPS) {
    out.push({ kind: 'internal', curve: { cx: target.cx, cy: target.cy, r: inner } });
  }
  return out;
}

type CurvePoints = { kind: 'none' } | { kind: 'coincident' } | { kind: 'points'; points: Vec[] };

function intersectCurves(a: Circle | Line, b: Circle | Line): CurvePoints {
  if (isCircle(a) && isCircle(b)) {
    const res = intersectCircleCircle(a, b);
    if (res.kind === 'tangent') {
      return { kind: 'points', points: [res.point] };
    }
    return res.kind === 'two' ? { kind: 'points', points: res.points } : res;
  }
  if (!isCircle(a) && !isCircle(b)) {
    const res = intersectLineLine(a, b);
    return res.kind === 'point' ? { kind: 'points', points: [res.point] } : res;
  }
  const circle = (isCircle(a) ? a : b) as Circle;
  const line = (isCircle(a) ? b : a) as Line;
  const res = intersectCircleLine(circle, line);
  if (res.kind === 'tangent') {
    return { kind: 'points', points: [res.point] };
  }
  return res.kind === 'two' ? { kind: 'points', points: res.points } : res;
}

// Contact point of the candidate circle with one target.
function contactOf(target: TangentTarget, offset: Offset, center: Vec, r: number): Contact {
  if (!isCircle(target)) {
    return { kind: 'line', point: projectOnLine(target, center) };
  }
  const tc = centerOf(target);
  const d = distance(center, tc);
  const u = scale(sub(center, tc), 1 / d);
  // The candidate encloses the target only for an internal contact with r > R.
  const side = offset.kind === 'internal' && r > target.r ? -1 : 1;
  return { kind: offset.kind, point: add(tc, scale(u, side * target.r)) };
}

/** All circles of radius r tangent to both targets, with contact kinds and points. */
export function tangentCandidates(a: TangentTarget, b: TangentTarget, r: number): TangentResult {
  const items: TangentCandidate[] = [];
  for (const oa of offsets(a, r)) {
    for (const ob of offsets(b, r)) {
      const res = intersectCurves(oa.curve, ob.curve);
      if (res.kind === 'coincident') {
        return { kind: 'infinite' };
      }
      if (res.kind === 'none') {
        continue;
      }
      for (const center of res.points) {
        if (items.some((it) => distance(it.center, center) < MERGE)) {
          continue;
        }
        items.push({
          center,
          contacts: [contactOf(a, oa, center, r), contactOf(b, ob, center, r)],
        });
      }
    }
  }
  return { kind: 'candidates', items };
}
