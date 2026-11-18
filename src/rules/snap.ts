import type { Chain, ChainInput, ChainSupport } from '../geom/chain.js';
import { buildChain, ChainError, meet } from '../geom/chain.js';
import type { Vec } from '../geom/primitives.js';
import { distance, lineThrough, SNAP, signedDistance } from '../geom/primitives.js';
import { ovalArc } from '../geom/shapes.js';
import type { PaintLayer, Shape, SpecInput } from '../spec/schema.js';
import { paintReferences, shapeReferences } from '../spec/schema.js';
import { isMultiple, pointSlots, RULES, stepAxis } from './lint.js';

/** A shape whose original value was kept because snapping it would collapse the figure. */
export type SnapKept = {
  id: string;
  reason:
    | 'zero length'
    | 'coincident vertices'
    | 'collinear'
    | 'flat rect'
    | 'steps too wide'
    | 'oval ratio'
    | 'arc angle'
    | 'outline';
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
// How far a rect's r may sit from half its shorter side and still count as half-circle ends.
const HALF_CIRCLE_MATCH = 0.05;
const MAX_DIRECTION_FIXES = 16;

// Rounds half away from zero, so mirrored inputs stay mirrored; never returns -0.
const roundGrid = (v: number): number => Math.sign(v) * Math.round(Math.abs(v) / GRID) * GRID || 0;
const roundRadius = (v: number): number => Math.max(GRID, roundGrid(v));
// The grid value nearest `v`, the smaller on a tie, at least one step.
const roundShort = (v: number): number => {
  const low = Math.floor(v / GRID + TOLERANCE);
  return Math.max(GRID, (v / GRID - low <= 0.5 + TOLERANCE ? low : low + 1) * GRID);
};
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;
const round12 = (v: number): number => Math.round(v * 1e12) / 1e12 || 0;
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
function equalise(
  shapes: InShape[],
  table: Mapping[],
  kept: SnapKept[],
  evened: Set<InShape>,
): void {
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
    evened.add(shape);
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
    if (typeof shape.rx === 'number' && typeof shape.ry === 'number') {
      const [rx, ry] = [shape.rx, shape.ry];
      const long = roundRadius(Math.max(rx, ry));
      const short = roundShort((long * Math.min(rx, ry)) / Math.max(rx, ry));
      [shape.rx, shape.ry] = rx >= ry ? [long, short] : [short, long];
    } else if (typeof shape.rx === 'number') {
      shape.rx = roundRadius(shape.rx);
    } else if (typeof shape.ry === 'number') {
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
      const [oa, ob] = original.type === 'rect' ? original.corners : [];
      const roundEnds =
        original.type === 'rect' &&
        typeof original.r === 'number' &&
        Array.isArray(oa) &&
        Array.isArray(ob) &&
        Math.abs(original.r - Math.min(Math.abs(ob[0] - oa[0]), Math.abs(ob[1] - oa[1])) / 2) <=
          HALF_CIRCLE_MATCH;
      if (roundEnds) {
        // Half-circle ends stay half-circle ends, whatever the grid.
        shape.r = half;
      } else if (shape.r > half + TOLERANCE) {
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

const isAllowedAngle = (theta: number): boolean =>
  RULES.angle.divisors.some((n) => isMultiple(theta * n, 180, RULES.angle.tolerance));

// True when `key` beats `best` component by component, ties within TOLERANCE falling through.
function lexLess(key: readonly number[], best: readonly number[]): boolean {
  for (let k = 0; k < key.length; k++) {
    const [a, b] = [key[k] as number, best[k] as number];
    if (a < b - TOLERANCE) {
      return true;
    }
    if (a > b + TOLERANCE) {
      return false;
    }
  }
  return false;
}

// The circle within one grid step of the rounded one that leaves the smallest worst gap at the seam points.
function refit(before: PlainCircle, after: PlainCircle, targets: readonly Xy[]): PlainCircle {
  const offsets = [-GRID, 0, GRID];
  let best = after;
  let bestKey: number[] | null = null;
  for (const dx of offsets) {
    for (const dy of offsets) {
      for (const dr of offsets) {
        const r = after.r + dr;
        if (r < GRID - TOLERANCE) {
          continue;
        }
        const center: Xy = [after.center[0] + dx, after.center[1] + dy];
        const worst = Math.max(
          ...targets.map((t) => Math.abs(Math.hypot(t[0] - center[0], t[1] - center[1]) - r)),
        );
        const key = [
          worst,
          Math.hypot(center[0] - before.center[0], center[1] - before.center[1]),
          Math.abs(r - before.r),
        ];
        if (bestKey === null || lexLess(key, bestKey)) {
          best = { center, r };
          bestKey = key;
        }
      }
    }
  }
  return best;
}

// Line and polyline vertices as before/after pairs.
function vertexSeams(originals: readonly InShape[], shapes: readonly InShape[]): Seam[] {
  const seams: Seam[] = [];
  originals.forEach((shape, i) => {
    if (shape.type === 'line' || shape.type === 'polyline') {
      const after = literalSlots(shapes[i] as InShape);
      literalSlots(shape).forEach((before, k) => {
        seams.push({ before: [before[0], before[1]], after: after[k] as Xy });
      });
    }
  });
  return seams;
}

const positionOf = (circle: PlainCircle, theta: number): Xy => {
  const rad = (theta * Math.PI) / 180;
  return [circle.center[0] + circle.r * Math.cos(rad), circle.center[1] + circle.r * Math.sin(rad)];
};

// The end positions and line vertices of a half turn whose two ends both meet line or polyline vertices.
function halfTurnSeams(
  arc: InShape,
  circles: ReadonlyMap<string, PlainCircle>,
  seams: readonly Seam[],
): { ends: [Xy, Xy]; seams: [Seam, Seam] } | null {
  if (arc.type !== 'arc' || typeof arc.from !== 'number' || typeof arc.to !== 'number') {
    return null;
  }
  const circle = circles.get(arc.on);
  if (circle === undefined || Math.abs(wrapDegrees(arc.to - arc.from) - 180) > SEAM_MATCH) {
    return null;
  }
  const ends: [Xy, Xy] = [positionOf(circle, arc.from), positionOf(circle, arc.to)];
  const s0 = seams.find((s) => matches(s.before, ends[0], SEAM_MATCH));
  const s1 = seams.find((s) => matches(s.before, ends[1], SEAM_MATCH));
  return s0 === undefined || s1 === undefined ? null : { ends, seams: [s0, s1] };
}

// Makes the rounded spacing of the lines a half turn joins a whole number, moving one end by half a step.
function widenHalfTurns(originals: readonly InShape[], shapes: InShape[]): void {
  const circles = plainCircles(originals);
  for (const arc of originals) {
    const seams = vertexSeams(originals, shapes);
    const half = halfTurnSeams(arc, circles, seams);
    if (half === null) {
      continue;
    }
    const [p0, p1] = half.ends;
    const [s0, s1] = half.seams;
    const axis: 0 | 1 | null =
      Math.abs(p1[0] - p0[0]) < SEAM_MATCH ? 1 : Math.abs(p1[1] - p0[1]) < SEAM_MATCH ? 0 : null;
    if (axis === null) {
      continue;
    }
    const chord = Math.abs(p1[axis] - p0[axis]);
    const spacing = Math.abs(s1.after[axis] - s0.after[axis]);
    if (isMultiple(spacing, 1, TOLERANCE)) {
      continue;
    }
    const [lower, upper] = [spacing - GRID, spacing + GRID];
    const target =
      lower > TOLERANCE && Math.abs(lower - chord) < Math.abs(upper - chord) - TOLERANCE
        ? lower
        : upper;
    const sign = target > spacing ? 1 : -1;
    // The end that lands nearest its original coordinate moves; `to` wins a tie.
    const options = [
      { end: p0, seam: s0, other: s1 },
      { end: p1, seam: s1, other: s0 },
    ].map((o) => {
      const away = Math.sign(o.seam.after[axis] - o.other.after[axis]);
      const value = o.seam.after[axis] + sign * away * GRID;
      return { ...o, value, off: Math.abs(value - o.end[axis]) };
    });
    const [first, second] = options as [(typeof options)[number], (typeof options)[number]];
    const pick = first.off < second.off - TOLERANCE ? first : second;
    originals.forEach((original, i) => {
      const slots = literalSlots(shapes[i] as InShape);
      literalSlots(original).forEach((before, k) => {
        if (Math.abs(before[axis] - pick.end[axis]) <= SEAM_MATCH) {
          (slots[k] as Xy)[axis] = pick.value;
        }
      });
    });
  }
}

type Direction = 'diagonal' | 'level' | 'upright';
type Segment = { direction: Direction; before: [Xy, Xy]; key: [Xy, Xy]; live: [Xy, Xy] };

function directionOf(a: Xy, b: Xy): Direction | null {
  const dx = Math.abs(b[0] - a[0]);
  const dy = Math.abs(b[1] - a[1]);
  if (Math.hypot(dx, dy) <= SEAM_MATCH) {
    return null;
  }
  if (dy < SEAM_MATCH) {
    return 'level';
  }
  if (dx < SEAM_MATCH) {
    return 'upright';
  }
  return Math.abs(dx - dy) < SEAM_MATCH ? 'diagonal' : null;
}

function isBroken({ direction, live }: Segment): boolean {
  const dx = Math.abs(live[1][0] - live[0][0]);
  const dy = Math.abs(live[1][1] - live[0][1]);
  if (direction === 'diagonal') {
    return Math.abs(dx - dy) > TOLERANCE;
  }
  return (direction === 'level' ? dy : dx) > TOLERANCE;
}

// Keeps segments that were diagonal, level or upright before rounding in that direction, moving a point by half a step.
function keepDirections(
  originals: readonly InShape[],
  shapes: readonly InShape[],
  evened: ReadonlySet<InShape>,
): void {
  const circles = plainCircles(originals);
  const seams = vertexSeams(originals, shapes);
  const segments: Segment[] = [];
  const add = (before: [Xy, Xy], key: [Xy, Xy], live: [Xy, Xy]): void => {
    const direction = directionOf(before[0], before[1]);
    if (direction !== null) {
      segments.push({ direction, before, key, live });
    }
  };
  originals.forEach((original, i) => {
    const shape = shapes[i] as InShape;
    if (original.type === 'line' && shape.type === 'line') {
      if (Array.isArray(original.from) && Array.isArray(original.to)) {
        const [from, to] = [original.from as Xy, original.to as Xy];
        add([from, to], [from, to], [shape.from as Xy, shape.to as Xy]);
      }
    } else if (original.type === 'polyline' && shape.type === 'polyline' && !evened.has(shape)) {
      for (let k = 0; k + 1 < original.through.length; k++) {
        const [a, b] = [original.through[k], original.through[k + 1]];
        if (Array.isArray(a) && Array.isArray(b)) {
          add(
            [a as Xy, b as Xy],
            [a as Xy, b as Xy],
            [shape.through[k] as Xy, shape.through[k + 1] as Xy],
          );
        }
      }
    } else if (original.type === 'arc') {
      const half = halfTurnSeams(original, circles, seams);
      if (half !== null) {
        const [s0, s1] = half.seams;
        add(half.ends, [s0.before, s1.before], [s0.after, s1.after]);
      }
    }
  });

  const slots = originals.flatMap((original, i) => {
    const live = literalSlots(shapes[i] as InShape);
    return literalSlots(original).map((before, k) => ({ before, live: live[k] as Xy }));
  });
  // Moves every point that sat at `key` before rounding; returns the undo.
  const shift = (key: Xy, axis: 0 | 1, value: number): (() => void) => {
    const moved = slots.filter((slot) => matches(slot.before, key, SEAM_MATCH));
    const old = moved.map((slot) => slot.live[axis]);
    moved.forEach((slot) => {
      slot.live[axis] = value;
    });
    return () => {
      moved.forEach((slot, n) => {
        slot.live[axis] = old[n] as number;
      });
    };
  };
  const count = (): number => segments.filter(isBroken).length;

  const skipped = new Set<Segment>();
  for (let fixes = 0; fixes < MAX_DIRECTION_FIXES; ) {
    const target = segments.find(
      (s) => s.direction === 'diagonal' && isBroken(s) && !skipped.has(s),
    );
    if (target === undefined) {
      return;
    }
    let best: { key: number[]; end: 0 | 1; axis: 0 | 1; value: number } | null = null;
    for (const end of [0, 1] as const) {
      for (const axis of [0, 1] as const) {
        for (const step of [GRID, -GRID]) {
          const value = target.live[end][axis] + step;
          const undo = shift(target.key[end], axis, value);
          if (!isBroken(target)) {
            const moved = distance(toVec(target.live[end]), toVec(target.before[end]));
            const key = [count(), moved];
            if (best === null || lexLess(key, best.key)) {
              best = { key, end, axis, value };
            }
          }
          undo();
        }
      }
    }
    if (best === null || best.key[0] === undefined || best.key[0] >= count()) {
      skipped.add(target);
    } else {
      shift(target.key[best.end], best.axis, best.value);
      fixes++;
    }
  }
}

const DEFAULT_COLOR = '#000000';

function edgeDistance(p: Xy, a: Xy, b: Xy): number {
  const [sx, sy] = [b[0] - a[0], b[1] - a[1]];
  const length2 = sx * sx + sy * sy;
  const t =
    length2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((p[0] - a[0]) * sx + (p[1] - a[1]) * sy) / length2));
  return Math.hypot(p[0] - (a[0] + t * sx), p[1] - (a[1] + t * sy));
}

// True when `p` lies inside the polygon and farther than TOLERANCE from every edge.
function insidePolygon(p: Xy, polygon: readonly Xy[]): boolean {
  let inside = false;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Xy;
    const b = polygon[(i + 1) % polygon.length] as Xy;
    if (edgeDistance(p, a, b) <= TOLERANCE) {
      return false;
    }
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])
    ) {
      inside = !inside;
    }
  }
  return inside;
}

