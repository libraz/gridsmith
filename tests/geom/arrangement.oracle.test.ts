import paper from 'paper';
import { describe, expect, it } from 'vitest';
import { arrange } from '../../src/geom/arrangement.js';
import type { ChainInput, ChainPiece, ChainSupport } from '../../src/geom/chain.js';
import { buildChain } from '../../src/geom/chain.js';
import type { Line, Vec } from '../../src/geom/primitives.js';
import {
  add,
  leftNormal,
  lineThrough,
  pointOnCircle,
  projectOnLine,
  scale,
  sub,
} from '../../src/geom/primitives.js';
import type { RegionNode, Source } from '../../src/geom/region.js';
import { boundsOfBoundedLeaves, contains, isBounded } from '../../src/geom/region.js';

paper.setup(new paper.Size(1, 1));

type Leaf = Extract<RegionNode, { kind: 'disc' | 'half' | 'poly' }>;
type Op = 'union' | 'intersect' | 'subtract';
type Shape = 'leaf' | { op: Op; children: Shape[] };
type Case = { tree: RegionNode; tangent: boolean; coincident: boolean; radii: number[] };

const CASES = 2000;
const SEED = 0x5eed_2026;
const OPS: readonly Op[] = ['union', 'intersect', 'subtract'];
const AXES: readonly Vec[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];
const PYTHAGOREAN: readonly Vec[] = [
  { x: 0.6, y: 0.8 },
  { x: -0.8, y: 0.6 },
  { x: -0.6, y: -0.8 },
  { x: 0.8, y: -0.6 },
];

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

class Gen {
  readonly rand: () => number;

  constructor(seed: number) {
    this.rand = mulberry32(seed);
  }

  int(lo: number, hi: number): number {
    return lo + Math.floor(this.rand() * (hi - lo + 1));
  }

  pick<T>(xs: readonly T[]): T {
    const x = xs[this.int(0, xs.length - 1)];
    if (x === undefined) {
      throw new Error('pick from an empty list');
    }
    return x;
  }

  /** Coordinate on the quarter-module lattice. */
  coord(): number {
    return this.int(-12, 12) * 0.25;
  }

  radius(): number {
    return this.int(2, 12) * 0.25;
  }

  /** Unit direction: axis-aligned, 3-4-5, or a generic angle. */
  direction(): Vec {
    const mode = this.int(0, 2);
    if (mode === 0) {
      return this.pick(AXES);
    }
    if (mode === 1) {
      return this.pick(PYTHAGOREAN);
    }
    const a = this.rand() * 2 * Math.PI;
    return { x: Math.cos(a), y: Math.sin(a) };
  }

  sign(): 1 | -1 {
    return this.rand() < 0.5 ? 1 : -1;
  }
}

const src = (k: number): Source => ({ id: `l${k}`, copy: 0 });
const discLeaf = (k: number, cx: number, cy: number, r: number): Leaf => ({
  kind: 'disc',
  circle: { cx, cy, r },
  source: src(k),
});
const halfLeaf = (k: number, line: Line, sign: 1 | -1): Leaf => ({
  kind: 'half',
  line,
  sign,
  source: src(k),
});
const polyLeaf = (k: number, loop: Vec[]): Leaf => ({
  kind: 'poly',
  loops: [loop],
  source: src(k),
});

const regular = (c: Vec, radius: number, n: number, rotate: number): Vec[] =>
  Array.from({ length: n }, (_, i) =>
    pointOnCircle({ cx: c.x, cy: c.y, r: radius }, rotate + (360 * i) / n),
  );

function randomLeaf(g: Gen, k: number): Leaf {
  const roll = g.rand();
  if (roll < 0.45) {
    return discLeaf(k, g.coord(), g.coord(), g.radius());
  }
  if (roll < 0.65) {
    const p = { x: g.coord(), y: g.coord() };
    return halfLeaf(k, lineThrough(p, add(p, g.direction())), g.sign());
  }
  if (roll < 0.85) {
    const rotate = g.rand() < 0.5 ? 15 * g.int(0, 23) : g.rand() * 360;
    return polyLeaf(
      k,
      regular({ x: g.coord(), y: g.coord() }, g.radius() + 0.25, g.int(3, 8), rotate),
    );
  }
  // Star-shaped about its centre, hence simple.
  const m = g.int(3, 7);
  const c = { x: g.coord(), y: g.coord() };
  const loop = Array.from({ length: m }, (_, i) => {
    const deg = (360 * (i + 0.6 * g.rand())) / m;
    return pointOnCircle({ cx: c.x, cy: c.y, r: g.radius() }, deg);
  });
  return polyLeaf(k, g.rand() < 0.5 ? loop : loop.reverse());
}

