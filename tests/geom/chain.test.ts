import { describe, expect, it } from 'vitest';
import { arrange } from '../../src/geom/arrangement.js';
import type { Chain, ChainInput, ChainSupport } from '../../src/geom/chain.js';
import {
  buildChain,
  ChainError,
  sameChain,
  transformChain,
  transformPieces,
} from '../../src/geom/chain.js';
import type { Circle, Vec } from '../../src/geom/primitives.js';
import {
  centerOf,
  distance,
  lineThrough,
  mirrorAcross,
  rotateAbout,
} from '../../src/geom/primitives.js';
import type { RegionNode } from '../../src/geom/region.js';
import { ovalArc } from '../../src/geom/shapes.js';

const circle = (cx: number, cy: number, r: number): ChainSupport => ({
  kind: 'circle',
  circle: { cx, cy, r },
});
const line = (a: Vec, b: Vec): ChainSupport => ({ kind: 'line', line: lineThrough(a, b) });
const piece = (
  support: ChainSupport,
  opts: { concave?: boolean; corner?: Vec } = {},
): ChainInput =>
  opts.corner === undefined
    ? { support, concave: opts.concave ?? false }
    : { support, concave: opts.concave ?? false, corner: opts.corner };
const disc = (c: Circle): RegionNode => ({ kind: 'disc', circle: c, source: { id: 'd', copy: 0 } });

const A5 = circle(-3, 0, 5);
const B5 = circle(3, 0, 5);
const lensInput = [piece(B5, { corner: { x: 0, y: -5 } }), piece(A5, { corner: { x: 0, y: 5 } })];
const unionInput = [piece(A5, { corner: { x: 0, y: -5 } }), piece(B5, { corner: { x: 0, y: 5 } })];
// Radius 2, centres 5 apart, closed by the two common tangents.
const stadiumInput = [
  piece(line({ x: 0, y: -2 }, { x: 1, y: -2 })),
  piece(circle(2.5, 0, 2)),
  piece(line({ x: 0, y: 2 }, { x: 1, y: 2 })),
  piece(circle(-2.5, 0, 2)),
];
// Two radius-2 lobes joined by two radius-3 fillets, every contact external.
const filletInput = [
  piece(circle(-3, 0, 2)),
  piece(circle(0, -4, 3), { concave: true }),
  piece(circle(3, 0, 2)),
  piece(circle(0, 4, 3), { concave: true }),
];
// Right triangle (0, 0), (6, 0), (0, 3) from three lines.
const triangleInput = [
  piece(line({ x: 0, y: 0 }, { x: 1, y: 0 })),
  piece(line({ x: 6, y: 0 }, { x: 0, y: 3 })),
  piece(line({ x: 0, y: 3 }, { x: 0, y: 0 })),
];

const lensTheta = 2 * Math.atan2(4, 3);
const lensArea = 25 * (lensTheta - Math.sin(lensTheta));
const filletTheta = 2 * Math.atan(4 / 3);
const filletArea = 24 - 9 * (Math.PI - filletTheta) + 4 * (2 * Math.PI - filletTheta);
const degrees = (rad: number): number => (rad * 180) / Math.PI;

const expectRelative = (actual: number, expected: number, rel: number): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(rel * Math.abs(expected));
};

const failure = (input: ChainInput[]): ChainError => {
  try {
    buildChain(input);
  } catch (e) {
    if (e instanceof ChainError) {
      return e;
    }
    throw e;
  }
  throw new Error('expected a ChainError');
};

describe('buildChain: closed forms', () => {
  it('a lens of two corners has the area of the intersection of its circles', () => {
    const chain = buildChain(lensInput);
    const inter = arrange({
      kind: 'intersect',
      children: [disc({ cx: -3, cy: 0, r: 5 }), disc({ cx: 3, cy: 0, r: 5 })],
    });
    expectRelative(chain.area, inter.area, 1e-9);
    expectRelative(chain.area, lensArea, 1e-9);
  });

  it('the outer arcs of the same circles have the area of their union', () => {
    const chain = buildChain(unionInput);
    const uni = arrange({
      kind: 'union',
      children: [disc({ cx: -3, cy: 0, r: 5 }), disc({ cx: 3, cy: 0, r: 5 })],
    });
    expectRelative(chain.area, uni.area, 1e-9);
    expectRelative(chain.area, 50 * Math.PI - lensArea, 1e-9);
  });

  it('a stadium of two circles and two common tangents', () => {
    expectRelative(buildChain(stadiumInput).area, 4 * Math.PI + 2 * 2 * 5, 1e-9);
  });

  it('two lobes and two concave fillets', () => {
    expectRelative(buildChain(filletInput).area, filletArea, 1e-9);
    expect(filletArea).toBeCloseTo(30.1314, 4);
  });

  it('three lines', () => {
    expectRelative(buildChain(triangleInput).area, 9, 1e-9);
  });
});

