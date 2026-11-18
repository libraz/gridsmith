/**
 * @file Turns parsed subpaths into y-up lines and arcs and recognises the elements they form
 * (line, polyline, points, rect, circle, oval, arc), or the parts listed on a skip.
 */

import type { SpecInput } from '../spec/schema.js';
import { type FitPiece, fitCubic } from './fit.js';
import { apply, type Matrix, type RawSubpath, type Vec } from './path.js';

/**
 * One part of a skipped subpath in y-up module coordinates. Arcs and ellipse arcs run
 * counter-clockwise from `from` to `to`, in degrees; an ellipse's angles are its parameter.
 */
export type ImportPiece =
  | { line: [Pt, Pt] }
  | { arc: { center: Pt; r: number; from: number; to: number } }
  | {
      ellipse: { center: Pt; rx: number; ry: number; rotate: number; from: number; to: number };
    };

export type ShapeInput = SpecInput['shapes'][number];
type Pt = [number, number];

type Line = { kind: 'line'; a: Vec; b: Vec };
/** Arc in y-up coordinates; `t1`/`dt` are ellipse parameters, `dt > 0` is counter-clockwise. */
type Arc = {
  kind: 'arc';
  a: Vec;
  b: Vec;
  c: Vec;
  rx: number;
  ry: number;
  givenRx: number;
  givenRy: number;
  phi: number;
  t1: number;
  dt: number;
  circular: boolean;
  /** Fitted to a Bezier curve rather than read from an arc command. */
  fitted?: boolean;
};
type Piece = Line | Arc;

/** Distance at which two vertices are the same point. */
const SAME_POINT = 1e-4;
/** Tolerance for axis-parallel edges, equal radii and quarter sweeps. */
const SHAPE_TOL = 1e-3;
/** Tolerance for diameters and pill widths rounded in the source. */
const ROUNDED_TOL = 0.02;
const MAX_POINTS = 32;
const ARC_STEPS = 16;
const HALF = 12;
/** Fitted pieces allowed per subpath, so one curve cannot exhaust the shape limit. */
const MAX_FIT_PIECES = 16;
/** Tolerance on centres and radii when fitted arcs close into a circle. */
const FIT_CIRCLE_TOL = 0.1;

export const round4 = (v: number): number => {
  const r = Math.round(v * 1e4) / 1e4;
  return r === 0 ? 0 : r;
};
export const pt = (p: Vec): Pt => [round4(p.x), round4(p.y)];
const dist = (p: Vec, q: Vec): number => Math.hypot(p.x - q.x, p.y - q.y);
const mid = (p: Vec, q: Vec): Vec => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
const degrees = (rad: number): number => (rad * 180) / Math.PI;

export const toUp = (p: Vec): Vec => ({ x: p.x - HALF, y: HALF - p.y });

const vectorAngle = (ux: number, uy: number, vx: number, vy: number): number =>
  Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);

/** Endpoint-to-centre conversion of an SVG arc (y-down), returned in y-up coordinates. */
function arcPiece(
  p1: Vec,
  p2: Vec,
  givenRx: number,
  givenRy: number,
  phiDeg: number,
  large: boolean,
  sweep: boolean,
): Arc {
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const hx = (p1.x - p2.x) / 2;
  const hy = (p1.y - p2.y) / 2;
  const x1 = cos * hx + sin * hy;
  const y1 = -sin * hx + cos * hy;
  let rx = Math.abs(givenRx);
  let ry = Math.abs(givenRy);
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const coef = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const centre = {
    x: cos * cx1 - sin * cy1 + (p1.x + p2.x) / 2,
    y: sin * cx1 + cos * cy1 + (p1.y + p2.y) / 2,
  };
  const ux = (x1 - cx1) / rx;
  const uy = (y1 - cy1) / ry;
  const t1 = vectorAngle(1, 0, ux, uy);
  let dt = vectorAngle(ux, uy, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) {
    dt -= 2 * Math.PI;
  } else if (sweep && dt < 0) {
    dt += 2 * Math.PI;
  }
  return {
    kind: 'arc',
    a: toUp(p1),
    b: toUp(p2),
    c: toUp(centre),
    rx,
    ry,
    givenRx: Math.abs(givenRx),
    givenRy: Math.abs(givenRy),
    phi: -phi,
    t1: -t1,
    dt: -dt,
    circular: Math.abs(Math.abs(givenRx) - Math.abs(givenRy)) <= SAME_POINT,
  };
}

