import {
  intersectCircleCircle,
  intersectCircleLine,
  intersectLineLine,
} from '../geom/intersect.js';
import type { Circle, Line, Vec } from '../geom/primitives.js';
import {
  centerOf,
  cross,
  distance,
  EPS,
  lineThrough,
  mirrorAcross,
  pointOnCircle,
  rotateAbout,
  SNAP,
  signedDistance,
  sub,
} from '../geom/primitives.js';
import type { RegionNode } from '../geom/region.js';
import type { TangentCandidate, TangentTarget } from '../geom/tangent.js';
import { tangentCandidates } from '../geom/tangent.js';
import { evaluateLengthExpression, parseLengthExpression } from '../spec/length.js';
import type { Length, PaintLayer, Point, Region, Shape, Spec } from '../spec/schema.js';
import { COORDINATE_MAX, LENGTH_MAX, LENGTH_MIN, WIDTH_MAX, WIDTH_MIN } from '../spec/schema.js';

export type ResolveError = {
  /** Shape id, or `paint[i]` for a layer-level failure. */
  id: string;
  message: string;
  /** Set when the element failed only because this earlier element did not resolve. */
  dependsOn?: string;
};

export type TangentContact = {
  to: string;
  kind: 'external' | 'internal' | 'line';
  x: number;
  y: number;
};

export type ResolvedPoint = { type: 'point'; id: string; x: number; y: number };
export type ResolvedCircle = { type: 'circle'; id: string; circle: Circle; label: string };
export type ResolvedTangentCircle = {
  type: 'tangent_circle';
  id: string;
  circle: Circle;
  label: string;
  contacts: TangentContact[];
};
export type ResolvedLine = { type: 'line'; id: string; line: Line; from: Vec; to: Vec };
/** `vertices` lists the n polygon vertices by index; `loops` are the closed paths (a compound star has several). */
export type ResolvedPolygon = { type: 'polygon'; id: string; loops: Vec[][]; vertices: Vec[] };
export type ResolvedPoints = { type: 'points'; id: string; loops: [Vec[]]; vertices: Vec[] };

/** An arc of a circle, counter-clockwise from `start` to `end`; angles are degrees in [0, 360) and `sweep` is in (0, 360). */
export type ArcGeometry = {
  circle: Circle;
  from: number;
  to: number;
  sweep: number;
  start: Vec;
  end: Vec;
};
export type ResolvedArc = { type: 'arc'; id: string } & ArcGeometry;

/** A repeated element: a tangent circle is copied as a plain circle. */
export type RepeatElement =
  | ResolvedCircle
  | ResolvedLine
  | ResolvedArc
  | ResolvedPolygon
  | ResolvedPoints;

/** Copy 0 is the original, which is not listed; generated copies are numbered from 1 per `of` element across all repeats. */
export type RepeatCopy = { of: string; copy: number; element: RepeatElement };

export type ResolvedRepeat = {
  type: 'repeat';
  id: string;
  of: string[];
  /** Distinct placements including the original. */
  copyCount: number;
  copies: RepeatCopy[];
};

export type ResolvedElement =
  | ResolvedPoint
  | ResolvedCircle
  | ResolvedTangentCircle
  | ResolvedLine
  | ResolvedArc
  | ResolvedPolygon
  | ResolvedPoints
  | ResolvedRepeat;

export type ResolvedFill = { index: number; color: string; region: RegionNode };

export type StrokeGeometry =
  | { kind: 'circle'; circle: Circle }
  | { kind: 'segment'; from: Vec; to: Vec }
  | ({ kind: 'arc' } & ArcGeometry)
  | { kind: 'polygon'; loops: Vec[][] };

/** A closed shape an erase layer hides the earlier layers inside of. */
export type EraseShape = { kind: 'circle'; circle: Circle } | { kind: 'polygon'; loops: Vec[][] };

export type ResolvedErase = { index: number; shapes: EraseShape[] };

/** `id` is the drawn element, `via` the id listed in the layer (a repeat when expanded). */
export type StrokeItem = { id: string; copy: number; via: string } & StrokeGeometry;

export type ResolvedStroke = {
  index: number;
  color: string;
  width: number;
  widthLabel: string;
  items: StrokeItem[];
};