const edgesOf = (loop: readonly Vec[]): [Vec, Vec][] =>
  loop.flatMap((a, i): [Vec, Vec][] => {
    const b = loop[(i + 1) % loop.length];
    return b === undefined ? [] : [[a, b]];
  });

/** A leaf touching `target` at a constructed tangency. */
function tangentTo(g: Gen, target: Leaf, k: number): Leaf {
  if (target.kind === 'disc') {
    const { cx, cy, r } = target.circle;
    const c = { x: cx, y: cy };
    const mode = g.int(0, 3);
    if (mode === 0) {
      const external = g.rand() < 0.6;
      let r2 = g.radius();
      while (!external && Math.abs(r2 - r) < 0.25) {
        r2 = g.radius();
      }
      const at = add(c, scale(g.direction(), external ? r + r2 : Math.abs(r - r2)));
      return discLeaf(k, at.x, at.y, r2);
    }
    const u = g.direction();
    const q = add(c, scale(u, r));
    if (mode === 1) {
      return halfLeaf(k, lineThrough(q, add(q, leftNormal(u))), g.sign());
    }
    if (mode === 2) {
      const n = g.int(3, 8);
      return polyLeaf(k, regular(c, r / Math.cos(Math.PI / n), n, g.rand() * 360));
    }
    const t = leftNormal(u);
    const apex = add(q, scale(u, g.sign() * g.radius()));
    const tri = [sub(q, scale(t, g.radius())), add(q, scale(t, g.radius())), apex];
    return polyLeaf(k, g.rand() < 0.5 ? tri : tri.reverse());
  }
  let foot: Vec;
  let d: Vec;
  if (target.kind === 'half') {
    d = target.line.d;
    foot = add(projectOnLine(target.line, { x: 0, y: 0 }), scale(d, g.coord()));
  } else {
    const [a, b] = g.pick(edgesOf(target.loops[0] ?? []));
    d = lineThrough(a, b).d;
    foot = scale(add(a, b), 0.5);
  }
  const r2 = g.radius();
  const at = add(foot, scale(leftNormal(d), g.sign() * r2));
  return discLeaf(k, at.x, at.y, r2);
}

/** A leaf whose boundary shares a curve with `target`. */
function coincidentWith(g: Gen, target: Leaf, k: number): Leaf {
  if (target.kind === 'disc') {
    const { cx, cy, r } = target.circle;
    if (g.rand() < 0.2) {
      const j = (): number => (g.rand() - 0.5) * 6e-8;
      return discLeaf(k, cx + j(), cy + j(), r + j());
    }
    return discLeaf(k, cx, cy, r);
  }
  if (target.kind === 'half') {
    const { p, d } = target.line;
    const shifted = add(p, scale(d, g.coord()));
    const line = g.rand() < 0.5 ? { p: shifted, d } : { p: shifted, d: scale(d, -1) };
    return halfLeaf(k, line, g.sign());
  }
  const loop = target.loops[0] ?? [];
  const [a, b] = g.pick(edgesOf(loop));
  const mode = g.int(0, 2);
  if (mode === 0) {
    return halfLeaf(k, lineThrough(a, b), g.sign());
  }
  if (mode === 1) {
    // The same vertex set started one step later.
    const shift = g.int(1, loop.length - 1);
    return polyLeaf(k, [...loop.slice(shift), ...loop.slice(0, shift)]);
  }
  const mid = scale(add(a, b), 0.5);
  const apex = add(mid, scale(leftNormal(lineThrough(a, b).d), g.sign() * g.radius()));
  return polyLeaf(k, g.rand() < 0.5 ? [b, a, apex] : [a, b, apex]);
}

function randomShape(g: Gen, depth: number): Shape {
  if (depth === 3 || (depth > 0 && g.rand() < 0.6)) {
    return 'leaf';
  }
  const n = g.rand() < 0.7 ? 2 : 3;
  return { op: g.pick(OPS), children: Array.from({ length: n }, () => randomShape(g, depth + 1)) };
}

