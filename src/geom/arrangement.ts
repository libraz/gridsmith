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
  lineThrough,
  SNAP,
  scale,
  signedDistance,
  sub,
} from './primitives.js';
import type { Bounds, RegionNode, Source } from './region.js';
import { boundsOfBoundedLeaves, contains, isBounded } from './region.js';

export type SegmentEdge = {
  kind: 'segment';
  from: Vec;
  to: Vec;
  sources: readonly Source[];
};

export type ArcEdge = {
  kind: 'arc';
  cx: number;
  cy: number;
  r: number;
  from: Vec;
  to: Vec;
  ccw: boolean;
  sources: readonly Source[];
};

export type Edge = SegmentEdge | ArcEdge;

/** Closed boundary loop; the filled side is on the left of every edge. */
export type Loop = Edge[];

export type FillResult = { loops: Loop[]; area: number; bbox: Bounds | null };

/** Boundary edges that could not be linked into closed loops. */
export class ArrangementInvariantError extends Error {
  readonly edgesLeft: number;

  constructor(edgesLeft: number) {
    super(`arrangement: ${edgesLeft} boundary edges do not close into loops`);
    this.name = 'ArrangementInvariantError';
    this.edgesLeft = edgesLeft;
  }
}

type Leaf = Extract<RegionNode, { kind: 'disc' | 'half' | 'poly' | 'chain' }>;

type CurveGeom = { kind: 'circle'; circle: Circle } | { kind: 'line'; line: Line };

type Curve = { geom: CurveGeom; sources: Source[] };

/** A polygon edge on a merged support line; `pa`/`pb` index the point list. */
type PolyEdge = { a: Vec; b: Vec; curve: number; pa: number; pb: number };

/** A chain piece on a merged curve; `entry`/`exit` index the point list. */
type ChainRef = { curve: number; entry: number; exit: number; ccw: boolean };

type LeafInfo = { node: Leaf; curve: number; edges: PolyEdge[]; pieces: ChainRef[] };

type Vertex = { p: Vec; curves: Set<number> };

type AtomicEdge = {
  curve: number;
  v0: number;
  v1: number;
  /** Position of `v0` in the curve's sorted vertex list. */
  index: number;
  /** Counter-clockwise sweep in radians for arcs, 0 for segments. */
  sweep: number;
  length: number;
};

type Directed = { edge: AtomicEdge; from: number; to: number; forward: boolean };

const TWO_PI = 2 * Math.PI;
const MAX_SAMPLE_ARC = 0.01;

