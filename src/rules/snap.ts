import type { Vec } from '../geom/primitives.js';
import { distance, lineThrough, SNAP, signedDistance } from '../geom/primitives.js';
import type { Shape, SpecInput } from '../spec/schema.js';
import { pointSlots, RULES, stepAxis } from './lint.js';

/** A shape whose original value was kept because snapping it would collapse the figure. */
export type SnapKept = {
  id: string;
  reason:
    | 'zero length'
    | 'coincident vertices'
    | 'collinear'
    | 'flat rect'
    | 'steps too wide'
    | 'oval ratio';
};

/** The snapped spec, the largest move of a point or radius, the largest seam gap left, and what was kept. */
export type SnapResult = { spec: SpecInput; moved: number; gap: number; kept: SnapKept[] };

type InShape = SpecInput['shapes'][number];
type Xy = [number, number];
type Mapping = { from: Xy; to: Xy };

const GRID = RULES.off_grid.gridStep.icon;
// Half side of the icon canvas, in modules.
const CANVAS_HALF = 12;
const VERTEX_MATCH = 1e-6;
const SEAM_MATCH = 1e-3;
const ANGLE_SNAP = 0.5;
const OVAL_RATIO_MAX = 4;
const TOLERANCE = 1e-9;

// Rounds half away from zero, so mirrored inputs stay mirrored; never returns -0.
const roundGrid = (v: number): number => Math.sign(v) * Math.round(Math.abs(v) / GRID) * GRID || 0;
const roundRadius = (v: number): number => Math.max(GRID, roundGrid(v));
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;
const wrapDegrees = (deg: number): number => ((deg % 360) + 360) % 360;
const matches = (a: Xy, b: Xy, tolerance: number): boolean =>
  Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;
const toVec = ([x, y]: Xy): Vec => ({ x, y });

// Literal coordinate arrays of the slots `off_grid` checks (arc ends are exempt there too); live references.
function literalSlots(shape: InShape): Xy[] {
  if (shape.type === 'arc' || shape.type === 'tangent_circle' || shape.type === 'outline') {
    return [];
  }
  return pointSlots(shape as Shape).flatMap(({ point }) => (Array.isArray(point) ? [point] : []));
}

// The numeric radii `off_grid` checks, as [key, value] pairs.
function radiusKeys(shape: InShape): { key: 'r' | 'rx' | 'ry'; value: number }[] {
  const out: { key: 'r' | 'rx' | 'ry'; value: number }[] = [];
  const add = (key: 'r' | 'rx' | 'ry', value: unknown): void => {
    if (typeof value === 'number') {
      out.push({ key, value });
    }
  };
  if (shape.type === 'circle' || shape.type === 'tangent_circle' || shape.type === 'rect') {
    add('r', shape.r);
  } else if (shape.type === 'oval') {
    add('rx', shape.rx);
    add('ry', shape.ry);
  }
  return out;
}

function literalThrough(shape: InShape): Xy[] | null {
  if (shape.type !== 'polyline' && shape.type !== 'points') {
    return null;
  }
  const arrays = shape.through.filter((p): p is Xy => Array.isArray(p));
  return arrays.length === shape.through.length ? arrays : null;
}

// Gives the polylines that `uneven_steps` would flag after plain rounding equal steps; records the vertex mapping.
function equalise(shapes: InShape[], table: Mapping[], kept: SnapKept[]): void {
  for (const shape of shapes) {
    const vertices = shape.type === 'polyline' ? literalThrough(shape) : null;
    if (vertices === null) {
      continue;
    }
    const found = stepAxis(vertices.map(toVec));
    if (found === null) {
      continue;
    }
    const a = found.axis === 'x' ? 0 : 1;
    const b = 1 - a;
    const rounded = vertices.map(([x, y]): Xy => [roundGrid(x), roundGrid(y)]);
    const steps = rounded.slice(1).map((v, k) => Math.abs(v[a] - (rounded[k] as Xy)[a]));
    if (Math.max(...steps) - Math.min(...steps) <= TOLERANCE) {
      continue;
    }
    const n = vertices.length - 1;
    const first = (vertices[0] as Xy)[a];
    const last = (vertices[n] as Xy)[a];
    const dir = Math.sign(last - first);
    const step = Math.max(GRID, roundGrid(Math.abs(last - first) / n));
    if (step * n > 2 * CANVAS_HALF) {
      kept.push({ id: shape.id, reason: 'steps too wide' });
      continue;
    }
    let start = roundGrid((first + last) / 2 - (dir * step * n) / 2);
    const end = start + dir * step * n;
    if (Math.max(start, end) > CANVAS_HALF) {
      start -= Math.max(start, end) - CANVAS_HALF;
    } else if (Math.min(start, end) < -CANVAS_HALF) {
      start += -CANVAS_HALF - Math.min(start, end);
    }
    vertices.forEach((old, i) => {
      if (table.some((entry) => matches(entry.from, old, VERTEX_MATCH))) {
        return;
      }
      const to: Xy = [0, 0];
      to[a] = start + dir * i * step;
      to[b] = roundGrid(old[b] as number);
      table.push({ from: [old[0], old[1]], to });
    });
  }
}