/** Fitted pieces as import pieces; arcs are marked `fitted`. */
const fittedPieces = (fit: readonly FitPiece[]): Piece[] =>
  fit.map((p): Piece => {
    if (p.kind === 'line') {
      return p;
    }
    return {
      kind: 'arc',
      a: p.a,
      b: p.b,
      c: p.c,
      rx: p.r,
      ry: p.r,
      givenRx: p.r,
      givenRy: p.r,
      phi: 0,
      t1: Math.atan2(p.a.y - p.c.y, p.a.x - p.c.x),
      dt: vectorAngle(p.a.x - p.c.x, p.a.y - p.c.y, p.b.x - p.c.x, p.b.y - p.c.y),
      circular: true,
      fitted: true,
    };
  });

type Built = {
  pieces: Piece[];
  ring: Piece[];
  closed: boolean;
  curves: number;
  fitted: number;
  deviation: number;
};

/**
 * Builds y-up pieces with transforms baked in, curves fitted and zero-length pieces dropped.
 * `ring` is the boundary a fill sees: `pieces` plus the implicit closing edge. Null when a curve
 * cannot be fitted or the fits need more than {@link MAX_FIT_PIECES} pieces.
 */
export function buildPieces(sub: RawSubpath, m: Matrix): Built | null {
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const turn = degrees(Math.atan2(m[1], m[0]));
  const all: Piece[] = [];
  const fit = { curves: 0, fitted: 0, deviation: 0 };
  let prev = apply(m, sub.start);
  for (const cmd of sub.cmds) {
    const to = apply(m, cmd.to);
    if (cmd.kind === 'C') {
      const curve = fitCubic(toUp(prev), toUp(apply(m, cmd.c1)), toUp(apply(m, cmd.c2)), toUp(to));
      if (curve === null) {
        return null;
      }
      fit.curves++;
      fit.fitted += curve.pieces.length;
      fit.deviation = Math.max(fit.deviation, curve.deviation);
      all.push(...fittedPieces(curve.pieces));
    } else if (cmd.kind === 'L' || cmd.rx === 0 || cmd.ry === 0) {
      all.push({ kind: 'line', a: toUp(prev), b: toUp(to) });
    } else {
      all.push(
        arcPiece(prev, to, cmd.rx * scale, cmd.ry * scale, cmd.phi + turn, cmd.large, cmd.sweep),
      );
    }
    prev = to;
  }
  if (fit.fitted > MAX_FIT_PIECES) {
    return null;
  }
  const pieces = all.filter((p) => dist(p.a, p.b) > SAME_POINT);
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  if (first === undefined || last === undefined) {
    return { pieces, ring: pieces, closed: sub.closed, ...fit };
  }
  const gap = dist(last.b, first.a);
  const ring: Piece[] =
    gap > SAME_POINT ? [...pieces, { kind: 'line', a: last.b, b: first.a }] : pieces;
  return sub.closed || gap <= SAME_POINT
    ? { pieces: ring, ring, closed: true, ...fit }
    : { pieces, ring, closed: false, ...fit };
}

export const isArc = (p: Piece): p is Arc => p.kind === 'arc';

/** Points along the closed boundary; arcs are cut into 16 chords. */
export function polygonOf(pieces: readonly Piece[]): Vec[] {
  const out: Vec[] = [];
  for (const p of pieces) {
    if (!isArc(p)) {
      out.push(p.a);
      continue;
    }
    for (let k = 0; k < ARC_STEPS; k++) {
      const t = p.t1 + (p.dt * k) / ARC_STEPS;
      const ex = p.rx * Math.cos(t);
      const ey = p.ry * Math.sin(t);
      out.push({
        x: p.c.x + Math.cos(p.phi) * ex - Math.sin(p.phi) * ey,
        y: p.c.y + Math.sin(p.phi) * ex + Math.cos(p.phi) * ey,
      });
    }
  }
  return out;
}

