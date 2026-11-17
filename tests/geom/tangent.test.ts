import { describe, expect, it } from 'vitest';
import { distance, lineThrough, signedDistance } from '../../src/geom/primitives.js';
import type { TangentCandidate, TangentTarget } from '../../src/geom/tangent.js';
import { tangentCandidates } from '../../src/geom/tangent.js';

const circ = (cx: number, cy: number, r: number) => ({ cx, cy, r });
const line = (x1: number, y1: number, x2: number, y2: number) =>
  lineThrough({ x: x1, y: y1 }, { x: x2, y: y2 });

const isCircle = (t: TangentTarget): t is ReturnType<typeof circ> => 'cx' in t;

// Distance from the candidate to a target must equal R + r, |R - r| or r (line).
function expectTangent(item: TangentCandidate, target: TangentTarget, r: number, index: 0 | 1) {
  const contact = item.contacts[index];
  expect(distance(contact.point, item.center)).toBeCloseTo(r, 9);
  if (isCircle(target)) {
    const d = distance(item.center, { x: target.cx, y: target.cy });
    const expected = contact.kind === 'external' ? target.r + r : Math.abs(target.r - r);
    expect(Math.abs(d - expected)).toBeLessThanOrEqual(1e-9);
    expect(
      Math.abs(distance(contact.point, { x: target.cx, y: target.cy }) - target.r),
    ).toBeLessThanOrEqual(1e-9);
  } else {
    expect(contact.kind).toBe('line');
    expect(Math.abs(Math.abs(signedDistance(target, item.center)) - r)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(signedDistance(target, contact.point))).toBeLessThanOrEqual(1e-9);
  }
}

function candidates(a: TangentTarget, b: TangentTarget, r: number): TangentCandidate[] {
  const res = tangentCandidates(a, b, r);
  if (res.kind !== 'candidates') {
    throw new Error('expected candidates');
  }
  for (const item of res.items) {
    expectTangent(item, a, r, 0);
    expectTangent(item, b, r, 1);
  }
  return res.items;
}

// Expected counts come from the offset curves: each circle gives radii R + r and
// |R - r| (dropped when <= EPS); each line gives the two lines at distance r.
describe('circle-circle', () => {
  it.each([
    // apart: offsets {5,3} vs {6,2}, d = 10; only 5 and 6 meet
    ['apart, large r', circ(0, 0, 1), circ(10, 0, 2), 4, 2],
    // apart, small r: offsets {2} vs {3,1}, d = 10; none meet
    ['apart, small r', circ(0, 0, 1), circ(10, 0, 2), 1, 0],
    // crossing: offsets {3,1} vs {3,1}, d = 3; (3,3) (3,1) (1,3) meet in two, (1,1) none
    ['crossing', circ(0, 0, 2), circ(3, 0, 2), 1, 6],
    // contained: offsets {7,3} vs {3,1}, d = 1; only (3,3) meets
    ['contained', circ(0, 0, 5), circ(1, 0, 1), 2, 2],
    // contained with offset circles tangent: {7.5,2.5} vs {3.5,1.5}, d = 1; two tangent pairs
    ['contained, offsets tangent', circ(0, 0, 5), circ(1, 0, 1), 2.5, 2],
    // concentric, offsets differ: {1.5,0.5} vs {3.5,2.5}
    ['concentric, no match', circ(0, 0, 1), circ(0, 0, 3), 0.5, 0],
    // internally tangent targets: d = 1 = R1 - R2; offsets {4,2} vs {3,1}; pairs (4,3) (2,3) (2,1) are tangent, (4,1) apart
    ['internally tangent targets', circ(0, 0, 3), circ(1, 0, 2), 1, 3],
  ])('%s', (_name, a, b, r, count) => {
    expect(candidates(a, b, r)).toHaveLength(count);
  });

  it('single-point offset tangency yields one candidate each', () => {
    const items = candidates(circ(0, 0, 5), circ(1, 0, 1), 2.5);
    const xs = items.map((i) => i.center.x).sort((p, q) => p - q);
    expect(xs[0]).toBeCloseTo(-2.5, 12);
    expect(xs[1]).toBeCloseTo(2.5, 12);
  });

  it('equal radii with r equal to the radius yield no internal candidate', () => {
    const items = candidates(circ(0, 0, 1), circ(3, 0, 1), 1);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.contacts.map((c) => c.kind)).toEqual(['external', 'external']);
    }
  });

  it('internal contact with r larger than the target encloses it', () => {
    const items = candidates(circ(0, 0, 1), circ(10, 0, 1), 20);
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.contacts.some((c) => c.kind === 'internal'))).toBe(true);
  });

  it('concentric targets with matching offsets are infinite', () => {
    // offsets {2,0 dropped} vs {4,2}: the radius-2 offsets coincide
    expect(tangentCandidates(circ(0, 0, 1), circ(0, 0, 3), 1).kind).toBe('infinite');
    expect(tangentCandidates(circ(0, 0, 1), circ(0, 0, 3), 2).kind).toBe('infinite');
  });

  it('identical targets are infinite', () => {
    expect(tangentCandidates(circ(0, 0, 1), circ(0, 0, 1), 0.5).kind).toBe('infinite');
  });
});

