/**
 * @file Fills and strokes of rings and paths that hold elliptical arcs.
 *
 * A filled ring becomes a region: the ring with every elliptical arc replaced by its chord, united
 * with the ovals of the arcs that bulge out and less the ovals of the arcs that carve in. The whole
 * oval stands in for its arc, so the result holds only when the rest of each oval falls inside the
 * shape (outside it, for a carved arc); {@link fillMatches} checks that on a lattice against the
 * source fill. A stroke is drawn in parts: runs of lines, and each elliptical arc as an `arc` on an
 * oval, when every seam between parts is smooth or caps and joins are round.
 */

import type { Region } from '../spec/schema.js';
import { outlinesOf } from './outline.js';
import type { Vec } from './path.js';
import {
  type Converted,
  closedShape,
  ellipseAt,
  isArc,
  isOvalArc,
  lineShape,
  ovalArcShapes,
  type Piece,
  type ShapeInput,
} from './shapes.js';

/** Whether a point lies inside a shape or region. */
export type InsideTest = (p: Vec) => boolean;

/** A filled ring with elliptical arcs as shapes and a region over them. */
export type Composed = {
  shapes: ShapeInput[];
  region: Region;
  /** Oval id of each elliptical arc of the ring. */
  ovals: Map<Piece, string>;
  /** Inside test of every id the region names; ovals are exact ellipses. */
  tests: Map<string, InsideTest>;
};

type Arc = Extract<Piece, { kind: 'arc' }>;

/** Chord rings whose area is at most this are not composed. */
const MIN_AREA = 1e-6;
/** Points along each arc when a ring is traced for the fill check. */
const TRACE_STEPS = 64;
/** Lattice of the fill check: spacing, and lattice points within this of the source edge. */
const LATTICE_STEP = 0.25;
const LATTICE_EDGE = 0.05;
const HALF = 12;
/** Largest turn at a seam that still counts as smooth, in degrees. */
const SMOOTH_SEAM = 1;
const MAX_OPERANDS = 16;

const isEllipse = (p: Piece): p is Arc => isArc(p) && !p.circular;

/** Closed polygon along a ring; each arc is cut into {@link TRACE_STEPS} chords. */
export function trace(ring: readonly Piece[]): Vec[] {
  const out: Vec[] = [];
  for (const p of ring) {
    if (!isArc(p)) {
      out.push(p.a);
      continue;
    }
    for (let k = 0; k < TRACE_STEPS; k++) {
      out.push(ellipseAt(p, p.t1 + (p.dt * k) / TRACE_STEPS).p);
    }
  }
  return out;
}

function signedArea(poly: readonly Vec[]): number {
  let sum = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j] as Vec;
    const b = poly[i] as Vec;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** Winding number of a closed polygon around `p`. */
function winding(p: Vec, poly: readonly Vec[]): number {
  let w = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j] as Vec;
    const b = poly[i] as Vec;
    const side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
    if (a.y <= p.y && b.y > p.y && side > 0) {
      w++;
    } else if (a.y > p.y && b.y <= p.y && side < 0) {
      w--;
    }
  }
  return w;
}

/** Inside test of a closed polygon by its winding number. */
export const polygonTest =
  (poly: readonly Vec[]): InsideTest =>
  (p) =>
    winding(p, poly) !== 0;

/** The oval an elliptical arc lies on, without an id. */
const ovalOf = (arc: Arc): Omit<Extract<ShapeInput, { type: 'oval' }>, 'id'> => {
  const [oval] = ovalArcShapes(arc, '').shapes;
  const { id: _, ...rest } = oval as Extract<ShapeInput, { type: 'oval' }>;
  return rest;
};

const ellipseTest =
  (arc: Arc): InsideTest =>
  (p) => {
    const dx = p.x - arc.c.x;
    const dy = p.y - arc.c.y;
    const cos = Math.cos(arc.phi);
    const sin = Math.sin(arc.phi);
    const u = (cos * dx + sin * dy) / arc.rx;
    const v = (-sin * dx + cos * dy) / arc.ry;
    return u * u + v * v < 1;
  };