function snapPoints(shape: InShape, table: Mapping[]): void {
  for (const xy of literalSlots(shape)) {
    const mapped = table.find((entry) => matches(entry.from, xy, VERTEX_MATCH));
    const [x, y] = mapped === undefined ? [roundGrid(xy[0]), roundGrid(xy[1])] : mapped.to;
    xy[0] = x;
    xy[1] = y;
  }
}

function snapRadii(shape: InShape): void {
  if (shape.type === 'circle' || shape.type === 'tangent_circle' || shape.type === 'rect') {
    if (typeof shape.r === 'number') {
      shape.r = roundRadius(shape.r);
    }
  } else if (shape.type === 'oval') {
    if (typeof shape.rx === 'number') {
      shape.rx = roundRadius(shape.rx);
    }
    if (typeof shape.ry === 'number') {
      shape.ry = roundRadius(shape.ry);
    }
  }
}

function isCollinear(vertices: readonly Xy[]): boolean {
  const points = vertices.map(toVec);
  const head = points[0];
  if (head === undefined) {
    return false;
  }
  const far = points.reduce(
    (best, v) => (distance(v, head) > distance(best, head) ? v : best),
    head,
  );
  if (distance(head, far) <= SNAP) {
    return false;
  }
  const base = lineThrough(head, far);
  return Math.max(...points.map((v) => Math.abs(signedDistance(base, v)))) <= SNAP;
}

// Handles figures the rounding collapsed. Returns the circle that replaces the shape, if any.
function squash(
  shape: InShape,
  original: InShape,
  kept: SnapKept[],
): { shape: InShape; circle: InShape | null } {
  const keep = (reason: SnapKept['reason']): { shape: InShape; circle: null } => {
    kept.push({ id: shape.id, reason });
    return { shape: structuredClone(original), circle: null };
  };
  const unchanged = { shape, circle: null };
  switch (shape.type) {
    case 'line': {
      const [from, to] = [shape.from, shape.to];
      return Array.isArray(from) && Array.isArray(to) && matches(from, to, SNAP)
        ? keep('zero length')
        : unchanged;
    }
    case 'polyline':
    case 'points': {
      const through = shape.through;
      const count = shape.type === 'points' ? through.length : through.length - 1;
      for (let k = 0; k < count; k++) {
        const here = through[k];
        const next = through[(k + 1) % through.length];
        if (Array.isArray(here) && Array.isArray(next) && matches(here, next, SNAP)) {
          return keep('coincident vertices');
        }
      }
      const literal = literalThrough(shape);
      return shape.type === 'points' && literal !== null && isCollinear(literal)
        ? keep('collinear')
        : unchanged;
    }
    case 'rect': {
      const [a, b] = shape.corners;
      if (!Array.isArray(a) || !Array.isArray(b)) {
        return unchanged;
      }
      const width = Math.abs(b[0] - a[0]);
      const height = Math.abs(b[1] - a[1]);
      if (width <= TOLERANCE || height <= TOLERANCE) {
        return keep('flat rect');
      }
      if (typeof shape.r !== 'number') {
        return unchanged;
      }
      const half = Math.min(width, height) / 2;
      if (shape.r > half + TOLERANCE) {
        const clamped = Math.floor(half / GRID + TOLERANCE) * GRID;
        if (clamped > 0) {
          shape.r = clamped;
        } else {
          delete shape.r;
        }
      }
      if (
        shape.r !== undefined &&
        Math.abs(width - height) <= TOLERANCE &&
        Math.abs(width - 2 * shape.r) <= TOLERANCE
      ) {
        const center: Xy = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        return { shape, circle: { id: shape.id, type: 'circle', center, r: shape.r } };
      }
      return unchanged;
    }
    case 'oval': {
      if (typeof shape.rx !== 'number' || typeof shape.ry !== 'number') {
        return unchanged;
      }
      if (shape.rx === shape.ry) {
        return {
          shape,
          circle: { id: shape.id, type: 'circle', center: shape.center, r: shape.rx },
        };
      }
      if (Math.max(shape.rx, shape.ry) / Math.min(shape.rx, shape.ry) > OVAL_RATIO_MAX) {
        kept.push({ id: shape.id, reason: 'oval ratio' });
        if (original.type === 'oval') {
          shape.rx = original.rx;
          shape.ry = original.ry;
        }
      }
      return unchanged;
    }
    default:
      return unchanged;
  }
}

// Largest move of a point or radius between a shape and its snapped counterpart (same type).
function motion(before: InShape, after: InShape): number {
  const pointsBefore = literalSlots(before);
  const pointsAfter = literalSlots(after);
  const radiiAfter = new Map(radiusKeys(after).map(({ key, value }) => [key, value]));
  const moves = [
    ...pointsBefore.map((p, k) => distance(toVec(p), toVec(pointsAfter[k] as Xy))),
    ...radiusKeys(before).map(({ key, value }) => Math.abs(value - (radiiAfter.get(key) ?? 0))),
  ];
  return Math.max(0, ...moves);
}