// The point where the segment from `q` to `p` meets the polygon boundary nearest `p`, if any.
function boundaryCrossing(q: Xy, p: Xy, polygon: readonly Xy[]): Xy | null {
  const [rx, ry] = [p[0] - q[0], p[1] - q[1]];
  let best = -1;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Xy;
    const b = polygon[(i + 1) % polygon.length] as Xy;
    const [sx, sy] = [b[0] - a[0], b[1] - a[1]];
    const denom = rx * sy - ry * sx;
    if (Math.abs(denom) < 1e-12) {
      continue;
    }
    const t = ((a[0] - q[0]) * sy - (a[1] - q[1]) * sx) / denom;
    const u = ((a[0] - q[0]) * ry - (a[1] - q[1]) * rx) / denom;
    if (t >= -TOLERANCE && t <= 1 + TOLERANCE && u >= -TOLERANCE && u <= 1 + TOLERANCE) {
      best = Math.max(best, t);
    }
  }
  return best < 0 ? null : [q[0] + best * rx, q[1] + best * ry];
}

// Stops a stroked shaft at the base of a same-coloured filled polygon its end runs into.
function stopShafts(
  paint: SpecInput['paint'],
  originals: readonly InShape[],
  shapes: readonly InShape[],
  evened: ReadonlySet<InShape>,
): void {
  const slots = originals.flatMap((original, i) => {
    const live = literalSlots(shapes[i] as InShape);
    return literalSlots(original).map((before, k) => ({ before, live: live[k] as Xy }));
  });
  for (const layer of paint) {
    if (!('stroke' in layer)) {
      continue;
    }
    const color = layer.color ?? DEFAULT_COLOR;
    const polygons = paint.flatMap((other) => {
      if (
        !('fill' in other) ||
        typeof other.fill !== 'string' ||
        (other.color ?? DEFAULT_COLOR) !== color
      ) {
        return [];
      }
      const heads = shapes.filter((shape) => shape.id === other.fill && shape.type === 'points');
      return heads.flatMap((shape) => {
        const vertices = literalThrough(shape);
        return vertices === null ? [] : [vertices];
      });
    });
    if (polygons.length === 0) {
      continue;
    }
    for (const id of layer.stroke) {
      const at = shapes.findIndex((shape) => shape.id === id);
      const shape = shapes[at];
      const original = originals[at];
      // Each pair is an end point with the neighbouring vertex it is joined to.
      const ends: { end: Xy; before: Xy; neighbour: Xy }[] = [];
      if (shape?.type === 'line' && original?.type === 'line') {
        if (
          Array.isArray(shape.from) &&
          Array.isArray(shape.to) &&
          Array.isArray(original.from) &&
          Array.isArray(original.to)
        ) {
          ends.push({
            end: shape.from as Xy,
            before: original.from as Xy,
            neighbour: shape.to as Xy,
          });
          ends.push({
            end: shape.to as Xy,
            before: original.to as Xy,
            neighbour: shape.from as Xy,
          });
        }
      } else if (
        shape?.type === 'polyline' &&
        original?.type === 'polyline' &&
        !evened.has(shape)
      ) {
        const last = shape.through.length - 1;
        const pairs: [number, number][] = [
          [0, 1],
          [last, last - 1],
        ];
        for (const [e, n] of pairs) {
          const [end, neighbour, before] = [
            shape.through[e],
            shape.through[n],
            original.through[e],
          ];
          if (Array.isArray(end) && Array.isArray(neighbour) && Array.isArray(before)) {
            ends.push({ end: end as Xy, before: before as Xy, neighbour: neighbour as Xy });
          }
        }
      }
      for (const { end, before, neighbour } of ends) {
        for (const polygon of polygons) {
          if (!insidePolygon(end, polygon) || insidePolygon(neighbour, polygon)) {
            continue;
          }
          const crossing = boundaryCrossing(neighbour, end, polygon);
          if (
            crossing === null ||
            !isMultiple(crossing[0], GRID, TOLERANCE) ||
            !isMultiple(crossing[1], GRID, TOLERANCE) ||
            matches(crossing, neighbour, TOLERANCE) ||
            slots.filter((slot) => matches(slot.before, before, SEAM_MATCH)).length > 1
          ) {
            continue;
          }
          end[0] = roundGrid(crossing[0]);
          end[1] = roundGrid(crossing[1]);
          break;
        }
      }
    }
  }
}