describe('buildChain: pieces and joints', () => {
  it('lens corners turn left by the exterior angle', () => {
    const chain = buildChain(lensInput);
    const turn = degrees(2 * Math.atan2(3, 4));
    expect(chain.joints.map((j) => j.kind)).toEqual(['corner', 'corner']);
    for (const j of chain.joints) {
      expect(j.turn).toBeCloseTo(turn, 9);
    }
    expect(distance(chain.joints[0]?.at ?? { x: 9, y: 9 }, { x: 0, y: -4 })).toBeLessThan(1e-12);
    expect(distance(chain.joints[1]?.at ?? { x: 9, y: 9 }, { x: 0, y: 4 })).toBeLessThan(1e-12);
  });

  it('union corners turn right', () => {
    const chain = buildChain(unionInput);
    for (const j of chain.joints) {
      expect(j.kind).toBe('corner');
      expect(j.turn).toBeCloseTo(-degrees(2 * Math.atan2(3, 4)), 9);
    }
  });

  it('arcs carry their start angle and positive sweep, direction in ccw', () => {
    const chain = buildChain(lensInput);
    const [b, a] = chain.pieces;
    expect(b?.kind === 'arc' && b.ccw).toBe(true);
    expect(a?.kind === 'arc' && a.ccw).toBe(true);
    if (b?.kind === 'arc' && a?.kind === 'arc') {
      expect(b.from).toBeCloseTo(Math.PI - Math.atan2(4, 3), 12);
      expect(b.sweep).toBeCloseTo(lensTheta, 12);
      expect(a.from).toBeCloseTo(-Math.atan2(4, 3), 12);
      expect(a.sweep).toBeCloseTo(lensTheta, 12);
    }
    const fillet = buildChain(filletInput).pieces[1];
    expect(fillet?.kind === 'arc' && !fillet.ccw).toBe(true);
    if (fillet?.kind === 'arc') {
      expect(fillet.sweep).toBeCloseTo(Math.PI - filletTheta, 12);
    }
  });

  it('consecutive pieces share their joint', () => {
    const chain = buildChain(filletInput);
    chain.pieces.forEach((p, k) => {
      const next = chain.pieces[(k + 1) % chain.pieces.length];
      expect(next?.start).toEqual(p.end);
      expect(chain.joints[k]?.at).toEqual(p.end);
    });
  });

  it('tangent joints lie on both circles and do not turn', () => {
    const input = filletInput;
    const chain = buildChain(input);
    chain.joints.forEach((j, k) => {
      expect(j.kind).toBe('tangent');
      expect(Math.abs(j.turn)).toBeLessThan(1e-6);
      for (const s of [input[k]?.support, input[(k + 1) % input.length]?.support]) {
        if (s?.kind !== 'circle') {
          throw new Error('circle expected');
        }
        expect(Math.abs(distance(j.at, centerOf(s.circle)) - s.circle.r)).toBeLessThanOrEqual(1e-9);
      }
    });
  });

  it('circle and line meet at tangent joints; lines at corners', () => {
    expect(buildChain(stadiumInput).joints.map((j) => j.kind)).toEqual([
      'tangent',
      'tangent',
      'tangent',
      'tangent',
    ]);
    const tri = buildChain(triangleInput);
    expect(tri.joints.map((j) => j.kind)).toEqual(['corner', 'corner', 'corner']);
    const turns = [180 - degrees(Math.atan2(3, 6)), 180 - degrees(Math.atan2(6, 3)), 90];
    tri.joints.forEach((j, k) => {
      expect(j.turn).toBeCloseTo(turns[k] ?? 0, 9);
    });
  });

  it('a curve may be used twice when the ranges are apart', () => {
    const big = circle(0, 0, 2);
    const chain = buildChain([
      piece(big, { corner: { x: -1.75, y: 1 } }),
      piece(circle(-2, 0, 1), { concave: true, corner: { x: -1.75, y: -1 } }),
      piece(big, { corner: { x: 1.75, y: -1 } }),
      piece(circle(2, 0, 1), { concave: true, corner: { x: 1.75, y: 1 } }),
    ]);
    expect(chain.pieces).toHaveLength(4);
    expect(chain.area).toBeGreaterThan(0);
  });
});