/** Degrees in [0, 360), 4 decimals. */
const turnOf = (rad: number): number => {
  const a = round4(((degrees(rad) % 360) + 360) % 360);
  return a === 360 ? 0 : a;
};
const angleOn = (c: Vec, p: Vec): number => turnOf(Math.atan2(p.y - c.y, p.x - c.x));

/** A piece as listed on a skip, arcs turned counter-clockwise. */
export const importPiece = (p: Piece): ImportPiece => {
  if (!isArc(p)) {
    return { line: [pt(p.a), pt(p.b)] };
  }
  const ccw = p.dt > 0;
  if (p.circular) {
    const [from, to] = ccw ? [p.a, p.b] : [p.b, p.a];
    return {
      arc: { center: pt(p.c), r: round4(p.rx), from: angleOn(p.c, from), to: angleOn(p.c, to) },
    };
  }
  const [from, to] = ccw ? [p.t1, p.t1 + p.dt] : [p.t1 + p.dt, p.t1];
  return {
    ellipse: {
      center: pt(p.c),
      rx: round4(p.rx),
      ry: round4(p.ry),
      rotate: turnOf(p.phi),
      from: turnOf(from),
      to: turnOf(to),
    },
  };
};

/** An open circular arc as an auxiliary circle and a counter-clockwise `arc`. */
const arcShapes = (arc: Arc, id: string): ShapeInput[] => {
  const ccw = arc.dt > 0;
  return [
    { id: `${id}c`, type: 'circle', center: pt(arc.c), r: round4(arc.rx) },
    {
      id,
      type: 'arc',
      on: `${id}c`,
      from: angleOn(arc.c, ccw ? arc.a : arc.b),
      to: angleOn(arc.c, ccw ? arc.b : arc.a),
    },
  ];
};

const lineShape = (verts: readonly Vec[], id: string): ShapeInput | string => {
  if (verts.length > MAX_POINTS) {
    return 'too many points';
  }
  const [a, b] = verts;
  if (verts.length === 2 && a !== undefined && b !== undefined) {
    return { id, type: 'line', from: pt(a), to: pt(b) };
  }
  return { id, type: 'polyline', through: verts.map(pt) };
};

const openVertices = (lines: readonly Piece[]): Vec[] => [
  ...lines.map((l) => l.a),
  ...lines.slice(-1).map((l) => l.b),
];

/** Axis-parallel rectangle with equal quarter/half corner arcs, or null. */
function roundedRect(
  pieces: readonly Piece[],
): { min: Vec; max: Vec; r: number; note?: string } | null {
  const arcs = pieces.filter(isArc);
  const lines = pieces.filter((p) => !isArc(p));
  const head = arcs[0];
  if (head === undefined || arcs.length < 2 || arcs.length > 4 || lines.length > 4) {
    return null;
  }
  const r = head.givenRx;
  let total = 0;
  for (const a of arcs) {
    const quarters = Math.abs(a.dt) / (Math.PI / 2);
    const whole = Math.round(quarters);
    if (
      !a.circular ||
      Math.abs(a.givenRx - r) > SHAPE_TOL ||
      Math.sign(a.dt) !== Math.sign(head.dt) ||
      (whole !== 1 && whole !== 2) ||
      Math.abs(quarters - whole) > SHAPE_TOL
    ) {
      return null;
    }
    total += Math.abs(a.dt);
  }
  if (Math.abs(total - 2 * Math.PI) > SHAPE_TOL) {
    return null;
  }
  const min = {
    x: Math.min(...arcs.map((a) => a.c.x)) - r,
    y: Math.min(...arcs.map((a) => a.c.y)) - r,
  };
  const max = {
    x: Math.max(...arcs.map((a) => a.c.x)) + r,
    y: Math.max(...arcs.map((a) => a.c.y)) + r,
  };
  const near = (v: number, ...targets: number[]) =>
    targets.some((t) => Math.abs(v - t) <= SHAPE_TOL);
  const cornersOk = arcs.every(
    (a) => near(a.c.x, min.x + r, max.x - r) && near(a.c.y, min.y + r, max.y - r),
  );
  const edgesOk = lines.every(
    (l) =>
      dist(l.a, l.b) <= ROUNDED_TOL ||
      (Math.abs(l.a.y - l.b.y) <= SHAPE_TOL && near(l.a.y, min.y, max.y)) ||
      (Math.abs(l.a.x - l.b.x) <= SHAPE_TOL && near(l.a.x, min.x, max.x)),
  );
  const short = Math.min(max.x - min.x, max.y - min.y);
  if (!cornersOk || !edgesOk || short - 2 * r < -ROUNDED_TOL) {
    return null;
  }
  if (Math.abs(short - 2 * r) <= ROUNDED_TOL) {
    const note = Math.abs(short - 2 * r) > SAME_POINT ? 'near pill' : undefined;
    return { min, max, r: short / 2, ...(note === undefined ? {} : { note }) };
  }
  return { min, max, r };
}