/** Boundary loops, area and bounding box of a bounded region. */
export function arrange(node: RegionNode): FillResult {
  const leafBox = boundsOfBoundedLeaves(node);
  if (!isBounded(node) || leafBox === null) {
    throw new Error('arrange: the region is unbounded');
  }
  const box: Bounds = {
    minX: leafBox.minX - 1,
    minY: leafBox.minY - 1,
    maxX: leafBox.maxX + 1,
    maxY: leafBox.maxY + 1,
  };

  const leafIndex = new Map<RegionNode, number>();
  const leaves: Leaf[] = [];
  collectLeaves(node, leaves, leafIndex);

  // Raw support curves: one per disc or half, one per polygon edge, one per chain piece.
  const raw: { geom: CurveGeom; source: Source }[] = [];
  const leafRaw: number[] = [];
  const rawPolyEdges: { leaf: number; a: Vec; b: Vec; raw: number }[] = [];
  const rawChains: { leaf: number; first: number }[] = [];
  leaves.forEach((leaf, li) => {
    if (leaf.kind === 'disc') {
      leafRaw.push(
        raw.push({ geom: { kind: 'circle', circle: leaf.circle }, source: leaf.source }) - 1,
      );
    } else if (leaf.kind === 'half') {
      leafRaw.push(raw.push({ geom: { kind: 'line', line: leaf.line }, source: leaf.source }) - 1);
    } else if (leaf.kind === 'chain') {
      leafRaw.push(-1);
      rawChains.push({ leaf: li, first: raw.length });
      for (const piece of leaf.pieces) {
        const geom: CurveGeom =
          piece.kind === 'arc'
            ? { kind: 'circle', circle: piece.circle }
            : { kind: 'line', line: piece.line };
        raw.push({ geom, source: leaf.source });
      }
    } else {
      leafRaw.push(-1);
      for (const loop of leaf.loops) {
        loop.forEach((a, i) => {
          const b = loop[(i + 1) % loop.length];
          if (b === undefined || distance(a, b) <= SNAP) {
            return;
          }
          const r = raw.push({
            geom: { kind: 'line', line: lineThrough(a, b) },
            source: leaf.source,
          });
          rawPolyEdges.push({ leaf: li, a, b, raw: r - 1 });
        });
      }
    }
  });

  const { curves, curveOfRaw } = mergeCurves(raw, box);

  const points: { p: Vec; curves: number[] }[] = [];
  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      const ci = curves[i];
      const cj = curves[j];
      if (ci === undefined || cj === undefined) {
        continue;
      }
      for (const p of intersectCurves(ci.geom, cj.geom)) {
        points.push({ p, curves: [i, j] });
      }
    }
  }

  const infos: LeafInfo[] = leaves.map((leaf, li) => ({
    node: leaf,
    curve: curveOfRaw[leafRaw[li] ?? -1] ?? -1,
    edges: [],
    pieces: [],
  }));
  // Polygon vertices are always vertices of their edge lines.
  for (const pe of rawPolyEdges) {
    const curve = curveOfRaw[pe.raw] ?? -1;
    const pa = points.push({ p: pe.a, curves: [curve] }) - 1;
    const pb = points.push({ p: pe.b, curves: [curve] }) - 1;
    infos[pe.leaf]?.edges.push({ a: pe.a, b: pe.b, curve, pa, pb });
  }
  // A chain joint is a vertex of the merged curves of both pieces it joins.
  for (const rc of rawChains) {
    const leaf = leaves[rc.leaf];
    const info = infos[rc.leaf];
    if (leaf?.kind !== 'chain' || info === undefined) {
      continue;
    }
    const pieces = leaf.pieces;
    const n = pieces.length;
    const curveOf = (k: number): number => curveOfRaw[rc.first + (k % n)] ?? -1;
    const joints = pieces.map(
      (piece, k) => points.push({ p: piece.end, curves: [curveOf(k), curveOf(k + 1)] }) - 1,
    );
    info.pieces = pieces.map((piece, k) => ({
      curve: curveOf(k),
      entry: joints[(k + n - 1) % n] ?? -1,
      exit: joints[k] ?? -1,
      ccw: piece.kind === 'arc' && piece.ccw,
    }));
  }

  const clusterOf = clusterPoints(points.map((q) => q.p));
  const vertices: Vertex[] = [];
  const sums: { x: number; y: number; n: number }[] = [];
  points.forEach((q, i) => {
    const v = clusterOf[i] ?? 0;
    while (vertices.length <= v) {
      vertices.push({ p: { x: 0, y: 0 }, curves: new Set() });
      sums.push({ x: 0, y: 0, n: 0 });
    }
    const s = sums[v];
    const vert = vertices[v];
    if (s === undefined || vert === undefined) {
      return;
    }
    s.x += q.p.x;
    s.y += q.p.y;
    s.n++;
    for (const c of q.curves) {
      vert.curves.add(c);
    }
  });
  vertices.forEach((vert, i) => {
    const s = sums[i];
    if (s !== undefined && s.n > 0) {
      vert.p = { x: s.x / s.n, y: s.y / s.n };
    }
  });
  // Polygons are evaluated on their snapped vertices, consistent with the merged support lines.
  for (const info of infos) {
    for (const pe of info.edges) {
      pe.a = vertices[clusterOf[pe.pa] ?? -1]?.p ?? pe.a;
      pe.b = vertices[clusterOf[pe.pb] ?? -1]?.p ?? pe.b;
    }
  }

  const onCurve: number[][] = curves.map(() => []);
  vertices.forEach((vert, vi) => {
    for (const c of vert.curves) {
      onCurve[c]?.push(vi);
    }
  });

  const edges: AtomicEdge[] = [];
  const positions: Map<number, number>[] = [];
  curves.forEach((curve, ci) => {
    const ids = onCurve[ci] ?? [];
    if (curve.geom.kind === 'circle') {
      const circle = curve.geom.circle;
      ensureTwoVertices(circle, ids, vertices, ci);
      const angle = (vi: number): number => angleOn(circle, vertices[vi]?.p ?? centerOf(circle));
      ids.sort((a, b) => angle(a) - angle(b));
      ids.forEach((v0, k) => {
        const v1 = ids[(k + 1) % ids.length];
        if (v1 === undefined) {
          return;
        }
        const nominal = k + 1 < ids.length ? angle(v1) - angle(v0) : angle(v1) + TWO_PI - angle(v0);
        const sweep = arcSweep(circle, vertices[v0]?.p, vertices[v1]?.p, nominal);
        edges.push({ curve: ci, v0, v1, index: k, sweep, length: circle.r * sweep });
      });
    } else {
      const line = curve.geom.line;
      const param = (vi: number): number => dot(line.d, sub(vertices[vi]?.p ?? line.p, line.p));
      ids.sort((a, b) => param(a) - param(b));
      for (let k = 0; k + 1 < ids.length; k++) {
        const v0 = ids[k];
        const v1 = ids[k + 1];
        if (v0 !== undefined && v1 !== undefined) {
          edges.push({ curve: ci, v0, v1, index: k, sweep: 0, length: param(v1) - param(v0) });
        }
      }
    }
    positions.push(new Map(ids.map((vi, k) => [vi, k])));
  });

  const boundary: Directed[] = [];
  const leftValues: boolean[] = new Array(leaves.length).fill(false);
  const rightValues: boolean[] = new Array(leaves.length).fill(false);
  for (const edge of edges) {
    const curve = curves[edge.curve];
    if (curve === undefined) {
      continue;
    }
    const { m, d } = midpointOf(curve.geom, edge, vertices);
    const n = leftNormal(d);
    infos.forEach((info, li) => {
      const [inL, inR] = leafSides(info, edge, curves, m, n, clusterOf, positions);
      leftValues[li] = inL;
      rightValues[li] = inR;
    });
    const inL = evaluate(node, leafIndex, leftValues);
    const inR = evaluate(node, leafIndex, rightValues);
    if (inL !== inR) {
      boundary.push({
        edge,
        from: inL ? edge.v0 : edge.v1,
        to: inL ? edge.v1 : edge.v0,
        forward: inL,
      });
    }
  }

  const loops = linkLoops(boundary, curves, vertices);
  // Chord and circular-segment terms are summed apart so that small segments keep their bits.
  let chords = 0;
  let segments = 0;
  let bbox: Bounds | null = null;
  const out: Loop[] = loops.map((loop) =>
    loop.map((d) => {
      const e = toEdge(d, curves, vertices);
      const sweep = d.forward ? d.edge.sweep : -d.edge.sweep;
      chords += cross(e.from, e.to) / 2;
      if (e.kind === 'arc') {
        segments += (e.r * e.r * sweepMinusSin(sweep)) / 2;
      }
      bbox = mergeBox(bbox, edgeBounds(e, sweep));
      return e;
    }),
  );
  return { loops: out, area: chords + segments, bbox };
}