/**
 * Writes one oval per distinct ellipse, `<id>e<k>`, into `shapes`, `ovals` and `tests`; arcs
 * whose oval is already in `ovals` keep it.
 */
function placeOvals(
  arcs: readonly Arc[],
  id: string,
  shapes: ShapeInput[],
  ovals: Map<Piece, string>,
  tests?: Map<string, InsideTest>,
): void {
  const byKey = new Map<string, string>();
  for (const arc of arcs) {
    if (ovals.has(arc)) {
      continue;
    }
    const oval = ovalOf(arc);
    const key = JSON.stringify(oval);
    let oid = byKey.get(key);
    if (oid === undefined) {
      oid = `${id}e${byKey.size}`;
      byKey.set(key, oid);
      shapes.push({ id: oid, ...oval });
      tests?.set(oid, ellipseTest(arc));
    }
    ovals.set(arc, oid);
  }
}

/**
 * A filled ring with elliptical arcs as its chord ring (written as `closedShape` or `outlinesOf`
 * would) plus ovals `<id>e<k>`: arcs turning with the chord ring are united, the others are
 * subtracted. Null when an arc cannot be an oval, the chord ring has no area or cannot be written.
 */
export function composeRing(ring: readonly Piece[], id: string): Composed | null {
  const arcs = ring.filter(isEllipse);
  if (arcs.length === 0 || !arcs.every(isOvalArc)) {
    return null;
  }
  const chords = ring.map((p): Piece => (isEllipse(p) ? { kind: 'line', a: p.a, b: p.b } : p));
  const chordPoly = trace(chords);
  const area = signedArea(chordPoly);
  if (Math.abs(area) <= MIN_AREA) {
    return null;
  }
  const shapes: ShapeInput[] = [];
  let ids: string[];
  const made = closedShape(chords, id);
  if (typeof made !== 'string') {
    if (!made.area) {
      return null;
    }
    shapes.push(...made.shapes);
    ids = made.ids;
  } else {
    // Every outline id is judged by the chord polygon, so no ring may be cut or capped.
    const outlines = made === 'mixed path' ? outlinesOf(chords, id, false) : null;
    if (outlines === null || !('shapes' in outlines)) {
      return null;
    }
    shapes.push(...outlines.shapes);
    ids = outlines.outlines.map((o) => o.id);
  }
  const tests = new Map<string, InsideTest>();
  const inChords = polygonTest(chordPoly);
  for (const k of ids) {
    tests.set(k, inChords);
  }
  const ovals = new Map<Piece, string>();
  placeOvals(arcs, id, shapes, ovals, tests);
  const outer: string[] = [];
  const inner: string[] = [];
  for (const arc of arcs) {
    const list = Math.sign(arc.dt) === Math.sign(area) ? outer : inner;
    const oid = ovals.get(arc) as string;
    if (!list.includes(oid)) {
      list.push(oid);
    }
  }
  const grown = [...ids, ...outer];
  if (grown.length > MAX_OPERANDS || inner.length >= MAX_OPERANDS) {
    return null;
  }
  const base: Region = grown.length === 1 ? (grown[0] as string) : { union: grown };
  const region: Region = inner.length === 0 ? base : { subtract: [base, ...inner] };
  return { shapes, region, ovals, tests };
}

/** Whether `p` lies in `region`, each id judged by its entry in `tests`. */
export function regionHas(region: Region, tests: ReadonlyMap<string, InsideTest>, p: Vec): boolean {
  if (typeof region === 'string') {
    const test = tests.get(region);
    if (test === undefined) {
      throw new Error(`no inside test for ${region}`);
    }
    return test(p);
  }
  if ('union' in region) {
    return region.union.some((r) => regionHas(r, tests, p));
  }
  if ('intersect' in region) {
    return region.intersect.every((r) => regionHas(r, tests, p));
  }
  if ('subtract' in region) {
    const [head, ...rest] = region.subtract;
    return (
      head !== undefined && regionHas(head, tests, p) && !rest.some((r) => regionHas(r, tests, p))
    );
  }
  throw new Error('half-planes are not composed');
}