/** Curve-fit totals: spans fitted, pieces they became and the largest deviation. */
export type FitStats = { curves: number; fitted: number; deviation: number };

export type Converted = {
  shapes: ShapeInput[];
  ids: string[];
  area: boolean;
  note?: string;
  /** Set when elliptical arcs were replaced by fitted circular arcs. */
  fit?: FitStats;
};

/** Point and tangent of an ellipse piece at parameter `t`, y-up. */
function ellipseAt(arc: Arc, t: number): { p: Vec; d: Vec } {
  const cos = Math.cos(arc.phi);
  const sin = Math.sin(arc.phi);
  const turn = (x: number, y: number): Vec => ({ x: cos * x - sin * y, y: sin * x + cos * y });
  const o = turn(arc.rx * Math.cos(t), arc.ry * Math.sin(t));
  return {
    p: { x: arc.c.x + o.x, y: arc.c.y + o.y },
    d: turn(-arc.rx * Math.sin(t), arc.ry * Math.cos(t)),
  };
}

/**
 * Replaces each elliptical arc by fitted circular arcs, one cubic per span of at most 90 degrees.
 * Null when a span cannot be fitted or the fits need more than `room` pieces.
 */
function fitEllipses(
  pieces: readonly Piece[],
  room: number,
): { pieces: Piece[]; fit: FitStats } | null {
  const out: Piece[] = [];
  const fit: FitStats = { curves: 0, fitted: 0, deviation: 0 };
  for (const piece of pieces) {
    if (!isArc(piece) || piece.circular) {
      out.push(piece);
      continue;
    }
    const spans = Math.max(1, Math.ceil(Math.abs(piece.dt) / (Math.PI / 2) - 1e-9));
    const step = piece.dt / spans;
    const k = (4 / 3) * Math.tan(step / 4);
    for (let i = 0; i < spans; i++) {
      const s = ellipseAt(piece, piece.t1 + i * step);
      const e = ellipseAt(piece, piece.t1 + (i + 1) * step);
      const curve = fitCubic(
        i === 0 ? piece.a : s.p,
        { x: s.p.x + k * s.d.x, y: s.p.y + k * s.d.y },
        { x: e.p.x - k * e.d.x, y: e.p.y - k * e.d.y },
        i === spans - 1 ? piece.b : e.p,
      );
      if (curve === null) {
        return null;
      }
      fit.curves++;
      fit.fitted += curve.pieces.length;
      fit.deviation = Math.max(fit.deviation, curve.deviation);
      out.push(...fittedPieces(curve.pieces));
    }
  }
  return fit.fitted > room ? null : { pieces: out, fit };
}

/** A closed ring of fitted arcs sharing one centre and radius, as their mean circle. */
function fittedCircle(pieces: readonly Piece[], id: string): Converted | null {
  const arcs = pieces.filter(isArc);
  if (arcs.length !== pieces.length || !arcs.every((a) => a.fitted)) {
    return null;
  }
  const n = arcs.length;
  const c = {
    x: arcs.reduce((s, a) => s + a.c.x, 0) / n,
    y: arcs.reduce((s, a) => s + a.c.y, 0) / n,
  };
  const r = arcs.reduce((s, a) => s + a.rx, 0) / n;
  const close = arcs.every(
    (a) => dist(a.c, c) <= FIT_CIRCLE_TOL && Math.abs(a.rx - r) <= FIT_CIRCLE_TOL,
  );
  return close
    ? { shapes: [{ id, type: 'circle', center: pt(c), r: round4(r) }], ids: [id], area: true }
    : null;
}