function collectLeaves(node: RegionNode, leaves: Leaf[], index: Map<RegionNode, number>): void {
  if (
    node.kind === 'disc' ||
    node.kind === 'half' ||
    node.kind === 'poly' ||
    node.kind === 'chain'
  ) {
    if (!index.has(node)) {
      index.set(node, leaves.length);
      leaves.push(node);
    }
    return;
  }
  for (const child of node.children) {
    collectLeaves(child, leaves, index);
  }
}

function evaluate(
  node: RegionNode,
  index: Map<RegionNode, number>,
  values: readonly boolean[],
): boolean {
  switch (node.kind) {
    case 'disc':
    case 'half':
    case 'poly':
    case 'chain':
      return values[index.get(node) ?? -1] === true;
    case 'union':
      return node.children.some((c) => evaluate(c, index, values));
    case 'intersect':
      return node.children.every((c) => evaluate(c, index, values));
    case 'subtract': {
      const [first, ...rest] = node.children;
      return (
        first !== undefined &&
        evaluate(first, index, values) &&
        !rest.some((c) => evaluate(c, index, values))
      );
    }
  }
}

function sameSource(a: Source, b: Source): boolean {
  return a.id === b.id && a.copy === b.copy;
}

/** Merge coincident circles and lines into one curve that keeps every source. */
function mergeCurves(
  raw: readonly { geom: CurveGeom; source: Source }[],
  box: Bounds,
): { curves: Curve[]; curveOfRaw: number[] } {
  const parent = raw.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while ((parent[r] ?? r) !== r) {
      r = parent[r] ?? r;
    }
    return r;
  };
  const clips = raw.map((c) => (c.geom.kind === 'line' ? clipLine(c.geom.line, box) : null));
  for (let i = 0; i < raw.length; i++) {
    for (let j = i + 1; j < raw.length; j++) {
      const a = raw[i]?.geom;
      const b = raw[j]?.geom;
      if (a === undefined || b === undefined) {
        continue;
      }
      let same = false;
      if (a.kind === 'circle' && b.kind === 'circle') {
        same = intersectCircleCircle(a.circle, b.circle).kind === 'coincident';
      } else if (a.kind === 'line' && b.kind === 'line') {
        same = clipWithin(clips[i] ?? null, b.line) || clipWithin(clips[j] ?? null, a.line);
      }
      if (same) {
        parent[find(j)] = find(i);
      }
    }
  }
  const curves: Curve[] = [];
  const curveOfRoot = new Map<number, number>();
  const curveOfRaw = raw.map((c, i) => {
    const root = find(i);
    let id = curveOfRoot.get(root);
    if (id === undefined) {
      const rootGeom = raw[root]?.geom ?? c.geom;
      id = curves.push({ geom: rootGeom, sources: [] }) - 1;
      curveOfRoot.set(root, id);
    }
    const sources = curves[id]?.sources;
    if (sources !== undefined && !sources.some((s) => sameSource(s, c.source))) {
      sources.push(c.source);
    }
    return id;
  });
  return { curves, curveOfRaw };
}

