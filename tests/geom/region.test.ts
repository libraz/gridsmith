import { describe, expect, it } from 'vitest';
import type { ChainInput, ChainSupport } from '../../src/geom/chain.js';
import { buildChain } from '../../src/geom/chain.js';
import type { Vec } from '../../src/geom/primitives.js';
import { lineThrough, pointOnCircle } from '../../src/geom/primitives.js';
import type { RegionNode } from '../../src/geom/region.js';
import {
  boundsOfBoundedLeaves,
  contains,
  isBounded,
  windingNumber,
} from '../../src/geom/region.js';

const src = { id: 'a', copy: 0 };
const disc = (cx: number, cy: number, r: number): RegionNode => ({
  kind: 'disc',
  circle: { cx, cy, r },
  source: src,
});
// Inside is the left of the x axis direction, i.e. y > 0, for sign 1.
const half = (sign: 1 | -1): RegionNode => ({
  kind: 'half',
  line: lineThrough({ x: 0, y: 0 }, { x: 1, y: 0 }),
  sign,
  source: src,
});
const poly = (...loops: Vec[][]): RegionNode => ({ kind: 'poly', loops, source: src });
const square: Vec[] = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 2, y: 2 },
  { x: 0, y: 2 },
];

const triangle = (startDeg: number, ccw: boolean): Vec[] => {
  const pts = [0, 120, 240].map((k) =>
    pointOnCircle({ cx: 0, cy: 0, r: 1 }, startDeg + (ccw ? k : -k)),
  );
  return pts;
};