export type ResolvedModel = {
  mode: Spec['mode'];
  /** Half side of the square canvas: R + margin. */
  canvasHalf: number;
  /** Radius of the grid circle in modules (equal to `divisions`). */
  R: number;
  divisions: Spec['grid']['divisions'];
  margin: number;
  elements: ResolvedElement[];
  byId: Map<string, ResolvedElement>;
  /** Fill layers of a `mark`, empty for a `figure`. */
  fills: ResolvedFill[];
  /** Stroke layers of a `figure`, empty for a `mark`. */
  strokes: ResolvedStroke[];
  /** Erase layers of a `figure`; `index` orders them against `strokes`. */
  erases: ResolvedErase[];
};

export type ResolveResult =
  | { ok: true; model: ResolvedModel }
  | { ok: false; errors: ResolveError[] };

// Candidates closer than MERGE are one; a best and second best within TIE are undecidable.
const MERGE = 1e-7;
const TIE = 1e-6;
/** How far an arc end given as a point may lie from the circle. */
const ARC_ON_CIRCLE = 1e-6;

type Drawable =
  | ResolvedCircle
  | ResolvedTangentCircle
  | ResolvedLine
  | ResolvedArc
  | ResolvedPolygon
  | ResolvedPoints;
type Placement = { el: Drawable; copy: number };
type Curve = { kind: 'circle'; circle: Circle } | { kind: 'line'; line: Line };

/** An element that cannot be resolved by itself. */
class Failure extends Error {}

/** An element that needs an earlier element which failed. */
class Blocked extends Error {
  on: string;

  constructor(on: string) {
    super(`depends on ${on}`);
    this.on = on;
  }
}

const fmt = (x: number): string => String(Number(x.toPrecision(6)));
const fmtPoint = (p: Vec): string => `(${fmt(p.x)}, ${fmt(p.y)})`;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

const mergePoints = (points: Vec[]): Vec[] =>
  points.filter((p, i) => !points.slice(0, i).some((q) => distance(p, q) < MERGE));

const mergeIntervals = (intervals: [number, number][]): [number, number][] => {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && lo <= last[1] + EPS) {
      last[1] = Math.max(last[1], hi);
    } else {
      out.push([lo, hi]);
    }
  }
  return out;
};

const intervalsText = (intervals: [number, number][]): string =>
  mergeIntervals(intervals)
    .map(([lo, hi]) => `${fmt(lo)} to ${fmt(hi)}`)
    .join(' or ');

// Radii of the circles a radius-r tangent circle's centre can lie on, for a circle target.
const offsetRadii = (c: Circle, r: number): number[] => {
  const inner = Math.abs(c.r - r);
  return inner > EPS ? [c.r + r, inner] : [c.r + r];
};

const sameCircle = (a: Circle, b: Circle): boolean =>
  distance(centerOf(a), centerOf(b)) <= SNAP && Math.abs(a.r - b.r) <= SNAP;

const normalizeDegrees = (deg: number): number => {
  const a = ((deg % 360) + 360) % 360;
  return 360 - a < 1e-9 ? 0 : a;
};

const degreesOf = (centre: Vec, p: Vec): number =>
  normalizeDegrees((Math.atan2(p.y - centre.y, p.x - centre.x) * 180) / Math.PI);

const arcBetween = (circle: Circle, start: Vec, end: Vec): ArcGeometry => {
  const from = degreesOf(centerOf(circle), start);
  const to = degreesOf(centerOf(circle), end);
  const sweep = normalizeDegrees(to - from);
  return { circle, from, to, sweep: sweep === 0 ? 360 : sweep, start, end };
};

const sameVertices = (a: Vec[], b: Vec[]): boolean =>
  a.length === b.length &&
  a.every((p) => b.some((q) => distance(p, q) <= SNAP)) &&
  b.every((q) => a.some((p) => distance(p, q) <= SNAP));