describe('buildChain: errors', () => {
  it('same_curve for neighbours on one curve, by id or within SNAP', () => {
    const e = failure([piece(A5), piece(A5), piece(B5)]);
    expect(e.code).toBe('same_curve');
    expect(e.pieces).toEqual([0, 1]);
    const near = failure([
      piece(B5, { corner: { x: 0, y: -5 } }),
      piece(A5, { corner: { x: 0, y: 5 } }),
      piece(circle(3, 5e-8, 5)),
    ]);
    expect(near.code).toBe('same_curve');
    expect(near.pieces).toEqual([2, 0]);
  });

  it('no_contact reports the gap and the relation', () => {
    const apart = failure([piece(circle(0, 0, 1)), piece(circle(5, 0, 1))]);
    expect(apart.code).toBe('no_contact');
    expect(apart.pieces).toEqual([0, 1]);
    expect(apart.contact).toBe('external');
    expect(apart.amount).toBeCloseTo(3, 12);
    const nested = failure([piece(circle(0, 0, 5)), piece(circle(1, 0, 1))]);
    expect(nested.contact).toBe('internal');
    expect(nested.amount).toBeCloseTo(3, 12);
    const off = failure([piece(circle(0, 0, 1)), piece(line({ x: 0, y: 3 }, { x: 1, y: 3 }))]);
    expect(off.contact).toBe('line');
    expect(off.amount).toBeCloseTo(2, 12);
    const parallel = failure([
      piece(line({ x: 0, y: 0 }, { x: 1, y: 0 })),
      piece(line({ x: 0, y: 1 }, { x: 1, y: 1 })),
    ]);
    expect(parallel.contact).toBe('parallel');
    expect(parallel.amount).toBeNull();
  });

  it('corner_required lists both crossings', () => {
    const e = failure([piece(B5), piece(A5, { corner: { x: 0, y: 5 } })]);
    expect(e.code).toBe('corner_required');
    expect(e.pieces).toEqual([0, 1]);
    const ys = e.points.map((p) => p.y).sort((u, v) => u - v);
    expect(ys[0]).toBeCloseTo(-4, 12);
    expect(ys[1]).toBeCloseTo(4, 12);
  });

  it('corner_not_needed at a tangent joint and between lines', () => {
    const tangent = failure([
      piece(line({ x: 0, y: -2 }, { x: 1, y: -2 }), { corner: { x: 2.5, y: -2 } }),
      ...stadiumInput.slice(1),
    ]);
    expect(tangent.code).toBe('corner_not_needed');
    expect(tangent.pieces).toEqual([0, 1]);
    const lines = failure([
      triangleInput[0] as ChainInput,
      piece(line({ x: 6, y: 0 }, { x: 0, y: 3 }), { corner: { x: 0, y: 3 } }),
      triangleInput[2] as ChainInput,
    ]);
    expect(lines.code).toBe('corner_not_needed');
    expect(lines.pieces).toEqual([1, 2]);
  });

  it('corner_tie when the hint is equidistant', () => {
    const e = failure([
      piece(B5, { corner: { x: 1, y: 0 } }),
      piece(A5, { corner: { x: 0, y: 5 } }),
    ]);
    expect(e.code).toBe('corner_tie');
    expect(e.pieces).toEqual([0, 1]);
    expect(e.points).toHaveLength(2);
  });

  it('zero_length for two tangent circles and for two lines', () => {
    const circles = failure([piece(circle(-1, 0, 1)), piece(circle(1, 0, 1))]);
    expect(circles.code).toBe('zero_length');
    expect(circles.pieces).toEqual([0]);
    expect(distance(circles.points[0] ?? { x: 9, y: 9 }, { x: 0, y: 0 })).toBeLessThan(1e-12);
    const lines = failure([
      piece(line({ x: 0, y: 0 }, { x: 1, y: 0 })),
      piece(line({ x: 0, y: 0 }, { x: 0, y: 1 })),
    ]);
    expect(lines.code).toBe('zero_length');
  });

  it('direction_mismatch at an external contact and at a line', () => {
    const external = failure([
      piece(circle(-3, 0, 2)),
      piece(circle(0, -4, 3)),
      piece(circle(3, 0, 2)),
      piece(circle(0, 4, 3), { concave: true }),
    ]);
    expect(external.code).toBe('direction_mismatch');
    expect(external.pieces).toEqual([0, 1]);
    expect(external.contact).toBe('external');
    const atLine = failure([
      stadiumInput[0] as ChainInput,
      piece(circle(2.5, 0, 2), { concave: true }),
      ...stadiumInput.slice(2),
    ]);
    expect(atLine.code).toBe('direction_mismatch');
    expect(atLine.pieces).toEqual([0, 1]);
    expect(atLine.contact).toBe('line');
  });

  it('self_intersection where non-adjacent pieces cross or overlap', () => {
    const bowtie = failure([
      piece(line({ x: 0, y: 0 }, { x: 1, y: 1 })),
      piece(line({ x: 4, y: 0 }, { x: 4, y: 1 })),
      piece(line({ x: 4, y: 0 }, { x: 0, y: 4 })),
      piece(line({ x: 0, y: 4 }, { x: 0, y: 0 })),
    ]);
    expect(bowtie.code).toBe('self_intersection');
    expect(bowtie.pieces).toEqual([0, 2]);
    expect(distance(bowtie.points[0] ?? { x: 9, y: 9 }, { x: 2, y: 2 })).toBeLessThan(1e-9);
    const big = circle(0, 0, 2);
    const overlap = failure([
      piece(big, { corner: { x: -1.75, y: 1 } }),
      piece(circle(-2, 0, 1), { concave: true, corner: { x: -1.75, y: -1 } }),
      piece(big, { concave: true, corner: { x: 1.75, y: -1 } }),
      piece(circle(2, 0, 1), { concave: true, corner: { x: 1.75, y: 1 } }),
    ]);
    expect(overlap.code).toBe('self_intersection');
    expect(overlap.pieces).toEqual([0, 2]);
  });

  it('clockwise when the pieces run the other way', () => {
    const e = failure([
      piece(B5, { concave: true, corner: { x: 0, y: -5 } }),
      piece(A5, { concave: true, corner: { x: 0, y: 5 } }),
    ]);
    expect(e.code).toBe('clockwise');
    expectRelative(e.amount ?? 0, -(50 * Math.PI - lensArea), 1e-9);
  });
});