function clipWithin(clip: [Vec, Vec] | null, line: Line): boolean {
  return (
    clip !== null &&
    Math.abs(signedDistance(line, clip[0])) <= SNAP &&
    Math.abs(signedDistance(line, clip[1])) <= SNAP
  );
}

/** End points of the part of a line inside a box, or null when it misses the box. */
function clipLine(line: Line, box: Bounds): [Vec, Vec] | null {
  let t0 = Number.NEGATIVE_INFINITY;
  let t1 = Number.POSITIVE_INFINITY;
  const axes: [number, number, number, number][] = [
    [line.p.x, line.d.x, box.minX, box.maxX],
    [line.p.y, line.d.y, box.minY, box.maxY],
  ];
  for (const [p, d, lo, hi] of axes) {
    if (d === 0) {
      if (p < lo || p > hi) {
        return null;
      }
      continue;
    }
    const ta = (lo - p) / d;
    const tb = (hi - p) / d;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
  }
  if (t0 > t1) {
    return null;
  }
  return [add(line.p, scale(line.d, t0)), add(line.p, scale(line.d, t1))];
}

function intersectCurves(a: CurveGeom, b: CurveGeom): Vec[] {
  if (a.kind === 'circle') {
    return b.kind === 'circle' ? circleCircle(a.circle, b.circle) : circleLine(a.circle, b.line);
  }
  return b.kind === 'circle' ? circleLine(b.circle, a.line) : lineLine(a.line, b.line);
}

function circleCircle(a: Circle, b: Circle): Vec[] {
  const res = intersectCircleCircle(a, b);
  if (res.kind === 'tangent') {
    return [res.point];
  }
  if (res.kind !== 'two') {
    return [];
  }
  return [...res.points];
}

function circleLine(c: Circle, line: Line): Vec[] {
  const res = intersectCircleLine(c, line);
  if (res.kind === 'tangent') {
    return [res.point];
  }
  if (res.kind !== 'two') {
    return [];
  }
  return [...res.points];
}

function lineLine(a: Line, b: Line): Vec[] {
  const res = intersectLineLine(a, b);
  if (res.kind === 'point') {
    return [res.point];
  }
  // Lines that agree near their anchor points but were not merged inside the box still cross.
  const denom = cross(a.d, b.d);
  if (res.kind === 'coincident' && Math.abs(denom) > EPS) {
    return [add(a.p, scale(a.d, cross(sub(b.p, a.p), b.d) / denom))];
  }
  return [];
}

/** Union-find of points closer than SNAP; returns a dense cluster id per point. */
function clusterPoints(points: readonly Vec[]): number[] {
  const parent = points.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while ((parent[r] ?? r) !== r) {
      r = parent[r] ?? r;
    }
    parent[i] = r;
    return r;
  };
  const grid = new Map<string, number[]>();
  points.forEach((p, i) => {
    const gx = Math.floor(p.x / SNAP);
    const gy = Math.floor(p.y / SNAP);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          const q = points[j];
          if (q !== undefined && distance(p, q) <= SNAP) {
            parent[find(j)] = find(i);
          }
        }
      }
    }
    const key = `${gx},${gy}`;
    const cell = grid.get(key);
    if (cell === undefined) {
      grid.set(key, [i]);
    } else {
      cell.push(i);
    }
  });
  const dense = new Map<number, number>();
  return points.map((_, i) => {
    const root = find(i);
    let id = dense.get(root);
    if (id === undefined) {
      id = dense.size;
      dense.set(root, id);
    }
    return id;
  });
}