type OutlineIn = Extract<InShape, { type: 'outline' }>;
type PieceIn = OutlineIn['through'][number];
// An outline with literal supports and corners; `supports[k]` is the shape index under piece k.
type OutlinePlan = { index: number; supports: number[] };

const onOf = (piece: PieceIn): string => (typeof piece === 'string' ? piece : piece.on);
const cornerOf = (piece: PieceIn): unknown =>
  typeof piece === 'string' ? undefined : piece.corner;

// The chain support of a circle with a numeric centre and radius or a line with numeric ends.
function supportOf(shape: InShape | undefined): ChainSupport | null {
  if (shape?.type === 'circle' && typeof shape.r === 'number') {
    const center = shape.center ?? [0, 0];
    return Array.isArray(center)
      ? { kind: 'circle', circle: { cx: center[0], cy: center[1], r: shape.r } }
      : null;
  }
  if (shape?.type === 'line' && Array.isArray(shape.from) && Array.isArray(shape.to)) {
    const [from, to] = [toVec(shape.from as Xy), toVec(shape.to as Xy)];
    return distance(from, to) > SNAP ? { kind: 'line', line: lineThrough(from, to) } : null;
  }
  return null;
}

// Outlines whose pieces all lie on literal circles and lines, and the supports no other shape or layer names.
function outlinePlans(
  shapes: readonly InShape[],
  paint: SpecInput['paint'],
): { plans: OutlinePlan[]; dedicated: Set<number> } {
  const at = new Map(shapes.map((shape, i) => [shape.id, i]));
  const uses = new Map<string, number>();
  const count = (ids: string[]): void => {
    for (const id of ids) {
      uses.set(id, (uses.get(id) ?? 0) + 1);
    }
  };
  for (const shape of shapes) {
    // Input shapes may omit the centre that parsing defaults to the origin.
    const filled =
      shape.type === 'circle' || shape.type === 'repeat'
        ? { ...shape, center: shape.center ?? [0, 0] }
        : shape;
    count(shapeReferences(filled as Shape));
  }
  for (const layer of paint) {
    count(paintReferences(layer as PaintLayer));
  }

  const plans: OutlinePlan[] = [];
  const dedicated = new Set<number>();
  shapes.forEach((shape, index) => {
    if (shape.type !== 'outline') {
      return;
    }
    const supports = shape.through.map((piece) => at.get(onOf(piece)) ?? -1);
    const literal = shape.through.every((piece, k) => {
      const corner = cornerOf(piece);
      return (
        supportOf(shapes[supports[k] as number]) !== null &&
        (corner === undefined || Array.isArray(corner))
      );
    });
    if (!literal) {
      return;
    }
    plans.push({ index, supports });
    for (const s of supports) {
      if (uses.get((shapes[s] as InShape).id) === 1) {
        dedicated.add(s);
      }
    }
  });
  return { plans, dedicated };
}