const sameGeometry = (a: RepeatElement, b: RepeatElement): boolean => {
  if (a.type === 'circle' && b.type === 'circle') {
    return sameCircle(a.circle, b.circle);
  }
  if (a.type === 'line' && b.type === 'line') {
    return sameVertices([a.from, a.to], [b.from, b.to]);
  }
  if (a.type === 'arc' && b.type === 'arc') {
    return (
      sameCircle(a.circle, b.circle) &&
      distance(a.start, b.start) <= SNAP &&
      distance(a.end, b.end) <= SNAP
    );
  }
  if ((a.type === 'polygon' || a.type === 'points') && a.type === b.type) {
    return sameVertices(a.vertices, b.vertices);
  }
  return false;
};

const mapElement = (el: RepeatElement, f: (p: Vec) => Vec): RepeatElement => {
  switch (el.type) {
    case 'circle': {
      const c = f(centerOf(el.circle));
      return { ...el, circle: { cx: c.x, cy: c.y, r: el.circle.r } };
    }
    case 'line': {
      const from = f(el.from);
      const to = f(el.to);
      return { ...el, from, to, line: lineThrough(from, to) };
    }
    case 'arc': {
      const c = f(centerOf(el.circle));
      const origin = f({ x: 0, y: 0 });
      const flipped = cross(sub(f({ x: 1, y: 0 }), origin), sub(f({ x: 0, y: 1 }), origin)) < 0;
      const [start, end] = flipped ? [f(el.end), f(el.start)] : [f(el.start), f(el.end)];
      return {
        type: 'arc',
        id: el.id,
        ...arcBetween({ cx: c.x, cy: c.y, r: el.circle.r }, start, end),
      };
    }
    case 'polygon':
      return { ...el, loops: el.loops.map((l) => l.map(f)), vertices: el.vertices.map(f) };
    case 'points':
      return { ...el, loops: [el.loops[0].map(f)], vertices: el.vertices.map(f) };
  }
};