describe('transformChain and sameChain', () => {
  const ORIGIN = { x: 0, y: 0 };

  const expectSameTurns = (a: Chain, b: Chain, index: (i: number) => number): void => {
    b.joints.forEach((j, i) => {
      const o = a.joints[index(i)];
      expect(j.kind).toBe(o?.kind);
      expect(j.turn).toBeCloseTo(o?.turn ?? Number.NaN, 9);
    });
  };

  it('a rotation keeps order, orientation, turns and area', () => {
    const chain = buildChain(filletInput);
    const turned = transformChain(chain, (v) => rotateAbout(v, { x: 1, y: 2 }, 37), false);
    expectRelative(turned.area, chain.area, 1e-9);
    expect(turned.pieces.map((p) => p.kind === 'arc' && p.ccw)).toEqual(
      chain.pieces.map((p) => p.kind === 'arc' && p.ccw),
    );
    expectSameTurns(chain, turned, (i) => i);
    turned.pieces.forEach((p, k) => {
      if (p.kind === 'arc') {
        const a = Math.atan2(p.start.y - p.circle.cy, p.start.x - p.circle.cx);
        expect(p.from).toBeCloseTo(a, 12);
        const o = chain.pieces[k];
        if (o?.kind === 'arc') {
          expect(p.sweep).toBeCloseTo(o.sweep, 12);
        }
      }
    });
  });

  it('a mirror reverses the pieces and stays counter-clockwise with the same turns', () => {
    const tri = buildChain(triangleInput);
    const n = tri.pieces.length;
    const mirrored = transformChain(tri, (v) => mirrorAcross(v, { x: 1, y: 0 }, 90), true);
    expectRelative(mirrored.area, 9, 1e-9);
    expectSameTurns(tri, mirrored, (i) => (((n - 2 - i) % n) + n) % n);
    mirrored.joints.forEach((j, i) => {
      const o = tri.joints[(((n - 2 - i) % n) + n) % n];
      expect(distance(j.at, mirrorAcross(o?.at ?? ORIGIN, { x: 1, y: 0 }, 90))).toBeLessThan(1e-12);
    });

    const fillet = buildChain(filletInput);
    const flipped = transformChain(fillet, (v) => mirrorAcross(v, { x: 1, y: 0 }, 90), true);
    expectRelative(flipped.area, fillet.area, 1e-9);
    expect(flipped.pieces.map((p) => p.kind === 'arc' && p.ccw)).toEqual(
      fillet.pieces.map((p) => p.kind === 'arc' && p.ccw).reverse(),
    );
    expectSameTurns(fillet, flipped, (i) => (((4 - 2 - i) % 4) + 4) % 4);
    flipped.pieces.forEach((p, k) => {
      const next = flipped.pieces[(k + 1) % flipped.pieces.length];
      expect(distance(p.end, next?.start ?? ORIGIN)).toBeLessThan(1e-12);
    });
  });

  it('symmetric copies are the same chain', () => {
    const fillet = buildChain(filletInput);
    expect(
      sameChain(
        transformChain(fillet, (v) => rotateAbout(v, ORIGIN, 180), false),
        fillet,
      ),
    ).toBe(true);
    const lens = buildChain(lensInput);
    expect(
      sameChain(
        transformChain(lens, (v) => mirrorAcross(v, ORIGIN, 0), true),
        lens,
      ),
    ).toBe(true);
    expect(
      sameChain(
        transformChain(lens, (v) => mirrorAcross(v, ORIGIN, 90), true),
        lens,
      ),
    ).toBe(true);
  });

  it('compares pieces up to a cyclic shift and within SNAP', () => {
    const lens = buildChain(lensInput);
    const shifted = buildChain([lensInput[1] as ChainInput, lensInput[0] as ChainInput]);
    expect(sameChain(lens, shifted)).toBe(true);
    expect(sameChain(lens, buildChain(unionInput))).toBe(false);
    const nudge = (d: number): Chain =>
      transformChain(lens, (v) => ({ x: v.x + d, y: v.y }), false);
    expect(sameChain(lens, nudge(5e-8))).toBe(true);
    expect(sameChain(lens, nudge(1e-6))).toBe(false);
    expect(sameChain(lens, buildChain(filletInput))).toBe(false);
  });
});