/** Closed subpath (or the implicitly closed fill of one) as one element. */
export function closedShape(pieces: readonly Piece[], id: string): Converted | string {
  const arcs = pieces.filter(isArc);
  if (arcs.length === 0) {
    const verts = pieces.map((p) => p.a);
    if (verts.length === 2) {
      const line = lineShape(verts, id);
      return typeof line === 'string' ? line : { shapes: [line], ids: [id], area: false };
    }
    if (verts.length > MAX_POINTS) {
      return 'too many points';
    }
    const xs = verts.map((v) => v.x);
    const ys = verts.map((v) => v.y);
    // Four edges alternating horizontal and vertical.
    const flat = (k: number): boolean =>
      Math.abs((verts[k] as Vec).y - (verts[(k + 1) % 4] as Vec).y) <= SHAPE_TOL;
    const upright = (k: number): boolean =>
      Math.abs((verts[k] as Vec).x - (verts[(k + 1) % 4] as Vec).x) <= SHAPE_TOL;
    const axis =
      verts.length === 4 &&
      [0, 1, 2, 3].every((k) => (k % 2 === (flat(0) ? 0 : 1) ? flat(k) : upright(k)));
    if (axis) {
      const corners: [Pt, Pt] = [
        [round4(Math.min(...xs)), round4(Math.min(...ys))],
        [round4(Math.max(...xs)), round4(Math.max(...ys))],
      ];
      return { shapes: [{ id, type: 'rect', corners }], ids: [id], area: true };
    }
    return { shapes: [{ id, type: 'points', through: verts.map(pt) }], ids: [id], area: true };
  }

  if (arcs.some((a) => a.fitted)) {
    return fittedCircle(pieces, id) ?? 'mixed path';
  }
  const [p, q] = arcs;
  if (pieces.length === 2 && p !== undefined && q !== undefined) {
    const sameTurn = Math.sign(p.dt) === Math.sign(q.dt);
    const centre = mid(p.a, p.b);
    if (p.circular && q.circular && sameTurn && Math.abs(p.givenRx - q.givenRx) <= SHAPE_TOL) {
      const gap = Math.abs(dist(p.a, p.b) - 2 * p.givenRx);
      if (gap <= ROUNDED_TOL) {
        const shape: ShapeInput = { id, type: 'circle', center: pt(centre), r: round4(p.givenRx) };
        return {
          shapes: [shape],
          ids: [id],
          area: true,
          ...(gap > SAME_POINT ? { note: 'rounded arc pair' } : {}),
        };
      }
    }
    // The chord must be a diameter of the ellipse, measured along its own direction.
    const along = Math.atan2(p.b.y - p.a.y, p.b.x - p.a.x) - p.phi;
    const diameter =
      2 / Math.sqrt((Math.cos(along) / p.givenRx) ** 2 + (Math.sin(along) / p.givenRy) ** 2);
    const gap = Math.abs(dist(p.a, p.b) - diameter);
    if (
      !p.circular &&
      !q.circular &&
      sameTurn &&
      Math.abs(Math.sin(p.phi - q.phi)) <= SHAPE_TOL &&
      Math.abs(p.givenRx - q.givenRx) <= SHAPE_TOL &&
      Math.abs(p.givenRy - q.givenRy) <= SHAPE_TOL &&
      gap <= ROUNDED_TOL
    ) {
      let rotate = degrees(p.phi) % 180;
      rotate = rotate > 90 ? rotate - 180 : rotate <= -90 ? rotate + 180 : rotate;
      const shape: ShapeInput = {
        id,
        type: 'oval',
        center: pt(centre),
        rx: round4(p.givenRx),
        ry: round4(p.givenRy),
        rotate: round4(rotate),
      };
      return {
        shapes: [shape],
        ids: [id],
        area: true,
        ...(gap > SAME_POINT ? { note: 'rounded arc pair' } : {}),
      };
    }
  }
  const rect = roundedRect(pieces);
  if (rect === null) {
    return 'mixed path';
  }
  const shape: ShapeInput = {
    id,
    type: 'rect',
    corners: [pt(rect.min), pt(rect.max)],
    r: round4(rect.r),
  };
  return {
    shapes: [shape],
    ids: [id],
    area: true,
    ...(rect.note === undefined ? {} : { note: rect.note }),
  };
}