// Builds an outline from the given shapes and corners; null when the kernel rejects it.
function tryChain(
  pieces: readonly PieceIn[],
  supports: readonly (ChainSupport | null)[],
  corners: readonly (Xy | undefined)[],
): Chain | null {
  const input: ChainInput[] = [];
  for (const [k, piece] of pieces.entries()) {
    const support = supports[k];
    if (support === undefined || support === null) {
      return null;
    }
    const corner = corners[k];
    const concave = typeof piece === 'string' ? false : (piece.concave ?? false);
    input.push({ support, concave, ...(corner === undefined ? {} : { corner: toVec(corner) }) });
  }
  try {
    return buildChain(input);
  } catch (error) {
    if (error instanceof ChainError) {
      return null;
    }
    throw error;
  }
}

// Corner hints for the rounded supports: the crossing nearest the joint before rounding, then nearest
// the piece's entry; undefined where the supports touch once; null when a joint cannot be decided.
function rejoinedCorners(
  before: Chain,
  supports: readonly (ChainSupport | null)[],
): (Xy | undefined)[] | null {
  const n = supports.length;
  const corners: (Xy | undefined)[] = [];
  for (let k = 0; k < n; k++) {
    const [a, b] = [supports[k], supports[(k + 1) % n]];
    if (a === null || a === undefined || b === null || b === undefined) {
      return null;
    }
    const m = meet(a, b);
    if (m.kind === 'same' || m.kind === 'none') {
      return null;
    }
    if (m.kind !== 'two') {
      corners.push(undefined);
      continue;
    }
    const joint = (before.joints[k] as Chain['joints'][number]).at;
    const entry = (before.joints[(k + n - 1) % n] as Chain['joints'][number]).at;
    const [keyP, keyQ] = m.points.map((p) => [distance(p, joint), distance(p, entry)]) as [
      number[],
      number[],
    ];
    const pick = lexLess(keyP, keyQ) ? m.points[0] : lexLess(keyQ, keyP) ? m.points[1] : null;
    if (pick === null) {
      return null;
    }
    corners.push([round12(pick.x), round12(pick.y)]);
  }
  return corners;
}

