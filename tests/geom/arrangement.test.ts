import { describe, expect, it } from 'vitest';
import type { Edge, FillResult } from '../../src/geom/arrangement.js';
import { arrange } from '../../src/geom/arrangement.js';
import type { ChainInput, ChainSupport } from '../../src/geom/chain.js';
import { buildChain } from '../../src/geom/chain.js';
import type { Vec } from '../../src/geom/primitives.js';
import { distance, lineThrough, pointOnCircle, signedDistance } from '../../src/geom/primitives.js';
import type { RegionNode, Source } from '../../src/geom/region.js';

const disc = (id: string, cx: number, cy: number, r: number): RegionNode => ({
  kind: 'disc',
  circle: { cx, cy, r },
  source: { id, copy: 0 },
});
// Half-plane on the left of the directed line a -> b.
const half = (id: string, a: Vec, b: Vec): RegionNode => ({
  kind: 'half',
  line: lineThrough(a, b),
  sign: 1,
  source: { id, copy: 0 },
});
const poly = (id: string, ...loops: Vec[][]): RegionNode => ({
  kind: 'poly',
  loops,
  source: { id, copy: 0 },
});
const rect = (id: string, x0: number, y0: number, x1: number, y1: number): RegionNode =>
  poly(id, [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ]);
const union = (...children: RegionNode[]): RegionNode => ({ kind: 'union', children });
const intersect = (...children: RegionNode[]): RegionNode => ({ kind: 'intersect', children });
const subtract = (...children: RegionNode[]): RegionNode => ({ kind: 'subtract', children });

/** `x - sin x` without cancellation for small x. */
const xMinusSin = (x: number): number => {
  if (x > 0.1) {
    return x - Math.sin(x);
  }
  let term = (x * x * x) / 6;
  let sum = 0;
  for (let k = 1; k < 8; k++) {
    sum += term;
    term *= -(x * x) / ((2 * k + 2) * (2 * k + 3));
  }
  return sum;
};

/** Lens area of two radius-r circles whose centres are d apart. */
const lensArea = (r: number, d: number): number => {
  const h = Math.sqrt((r - d / 2) * (r + d / 2));
  const theta = 2 * Math.atan2(h, d / 2);
  return r * r * xMinusSin(theta);
};

const leavesOf = (node: RegionNode): Extract<RegionNode, { source: Source }>[] =>
  node.kind === 'disc' || node.kind === 'half' || node.kind === 'poly' || node.kind === 'chain'
    ? [node]
    : node.children.flatMap(leavesOf);

/** Whether an edge lies on the boundary curve of a leaf. */
const edgeOnLeaf = (e: Edge, leaf: Extract<RegionNode, { source: Source }>): boolean => {
  const tol = 1e-7;
  if (leaf.kind === 'chain') {
    return leaf.pieces.some((p) =>
      p.kind === 'arc'
        ? edgeOnLeaf(e, { kind: 'disc', circle: p.circle, source: leaf.source })
        : edgeOnLeaf(e, { kind: 'half', line: p.line, sign: 1, source: leaf.source }),
    );
  }
  if (leaf.kind === 'disc') {
    const c = leaf.circle;
    return (
      e.kind === 'arc' &&
      Math.abs(e.cx - c.cx) <= tol &&
      Math.abs(e.cy - c.cy) <= tol &&
      Math.abs(e.r - c.r) <= tol
    );
  }
  if (e.kind !== 'segment') {
    return false;
  }
  const lines =
    leaf.kind === 'half'
      ? [leaf.line]
      : leaf.loops.flatMap((loop) =>
          loop.map((a, i) => lineThrough(a, loop[(i + 1) % loop.length] ?? a)),
        );
  return lines.some(
    (line) =>
      Math.abs(signedDistance(line, e.from)) <= tol && Math.abs(signedDistance(line, e.to)) <= tol,
  );
};