function nearEdge(p: Vec, polys: readonly Vec[][]): boolean {
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j] as Vec;
      const b = poly[i] as Vec;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t =
        len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      if (Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) <= LATTICE_EDGE) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Whether `region` covers the same lattice points of the canvas as the fill of `rings` under the
 * given rule. Points within {@link LATTICE_EDGE} of a ring are not compared.
 */
export function fillMatches(
  rings: readonly (readonly Piece[])[],
  evenOdd: boolean,
  region: Region,
  tests: ReadonlyMap<string, InsideTest>,
): boolean {
  const polys = rings.map(trace);
  const count = Math.round((2 * HALF) / LATTICE_STEP);
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < count; j++) {
      const p = { x: -HALF + (i + 0.5) * LATTICE_STEP, y: -HALF + (j + 0.5) * LATTICE_STEP };
      const w = polys.reduce((s, poly) => s + winding(p, poly), 0);
      const source = evenOdd ? w % 2 !== 0 : w !== 0;
      if (source !== regionHas(region, tests, p) && !nearEdge(p, polys)) {
        return false;
      }
    }
  }
  return true;
}

/** Unit direction of a piece at its start (`end` false) or end, along the path. */
function heading(p: Piece, end: boolean): Vec {
  let d: Vec;
  if (isArc(p)) {
    const t = ellipseAt(p, end ? p.t1 + p.dt : p.t1).d;
    d = p.dt > 0 ? t : { x: -t.x, y: -t.y };
  } else {
    d = { x: p.b.x - p.a.x, y: p.b.y - p.a.y };
  }
  const len = Math.hypot(d.x, d.y);
  return { x: d.x / len, y: d.y / len };
}

const smooth = (p: Piece, q: Piece): boolean => {
  const u = heading(p, true);
  const v = heading(q, false);
  const turn = Math.abs(Math.atan2(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y));
  return (turn * 180) / Math.PI <= SMOOTH_SEAM;
};

/**
 * A stroke of lines and elliptical arcs as parts `<id>a`, `<id>b`, ...: each run of lines a
 * `line` or `polyline`, each arc an `arc` on its oval from `ovals`, or on a new oval `<id>e<k>`
 * written first. A closed ring starts after an arc so no run wraps. Null when the stroke holds a
 * circular arc or an arc that cannot be an oval, or a seam is not smooth and `round` is false.
 */
export function strokeParts(
  pieces: readonly Piece[],
  id: string,
  closed: boolean,
  round: boolean,
  ovals: ReadonlyMap<Piece, string> = new Map(),
): Converted | null {
  const arcs = pieces.filter(isArc);
  const first = pieces.findIndex(isArc);
  if (arcs.length === 0 || !arcs.every(isOvalArc)) {
    return null;
  }
  const path = closed ? [...pieces.slice(first + 1), ...pieces.slice(0, first + 1)] : [...pieces];
  const parts: Piece[][] = [];
  for (const p of path) {
    const last = parts[parts.length - 1];
    if (!isArc(p) && last !== undefined && !isArc(last[0] as Piece)) {
      last.push(p);
    } else {
      parts.push([p]);
    }
  }
  const seams = parts.length - (closed ? 0 : 1);
  for (let k = 0; k < seams && !round; k++) {
    const here = parts[k] as Piece[];
    const next = parts[(k + 1) % parts.length] as Piece[];
    if (!smooth(here[here.length - 1] as Piece, next[0] as Piece)) {
      return null;
    }
  }
  const shapes: ShapeInput[] = [];
  const placed = new Map(ovals);
  placeOvals(arcs, id, shapes, placed);
  const ids: string[] = [];
  for (const part of parts) {
    const pid = `${id}${String.fromCharCode(97 + ids.length)}`;
    const head = part[0] as Piece;
    if (isArc(head)) {
      const arc = ovalArcShapes(head, pid).shapes[1] as Extract<ShapeInput, { type: 'arc' }>;
      shapes.push({ ...arc, on: placed.get(head) as string });
    } else {
      const line = lineShape([...part.map((l) => l.a), (part[part.length - 1] as Piece).b], pid);
      if (typeof line === 'string') {
        return null;
      }
      shapes.push(line);
    }
    ids.push(pid);
  }
  return { shapes, ids, area: false };
}