// Re-decides the joints of each planned outline on the rounded supports; an outline that cannot be
// re-joined goes back to its original pieces with its dedicated supports. Returns the reverted shapes.
function rejoinOutlines(
  plans: readonly OutlinePlan[],
  dedicated: ReadonlySet<number>,
  originals: readonly InShape[],
  shapes: InShape[],
  kept: SnapKept[],
): Set<number> {
  const reverted = new Set<number>();
  for (const { index, supports } of plans) {
    const original = originals[index] as OutlineIn;
    const pieces = original.through;
    const before = tryChain(
      pieces,
      supports.map((s) => supportOf(originals[s])),
      pieces.map((piece) => cornerOf(piece) as Xy | undefined),
    );
    if (before === null) {
      continue;
    }
    const rounded = supports.map((s) => supportOf(shapes[s]));
    const corners = rejoinedCorners(before, rounded);
    const after = corners === null ? null : tryChain(pieces, rounded, corners);
    // A joint moving more than a grid step is a change of shape, not rounding.
    const faithful =
      after?.joints.every(
        (joint, k) =>
          distance(joint.at, (before.joints[k] as Chain['joints'][number]).at) <= GRID + TOLERANCE,
      ) ?? false;
    if (corners !== null && faithful) {
      (shapes[index] as OutlineIn).through = pieces.map((piece, k) => {
        const corner = corners[k];
        if (typeof piece === 'string') {
          return corner === undefined ? piece : { on: piece, corner };
        }
        const next = { ...piece };
        delete next.corner;
        return corner === undefined ? next : { ...next, corner };
      });
      continue;
    }
    shapes[index] = structuredClone(original);
    const back = new Set<string>();
    for (const s of supports) {
      if (dedicated.has(s)) {
        shapes[s] = structuredClone(originals[s] as InShape);
        reverted.add(s);
        back.add((originals[s] as InShape).id);
      }
    }
    for (let k = kept.length - 1; k >= 0; k--) {
      if (back.has((kept[k] as SnapKept).id)) {
        kept.splice(k, 1);
      }
    }
    kept.push({ id: original.id, reason: 'outline' });
  }
  return reverted;
}