/** Loops close, arcs end on their circle, and every source names a leaf carrying the edge. */
const checkStructure = (node: RegionNode, res: FillResult): void => {
  const leaves = leavesOf(node);
  for (const loop of res.loops) {
    expect(loop.length).toBeGreaterThan(0);
    loop.forEach((e, i) => {
      const next = loop[(i + 1) % loop.length];
      expect(next).toBeDefined();
      if (next !== undefined) {
        expect(distance(e.to, next.from)).toBeLessThanOrEqual(1e-9);
      }
      if (e.kind === 'arc') {
        expect(Math.abs(distance({ x: e.cx, y: e.cy }, e.from) - e.r)).toBeLessThanOrEqual(1e-7);
        expect(Math.abs(distance({ x: e.cx, y: e.cy }, e.to) - e.r)).toBeLessThanOrEqual(1e-7);
      }
      expect(e.sources.length).toBeGreaterThan(0);
      for (const s of e.sources) {
        const owners = leaves.filter((l) => l.source.id === s.id && l.source.copy === s.copy);
        expect(owners.some((l) => edgeOnLeaf(e, l))).toBe(true);
      }
    });
  }
};

const sourceIds = (e: Edge): string[] => e.sources.map((s) => s.id).sort();

const expectArea = (res: FillResult, expected: number): void => {
  expect(Math.abs(res.area - expected)).toBeLessThanOrEqual(1e-9 * Math.abs(expected));
};

const run = (node: RegionNode): FillResult => {
  const res = arrange(node);
  checkStructure(node, res);
  return res;
};

describe('arrange: tangency', () => {
  it('union of externally tangent unit circles is two loops of area 2pi', () => {
    const res = run(union(disc('a', 0, 0, 1), disc('b', 2, 0, 1)));
    expect(res.loops).toHaveLength(2);
    expectArea(res, 2 * Math.PI);
    for (const loop of res.loops) {
      const ids = new Set(loop.flatMap(sourceIds));
      expect(ids.size).toBe(1);
    }
    expect(res.bbox).toEqual({ minX: -1, minY: -1, maxX: 3, maxY: 1 });
  });

  it('intersection of externally tangent circles has no loops', () => {
    const res = run(intersect(disc('a', 0, 0, 1), disc('b', 2, 0, 1)));
    expect(res.loops).toHaveLength(0);
    expect(res.area).toBe(0);
    expect(res.bbox).toBeNull();
  });

  it('internally tangent difference has area 3pi', () => {
    const res = run(subtract(disc('a', 0, 0, 2), disc('b', 1, 0, 1)));
    expectArea(res, 3 * Math.PI);
    expect(res.loops).toHaveLength(1);
    const inner = res.loops.flat().filter((e) => e.kind === 'arc' && e.r === 1);
    expect(inner).toHaveLength(2);
    expect(inner.every((e) => e.kind === 'arc' && !e.ccw)).toBe(true);
  });

  it('a circle with one tangent vertex keeps the whole disc', () => {
    const d = disc('a', 0, 0, 2);
    // y < 2 contains the disc and touches it at (0, 2).
    const below = half('h', { x: 1, y: 2 }, { x: 0, y: 2 });
    const res = run(intersect(d, below));
    expect(res.loops).toHaveLength(1);
    expectArea(res, 4 * Math.PI);
    const arcs = res.loops.flat();
    expect(arcs).toHaveLength(2);
    expect(arcs.some((e) => distance(e.from, { x: 0, y: 2 }) < 1e-12)).toBe(true);
    expect(arcs.some((e) => distance(e.from, { x: 0, y: -2 }) < 1e-12)).toBe(true);
    expect(arcs.every((e) => sourceIds(e).join() === 'a')).toBe(true);
  });

  it('a disc minus two mutually tangent inner discs touching it leaves two loops', () => {
    const res = run(subtract(disc('o', 0, 0, 2), disc('a', -1, 0, 1), disc('b', 1, 0, 1)));
    expect(res.loops).toHaveLength(2);
    expectArea(res, 2 * Math.PI);
  });

  it('a disc minus two mutually tangent discs inside it gives an outer loop and a pinched hole', () => {
    const res = run(subtract(disc('o', 0, 0, 3), disc('a', -1, 0, 1), disc('b', 1, 0, 1)));
    expect(res.loops).toHaveLength(2);
    expectArea(res, 7 * Math.PI);
  });

  it('generic-angle tangency keeps two loops', () => {
    const c = pointOnCircle({ cx: 0.3, cy: -0.2, r: 1.7 }, 37.3);
    const res = run(union(disc('a', 0.3, -0.2, 1), disc('b', c.x, c.y, 0.7)));
    expect(res.loops).toHaveLength(2);
    expectArea(res, Math.PI * (1 + 0.49));
  });
});