// The nearest multiple of 180/n within the snap distance, else the angle itself.
function snapAngle(theta: number): number {
  let best = theta;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const n of RULES.angle.divisors) {
    const unit = 180 / n;
    const candidate = Math.round(theta / unit) * unit;
    const diff = Math.abs(theta - candidate);
    if (diff < bestDiff) {
      best = candidate;
      bestDiff = diff;
    }
  }
  return bestDiff > TOLERANCE && bestDiff <= ANGLE_SNAP + TOLERANCE ? best : theta;
}

type Seam = { before: Xy; after: Xy };
type PlainCircle = { center: Xy; r: number };

function plainCircles(shapes: readonly InShape[]): Map<string, PlainCircle> {
  const out = new Map<string, PlainCircle>();
  for (const shape of shapes) {
    if (shape.type !== 'circle' || typeof shape.r !== 'number') {
      continue;
    }
    const center = shape.center ?? [0, 0];
    if (Array.isArray(center)) {
      out.set(shape.id, { center: [center[0], center[1]], r: shape.r });
    }
  }
  return out;
}

// Re-aims arc ends that met a line or polyline vertex, then snaps ends near an allowed angle.
function snapAngles(originals: readonly InShape[], shapes: InShape[]): { gap: number } {
  const seams: Seam[] = [];
  originals.forEach((shape, i) => {
    if (shape.type === 'line' || shape.type === 'polyline') {
      const after = literalSlots(shapes[i] as InShape);
      literalSlots(shape).forEach((before, k) => {
        seams.push({ before: [before[0], before[1]], after: after[k] as Xy });
      });
    }
  });
  const circlesBefore = plainCircles(originals);
  const circlesAfter = plainCircles(shapes);
  let gap = 0;
  originals.forEach((original, i) => {
    const shape = shapes[i];
    if (original.type !== 'arc' || shape?.type !== 'arc') {
      return;
    }
    const before = circlesBefore.get(original.on);
    const after = circlesAfter.get(original.on);
    const gaps: number[] = [];
    const aim = (theta: number): number => {
      if (before === undefined || after === undefined) {
        return theta;
      }
      const rad = (theta * Math.PI) / 180;
      const end: Xy = [
        before.center[0] + before.r * Math.cos(rad),
        before.center[1] + before.r * Math.sin(rad),
      ];
      const seam = seams.find((s) => matches(s.before, end, SEAM_MATCH));
      if (seam === undefined) {
        return theta;
      }
      const dx = seam.after[0] - after.center[0];
      const dy = seam.after[1] - after.center[1];
      gaps.push(Math.abs(Math.hypot(dx, dy) - after.r));
      const wrapped = round4(wrapDegrees((Math.atan2(dy, dx) * 180) / Math.PI));
      return wrapped >= 360 ? 0 : wrapped;
    };
    const from = typeof original.from === 'number' ? snapAngle(aim(original.from)) : original.from;
    const to = typeof original.to === 'number' ? snapAngle(aim(original.to)) : original.to;
    if (typeof from === 'number' && typeof to === 'number' && wrapDegrees(from - to) <= TOLERANCE) {
      return;
    }
    shape.from = from;
    shape.to = to;
    gap = Math.max(gap, ...gaps);
  });
  return { gap };
}

/**
 * Rounds an icon spec onto the grid and the angle rules, without changing its meaning.
 *
 * Numeric coordinates and radii go to multiples of 0.5 (halves away from zero), polylines that
 * rounding would make uneven get equal steps, coincident vertices move together, figures the
 * rounding collapses are kept as written or change kind, and arc ends that met a line follow
 * their vertex. The input is not modified. Throws when the spec is not an icon.
 */
export function snapSpec(spec: SpecInput): SnapResult {
  if (spec.mode !== 'icon') {
    throw new Error(`snapSpec needs an icon spec (received: mode ${spec.mode}; allowed: icon)`);
  }
  const out = structuredClone(spec);
  const originals = spec.shapes;
  const shapes = out.shapes;
  const kept: SnapKept[] = [];
  const table: Mapping[] = [];

  equalise(shapes, table, kept);
  for (const shape of shapes) {
    snapPoints(shape, table);
    snapRadii(shape);
  }

  let moved = 0;
  const circles = new Map<number, InShape>();
  shapes.forEach((shape, i) => {
    const original = originals[i] as InShape;
    const result = squash(shape, original, kept);
    shapes[i] = result.shape;
    moved = Math.max(moved, motion(original, result.shape));
    if (result.circle !== null) {
      circles.set(i, result.circle);
    }
  });
  for (const [i, circle] of circles) {
    shapes[i] = circle;
  }

  const { gap } = snapAngles(originals, shapes);
  return { spec: out, moved: round4(moved), gap: round4(gap), kept };
}