const OVAL_END_MOVE_MAX = 0.25;

const ovalIdsOf = (shapes: readonly InShape[]): Set<string> =>
  new Set(shapes.flatMap((s) => (s.type === 'oval' ? [s.id] : [])));

// The point seen from the centre at `theta` degrees on a rounded oval or circle, or null when not numeric.
function edgePoint(shape: InShape | undefined, theta: number): Vec | null {
  const rad = (wrapDegrees(theta) * Math.PI) / 180;
  if (shape?.type === 'circle' && typeof shape.r === 'number') {
    const [cx, cy] = Array.isArray(shape.center) ? shape.center : [0, 0];
    return {
      x: (cx as number) + shape.r * Math.cos(rad),
      y: (cy as number) + shape.r * Math.sin(rad),
    };
  }
  if (
    shape?.type === 'oval' &&
    Array.isArray(shape.center) &&
    typeof shape.rx === 'number' &&
    typeof shape.ry === 'number' &&
    typeof (shape.rotate ?? 0) === 'number'
  ) {
    const center = toVec(shape.center as Xy);
    const turn = (Number(shape.rotate ?? 0) * Math.PI) / 180;
    return ovalArc(center, shape.rx, shape.ry, turn, rad, rad + Math.PI)[0]?.start ?? null;
  }
  return null;
}