/** Give a circle at least two vertices so that no edge starts and ends at the same vertex. */
function ensureTwoVertices(circle: Circle, ids: number[], vertices: Vertex[], curve: number): void {
  const c = centerOf(circle);
  const addVertex = (p: Vec): void => {
    ids.push(vertices.push({ p, curves: new Set([curve]) }) - 1);
  };
  if (ids.length === 0) {
    addVertex({ x: c.x + circle.r, y: c.y });
    addVertex({ x: c.x - circle.r, y: c.y });
  } else if (ids.length === 1) {
    const p = vertices[ids[0] ?? 0]?.p ?? { x: c.x + circle.r, y: c.y };
    const v = sub(p, c);
    addVertex(sub(c, scale(v, circle.r / length(v))));
  }
}

function angleOn(circle: Circle, p: Vec): number {
  return Math.atan2(p.y - circle.cy, p.x - circle.cx);
}

/** Sweep between two vertices from their vectors, choosing the turn nearest the sorted angles. */
function arcSweep(
  circle: Circle,
  p0: Vec | undefined,
  p1: Vec | undefined,
  nominal: number,
): number {
  if (p0 === undefined || p1 === undefined) {
    return nominal;
  }
  const u0 = sub(p0, centerOf(circle));
  const u1 = sub(p1, centerOf(circle));
  const e = Math.atan2(cross(u0, u1), dot(u0, u1));
  let best = e;
  for (const cand of [e + TWO_PI, e - TWO_PI]) {
    if (Math.abs(cand - nominal) < Math.abs(best - nominal)) {
      best = cand;
    }
  }
  return best;
}

/** Midpoint of an atomic edge and the curve's travel direction there. */
function midpointOf(
  geom: CurveGeom,
  edge: AtomicEdge,
  vertices: readonly Vertex[],
): { m: Vec; d: Vec } {
  const p0 = vertices[edge.v0]?.p;
  if (geom.kind === 'circle') {
    const c = geom.circle;
    const a = (p0 === undefined ? 0 : angleOn(c, p0)) + edge.sweep / 2;
    const u = { x: Math.cos(a), y: Math.sin(a) };
    return { m: add(centerOf(c), scale(u, c.r)), d: leftNormal(u) };
  }
  const line = geom.line;
  const t0 = p0 === undefined ? 0 : dot(line.d, sub(p0, line.p));
  return { m: add(line.p, scale(line.d, t0 + edge.length / 2)), d: line.d };
}

/**
 * Membership of a leaf on the left and right of an edge at its midpoint. Leaves are taken with
 * their normalized geometry: discs and halves on their merged curve, polygons on snapped vertices.
 */
function leafSides(
  info: LeafInfo,
  edge: AtomicEdge,
  curves: readonly Curve[],
  m: Vec,
  n: Vec,
  clusterOf: readonly number[],
  positions: readonly Map<number, number>[],
): [boolean, boolean] {
  const leaf = info.node;
  const own = curves[info.curve]?.geom;
  if (leaf.kind === 'disc') {
    if (info.curve === edge.curve) {
      return [true, false];
    }
    const c = own?.kind === 'circle' ? own.circle : leaf.circle;
    const inside = Math.hypot(m.x - c.cx, m.y - c.cy) < c.r;
    return [inside, inside];
  }
  if (leaf.kind === 'half') {
    const line = own?.kind === 'line' ? own.line : leaf.line;
    const left = dot(leaf.line.d, line.d) > 0 === (leaf.sign === 1);
    if (info.curve === edge.curve) {
      return [left, !left];
    }
    const sd = signedDistance(line, m);
    const inside = left ? sd > 0 : sd < 0;
    return [inside, inside];
  }
  if (leaf.kind === 'chain') {
    return chainSides(info, edge, curves, m, clusterOf, positions);
  }
  const pos = positions[edge.curve];
  let through = 0;
  let carried = false;
  for (const pe of info.edges) {
    if (pe.curve !== edge.curve || pos === undefined) {
      continue;
    }
    const ka = pos.get(clusterOf[pe.pa] ?? -1);
    const kb = pos.get(clusterOf[pe.pb] ?? -1);
    if (ka === undefined || kb === undefined) {
      continue;
    }
    if (Math.min(ka, kb) <= edge.index && edge.index < Math.max(ka, kb)) {
      carried = true;
      // An edge along the travel direction crosses the normal ray right to left.
      through += kb > ka ? -1 : 1;
    }
  }
  if (!carried) {
    const inside = rayWinding(info.edges, -1, m, n) !== 0;
    return [inside, inside];
  }
  const left = rayWinding(info.edges, edge.curve, m, n);
  return [left !== 0, left + through !== 0];
}