describe('contains', () => {
  it('disc', () => {
    expect(contains(disc(1, 1, 2), { x: 2, y: 2 })).toBe(true);
    expect(contains(disc(1, 1, 2), { x: 3.5, y: 1 })).toBe(false);
  });

  it('half uses sign', () => {
    expect(contains(half(1), { x: 5, y: 1 })).toBe(true);
    expect(contains(half(1), { x: 5, y: -1 })).toBe(false);
    expect(contains(half(-1), { x: 5, y: -1 })).toBe(true);
    expect(contains(half(-1), { x: 5, y: 1 })).toBe(false);
  });

  it('poly uses the sum of winding numbers', () => {
    expect(contains(poly(square), { x: 1, y: 1 })).toBe(true);
    expect(contains(poly(square), { x: 3, y: 1 })).toBe(false);
    const inner: Vec[] = [
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 1.5 },
      { x: 1.5, y: 1.5 },
      { x: 1.5, y: 0.5 },
    ];
    expect(contains(poly(square, inner), { x: 1, y: 1 })).toBe(false);
    expect(contains(poly(square, inner), { x: 0.25, y: 1 })).toBe(true);
  });

  it('union, intersect and subtract', () => {
    const a = disc(0, 0, 2);
    const b = disc(2, 0, 2);
    const onlyA = { x: -1.5, y: 0 };
    const both = { x: 1, y: 0 };
    const onlyB = { x: 3.5, y: 0 };
    const none = { x: 0, y: 5 };
    const union: RegionNode = { kind: 'union', children: [a, b] };
    const inter: RegionNode = { kind: 'intersect', children: [a, b] };
    const sub: RegionNode = { kind: 'subtract', children: [a, b] };
    expect([onlyA, both, onlyB, none].map((p) => contains(union, p))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect([onlyA, both, onlyB, none].map((p) => contains(inter, p))).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect([onlyA, both, onlyB, none].map((p) => contains(sub, p))).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it('subtract removes every later child', () => {
    const node: RegionNode = {
      kind: 'subtract',
      children: [disc(0, 0, 5), disc(-2, 0, 1), disc(2, 0, 1)],
    };
    expect(contains(node, { x: -2, y: 0 })).toBe(false);
    expect(contains(node, { x: 2, y: 0 })).toBe(false);
    expect(contains(node, { x: 0, y: 0 })).toBe(true);
  });
});

describe('windingNumber', () => {
  it('counts orientation', () => {
    expect(windingNumber(square, { x: 1, y: 1 })).toBe(1);
    expect(windingNumber([...square].reverse(), { x: 1, y: 1 })).toBe(-1);
    expect(windingNumber(square, { x: 5, y: 1 })).toBe(0);
  });

  it('hexagram of two same-direction triangles', () => {
    const star = poly(triangle(90, true), triangle(270, true));
    const loops = star.kind === 'poly' ? star.loops : [];
    const wn = (p: Vec) => loops.reduce((s, l) => s + windingNumber(l, p), 0);
    expect(wn({ x: 0, y: 0 })).toBe(2);
    expect(wn({ x: 0, y: 0.9 })).toBe(1);
    expect(wn({ x: 0.9, y: 0.9 })).toBe(0);
    expect(contains(star, { x: 0, y: 0 })).toBe(true);
    expect(contains(star, { x: 0, y: 0.9 })).toBe(true);
    expect(contains(star, { x: 0.9, y: 0.9 })).toBe(false);
  });

  it('hexagram of opposite-direction triangles cancels in the centre', () => {
    const star = poly(triangle(90, true), triangle(270, false));
    expect(contains(star, { x: 0, y: 0 })).toBe(false);
    expect(contains(star, { x: 0, y: 0.9 })).toBe(true);
  });
});

describe('isBounded', () => {
  const d = disc(0, 0, 1);
  const h = half(1);
  const p = poly(square);
  const op = (kind: 'union' | 'intersect' | 'subtract', ...children: RegionNode[]): RegionNode => ({
    kind,
    children,
  });

  it.each([
    ['disc', d, true],
    ['poly', p, true],
    ['half', h, false],
    ['union of bounded', op('union', d, p), true],
    ['union with half', op('union', d, h), false],
    ['intersect of bounded and half', op('intersect', d, h), true],
    ['intersect of halves', op('intersect', h, half(-1)), false],
    ['subtract bounded minus half', op('subtract', d, h), true],
    ['subtract half minus bounded', op('subtract', h, d), false],
    ['nested', op('union', op('intersect', h, d), op('subtract', p, h)), true],
  ] as const)('%s', (_name, node, expected) => {
    expect(isBounded(node)).toBe(expected);
  });
});

describe('boundsOfBoundedLeaves', () => {
  it('covers discs and polys and ignores halves', () => {
    const node: RegionNode = {
      kind: 'union',
      children: [disc(0, 0, 1), { kind: 'intersect', children: [half(1), poly(square)] }],
    };
    expect(boundsOfBoundedLeaves(node)).toEqual({ minX: -1, minY: -1, maxX: 2, maxY: 2 });
  });

  it('is null without bounded leaves', () => {
    expect(boundsOfBoundedLeaves(half(1))).toBeNull();
  });
});

describe('chain leaf', () => {
  const circle = (cx: number, cy: number, r: number): ChainSupport => ({
    kind: 'circle',
    circle: { cx, cy, r },
  });
  const piece = (support: ChainSupport, concave = false, corner?: Vec): ChainInput =>
    corner === undefined ? { support, concave } : { support, concave, corner };
  const chainLeaf = (input: ChainInput[]): { node: RegionNode; area: number } => {
    const chain = buildChain(input);
    return { node: { kind: 'chain', pieces: chain.pieces, source: src }, area: chain.area };
  };

  const lens = chainLeaf([
    piece(circle(3, 0, 5), false, { x: 0, y: -5 }),
    piece(circle(-3, 0, 5), false, { x: 0, y: 5 }),
  ]);
  const outer = chainLeaf([
    piece(circle(-3, 0, 5), false, { x: 0, y: -5 }),
    piece(circle(3, 0, 5), false, { x: 0, y: 5 }),
  ]);
  const stadium = chainLeaf([
    piece({ kind: 'line', line: lineThrough({ x: 0, y: -2 }, { x: 1, y: -2 }) }),
    piece(circle(2.5, 0, 2)),
    piece({ kind: 'line', line: lineThrough({ x: 0, y: 2 }, { x: 1, y: 2 }) }),
    piece(circle(-2.5, 0, 2)),
  ]);
  const fillet = chainLeaf([
    piece(circle(-3, 0, 2)),
    piece(circle(0, -4, 3), true),
    piece(circle(3, 0, 2)),
    piece(circle(0, 4, 3), true),
  ]);

  /** Area by counting cell centres of a 1024 x 1024 grid over the leaf's bounding box. */
  const gridArea = (node: RegionNode): number => {
    const box = boundsOfBoundedLeaves(node);
    if (box === null) {
      return 0;
    }
    const n = 1024;
    const w = (box.maxX - box.minX) / n;
    const h = (box.maxY - box.minY) / n;
    let count = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (contains(node, { x: box.minX + (i + 0.5) * w, y: box.minY + (j + 0.5) * h })) {
          count++;
        }
      }
    }
    return count * w * h;
  };

  it.each([
    ['lens', lens],
    ['outer arcs', outer],
    ['stadium', stadium],
    ['lobes and fillets', fillet],
  ] as const)('grid count of contains matches the chain area: %s', (_name, shape) => {
    const grid = gridArea(shape.node);
    expect(Math.abs(grid - shape.area)).toBeLessThanOrEqual(0.01 * shape.area);
  });

  it('points on the chord between joints are inside the lens', () => {
    expect(contains(lens.node, { x: 0, y: 0 })).toBe(true);
    expect(contains(lens.node, { x: 0, y: 2 })).toBe(true);
    expect(contains(lens.node, { x: 0, y: -3.5 })).toBe(true);
    expect(contains(lens.node, { x: 2.5, y: 0 })).toBe(false);
    expect(contains(lens.node, { x: 0, y: 4.5 })).toBe(false);
  });

  it('a concave fillet centre is outside and a lobe centre inside', () => {
    expect(contains(fillet.node, { x: 0, y: -4 })).toBe(false);
    expect(contains(fillet.node, { x: -3, y: 0 })).toBe(true);
    expect(contains(fillet.node, { x: 0, y: 0 })).toBe(true);
  });

  it('is bounded, with bounds from joints and the axis extremes of the arcs', () => {
    expect(isBounded(lens.node)).toBe(true);
    expect(boundsOfBoundedLeaves(lens.node)).toEqual({ minX: -2, minY: -4, maxX: 2, maxY: 4 });
    expect(boundsOfBoundedLeaves(stadium.node)).toEqual({
      minX: -4.5,
      minY: -2,
      maxX: 4.5,
      maxY: 2,
    });
  });
});