describe('arrange: vesica and transversal crossings', () => {
  const a = disc('a', 0, 0, 1);
  const b = disc('b', 1, 0, 1);
  const lens = (2 * Math.PI) / 3 - Math.sqrt(3) / 2;

  it('union', () => {
    const res = run(union(a, b));
    expect(res.loops).toHaveLength(1);
    expectArea(res, 2 * Math.PI - lens);
  });

  it('difference', () => {
    const res = run(subtract(a, b));
    expect(res.loops).toHaveLength(1);
    expectArea(res, Math.PI - lens);
  });

  it('intersection', () => {
    const res = run(intersect(a, b));
    expect(res.loops).toHaveLength(1);
    expectArea(res, lens);
    expect(res.loops[0]?.map(sourceIds)).toEqual(expect.arrayContaining([['a'], ['b']]));
  });

  it('symmetric difference separates at the four-edge crossing vertices', () => {
    const res = run(union(subtract(a, b), subtract(b, a)));
    expect(res.loops).toHaveLength(2);
    expectArea(res, 2 * (Math.PI - lens));
  });

  it('a plus sign of two crossing rectangles', () => {
    const res = run(union(rect('h', -3, -1, 3, 1), rect('v', -1, -3, 1, 3)));
    expect(res.loops).toHaveLength(1);
    expect(res.loops[0]).toHaveLength(12);
    expectArea(res, 20);
  });
});

describe('arrange: three curves through one point', () => {
  it('two tangent circles and a third through the contact point', () => {
    // All three pass through the origin; a and c touch there.
    const node = union(disc('a', 1, 0, 1), disc('b', 0, 1, 1), disc('c', -1, 0, 1));
    const res = run(node);
    expect(res.loops).toHaveLength(1);
    expectArea(res, 2 * Math.PI + 2);
  });

  it('lens of two of them minus the third', () => {
    const res = run(
      subtract(intersect(disc('a', 1, 0, 1), disc('b', 0, 1, 1)), disc('c', -1, 0, 1)),
    );
    expect(res.loops).toHaveLength(1);
    expectArea(res, Math.PI / 2 - 1);
  });

  it('a disc minus an inscribed rectangle on exact lattice points', () => {
    const node = subtract(disc('d', 0, 0, 5), rect('r', -3, -4, 3, 4));
    const res = run(node);
    expect(res.loops).toHaveLength(4);
    expectArea(res, 25 * Math.PI - 48);
  });

  it('a disc minus an inscribed triangle', () => {
    const tri = [90, 210, 330].map((deg) => pointOnCircle({ cx: 0, cy: 0, r: 1 }, deg));
    const res = run(subtract(disc('d', 0, 0, 1), poly('t', tri)));
    expect(res.loops).toHaveLength(3);
    expectArea(res, Math.PI - (3 * Math.sqrt(3)) / 4);
  });
});

describe('arrange: thin overlaps', () => {
  for (const overlap of [5e-7, 5e-9]) {
    const d = 2 - overlap;
    const a = disc('a', 0, 0, 1);
    const b = disc('b', d, 0, 1);
    const lens = lensArea(1, d);

    it(`union with overlap ${overlap}`, () => {
      const res = run(union(a, b));
      expect(res.loops).toHaveLength(1);
      expectArea(res, 2 * Math.PI - lens);
    });

    it(`difference with overlap ${overlap}`, () => {
      const res = run(subtract(a, b));
      expect(res.loops).toHaveLength(1);
      expectArea(res, Math.PI - lens);
    });

    it(`intersection with overlap ${overlap}`, () => {
      const res = run(intersect(a, b));
      expect(res.loops).toHaveLength(1);
      expectArea(res, lens);
    });
  }

  it('concentric circles 5e-7 apart in radius unite to the larger', () => {
    const r = 1 + 5e-7;
    const res = run(union(disc('a', 0, 0, 1), disc('b', 0, 0, r)));
    expect(res.loops).toHaveLength(1);
    expectArea(res, Math.PI * r * r);
    expect(res.loops.flat().every((e) => sourceIds(e).join() === 'b')).toBe(true);
  });
});