const countLeaves = (s: Shape): number =>
  s === 'leaf' ? 1 : s.children.reduce((sum, c) => sum + countLeaves(c), 0);

function buildTree(s: Shape, leaves: Leaf[]): RegionNode {
  if (s === 'leaf') {
    const leaf = leaves.shift();
    if (leaf === undefined) {
      throw new Error('ran out of leaves');
    }
    return leaf;
  }
  return { kind: s.op, children: s.children.map((c) => buildTree(c, leaves)) };
}

function generateCase(g: Gen): Case {
  const wantTangent = g.rand() < 0.45;
  const wantCoincident = g.rand() < 0.45;
  for (;;) {
    const shape = randomShape(g, 0);
    const count = countLeaves(shape);
    if (wantTangent && wantCoincident && count < 3) {
      continue;
    }
    const slots = Array.from({ length: count - 1 }, (_, i) => i + 1);
    const tangentSlot = wantTangent ? slots.splice(g.int(0, slots.length - 1), 1)[0] : undefined;
    const coincidentSlot = wantCoincident
      ? slots.splice(g.int(0, slots.length - 1), 1)[0]
      : undefined;
    const leaves: Leaf[] = [discLeaf(0, g.coord(), g.coord(), g.radius())];
    for (let k = 1; k < count; k++) {
      const target = g.pick(leaves);
      if (k === tangentSlot) {
        leaves.push(tangentTo(g, target, k));
      } else if (k === coincidentSlot) {
        leaves.push(coincidentWith(g, target, k));
      } else {
        leaves.push(randomLeaf(g, k));
      }
    }
    const radii = leaves.flatMap((l) => (l.kind === 'disc' ? [l.circle.r] : []));
    for (let i = leaves.length - 1; i > 0; i--) {
      const j = g.int(0, i);
      const li = leaves[i];
      const lj = leaves[j];
      if (li !== undefined && lj !== undefined) {
        leaves[i] = lj;
        leaves[j] = li;
      }
    }
    const tree = buildTree(shape, leaves);
    if (isBounded(tree)) {
      return { tree, tangent: wantTangent, coincident: wantCoincident, radii };
    }
  }
}

const P = (v: Vec): paper.Point => new paper.Point(v.x, v.y);

/** Circle as 16 cubic Bezier segments. */
function paperCircle(cx: number, cy: number, r: number): paper.Path {
  const k = (4 / 3) * Math.tan(Math.PI / 32) * r;
  const segments = Array.from({ length: 16 }, (_, i) => {
    const a = (i * Math.PI) / 8;
    const tangent = new paper.Point(-Math.sin(a) * k, Math.cos(a) * k);
    return new paper.Segment(
      new paper.Point(cx + r * Math.cos(a), cy + r * Math.sin(a)),
      tangent.multiply(-1),
      tangent,
    );
  });
  return new paper.Path({ segments, closed: true, insert: false });
}

function toPaper(node: RegionNode): paper.PathItem {
  switch (node.kind) {
    case 'disc':
      return paperCircle(node.circle.cx, node.circle.cy, node.circle.r);
    case 'half': {
      // Square of side 400 with one side on the line, lying on the inner side.
      const q = projectOnLine(node.line, { x: 0, y: 0 });
      const along = scale(node.line.d, 200);
      const inward = scale(leftNormal(node.line.d), 400 * node.sign);
      const a = sub(q, along);
      const b = add(q, along);
      return new paper.Path({
        segments: [a, b, add(b, inward), add(a, inward)].map(P),
        closed: true,
        insert: false,
      });
    }
    case 'poly':
      return new paper.Path({
        segments: (node.loops[0] ?? []).map(P),
        closed: true,
        insert: false,
      });
    case 'chain':
      return paperChain(node.pieces);
    default: {
      const [first, ...rest] = node.children.map(toPaper);
      if (first === undefined) {
        throw new Error('operator without children');
      }
      return rest.reduce((acc, item) => {
        if (node.kind === 'union') {
          return acc.unite(item, { insert: false });
        }
        if (node.kind === 'intersect') {
          return acc.intersect(item, { insert: false });
        }
        return acc.subtract(item, { insert: false });
      }, first);
    }
  }
}

