import { describe, expect, it } from 'vitest';
import type { Edge, FillResult } from '../../src/geom/arrangement.js';
import { arrange } from '../../src/geom/arrangement.js';
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
  node.kind === 'disc' || node.kind === 'half' || node.kind === 'poly'
    ? [node]
    : node.children.flatMap(leavesOf);

/** Whether an edge lies on the boundary curve of a leaf. */
const edgeOnLeaf = (e: Edge, leaf: Extract<RegionNode, { source: Source }>): boolean => {
  const tol = 1e-7;
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