describe('circle-line', () => {
  it.each([
    // apart: circle offsets {2}, lines y = 9, 11; none meet
    ['apart, small r', circ(0, 0, 1), line(0, 10, 1, 10), 1, 0],
    // apart, large r: offsets {6,4}, lines y = 5, 15; only 6 meets y = 5, in two points
    ['apart, large r', circ(0, 0, 1), line(0, 10, 1, 10), 5, 2],
    // crossing through the centre: offsets {3,1}, lines y = +-1; each line gets two + one tangent
    ['crossing', circ(0, 0, 2), line(-1, 0, 1, 0), 1, 6],
    // away from a larger circle: offsets {4}, lines y = 3, 7; only y = 3 meets
    ['one side only', circ(0, 0, 2), line(0, 5, 1, 5), 2, 2],
    // tangent target: line y = 2 tangent to R = 2; offsets {3,1} vs y = 1, 3
    ['tangent target', circ(0, 0, 2), line(0, 2, 1, 2), 1, 4],
  ])('%s', (_name, a, b, r, count) => {
    expect(candidates(a, b, r)).toHaveLength(count);
    expect(candidates(b, a, r)).toHaveLength(count);
  });

  it('contacts report the line side', () => {
    const items = candidates(circ(0, 0, 2), line(0, 5, 1, 5), 2);
    for (const item of items) {
      expect(item.contacts[0].kind).toBe('external');
      expect(item.contacts[1].kind).toBe('line');
    }
  });
});

describe('line-line', () => {
  it('crossing perpendicular lines give four candidates', () => {
    expect(candidates(line(-1, 0, 1, 0), line(0, -1, 0, 1), 1)).toHaveLength(4);
  });

  it('crossing oblique lines give four candidates', () => {
    expect(candidates(line(0, 0, 1, 0), line(0, 0, 1, 2), 0.7)).toHaveLength(4);
  });

  it('parallel lines further than 2r apart give none', () => {
    expect(candidates(line(0, 0, 1, 0), line(0, 4, 1, 4), 1)).toHaveLength(0);
    expect(candidates(line(0, 0, 1, 0), line(0, 4, -1, 4), 1)).toHaveLength(0);
  });

  it('parallel lines exactly 2r apart are infinite', () => {
    expect(tangentCandidates(line(0, 0, 1, 0), line(0, 2, 1, 2), 1).kind).toBe('infinite');
    expect(tangentCandidates(line(0, 0, 1, 0), line(0, 4, -1, 4), 2).kind).toBe('infinite');
  });

  it('the same line twice is infinite', () => {
    expect(tangentCandidates(line(0, 0, 1, 0), line(3, 0, 4, 0), 1).kind).toBe('infinite');
  });
});