/** Chain as one closed path; arcs as cubic Beziers of at most 22.5 degrees, like `paperCircle`. */
function paperChain(pieces: readonly ChainPiece[]): paper.Path {
  const segments: paper.Segment[] = [];
  // Handle pointing into the joint that ends the previous piece.
  let handleIn = new paper.Point(0, 0);
  for (const piece of pieces) {
    if (piece.kind === 'line') {
      segments.push(new paper.Segment(P(piece.start), handleIn, new paper.Point(0, 0)));
      handleIn = new paper.Point(0, 0);
      continue;
    }
    const { cx, cy, r } = piece.circle;
    const sign = piece.ccw ? 1 : -1;
    const parts = Math.ceil(piece.sweep / (Math.PI / 8));
    const step = piece.sweep / parts;
    const k = (4 / 3) * Math.tan(step / 4) * r;
    const tangent = (a: number): paper.Point =>
      new paper.Point(-Math.sin(a) * k * sign, Math.cos(a) * k * sign);
    for (let i = 0; i < parts; i++) {
      const a = piece.from + sign * i * step;
      const at = i === 0 ? piece.start : { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
      segments.push(
        new paper.Segment(P(at), i === 0 ? handleIn : tangent(a).multiply(-1), tangent(a)),
      );
    }
    handleIn = tangent(piece.from + sign * piece.sweep).multiply(-1);
  }
  const first = segments[0];
  if (first !== undefined) {
    first.handleIn = handleIn;
  }
  return new paper.Path({ segments, closed: true, insert: false });
}

function paperArea(item: paper.PathItem): number {
  if (item instanceof paper.Path || item instanceof paper.CompoundPath) {
    return Math.abs(item.area);
  }
  throw new Error(`unexpected paper result ${item.className}`);
}

/** Area by counting cell centres of a 1024 x 1024 grid over the leaves' bounding box. */
function gridArea(tree: RegionNode): number {
  const box = boundsOfBoundedLeaves(tree);
  if (box === null) {
    return 0;
  }
  const n = 1024;
  const w = (box.maxX - box.minX) / n;
  const h = (box.maxY - box.minY) / n;
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (contains(tree, { x: box.minX + (i + 0.5) * w, y: box.minY + (j + 0.5) * h })) {
        count++;
      }
    }
  }
  return count * w * h;
}

describe('arrange against paper.js', () => {
  it('matches the area of an independent boolean implementation', () => {
    const g = new Gen(SEED);
    const cases = Array.from({ length: CASES }, () => generateCase(g));
    const engineErrors: string[] = [];
    const mismatches: string[] = [];
    let paperErrors = 0;
    let paperWrong = 0;
    for (const c of cases) {
      const tree = JSON.stringify(c.tree);
      let area: number;
      try {
        area = arrange(c.tree).area;
      } catch (e) {
        engineErrors.push(`${String(e)}\n${tree}`);
        continue;
      }
      let expected: number;
      try {
        expected = paperArea(toPaper(c.tree));
      } catch {
        paperErrors++;
        continue;
      }
      const tol = 1e-5 * c.radii.reduce((s, r) => s + r * r, 0) + 1e-9;
      if (Math.abs(area - expected) <= tol) {
        continue;
      }
      const grid = gridArea(c.tree);
      if (Math.abs(area - grid) <= 0.01 * Math.max(area, grid)) {
        paperWrong++;
        continue;
      }
      mismatches.push(`engine ${area} paper ${expected} grid ${grid}\n${tree}`);
    }
    expect(cases).toHaveLength(CASES);
    expect(engineErrors).toEqual([]);
    expect(mismatches).toEqual([]);
    expect(paperErrors + paperWrong).toBeLessThanOrEqual(40);
    expect(cases.filter((c) => c.tangent).length).toBeGreaterThanOrEqual(0.25 * CASES);
    expect(cases.filter((c) => c.coincident).length).toBeGreaterThanOrEqual(0.25 * CASES);
  }, 60_000);
});