// The allowed angle nearest `theta`; the smaller one on a tie.
function nearestAllowed(theta: number): number {
  let best = theta;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const n of RULES.angle.divisors) {
    const unit = 180 / n;
    const low = Math.floor(theta / unit);
    for (const candidate of [low * unit, (low + 1) * unit]) {
      const diff = Math.abs(theta - candidate);
      if (diff < bestDiff - TOLERANCE || (diff <= bestDiff + TOLERANCE && candidate < best)) {
        best = candidate;
        bestDiff = diff;
      }
    }
  }
  return best;
}

// Moves the numeric ends of arcs that sat on an oval to the nearest allowed angle, unless the end moves too far.
function snapOvalArcs(originals: readonly InShape[], shapes: InShape[], kept: SnapKept[]): void {
  const ovals = ovalIdsOf(originals);
  originals.forEach((original, i) => {
    const shape = shapes[i];
    if (original.type !== 'arc' || shape?.type !== 'arc' || !ovals.has(original.on)) {
      return;
    }
    const target = shapes.find((s) => s.id === original.on);
    const place = (end: typeof original.from): typeof original.from | null => {
      if (typeof end !== 'number') {
        return end;
      }
      const to = nearestAllowed(end);
      const [a, b] = [edgePoint(target, end), edgePoint(target, to)];
      if (a === null || b === null) {
        return end;
      }
      return distance(a, b) > OVAL_END_MOVE_MAX + TOLERANCE ? null : round4(to);
    };
    const from = place(original.from);
    const to = place(original.to);
    const coincide =
      typeof from === 'number' && typeof to === 'number' && wrapDegrees(from - to) <= TOLERANCE;
    if (from === null || to === null || coincide) {
      kept.push({ id: original.id, reason: 'arc angle' });
    }
    shape.from = from === null || coincide ? original.from : from;
    shape.to = to === null || coincide ? original.to : to;
  });
}

type ArcEnd = { index: number; pos: Xy };