describe('arrange: coincident curves', () => {
  it('identical circles subtract to nothing', () => {
    const res = run(subtract(disc('a', 1, 1, 2), disc('b', 1, 1, 2)));
    expect(res.loops).toHaveLength(0);
  });

  it('identical circles unite into one loop carrying both sources', () => {
    const res = run(union(disc('a', 1, 1, 2), disc('b', 1, 1, 2)));
    expect(res.loops).toHaveLength(1);
    expectArea(res, 4 * Math.PI);
    expect(res.loops.flat().every((e) => sourceIds(e).join() === 'a,b')).toBe(true);
  });

  it('rectangles sharing a stretch of their bottom edge: subtract', () => {
    const res = run(subtract(rect('a', 0, 0, 2, 2), rect('b', 1, 0, 3, 1)));
    expect(res.loops).toHaveLength(1);
    expectArea(res, 3);
    const bottom = res.loops.flat().filter((e) => e.from.y === 0 && e.to.y === 0);
    expect(bottom).toHaveLength(1);
    expect(bottom.map(sourceIds)).toEqual([['a', 'b']]);
  });

  it('rectangles sharing a stretch of their bottom edge: union', () => {
    const res = run(union(rect('a', 0, 0, 2, 2), rect('b', 1, 0, 3, 1)));
    expect(res.loops).toHaveLength(1);
    expectArea(res, 5);
  });

  it('rectangles touching along a stretch unite into one loop', () => {
    const res = run(union(rect('a', 0, 0, 2, 1), rect('b', 1, 1, 3, 2)));
    expect(res.loops).toHaveLength(1);
    // Atomic edges are split wherever another support line crosses.
    expect(res.loops[0]).toHaveLength(10);
    expectArea(res, 4);
    expectArea(run(subtract(rect('a', 0, 0, 2, 1), rect('b', 1, 1, 3, 2))), 2);
  });

  it('a half-plane along a polygon edge', () => {
    const square = rect('s', 0, 0, 2, 2);
    // Left of (0, 0) -> (2, 0) is y > 0, which contains the square.
    const res = run(intersect(square, half('h', { x: 0, y: 0 }, { x: 2, y: 0 })));
    expectArea(res, 4);
    const bottom = res.loops.flat().filter((e) => e.from.y === 0 && e.to.y === 0);
    expect(bottom.map(sourceIds)).toEqual([['h', 's']]);
    expect(run(subtract(square, half('h', { x: 0, y: 0 }, { x: 2, y: 0 }))).loops).toHaveLength(0);
  });
});

describe('arrange: half-planes and polygons', () => {
  it('half-plane through the centre cuts a semicircle', () => {
    const d = disc('d', 0, 0, 1);
    const upper = half('h', { x: -1, y: 0 }, { x: 1, y: 0 });
    expectArea(run(intersect(d, upper)), Math.PI / 2);
    expectArea(run(subtract(d, upper)), Math.PI / 2);
    const p = pointOnCircle({ cx: 0, cy: 0, r: 1 }, 37);
    expectArea(run(intersect(d, half('g', { x: 0, y: 0 }, p))), Math.PI / 2);
  });

  it('an off-centre chord cuts a circular segment', () => {
    const res = run(intersect(disc('d', 0, 0, 1), half('h', { x: 1, y: 0.5 }, { x: -1, y: 0.5 })));
    expect(res.loops).toHaveLength(1);
    // y < 0.5 keeps all but the segment above the chord.
    expectArea(res, Math.PI - ((2 * Math.PI) / 3 - Math.sqrt(3) / 2) / 2);
  });

  it('square with a corner at the disc centre', () => {
    const res = run(intersect(rect('s', 0, 0, 2, 2), disc('d', 0, 0, 1)));
    expect(res.loops).toHaveLength(1);
    expectArea(res, Math.PI / 4);
  });

  it('square circumscribing the disc touches it at four points', () => {
    const res = run(intersect(rect('s', -1, -1, 1, 1), disc('d', 0, 0, 1)));
    expect(res.loops).toHaveLength(1);
    expectArea(res, Math.PI);
    expect(res.loops.flat().every((e) => e.kind === 'arc')).toBe(true);
  });

  it('hexagram as two triangle loops', () => {
    const c = { cx: 0, cy: 0, r: 1 };
    const t1 = [90, 210, 330].map((deg) => pointOnCircle(c, deg));
    const t2 = [150, 270, 30].map((deg) => pointOnCircle(c, deg));
    const res = run(poly('star', t1, t2));
    expect(res.loops).toHaveLength(1);
    expect(res.loops[0]).toHaveLength(12);
    expectArea(res, Math.sqrt(3));
    expectArea(run(intersect(poly('star', t1, t2), disc('d', 0, 0, 1))), Math.sqrt(3));
  });
});