/**
 * Chain membership on both sides of an edge. A piece carries the edge when the edge lies between
 * the positions of the piece's entry and exit joints on the merged curve: counter-clockwise from
 * entry to exit for a counter-clockwise arc, from exit to entry for a clockwise one, between the
 * two for a line. The inside is on the left of the piece's travel.
 */
function chainSides(
  info: LeafInfo,
  edge: AtomicEdge,
  curves: readonly Curve[],
  m: Vec,
  clusterOf: readonly number[],
  positions: readonly Map<number, number>[],
): [boolean, boolean] {
  const pos = positions[edge.curve];
  const circle = curves[edge.curve]?.geom.kind === 'circle';
  for (const piece of info.pieces) {
    if (piece.curve !== edge.curve || pos === undefined) {
      continue;
    }
    const ka = pos.get(clusterOf[piece.entry] ?? -1);
    const kb = pos.get(clusterOf[piece.exit] ?? -1);
    if (ka === undefined || kb === undefined) {
      continue;
    }
    if (circle) {
      const count = pos.size;
      const [lo, hi] = piece.ccw ? [ka, kb] : [kb, ka];
      if ((edge.index - lo + count) % count < (hi - lo + count) % count) {
        return piece.ccw ? [true, false] : [false, true];
      }
    } else if (Math.min(ka, kb) <= edge.index && edge.index < Math.max(ka, kb)) {
      return kb > ka ? [true, false] : [false, true];
    }
  }
  const inside = contains(info.node, m);
  return [inside, inside];
}

/** Signed crossings of the ray from `m` along `n` with polygon edges off the given curve (-1: none). */
function rayWinding(edges: readonly PolyEdge[], curve: number, m: Vec, n: Vec): number {
  let w = 0;
  for (const pe of edges) {
    if (pe.curve === curve) {
      continue;
    }
    const sa = cross(n, sub(pe.a, m));
    const sb = cross(n, sub(pe.b, m));
    const ua = sa > 0;
    const ub = sb > 0;
    if (ua === ub) {
      continue;
    }
    const p = add(pe.a, scale(sub(pe.b, pe.a), sa / (sa - sb)));
    if (dot(n, sub(p, m)) > 0) {
      w += ub ? 1 : -1;
    }
  }
  return w;
}

/** Point at arc length `s` from the start (or back from the end) of a directed edge. */
function sampleAt(
  e: Directed,
  s: number,
  atStart: boolean,
  curves: readonly Curve[],
  vertices: readonly Vertex[],
): Vec {
  const from = vertices[e.from]?.p ?? { x: 0, y: 0 };
  const to = vertices[e.to]?.p ?? from;
  const geom = curves[e.edge.curve]?.geom;
  if (geom === undefined || geom.kind === 'line') {
    const dir = scale(sub(to, from), 1 / distance(from, to));
    return atStart ? add(from, scale(dir, s)) : sub(to, scale(dir, s));
  }
  const c = geom.circle;
  const sign = e.forward ? 1 : -1;
  const a = atStart ? angleOn(c, from) + (sign * s) / c.r : angleOn(c, to) - (sign * s) / c.r;
  return { x: c.cx + c.r * Math.cos(a), y: c.cy + c.r * Math.sin(a) };
}