// Re-fits circles that carry seams, re-aims arc ends at the seam points, then snaps ends near an allowed angle.
function snapAngles(
  originals: readonly InShape[],
  shapes: InShape[],
): { gap: number; moved: number } {
  const seams = vertexSeams(originals, shapes);
  const circlesBefore = plainCircles(originals);
  const circlesAfter = plainCircles(shapes);
  const positionOf = (circle: PlainCircle, theta: number): Xy => {
    const rad = (theta * Math.PI) / 180;
    return [
      circle.center[0] + circle.r * Math.cos(rad),
      circle.center[1] + circle.r * Math.sin(rad),
    ];
  };
  const seamAt = (end: Xy): Seam | undefined =>
    seams.find((s) => matches(s.before, end, SEAM_MATCH));

  // Arc ends that meet another arc and no line vertex become seams at the rounded joint.
  const ends: ArcEnd[] = [];
  originals.forEach((shape, i) => {
    const circle = shape.type === 'arc' ? circlesBefore.get(shape.on) : undefined;
    if (shape.type !== 'arc' || circle === undefined || shapes[i]?.type !== 'arc') {
      return;
    }
    for (const theta of [shape.from, shape.to]) {
      if (typeof theta === 'number') {
        ends.push({ index: i, pos: positionOf(circle, theta) });
      }
    }
  });
  for (const end of ends) {
    if (
      seamAt(end.pos) === undefined &&
      ends.some((o) => o.index !== end.index && matches(o.pos, end.pos, SEAM_MATCH))
    ) {
      seams.push({ before: end.pos, after: [roundGrid(end.pos[0]), roundGrid(end.pos[1])] });
    }
  }

  // Choose each seam-bearing circle anew from the candidates around its rounded value.
  const targets = new Map<string, Xy[]>();
  for (const end of ends) {
    const arc = originals[end.index];
    const seam = seamAt(end.pos);
    if (arc?.type === 'arc' && seam !== undefined) {
      targets.set(arc.on, [...(targets.get(arc.on) ?? []), seam.after]);
    }
  }
  let moved = 0;
  for (const [id, points] of targets) {
    const before = circlesBefore.get(id);
    const after = circlesAfter.get(id);
    const shape = shapes.find((s) => s.id === id);
    if (before === undefined || after === undefined || shape?.type !== 'circle') {
      continue;
    }
    const chosen = refit(before, after, points);
    if (chosen === after) {
      continue;
    }
    if (shape.center !== undefined || chosen.center[0] !== 0 || chosen.center[1] !== 0) {
      shape.center = chosen.center;
    }
    shape.r = chosen.r;
    circlesAfter.set(id, chosen);
    moved = Math.max(
      moved,
      Math.hypot(chosen.center[0] - before.center[0], chosen.center[1] - before.center[1]),
      Math.abs(chosen.r - before.r),
    );
  }

  const ovals = ovalIdsOf(originals);
  let gap = 0;
  originals.forEach((original, i) => {
    const shape = shapes[i];
    if (original.type !== 'arc' || shape?.type !== 'arc' || ovals.has(original.on)) {
      return;
    }
    const before = circlesBefore.get(original.on);
    const after = circlesAfter.get(original.on);
    const gaps: number[] = [];
    const place = (end: typeof original.from): typeof original.from => {
      if (typeof end !== 'number') {
        return end;
      }
      let theta = end;
      let seam: Seam | undefined;
      let closed = false;
      if (before !== undefined && after !== undefined) {
        seam = seamAt(positionOf(before, end));
        if (seam !== undefined) {
          const dx = seam.after[0] - after.center[0];
          const dy = seam.after[1] - after.center[1];
          const off = Math.abs(Math.hypot(dx, dy) - after.r);
          gaps.push(off);
          closed = off <= TOLERANCE;
          const wrapped = round4(wrapDegrees((Math.atan2(dy, dx) * 180) / Math.PI));
          theta = wrapped >= 360 ? 0 : wrapped;
        }
      }
      theta = snapAngle(theta);
      return seam !== undefined && closed && !isAllowedAngle(theta)
        ? [seam.after[0], seam.after[1]]
        : theta;
    };
    const from = place(original.from);
    const to = place(original.to);
    if (typeof from === 'number' && typeof to === 'number' && wrapDegrees(from - to) <= TOLERANCE) {
      return;
    }
    shape.from = from;
    shape.to = to;
    gap = Math.max(gap, ...gaps);
  });
  return { gap, moved };
}

/**
 * Rounds an icon spec onto the grid and the angle rules, without changing its meaning.
 *
 * Numeric coordinates and radii go to multiples of 0.5 (halves away from zero), polylines that
 * rounding would make uneven get equal steps, coincident vertices move together, figures the
 * rounding collapses are kept as written or change kind, and arc ends that met a line or another
 * arc follow their seam point, with the circle re-fitted to close it. Outline joints are decided
 * anew on the rounded circles and lines; an outline that no longer closes keeps its original
 * pieces and the supports only it uses. The input is not modified.
 * Throws when the spec is not an icon.
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

  const evened = new Set<InShape>();
  equalise(shapes, table, kept, evened);
  for (const shape of shapes) {
    snapPoints(shape, table);
    snapRadii(shape);
  }
  // Supports only an outline uses are left out of the steps that move shared points together.
  const { plans, dedicated } = outlinePlans(originals, spec.paint);
  const free = (_: InShape, i: number): boolean => !dedicated.has(i);
  const [freeOriginals, freeShapes] = [originals.filter(free), shapes.filter(free)];
  widenHalfTurns(freeOriginals, freeShapes);
  keepDirections(freeOriginals, freeShapes, evened);
  stopShafts(spec.paint, freeOriginals, freeShapes, evened);

  const motions: number[] = [];
  const circles = new Map<number, InShape>();
  shapes.forEach((shape, i) => {
    const original = originals[i] as InShape;
    const result = squash(shape, original, kept);
    shapes[i] = result.shape;
    motions.push(motion(original, result.shape));
    if (result.circle !== null) {
      circles.set(i, result.circle);
    }
  });
  for (const [i, circle] of circles) {
    shapes[i] = circle;
  }
  const reverted = rejoinOutlines(plans, dedicated, originals, shapes, kept);
  const moved = Math.max(0, ...motions.filter((_, i) => !reverted.has(i)));

  snapOvalArcs(originals, shapes, kept);
  const angles = snapAngles(originals, shapes);
  return {
    spec: out,
    moved: round4(Math.max(moved, angles.moved)),
    gap: round4(angles.gap),
    kept,
  };
}