/** Resolves a validated spec into concrete geometry, collecting every failed element. */
export function resolveSpec(spec: Spec): ResolveResult {
  const divisions = spec.grid.divisions;
  const R = divisions;
  const elements: ResolvedElement[] = [];
  const byId = new Map<string, ResolvedElement>();
  const failed = new Set<string>();
  const roots: ResolveError[] = [];
  const dependents: ResolveError[] = [];
  const copyCounter = new Map<string, number>();

  const record = (id: string, error: unknown): void => {
    if (error instanceof Blocked) {
      dependents.push({
        id,
        message: `unresolved because it depends on "${error.on}", which could not be resolved (received: "${error.on}"; allowed: a resolved element). Fix "${error.on}" first.`,
        dependsOn: error.on,
      });
    } else if (error instanceof Failure) {
      roots.push({ id, message: error.message });
    } else {
      throw error;
    }
  };

  const lookup = (id: string): ResolvedElement => {
    const el = byId.get(id);
    if (el !== undefined) {
      return el;
    }
    if (failed.has(id)) {
      throw new Blocked(id);
    }
    throw new Failure(`unknown element (received: "${id}"; allowed: an element declared earlier)`);
  };

  const circleOf = (id: string): Circle => {
    const el = lookup(id);
    if (el.type === 'circle' || el.type === 'tangent_circle') {
      return el.circle;
    }
    throw new Failure(`not a circle (received: "${id}", a ${el.type}; allowed: a circle)`);
  };

  const lineOf = (id: string): ResolvedLine => {
    const el = lookup(id);
    if (el.type === 'line') {
      return el;
    }
    throw new Failure(`not a line (received: "${id}", a ${el.type}; allowed: a line)`);
  };

  const curveOf = (id: string): Curve => {
    const el = lookup(id);
    if (el.type === 'circle' || el.type === 'tangent_circle') {
      return { kind: 'circle', circle: el.circle };
    }
    if (el.type === 'line') {
      return { kind: 'line', line: el.line };
    }
    throw new Failure(
      `not a circle or line (received: "${id}", a ${el.type}; allowed: a circle or line)`,
    );
  };

  const evalLength = (length: Length, lo: number, hi: number, what: string) => {
    if (typeof length === 'number') {
      return { value: length, label: String(length) };
    }
    const expr = parseLengthExpression(length);
    if (expr === null) {
      throw new Failure(`${what} is not a length expression (received: "${length}")`);
    }
    const base = expr.base.kind === 'R' ? R : circleOf(expr.base.id).r;
    const value = evaluateLengthExpression(expr, base);
    if (!(value >= lo - EPS && value <= hi + EPS)) {
      throw new Failure(
        `${what} is out of range (received: ${length} = ${fmt(value)}; allowed: ${lo} to ${hi}). Change the base or a factor.`,
      );
    }
    return { value, label: length };
  };

  const hint = 'Use { "on": "<circle id>", "angle": <degrees> } or [x, y] to place it directly.';

  const infinite = (what: string, label: string): Failure =>
    new Failure(
      `infinitely many candidates (received: ${what} ${label} coincide; allowed: a configuration with finitely many candidates). ${hint}`,
    );

  const intersectionCandidates = (ia: string, ib: string): Vec[] => {
    const a = curveOf(ia);
    const b = curveOf(ib);
    const label = `"${ia}" and "${ib}"`;
    if (a.kind === 'circle' && b.kind === 'circle') {
      const res = intersectCircleCircle(a.circle, b.circle);
      if (res.kind === 'coincident') {
        throw infinite('circles', label);
      }
      if (res.kind === 'none') {
        const d = distance(centerOf(a.circle), centerOf(b.circle));
        throw new Failure(
          `no intersection (received: centre distance ${fmt(d)} between ${label}, radii ${fmt(a.circle.r)} and ${fmt(b.circle.r)}; allowed: ${fmt(Math.abs(a.circle.r - b.circle.r))} to ${fmt(a.circle.r + b.circle.r)}). Move or resize a circle so the distance falls in that range.`,
        );
      }
      return mergePoints(res.kind === 'tangent' ? [res.point] : res.points);
    }
    if (a.kind === 'line' && b.kind === 'line') {
      const res = intersectLineLine(a.line, b.line);
      if (res.kind === 'coincident') {
        throw infinite('lines', label);
      }
      if (res.kind === 'none') {
        throw new Failure(
          `no intersection (received: parallel lines ${label} ${fmt(Math.abs(signedDistance(b.line, a.line.p)))} apart; allowed: lines that cross). Change a line's direction.`,
        );
      }
      return [res.point];
    }
    const circle = a.kind === 'circle' ? a : b;
    const line = a.kind === 'line' ? a : b;
    if (circle.kind !== 'circle' || line.kind !== 'line') {
      throw new Failure('unexpected curve kinds');
    }
    const res = intersectCircleLine(circle.circle, line.line);
    if (res.kind === 'none') {
      const s = Math.abs(signedDistance(line.line, centerOf(circle.circle)));
      throw new Failure(
        `no intersection (received: distance ${fmt(s)} from the circle centre to the line, between ${label}, radius ${fmt(circle.circle.r)}; allowed: distance up to ${fmt(circle.circle.r)}). Move the line or enlarge the circle.`,
      );
    }
    return mergePoints(res.kind === 'tangent' ? [res.point] : res.points);
  };

  // Picks the candidate nearest `near`; undecidable choices carry every candidate.
  const pick = <T>(items: T[], pointOf: (t: T) => Vec, near: Vec | undefined, what: string): T => {
    const first = items[0];
    if (near === undefined) {
      if (items.length === 1 && first !== undefined) {
        return first;
      }
      const list = items.map((t) => fmtPoint(pointOf(t))).join(', ');
      throw new Failure(
        `${what} has ${items.length} candidates and no near point (received: candidates ${list}; allowed: near is required unless there is exactly one candidate). Add near: a point closer to the wanted candidate.`,
      );
    }
    const ranked = items
      .map((item) => ({ item, d: distance(pointOf(item), near) }))
      .sort((p, q) => p.d - q.d);
    const best = ranked[0];
    const second = ranked[1];
    if (best === undefined) {
      throw new Failure(`${what} has no candidates`);
    }
    if (second !== undefined && second.d - best.d <= TIE) {
      const list = ranked
        .map((x) => `${fmtPoint(pointOf(x.item))} at distance ${fmt(x.d)}`)
        .join(', ');
      throw new Failure(
        `${what} is undecidable (received: near ${fmtPoint(near)} is equally close to candidates ${list}; allowed: a near point whose nearest candidate leads by more than ${TIE}). Move near toward the wanted candidate.`,
      );
    }
    return best.item;
  };

  const evalPoint = (p: Point): Vec => {
    if (Array.isArray(p)) {
      return { x: p[0], y: p[1] };
    }
    if (typeof p === 'string') {
      const el = lookup(p);
      if (el.type === 'point') {
        return { x: el.x, y: el.y };
      }
      if (el.type === 'circle' || el.type === 'tangent_circle') {
        return centerOf(el.circle);
      }
      throw new Failure(`not a point (received: "${p}", a ${el.type}; allowed: a point or circle)`);
    }
    if ('on' in p) {
      return pointOnCircle(circleOf(p.on), p.angle);
    }
    const [ia, ib] = p.intersect;
    const candidates = intersectionCandidates(ia, ib);
    const near = p.near === undefined ? undefined : evalPoint(p.near);
    return pick(candidates, (v) => v, near, `intersect of "${ia}" and "${ib}"`);
  };

  const located = (p: Point, what: string): Vec => {
    const v = evalPoint(p);
    if (!(Math.abs(v.x) <= COORDINATE_MAX + EPS && Math.abs(v.y) <= COORDINATE_MAX + EPS)) {
      throw new Failure(
        `${what} is outside the canvas range (received: ${fmtPoint(v)}; allowed: each coordinate from -${COORDINATE_MAX} to ${COORDINATE_MAX})`,
      );
    }
    return v;
  };

  const tangentFailure = (ia: string, ib: string, a: Curve, b: Curve, r: number): Failure => {
    const label = `"${ia}" and "${ib}"`;
    const head = `no circle of radius ${fmt(r)} touches both ${label}`;
    if (a.kind === 'circle' && b.kind === 'circle') {
      const d = distance(centerOf(a.circle), centerOf(b.circle));
      const ranges: [number, number][] = [];
      for (const x of offsetRadii(a.circle, r)) {
        for (const y of offsetRadii(b.circle, r)) {
          ranges.push([Math.abs(x - y), x + y]);
        }
      }
      return new Failure(
        `${head} (received: centre distance ${fmt(d)}, radii ${fmt(a.circle.r)} and ${fmt(b.circle.r)}; allowed: centre distance ${intervalsText(ranges)}). Move a circle or change r.`,
      );
    }
    if (a.kind === 'line' && b.kind === 'line') {
      const gap = Math.abs(signedDistance(b.line, a.line.p));
      return new Failure(
        `${head} (received: parallel lines ${fmt(gap)} apart; allowed: lines that cross or lie ${fmt(2 * r)} apart). Change the lines or r.`,
      );
    }
    const circle = a.kind === 'circle' ? a : b;
    const line = a.kind === 'line' ? a : b;
    if (circle.kind !== 'circle' || line.kind !== 'line') {
      return new Failure(head);
    }
    const s = Math.abs(signedDistance(line.line, centerOf(circle.circle)));
    const ranges = offsetRadii(circle.circle, r).map((x): [number, number] => [
      Math.max(0, r - x),
      r + x,
    ]);
    return new Failure(
      `${head} (received: distance ${fmt(s)} from the circle centre to the line, radius ${fmt(circle.circle.r)}; allowed: distance ${intervalsText(ranges)}). Move the circle or line, or change r.`,
    );
  };

  const resolveArc = (shape: Extract<Shape, { type: 'arc' }>): ResolvedArc => {
    const circle = circleOf(shape.on);
    const endOf = (value: Point | number, label: string): Vec => {
      if (typeof value === 'number') {
        return pointOnCircle(circle, value);
      }
      const p = located(value, label);
      const off = Math.abs(distance(p, centerOf(circle)) - circle.r);
      if (off > ARC_ON_CIRCLE) {
        throw new Failure(
          `arc ${label} is off the circle (received: ${fmtPoint(p)} at distance ${fmt(off)} from the circumference of "${shape.on}"; allowed: within ${ARC_ON_CIRCLE}). Use degrees, { "on": "${shape.on}", "angle": <degrees> } or an intersect that includes "${shape.on}".`,
        );
      }
      return pointOnCircle(circle, degreesOf(centerOf(circle), p));
    };
    const start = endOf(shape.from, 'from');
    const end = endOf(shape.to, 'to');
    if (distance(start, end) <= SNAP) {
      throw new Failure(
        `arc ends coincide (received: from ${fmtPoint(start)} and to ${fmtPoint(end)}, distance ${fmt(distance(start, end))}; allowed: distance above ${SNAP}). Use a circle for a full circumference.`,
      );
    }
    return { type: 'arc', id: shape.id, ...arcBetween(circle, start, end) };
  };

  const resolvePolygon = (shape: Extract<Shape, { type: 'polygon' }>): ResolvedPolygon => {
    const circle = circleOf(shape.in);
    const vertices = Array.from({ length: shape.n }, (_, k) =>
      pointOnCircle(circle, shape.rotate + (360 * k) / shape.n),
    );
    const g = gcd(shape.n, shape.step);
    const loops: Vec[][] = [];
    for (let s = 0; s < g; s++) {
      const loop: Vec[] = [];
      for (let j = 0; j < shape.n / g; j++) {
        const v = vertices[(s + j * shape.step) % shape.n];
        if (v !== undefined) {
          loop.push(v);
        }
      }
      loops.push(loop);
    }
    return { type: 'polygon', id: shape.id, loops, vertices };
  };

  const resolvePoints = (shape: Extract<Shape, { type: 'points' }>): ResolvedPoints => {
    const vertices = shape.through.map((p, k) => located(p, `through[${k}]`));
    vertices.forEach((v, k) => {
      const next = vertices[(k + 1) % vertices.length];
      if (next !== undefined && distance(v, next) <= SNAP) {
        throw new Failure(
          `adjacent points coincide (received: through[${k}] ${fmtPoint(v)} and through[${(k + 1) % vertices.length}] ${fmtPoint(next)}, distance ${fmt(distance(v, next))}; allowed: distance above ${SNAP}). Remove or move one of them.`,
        );
      }
    });
    const [head] = vertices;
    const far = vertices.reduce<Vec | undefined>(
      (best, v) =>
        head !== undefined && (best === undefined || distance(v, head) > distance(best, head))
          ? v
          : best,
      undefined,
    );
    if (head !== undefined && far !== undefined && distance(head, far) > SNAP) {
      const base = lineThrough(head, far);
      const spread = Math.max(...vertices.map((v) => Math.abs(signedDistance(base, v))));
      if (spread <= SNAP) {
        throw new Failure(
          `points are collinear (received: largest offset ${fmt(spread)} from the line through the extreme points; allowed: above ${SNAP}). Move a point off the line.`,
        );
      }
    }
    return { type: 'points', id: shape.id, loops: [vertices], vertices };
  };

  const resolveRepeat = (shape: Extract<Shape, { type: 'repeat' }>): ResolvedRepeat => {
    const center = located(shape.center, 'center');
    const originals = shape.of.map((id): RepeatElement => {
      const el = lookup(id);
      switch (el.type) {
        case 'tangent_circle':
          return { type: 'circle', id: el.id, circle: el.circle, label: el.label };
        case 'circle':
        case 'line':
        case 'arc':
        case 'polygon':
        case 'points':
          return el;
        default:
          throw new Failure(
            `cannot repeat (received: "${id}", a ${el.type}; allowed: a circle, line, arc, polygon or points)`,
          );
      }
    });
    const placements: ((v: Vec) => Vec)[] = [];
    for (let k = 1; k < shape.n; k++) {
      placements.push((v) => rotateAbout(v, center, (360 * k) / shape.n));
    }
    if (shape.mirror) {
      for (let k = 0; k < shape.n; k++) {
        placements.push((v) =>
          rotateAbout(mirrorAcross(v, center, shape.axis), center, (360 * k) / shape.n),
        );
      }
    }
    const copies: RepeatCopy[] = [];
    const used = new Set<number>();
    for (const original of originals) {
      const kept: RepeatElement[] = [original];
      placements.forEach((place, p) => {
        const element = mapElement(original, place);
        if (kept.some((k) => sameGeometry(k, element))) {
          return;
        }
        kept.push(element);
        used.add(p);
        const copy = (copyCounter.get(original.id) ?? 0) + 1;
        copyCounter.set(original.id, copy);
        copies.push({ of: original.id, copy, element });
      });
    }
    return { type: 'repeat', id: shape.id, of: shape.of, copyCount: 1 + used.size, copies };
  };

  const resolveShape = (shape: Shape): ResolvedElement => {
    switch (shape.type) {
      case 'point': {
        const v = located(shape.at, 'at');
        return { type: 'point', id: shape.id, x: v.x, y: v.y };
      }
      case 'circle': {
        const center = located(shape.center, 'center');
        const r = evalLength(shape.r, LENGTH_MIN, LENGTH_MAX, 'r');
        return {
          type: 'circle',
          id: shape.id,
          circle: { cx: center.x, cy: center.y, r: r.value },
          label: r.label,
        };
      }
      case 'tangent_circle': {
        const [ia, ib] = shape.to;
        const a = curveOf(ia);
        const b = curveOf(ib);
        const r = evalLength(shape.r, LENGTH_MIN, LENGTH_MAX, 'r');
        const near = evalPoint(shape.near);
        const target = (c: Curve): TangentTarget => (c.kind === 'circle' ? c.circle : c.line);
        const res = tangentCandidates(target(a), target(b), r.value);
        if (res.kind === 'infinite') {
          throw infinite('offset curves of', `"${ia}" and "${ib}"`);
        }
        if (res.items.length === 0) {
          throw tangentFailure(ia, ib, a, b, r.value);
        }
        const chosen: TangentCandidate = pick(
          res.items,
          (c) => c.center,
          near,
          `tangent circle to "${ia}" and "${ib}"`,
        );
        const [ca, cb] = chosen.contacts;
        const contacts: TangentContact[] = [
          { to: ia, kind: ca.kind, x: ca.point.x, y: ca.point.y },
          { to: ib, kind: cb.kind, x: cb.point.x, y: cb.point.y },
        ];
        const center = chosen.center;
        if (
          !(
            Math.abs(center.x) <= COORDINATE_MAX + EPS && Math.abs(center.y) <= COORDINATE_MAX + EPS
          )
        ) {
          throw new Failure(
            `centre is outside the canvas range (received: ${fmtPoint(center)}; allowed: each coordinate from -${COORDINATE_MAX} to ${COORDINATE_MAX})`,
          );
        }
        return {
          type: 'tangent_circle',
          id: shape.id,
          circle: { cx: center.x, cy: center.y, r: r.value },
          label: r.label,
          contacts,
        };
      }
      case 'line': {
        const from = located(shape.from, 'from');
        const to = located(shape.to, 'to');
        if (distance(from, to) <= SNAP) {
          throw new Failure(
            `line endpoints coincide (received: from ${fmtPoint(from)} and to ${fmtPoint(to)}, distance ${fmt(distance(from, to))}; allowed: distance above ${SNAP}). Use two different points.`,
          );
        }
        return { type: 'line', id: shape.id, line: lineThrough(from, to), from, to };
      }
      case 'arc':
        return resolveArc(shape);
      case 'polygon':
        return resolvePolygon(shape);
      case 'points':
        return resolvePoints(shape);
      case 'repeat':
        return resolveRepeat(shape);
    }
  };

  for (const shape of spec.shapes) {
    try {
      const el = resolveShape(shape);
      elements.push(el);
      byId.set(el.id, el);
    } catch (error) {
      failed.add(shape.id);
      record(shape.id, error);
    }
  }

  // Original (copy 0) and every generated copy of an element, in drawing order.
  const expand = (el: ResolvedElement): Placement[] => {
    switch (el.type) {
      case 'point':
        return [];
      case 'repeat':
        return el.of.flatMap((ofId) => {
          const original = byId.get(ofId);
          const placed: Placement[] =
            original !== undefined && original.type !== 'point' && original.type !== 'repeat'
              ? [{ el: original, copy: 0 }]
              : [];
          for (const c of el.copies) {
            if (c.of === ofId) {
              placed.push({ el: c.element, copy: c.copy });
            }
          }
          return placed;
        });
      default:
        return [{ el, copy: 0 }];
    }
  };

  const leafOf = ({ el, copy }: Placement): RegionNode | null => {
    const source = { id: el.id, copy };
    switch (el.type) {
      case 'circle':
      case 'tangent_circle':
        return { kind: 'disc', circle: el.circle, source };
      case 'polygon':
      case 'points':
        return { kind: 'poly', loops: el.loops, source };
      case 'line':
      case 'arc':
        return null;
    }
  };

  const itemOf = ({ el, copy }: Placement, via: string): StrokeItem => {
    switch (el.type) {
      case 'circle':
      case 'tangent_circle':
        return { id: el.id, copy, via, kind: 'circle', circle: el.circle };
      case 'line':
        return { id: el.id, copy, via, kind: 'segment', from: el.from, to: el.to };
      case 'arc':
        return {
          id: el.id,
          copy,
          via,
          kind: 'arc',
          circle: el.circle,
          from: el.from,
          to: el.to,
          sweep: el.sweep,
          start: el.start,
          end: el.end,
        };
      case 'polygon':
      case 'points':
        return { id: el.id, copy, via, kind: 'polygon', loops: el.loops };
    }
  };

  const eraseShapeOf = ({ el }: Placement): EraseShape => {
    switch (el.type) {
      case 'circle':
      case 'tangent_circle':
        return { kind: 'circle', circle: el.circle };
      case 'polygon':
      case 'points':
        return { kind: 'polygon', loops: el.loops };
      case 'line':
      case 'arc':
        throw new Failure(
          `cannot erase (received: "${el.id}", a ${el.type}; allowed: a circle, polygon, points or repeat of those)`,
        );
    }
  };

  const buildRegion = (region: Region): RegionNode => {
    if (typeof region === 'string') {
      const leaves = expand(lookup(region))
        .map(leafOf)
        .filter((n): n is RegionNode => n !== null);
      const [only] = leaves;
      if (leaves.length === 1 && only !== undefined) {
        return only;
      }
      if (leaves.length === 0) {
        throw new Failure(
          `region has no area (received: "${region}"; allowed: a circle, polygon, points or repeat of those)`,
        );
      }
      return { kind: 'union', children: leaves };
    }
    if ('half' in region) {
      const line = lineOf(region.half);
      const toward = evalPoint(region.toward);
      const s = signedDistance(line.line, toward);
      if (Math.abs(s) <= TIE) {
        throw new Failure(
          `toward point lies on the line (received: toward ${fmtPoint(toward)} at distance ${fmt(Math.abs(s))} from "${region.half}"; allowed: distance above ${TIE}). Move toward to the side to keep.`,
        );
      }
      return {
        kind: 'half',
        line: line.line,
        sign: s > 0 ? 1 : -1,
        source: { id: region.half, copy: 0 },
      };
    }
    if ('union' in region) {
      return { kind: 'union', children: region.union.map(buildRegion) };
    }
    if ('intersect' in region) {
      return { kind: 'intersect', children: region.intersect.map(buildRegion) };
    }
    return { kind: 'subtract', children: region.subtract.map(buildRegion) };
  };

  const fills: ResolvedFill[] = [];
  const strokes: ResolvedStroke[] = [];
  const erases: ResolvedErase[] = [];

  const resolveLayer = (layer: PaintLayer, index: number): void => {
    if ('fill' in layer) {
      fills.push({ index, color: layer.color, region: buildRegion(layer.fill) });
      return;
    }
    if ('erase' in layer) {
      const shapes = layer.erase.flatMap((id) => expand(lookup(id)).map(eraseShapeOf));
      erases.push({ index, shapes });
      return;
    }
    const width = evalLength(layer.width, WIDTH_MIN, WIDTH_MAX, 'width');
    const items = layer.stroke.flatMap((id) =>
      expand(lookup(id)).map((placement) => itemOf(placement, id)),
    );
    strokes.push({ index, color: layer.color, width: width.value, widthLabel: width.label, items });
  };

  spec.paint.forEach((layer, index) => {
    try {
      resolveLayer(layer, index);
    } catch (error) {
      record(`paint[${index}]`, error);
    }
  });

  if (roots.length > 0 || dependents.length > 0) {
    return { ok: false, errors: [...roots, ...dependents] };
  }
  return {
    ok: true,
    model: {
      mode: spec.mode,
      canvasHalf: R + spec.grid.margin,
      R,
      divisions,
      margin: spec.grid.margin,
      elements,
      byId,
      fills,
      strokes,
      erases,
    },
  };
}