/** Link directed boundary edges into loops, turning clockwise from each incoming edge. */
function linkLoops(
  boundary: readonly Directed[],
  curves: readonly Curve[],
  vertices: readonly Vertex[],
): Directed[][] {
  const outgoing = new Map<number, number[]>();
  const shortest = new Map<number, number>();
  boundary.forEach((e, i) => {
    const list = outgoing.get(e.from);
    if (list === undefined) {
      outgoing.set(e.from, [i]);
    } else {
      list.push(i);
    }
    for (const v of [e.from, e.to]) {
      shortest.set(v, Math.min(shortest.get(v) ?? Number.POSITIVE_INFINITY, e.edge.length));
    }
  });
  const next = boundary.map((e) => {
    const options = outgoing.get(e.to) ?? [];
    if (options.length <= 1) {
      return options[0] ?? -1;
    }
    const v = vertices[e.to]?.p ?? { x: 0, y: 0 };
    const s = Math.min(MAX_SAMPLE_ARC, (shortest.get(e.to) ?? 0) / 2);
    const azimuth = (p: Vec): number => Math.atan2(p.y - v.y, p.x - v.x);
    const incoming = azimuth(sampleAt(e, s, false, curves, vertices));
    let best = -1;
    let bestTurn = Number.POSITIVE_INFINITY;
    for (const o of options) {
      const out = boundary[o];
      if (out === undefined) {
        continue;
      }
      let turn = incoming - azimuth(sampleAt(out, s, true, curves, vertices));
      while (turn <= 0) {
        turn += TWO_PI;
      }
      while (turn > TWO_PI) {
        turn -= TWO_PI;
      }
      if (turn < bestTurn) {
        bestTurn = turn;
        best = o;
      }
    }
    return best;
  });

  const used = new Uint8Array(boundary.length);
  const loops: Directed[][] = [];
  let left = 0;
  for (let start = 0; start < boundary.length; start++) {
    if (used[start] === 1) {
      continue;
    }
    const seq: number[] = [];
    let cur = start;
    let closed = false;
    while (cur !== -1 && used[cur] !== 1) {
      used[cur] = 1;
      seq.push(cur);
      cur = next[cur] ?? -1;
      if (cur === start) {
        closed = true;
        break;
      }
    }
    if (!closed) {
      left += seq.length;
      continue;
    }
    const loop: Directed[] = [];
    for (const i of seq) {
      const e = boundary[i];
      if (e !== undefined) {
        loop.push(e);
      }
    }
    loops.push(loop);
  }
  if (left > 0) {
    throw new ArrangementInvariantError(left);
  }
  return loops;
}

function toEdge(e: Directed, curves: readonly Curve[], vertices: readonly Vertex[]): Edge {
  const curve = curves[e.edge.curve];
  const from = vertices[e.from]?.p ?? { x: 0, y: 0 };
  const to = vertices[e.to]?.p ?? from;
  const sources = curve?.sources ?? [];
  if (curve === undefined || curve.geom.kind === 'line') {
    return { kind: 'segment', from, to, sources };
  }
  const { cx, cy, r } = curve.geom.circle;
  return { kind: 'arc', cx, cy, r, from, to, ccw: e.forward, sources };
}

/** `x - sin x`, by series where the subtraction would cancel. */
function sweepMinusSin(x: number): number {
  if (Math.abs(x) > 0.1) {
    return x - Math.sin(x);
  }
  const x2 = x * x;
  return ((x * x2) / 6) * (1 - (x2 / 20) * (1 - (x2 / 42) * (1 - x2 / 72)));
}

/** Bounds of an edge; `sweep` is signed by the arc's direction. */
function edgeBounds(e: Edge, sweep: number): Bounds {
  let box: Bounds = {
    minX: Math.min(e.from.x, e.to.x),
    minY: Math.min(e.from.y, e.to.y),
    maxX: Math.max(e.from.x, e.to.x),
    maxY: Math.max(e.from.y, e.to.y),
  };
  if (e.kind === 'segment') {
    return box;
  }
  const start = Math.atan2(e.from.y - e.cy, e.from.x - e.cx);
  for (let k = 0; k < 4; k++) {
    const axis = (k * Math.PI) / 2;
    // Fraction of the sweep at which the arc passes this axis direction.
    let delta = (axis - start) * Math.sign(sweep);
    delta = ((delta % TWO_PI) + TWO_PI) % TWO_PI;
    if (delta < Math.abs(sweep)) {
      const p = { x: e.cx + e.r * Math.cos(axis), y: e.cy + e.r * Math.sin(axis) };
      box = mergeBox(box, { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y });
    }
  }
  return box;
}

function mergeBox(a: Bounds | null, b: Bounds): Bounds {
  if (a === null) {
    return b;
  }
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}