describe('arc on an oval', () => {
  const ORIGIN = { x: 0, y: 0 };
  const center = { x: 1, y: 0 };
  // Upper half of a 3 by 2 oval about (1, 0): half an end arc, thirteen whole arcs, half an end arc.
  const upper = ovalArc(center, 3, 2, 0, 0, Math.PI);

  it('a mirror reverses the order and travel of open pieces, so the ends stay joined', () => {
    // The oval is symmetric about x = 1, so the mirrored upper half is the upper half again.
    const across = transformPieces(upper, (p) => mirrorAcross(p, center, 90), true);
    expect(across).toHaveLength(15);
    across.forEach((p, i) => {
      const o = upper[i];
      expect(distance(p.start, o?.start ?? ORIGIN)).toBeLessThan(1e-12);
      expect(distance(p.end, o?.end ?? ORIGIN)).toBeLessThan(1e-12);
      if (p.kind === 'arc' && o?.kind === 'arc') {
        expect(p.ccw).toBe(true);
        expect(p.circle.r).toBeCloseTo(o.circle.r, 12);
        expect(p.sweep).toBeCloseTo(o.sweep, 12);
      }
    });
    // Mirroring in the x axis turns the upper half into the lower half, run from (-2, 0) to (4, 0).
    const lower = transformPieces(upper, (p) => mirrorAcross(p, ORIGIN, 0), true);
    expect(distance(lower[0]?.start ?? center, { x: -2, y: 0 })).toBeLessThan(1e-12);
    expect(distance(lower[lower.length - 1]?.end ?? center, { x: 4, y: 0 })).toBeLessThan(1e-12);
    lower.forEach((p, i) => {
      expect(p.start.y).toBeLessThanOrEqual(1e-12);
      const next = lower[i + 1];
      if (next !== undefined) {
        expect(distance(p.end, next.start)).toBeLessThan(1e-12);
      }
    });
  });

  it('a direct move keeps the order and shifts every piece', () => {
    const turned = transformPieces(upper, (p) => rotateAbout(p, center, 90), false);
    expect(distance(turned[0]?.start ?? ORIGIN, { x: 1, y: 3 })).toBeLessThan(1e-12);
    expect(distance(turned[turned.length - 1]?.end ?? ORIGIN, { x: 1, y: -3 })).toBeLessThan(1e-12);
  });
});