describe('chain leaf against paper.js', () => {
  const src0 = (id: string): Source => ({ id, copy: 0 });
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
    source: src0(id),
  });
  const disc = (id: string, cx: number, cy: number, r: number): RegionNode => ({
    kind: 'disc',
    circle: { cx, cy, r },
    source: src0(id),
  });
  const half = (id: string, a: Vec, b: Vec): RegionNode => ({
    kind: 'half',
    line: lineThrough(a, b),
    sign: 1,
    source: src0(id),
  });
  const rect = (id: string, x0: number, y0: number, x1: number, y1: number): RegionNode => ({
    kind: 'poly',
    loops: [
      [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ],
    ],
    source: src0(id),
  });
  const op = (kind: Op, ...children: RegionNode[]): RegionNode => ({ kind, children });

  const lens = (): RegionNode =>
    chain('lens', [
      piece(circle(3, 0, 5), false, { x: 0, y: -5 }),
      piece(circle(-3, 0, 5), false, { x: 0, y: 5 }),
    ]);
  const outer = (): RegionNode =>
    chain('outer', [
      piece(circle(-3, 0, 5), false, { x: 0, y: -5 }),
      piece(circle(3, 0, 5), false, { x: 0, y: 5 }),
    ]);
  const fillet = (): RegionNode =>
    chain('fillet', [
      piece(circle(-3, 0, 2)),
      piece(circle(0, -4, 3), true),
      piece(circle(3, 0, 2)),
      piece(circle(0, 4, 3), true),
    ]);
  const stadium = (id: string, r: number, a: number, vertical = false): RegionNode => {
    const t = (x: number, y: number): Vec => (vertical ? { x: -y, y: x } : { x, y });
    return chain(id, [
      piece(straight(t(0, -r), t(1, -r))),
      piece(vertical ? circle(0, a, r) : circle(a, 0, r)),
      piece(straight(t(0, r), t(1, r))),
      piece(vertical ? circle(0, -a, r) : circle(-a, 0, r)),
    ]);
  };
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
  const west = (): RegionNode => half('h', { x: 0, y: -1 }, { x: 0, y: 1 });
  const north = (): RegionNode => half('n', { x: -1, y: 0 }, { x: 1, y: 0 });

  const cases: [string, () => RegionNode][] = [
    ['lens alone', () => lens()],
    ['fillet alone', () => fillet()],
    ['stadium alone', () => stadium('s', 2, 2.5)],
    ['lens and a half-plane through both joints', () => op('intersect', lens(), west())],
    ['lens minus a half-plane through both joints', () => op('subtract', lens(), west())],
    ['lens and a disc on a piece circle', () => op('union', lens(), disc('b', 3, 0, 5))],
    ['disc on a piece circle minus the lens', () => op('subtract', disc('b', 3, 0, 5), lens())],
    ['fillet and a disc on a lobe circle', () => op('union', fillet(), disc('a', -3, 0, 2))],
    [
      'fillet minus a disc 6e-8 off a lobe circle',
      () => op('subtract', fillet(), disc('a', -3 + 6e-8, 0, 2)),
    ],
    [
      'fillet and a disc 6e-8 off a lobe circle',
      () => op('union', fillet(), disc('a', -3 + 6e-8, 0, 2)),
    ],
    ['fillet around a disc', () => op('subtract', fillet(), disc('o', 0, 0, 0.5))],
    ['disc around the lens', () => op('subtract', disc('o', 0, 0, 10), lens())],
    ['union of two stadiums', () => op('union', stadium('h', 1, 3), stadium('v', 1, 3, true))],
    [
      'intersection of two stadiums',
      () => op('intersect', stadium('h', 1, 3), stadium('v', 1, 3, true)),
    ],
    ['union of the lens and the outer arcs', () => op('union', lens(), outer())],
    [
      'stadium minus a rectangle',
      () => op('subtract', stadium('s', 1, 2), rect('r', -1, -3, 1, 3)),
    ],
    [
      'stadium and a rectangle on its lines',
      () => op('union', stadium('s', 1, 2), rect('r', -2, -1, 2, 1)),
    ],
    ['forty circles', () => ring()],
    ['forty circles and a half-plane', () => op('intersect', ring(), north())],
  ];

  it.each(cases)('%s', (_name, build) => {
    const tree = build();
    const area = arrange(tree).area;
    const expected = paperArea(toPaper(tree));
    expect(expected).toBeGreaterThan(0);
    expect(Math.abs(area - expected)).toBeLessThanOrEqual(0.01 * expected);
  });
});