describe('arrange: chain leaf', () => {
  const circle = (cx: number, cy: number, r: number): ChainSupport => ({
    kind: 'circle',
    circle: { cx, cy, r },
  });
  const straight = (a: Vec, b: Vec): ChainSupport => ({ kind: 'line', line: lineThrough(a, b) });
  const piece = (support: ChainSupport, concave = false, corner?: Vec): ChainInput =>
    corner === undefined ? { support, concave } : { support, concave, corner };
  const chain = (id: string, input: ChainInput[]): RegionNode => ({
    kind: 'chain',
    pieces: buildChain(input).pieces,
    source: { id, copy: 0 },
  });

  // Lens of the circles (-3, 0) r 5 and (3, 0) r 5, joints (0, -4) and (0, 4).
  const lens = (): RegionNode =>
    chain('lens', [
      piece(circle(3, 0, 5), false, { x: 0, y: -5 }),
      piece(circle(-3, 0, 5), false, { x: 0, y: 5 }),
    ]);
  const lensTheta = 2 * Math.atan2(4, 3);
  const lensArea = 25 * (lensTheta - Math.sin(lensTheta));
  // Lobes (-3, 0) r 2 and (3, 0) r 2 joined by concave fillets (0, -4) r 3 and (0, 4) r 3.
  const fillet = (): RegionNode =>
    chain('fillet', [
      piece(circle(-3, 0, 2)),
      piece(circle(0, -4, 3), true),
      piece(circle(3, 0, 2)),
      piece(circle(0, 4, 3), true),
    ]);
  const filletTheta = 2 * Math.atan(4 / 3);
  const filletArea = 24 - 9 * (Math.PI - filletTheta) + 4 * (2 * Math.PI - filletTheta);
  // Stadium of radius r around the segment from (-a, 0) to (a, 0), or its transpose.
  const stadium = (id: string, r: number, a: number, vertical = false): RegionNode => {
    const t = (x: number, y: number): Vec => (vertical ? { x: -y, y: x } : { x, y });
    return chain(id, [
      piece(straight(t(0, -r), t(1, -r))),
      piece(vertical ? circle(0, a, r) : circle(a, 0, r)),
      piece(straight(t(0, r), t(1, r))),
      piece(vertical ? circle(0, -a, r) : circle(-a, 0, r)),
    ]);
  };
  // Forty radius-0.6 circles 9 degrees apart on a radius-6 ring, even ones bulging, odd ones
  // cutting in, every joint the inner crossing of neighbours.
  const ring = (): RegionNode =>
    chain(
      'ring',
      Array.from({ length: 40 }, (_, k) => {
        const c = pointOnCircle({ cx: 0, cy: 0, r: 6 }, 9 * k);
        return piece(
          circle(c.x, c.y, 0.6),
          k % 2 === 1,
          pointOnCircle({ cx: 0, cy: 0, r: 5.6 }, 9 * k + 4.5),
        );
      }),
    );
  const ringRho = 6 * Math.cos(Math.PI / 40) - Math.sqrt(0.36 - (6 * Math.sin(Math.PI / 40)) ** 2);
  const ringAlpha = 2 * Math.asin((ringRho * Math.sin(Math.PI / 40)) / 0.6);
  // Forty-gon of the joints, plus twenty major segments, minus twenty minor ones.
  const ringArea =
    20 * ringRho * ringRho * Math.sin(Math.PI / 20) +
    3.6 * (2 * Math.PI - 2 * ringAlpha + 2 * Math.sin(ringAlpha));

  const expectNear = (res: FillResult, expected: number, tol: number): void => {
    expect(Math.abs(res.area - expected)).toBeLessThanOrEqual(tol);
  };
  // x < 0
  const west = (): RegionNode => half('h', { x: 0, y: -1 }, { x: 0, y: 1 });

  it('a chain alone has its own area', () => {
    const l = run(lens());
    expect(l.loops).toHaveLength(1);
    expectArea(l, lensArea);
    expect(l.bbox).toEqual({ minX: -2, minY: -4, maxX: 2, maxY: 4 });
    const f = run(fillet());
    expect(f.loops).toHaveLength(1);
    expectArea(f, filletArea);
    const s = run(stadium('s', 2, 2.5));
    expect(s.loops).toHaveLength(1);
    expectArea(s, 4 * Math.PI + 20);
  });

  it('a half-plane through both joints of the lens', () => {
    const inter = run(intersect(lens(), west()));
    expect(inter.loops).toHaveLength(1);
    expectArea(inter, lensArea / 2);
    const diff = run(subtract(lens(), west()));
    expect(diff.loops).toHaveLength(1);
    expectArea(diff, lensArea / 2);
  });

  it('a disc on the same circle as a piece', () => {
    const uni = run(union(lens(), disc('b', 3, 0, 5)));
    expect(uni.loops).toHaveLength(1);
    expectArea(uni, 25 * Math.PI);
    const crescent = run(subtract(disc('b', 3, 0, 5), lens()));
    expect(crescent.loops).toHaveLength(1);
    expectArea(crescent, 25 * Math.PI - lensArea);
    const lobes = run(union(fillet(), disc('a', -3, 0, 2)));
    expect(lobes.loops).toHaveLength(1);
    expectArea(lobes, filletArea);
  });

  it('a disc 6e-8 off the circle of a piece', () => {
    const empty = run(subtract(lens(), disc('b', 3 + 6e-8, 0, 5)));
    expect(empty.loops).toHaveLength(0);
    const cut = run(subtract(fillet(), disc('a', -3 + 6e-8, 0, 2)));
    expect(cut.loops).toHaveLength(1);
    expectNear(cut, filletArea - 4 * Math.PI, 1e-5);
    const kept = run(union(fillet(), disc('a', -3 + 6e-8, 0, 2)));
    expect(kept.loops).toHaveLength(1);
    expectNear(kept, filletArea, 1e-5);
  });

  it('a chain around a disc', () => {
    const hole = run(subtract(fillet(), disc('o', 0, 0, 0.5)));
    expect(hole.loops).toHaveLength(2);
    expectArea(hole, filletArea - Math.PI / 4);
    expectArea(run(union(fillet(), disc('o', 0, 0, 0.5))), filletArea);
    expectArea(run(intersect(fillet(), disc('o', 0, 0, 0.5))), Math.PI / 4);
  });

  it('a disc around a chain', () => {
    const ring10 = run(subtract(disc('o', 0, 0, 10), lens()));
    expect(ring10.loops).toHaveLength(2);
    expectArea(ring10, 100 * Math.PI - lensArea);
    expectArea(run(intersect(disc('o', 0, 0, 10), lens())), lensArea);
  });

  it('two chains', () => {
    const across = (): RegionNode => stadium('h', 1, 3);
    const upright = (): RegionNode => stadium('v', 1, 3, true);
    const uni = run(union(across(), upright()));
    expect(uni.loops).toHaveLength(1);
    expectArea(uni, 2 * Math.PI + 20);
    const inter = run(intersect(across(), upright()));
    expect(inter.loops).toHaveLength(1);
    expectArea(inter, 4);
    const lenses = run(
      union(
        lens(),
        chain('outer', [
          piece(circle(-3, 0, 5), false, { x: 0, y: -5 }),
          piece(circle(3, 0, 5), false, { x: 0, y: 5 }),
        ]),
      ),
    );
    expect(lenses.loops).toHaveLength(1);
    expectArea(lenses, 50 * Math.PI - lensArea);
  });

  it('a chain and polygons', () => {
    const s = (): RegionNode => stadium('s', 1, 2);
    const inter = run(intersect(s(), rect('r', -1, -3, 1, 3)));
    expect(inter.loops).toHaveLength(1);
    expectArea(inter, 4);
    const diff = run(subtract(s(), rect('r', -1, -3, 1, 3)));
    expect(diff.loops).toHaveLength(2);
    expectArea(diff, Math.PI + 4);
    // The rectangle's long sides lie on the stadium's lines.
    const uni = run(union(s(), rect('r', -2, -1, 2, 1)));
    expect(uni.loops).toHaveLength(1);
    expectArea(uni, Math.PI + 8);
  });

  it('forty circles in one chain', () => {
    const alone = run(ring());
    expect(alone.loops).toHaveLength(1);
    expectArea(alone, ringArea);
    const north = run(intersect(ring(), half('n', { x: -1, y: 0 }, { x: 1, y: 0 })));
    expect(north.loops).toHaveLength(1);
    expectArea(north, ringArea / 2);
    expectArea(run(union(ring(), disc('o', 0, 0, 3))), ringArea);
  });
});