/** Radii differing by less than this, or by a ratio above {@link MAX_OVAL_RATIO}, are fitted instead. */
const MIN_OVAL_DIFF = 0.05;
const MAX_OVAL_RATIO = 4;

const isOvalArc = (p: Piece): p is Arc => {
  if (!isArc(p) || p.circular || p.fitted) {
    return false;
  }
  const [lo, hi] = [Math.min(p.rx, p.ry), Math.max(p.rx, p.ry)];
  return hi - lo >= MIN_OVAL_DIFF && hi / lo <= MAX_OVAL_RATIO;
};

/** A lone elliptical arc as an `oval` and a counter-clockwise `arc` on it. */
function ovalArcShapes(arc: Arc, id: string): Converted {
  const ccw = arc.dt > 0;
  let rotate = degrees(arc.phi) % 180;
  rotate = rotate > 90 ? rotate - 180 : rotate <= -90 ? rotate + 180 : rotate;
  const shapes: ShapeInput[] = [
    {
      id: `${id}c`,
      type: 'oval',
      center: pt(arc.c),
      rx: round4(arc.rx),
      ry: round4(arc.ry),
      rotate: round4(rotate),
    },
    {
      id,
      type: 'arc',
      on: `${id}c`,
      from: angleOn(arc.c, ccw ? arc.a : arc.b),
      to: angleOn(arc.c, ccw ? arc.b : arc.a),
    },
  ];
  return { shapes, ids: [id], area: false };
}

/** Stroked subpath, open or a closed round ring: lines, one arc, or line/arc parts. */
export function openShape(
  source: readonly Piece[],
  id: string,
  splittable: boolean,
  fitted = 0,
): Converted | string {
  const lone = source.length === 1 ? source[0] : undefined;
  if (lone !== undefined && isOvalArc(lone)) {
    return ovalArcShapes(lone, id);
  }
  let pieces = source;
  let fit: FitStats | undefined;
  if (source.some((p) => isArc(p) && !p.circular)) {
    const swapped = fitEllipses(source, MAX_FIT_PIECES - fitted);
    if (swapped === null) {
      return 'mixed path';
    }
    pieces = swapped.pieces;
    fit = swapped.fit;
  }
  const result = openParts(pieces, id, splittable);
  return typeof result === 'string' || fit === undefined ? result : { ...result, fit };
}

function openParts(pieces: readonly Piece[], id: string, splittable: boolean): Converted | string {
  const arcs = pieces.filter(isArc);
  if (arcs.length === 0) {
    const line = lineShape(openVertices(pieces), id);
    return typeof line === 'string' ? line : { shapes: [line], ids: [id], area: false };
  }
  const only = arcs[0];
  if (pieces.length === 1 && only !== undefined && only.circular) {
    return { shapes: arcShapes(only, id), ids: [id], area: false };
  }
  if (!splittable || !arcs.every((a) => a.circular)) {
    return 'mixed path';
  }
  const shapes: ShapeInput[] = [];
  const ids: string[] = [];
  let run: Piece[] = [];
  const letter = (): string => `${id}${String.fromCharCode(97 + ids.length)}`;
  const flush = (): string | null => {
    if (run.length === 0) {
      return null;
    }
    const part = letter();
    const line = lineShape(openVertices(run), part);
    run = [];
    if (typeof line === 'string') {
      return line;
    }
    shapes.push(line);
    ids.push(part);
    return null;
  };
  for (const piece of pieces) {
    if (!isArc(piece)) {
      run.push(piece);
      continue;
    }
    const failed = flush();
    if (failed !== null) {
      return failed;
    }
    const part = letter();
    shapes.push(...arcShapes(piece, part));
    ids.push(part);
  }
  const failed = flush();
  return failed ?? { shapes, ids, area: false };
}
