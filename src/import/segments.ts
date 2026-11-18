/**
 * @file Converts a 24-unit icon stored as SVG path segments into an icon spec.
 *
 * Path data is read with the full SVG grammar, transforms are baked into the points, and each
 * subpath becomes one element (line, polyline, points, rect, circle, oval, arc) or a skip with a
 * reason. Coordinates map as x = x' - 12, y = 12 - y' and are rounded to 4 decimals without any
 * snapping to the grid. The arc-centre math lives here so this layer reads only `spec` types.
 * Bezier curves are fitted with lines and circular arcs (`fit.ts`); a fitted arc is never
 * recognised as part of a rect, and is part of a circle only when the whole closed subpath is.
 */

import type { Region, SpecInput } from '../spec/schema.js';
import { elevate, fitCubic } from './fit.js';

/** One path of a 24-unit icon: SVG path data plus presentation attributes. */
export type ImportSegment = {
  d: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number | string;
  strokeLinecap?: string;
  strokeLinejoin?: string;
  strokeDasharray?: string;
  fillRule?: 'nonzero' | 'evenodd';
  transform?: string;
};

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

/**
 * A subpath that was not converted; `segment` and `subpath` are -1 for spec-wide limits.
 * A `mixed path` carries its parts: the filled ring for a filled subpath, else the stroked parts.
 */
export type ImportSkip = {
  segment: number;
  subpath: number;
  reason: string;
  pieces?: ImportPiece[];
};

/**
 * A conversion that approximated the source. A `curve fit` note gives the largest fitting
 * deviation, the number of Bezier commands and the number of pieces fitted to them.
 */
export type ImportNote = {
  segment: number;
  subpath: number;
  note: string;
  deviation?: number;
  curves?: number;
  arcs?: number;
};

/** Result of {@link importSegments}; `subpaths` counts every subpath that draws something. */
export type ImportResult = {
  spec: SpecInput | null;
  skipped: ImportSkip[];
  notes: ImportNote[];
  subpaths: number;
};

type ShapeInput = SpecInput['shapes'][number];
type PaintInput = SpecInput['paint'][number];
type Pt = [number, number];
type Vec = { x: number; y: number };
type Matrix = [number, number, number, number, number, number];

type RawCmd =
  | { kind: 'L'; to: Vec }
  | { kind: 'A'; rx: number; ry: number; phi: number; large: boolean; sweep: boolean; to: Vec }
  | { kind: 'C'; c1: Vec; c2: Vec; to: Vec };
type RawSubpath = { index: number; start: Vec; cmds: RawCmd[]; closed: boolean };

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
const MAX_SHAPES = 64;
const MAX_LAYERS = 16;
const MAX_OPERANDS = 16;
const ARC_STEPS = 16;
const HALF = 12;
/** Fitted pieces allowed per subpath, so one curve cannot exhaust the shape limit. */
const MAX_FIT_PIECES = 16;
/** Tolerance on centres and radii when fitted arcs close into a circle. */
const FIT_CIRCLE_TOL = 0.1;
const MAX_D = 4096;

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const COMMANDS = 'MmLlHhVvAaZzCcSsQqTt';

const round4 = (v: number): number => {
  const r = Math.round(v * 1e4) / 1e4;
  return r === 0 ? 0 : r;
};
const pt = (p: Vec): Pt => [round4(p.x), round4(p.y)];
const dist = (p: Vec, q: Vec): number => Math.hypot(p.x - q.x, p.y - q.y);
const mid = (p: Vec, q: Vec): Vec => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
const degrees = (rad: number): number => (rad * 180) / Math.PI;

/** Parses SVG path data into subpaths; throws on characters outside the grammar. */
function parsePath(d: string, segment: number): RawSubpath[] {
  const subpaths: RawSubpath[] = [];
  let pos = 0;
  const fail = (what: string): never => {
    throw new Error(`segment ${segment}: ${what} at character ${pos} of d`);
  };
  const skip = (): void => {
    while (pos < d.length && /[\s,]/.test(d.charAt(pos))) {
      pos++;
    }
  };
  const missing = (): never => {
    const c = d.charAt(pos);
    return fail(
      c === '' || COMMANDS.includes(c) ? 'missing number' : `unexpected character "${c}"`,
    );
  };
  const number = (): number => {
    skip();
    NUMBER.lastIndex = pos;
    const m = NUMBER.exec(d);
    if (m === null) {
      return missing();
    }
    const v = Number(m[0]);
    if (!Number.isFinite(v)) {
      fail('number out of range');
    }
    pos += m[0].length;
    return v;
  };
  const flag = (): boolean => {
    skip();
    const c = d.charAt(pos);
    if (c !== '0' && c !== '1') {
      return missing();
    }
    pos++;
    return c === '1';
  };

  let cur: Vec = { x: 0, y: 0 };
  let cmd = '';
  const state: { sub: RawSubpath | null; reopen: boolean } = { sub: null, reopen: false };
  const open = (start: Vec): RawSubpath => {
    const created: RawSubpath = {
      index: subpaths.length,
      start,
      cmds: [],
      closed: false,
    };
    subpaths.push(created);
    state.sub = created;
    state.reopen = false;
    return created;
  };
  // After Z, the next drawing command starts a new subpath at the closed one's start.
  const active = (): RawSubpath => (state.sub === null || state.reopen ? open(cur) : state.sub);

  // Second control point of the previous C/S, or the control point of the previous Q/T.
  let lastCubic: Vec | null = null;
  let lastQuad: Vec | null = null;
  skip();
  while (pos < d.length) {
    const c = d.charAt(pos);
    if (COMMANDS.includes(c)) {
      if (cmd === '' && c !== 'M' && c !== 'm') {
        fail(`unexpected character "${c}"`);
      }
      cmd = c;
      pos++;
    } else if (cmd === '' || cmd === 'Z' || cmd === 'z' || !/[\d.+-]/.test(c)) {
      fail(`unexpected character "${c}"`);
    }
    const rel = cmd === cmd.toLowerCase();
    const base = cur;
    const pair = (): Vec => {
      const x = number();
      const y = number();
      return rel ? { x: base.x + x, y: base.y + y } : { x, y };
    };
    const upper = cmd.toUpperCase();
    const mirror = (q: Vec | null): Vec =>
      q === null ? base : { x: 2 * base.x - q.x, y: 2 * base.y - q.y };
    const cubic = (c1: Vec, c2: Vec, to: Vec): void => {
      active().cmds.push({ kind: 'C', c1, c2, to });
      cur = to;
    };
    const prevCubic: Vec | null = lastCubic;
    const prevQuad: Vec | null = lastQuad;
    lastCubic = null;
    lastQuad = null;
    switch (upper) {
      case 'M':
        cur = pair();
        open(cur);
        cmd = rel ? 'l' : 'L';
        break;
      case 'L': {
        const to = pair();
        active().cmds.push({ kind: 'L', to });
        cur = to;
        break;
      }
      case 'H':
      case 'V': {
        const v = number();
        const to =
          upper === 'H'
            ? { x: rel ? base.x + v : v, y: base.y }
            : { x: base.x, y: rel ? base.y + v : v };
        active().cmds.push({ kind: 'L', to });
        cur = to;
        break;
      }
      case 'A': {
        const rx = number();
        const ry = number();
        const phi = number();
        const large = flag();
        const sweep = flag();
        const to = pair();
        active().cmds.push({ kind: 'A', rx, ry, phi, large, sweep, to });
        cur = to;
        break;
      }
      case 'Z':
        if (state.sub !== null && !state.reopen) {
          state.sub.closed = true;
          cur = state.sub.start;
          state.reopen = true;
        }
        break;
      case 'C':
      case 'S': {
        const c1 = upper === 'C' ? pair() : mirror(prevCubic);
        const c2 = pair();
        cubic(c1, c2, pair());
        lastCubic = c2;
        break;
      }
      default: {
        const q1: Vec = upper === 'Q' ? pair() : mirror(prevQuad);
        const [, c1, c2, to] = elevate(base, q1, pair());
        cubic(c1, c2, to);
        lastQuad = q1;
      }
    }
    skip();
  }
  return subpaths;
}

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const translation = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
const rotation = (deg: number): Matrix => {
  const t = (deg * Math.PI) / 180;
  return [Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t), 0, 0];
};

/** Parses a translate/scale/rotate list; returns a skip reason for anything else. */
function parseTransform(text: string): Matrix | string {
  let m: Matrix = [1, 0, 0, 1, 0, 0];
  const re = /\s*([a-zA-Z]+)\s*\(([^)]*)\)\s*,?/y;
  let pos = 0;
  while (pos < text.length) {
    re.lastIndex = pos;
    const found = re.exec(text);
    if (found === null) {
      if (text.slice(pos).trim() === '') {
        break;
      }
      return 'transform';
    }
    pos = re.lastIndex;
    const name = found[1] ?? '';
    const args = (found[2] ?? '')
      .trim()
      .split(/[\s,]+/)
      .filter((s) => s !== '')
      .map(Number);
    if (args.some((v) => !Number.isFinite(v))) {
      return 'transform';
    }
    const [p = 0, q, r] = args;
    if (name === 'translate' && (args.length === 1 || args.length === 2)) {
      m = multiply(m, translation(p, q ?? 0));
    } else if (name === 'scale' && (args.length === 1 || args.length === 2)) {
      if (q !== undefined && Math.abs(q - p) > 1e-9) {
        return 'non-uniform scale';
      }
      m = multiply(m, [p, 0, 0, p, 0, 0]);
    } else if (name === 'rotate' && args.length === 1) {
      m = multiply(m, rotation(p));
    } else if (name === 'rotate' && args.length === 3) {
      const cx = q ?? 0;
      const cy = r ?? 0;
      m = multiply(multiply(multiply(m, translation(cx, cy)), rotation(p)), translation(-cx, -cy));
    } else {
      return 'transform';
    }
  }
  return m;
}

const apply = (m: Matrix, p: Vec): Vec => ({
  x: m[0] * p.x + m[2] * p.y + m[4],
  y: m[1] * p.x + m[3] * p.y + m[5],
});
const toUp = (p: Vec): Vec => ({ x: p.x - HALF, y: HALF - p.y });

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
function buildPieces(sub: RawSubpath, m: Matrix): Built | null {
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
      for (const p of curve.pieces) {
        if (p.kind === 'line') {
          all.push(p);
          continue;
        }
        const t1 = Math.atan2(p.a.y - p.c.y, p.a.x - p.c.x);
        const dt = vectorAngle(p.a.x - p.c.x, p.a.y - p.c.y, p.b.x - p.c.x, p.b.y - p.c.y);
        all.push({
          kind: 'arc',
          a: p.a,
          b: p.b,
          c: p.c,
          rx: p.r,
          ry: p.r,
          givenRx: p.r,
          givenRy: p.r,
          phi: 0,
          t1,
          dt,
          circular: true,
          fitted: true,
        });
      }
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

const isArc = (p: Piece): p is Arc => p.kind === 'arc';

/** Points along the closed boundary; arcs are cut into 16 chords. */
function polygonOf(pieces: readonly Piece[]): Vec[] {
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

function inside(p: Vec, poly: readonly Vec[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Vec;
    const b = poly[j] as Vec;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      hit = !hit;
    }
  }
  return hit;
}

/** Degrees in [0, 360), 4 decimals. */
const turnOf = (rad: number): number => {
  const a = round4(((degrees(rad) % 360) + 360) % 360);
  return a === 360 ? 0 : a;
};
const angleOn = (c: Vec, p: Vec): number => turnOf(Math.atan2(p.y - c.y, p.x - c.x));

/** A piece as listed on a skip, arcs turned counter-clockwise. */
const importPiece = (p: Piece): ImportPiece => {
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

type Converted = { shapes: ShapeInput[]; ids: string[]; area: boolean; note?: string };

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
function closedShape(pieces: readonly Piece[], id: string): Converted | string {
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

/** Stroked subpath, open or a closed round ring: lines, one arc, or line/arc parts. */
function openShape(pieces: readonly Piece[], id: string, splittable: boolean): Converted | string {
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

const unionOf = (items: Region[]): Region => {
  if (items.length === 1) {
    return items[0] as Region;
  }
  if (items.length <= MAX_OPERANDS) {
    return { union: items };
  }
  const groups: Region[] = [];
  for (let k = 0; k < items.length; k += MAX_OPERANDS) {
    groups.push(unionOf(items.slice(k, k + MAX_OPERANDS)));
  }
  return unionOf(groups);
};

/** Even-odd nesting as subtract trees; containment is tested on each leaf's first vertex. */
function evenOddRegion(leaves: readonly { id: string; poly: Vec[] }[]): Region {
  const holds = (i: number, j: number): boolean => {
    const probe = leaves[j]?.poly[0];
    return probe !== undefined && inside(probe, leaves[i]?.poly ?? []);
  };
  // Mutual containment (coincident outlines) keeps the earlier leaf outside.
  const contains = (i: number, j: number): boolean =>
    i !== j && holds(i, j) && (!holds(j, i) || i < j);
  const containers = leaves.map((_, j) => leaves.map((_, i) => i).filter((i) => contains(i, j)));
  const parent = containers.map((list) =>
    list.reduce<number>(
      (best, i) =>
        best < 0 || (containers[i]?.length ?? 0) > (containers[best]?.length ?? 0) ? i : best,
      -1,
    ),
  );
  const region = (node: number): Region => {
    const id = leaves[node]?.id ?? '';
    const children = parent.flatMap((p, k) => (p === node ? [region(k)] : []));
    if (children.length === 0) {
      return id;
    }
    return {
      subtract: children.length < MAX_OPERANDS ? [id, ...children] : [id, unionOf(children)],
    };
  };
  return unionOf(parent.flatMap((p, k) => (p < 0 ? [region(k)] : [])));
}

/** Lower-case `#rrggbb`, `null` for no paint, or `undefined` for an unsupported colour. */
const colour = (value: string): string | null | undefined => {
  const v = value.trim().toLowerCase();
  if (v === 'none') {
    return null;
  }
  if (/^#[0-9a-f]{6}$/.test(v)) {
    return v;
  }
  if (/^#[0-9a-f]{3}$/.test(v)) {
    return `#${[...v.slice(1)].map((h) => h + h).join('')}`;
  }
  return undefined;
};

const STRING_KEYS = [
  'fill',
  'stroke',
  'strokeLinecap',
  'strokeLinejoin',
  'strokeDasharray',
  'transform',
] as const;

/** Checks the input shape; positions are reported as `segments[i]`. */
function validate(segments: unknown): ImportSegment[] {
  if (!Array.isArray(segments)) {
    throw new Error(`segments must be an array (received: ${typeof segments})`);
  }
  segments.forEach((s: unknown, i) => {
    if (typeof s !== 'object' || s === null || typeof (s as { d?: unknown }).d !== 'string') {
      throw new Error(`segments[${i}].d must be a string`);
    }
    const seg = s as Record<string, unknown>;
    const length = (seg.d as string).length;
    if (length > MAX_D) {
      throw new Error(`segments[${i}].d must be at most ${MAX_D} characters (received: ${length})`);
    }
    for (const key of STRING_KEYS) {
      if (seg[key] !== undefined && typeof seg[key] !== 'string') {
        throw new Error(`segments[${i}].${key} must be a string`);
      }
    }
    if (seg.fillRule !== undefined && seg.fillRule !== 'nonzero' && seg.fillRule !== 'evenodd') {
      throw new Error(`segments[${i}].fillRule must be "nonzero" or "evenodd"`);
    }
    if (
      seg.strokeLinecap !== undefined &&
      !['round', 'butt', 'square'].includes(seg.strokeLinecap as string)
    ) {
      throw new Error(`segments[${i}].strokeLinecap must be "round", "butt" or "square"`);
    }
    if (
      seg.strokeLinejoin !== undefined &&
      !['round', 'miter', 'bevel', 'arcs', 'miter-clip'].includes(seg.strokeLinejoin as string)
    ) {
      throw new Error(
        `segments[${i}].strokeLinejoin must be "round", "miter", "bevel", "arcs" or "miter-clip"`,
      );
    }
    const width = seg.strokeWidth;
    if (width !== undefined) {
      const v =
        typeof width === 'number' ? width : typeof width === 'string' ? Number(width) : Number.NaN;
      if (!Number.isFinite(v) || v <= 0 || (typeof width === 'string' && width.trim() === '')) {
        throw new Error(
          `segments[${i}].strokeWidth must be a positive number (received: ${JSON.stringify(width)})`,
        );
      }
    }
  });
  return segments as ImportSegment[];
}

/**
 * Converts one icon's segments into an icon spec.
 *
 * Subpaths that cannot be expressed are listed in `skipped` with a reason; the rest still
 * convert. `spec` is `null` when nothing converted or a spec-wide limit is exceeded.
 * Throws on malformed input or path data, naming the segment and character position.
 */
export function importSegments(segments: unknown): ImportResult {
  const list = validate(segments);
  const shapes: ShapeInput[] = [];
  const paint: PaintInput[] = [];
  const skipped: ImportSkip[] = [];
  const notes: ImportNote[] = [];
  let count = 0;

  list.forEach((seg, i) => {
    const subpaths = parsePath(seg.d, i).filter((s) => s.cmds.length > 0 || s.closed);
    count += subpaths.length;
    const skipAll = (reason: string) => {
      for (const s of subpaths) {
        skipped.push({ segment: i, subpath: s.index, reason });
      }
    };
    const m = seg.transform === undefined ? parseTransform('') : parseTransform(seg.transform);
    if (typeof m === 'string') {
      skipAll(m);
      return;
    }
    const strokeColor = seg.stroke === undefined ? null : colour(seg.stroke);
    const fillColor = seg.fill === undefined ? null : colour(seg.fill);
    if (fillColor === undefined || strokeColor === undefined) {
      skipAll('colour');
      return;
    }
    if (seg.strokeLinejoin === 'arcs' || seg.strokeLinejoin === 'miter-clip') {
      skipAll('stroke join');
      return;
    }
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    let dash: [number, number] | undefined;
    if (seg.strokeDasharray !== undefined) {
      const values = seg.strokeDasharray
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      const [on, off] = values;
      if (
        values.length !== 2 ||
        on === undefined ||
        off === undefined ||
        !values.every((v) => Number.isFinite(v) && v > 0)
      ) {
        skipAll('dash pattern');
        return;
      }
      dash = [round4(on * scale), round4(off * scale)];
    }
    const width = round4(Number(seg.strokeWidth ?? 1) * scale);
    const cap = (seg.strokeLinecap ?? 'butt') as 'round' | 'butt' | 'square';
    const join = (seg.strokeLinejoin ?? 'miter') as 'round' | 'miter' | 'bevel';
    const splittable =
      cap === 'round' && join === 'round' && dash === undefined && fillColor === null;

    const fillLeaves: { id: string; poly: Vec[] }[] = [];
    const strokeIds: string[] = [];
    const dotIds: string[] = [];
    for (const sub of subpaths) {
      const id = `s${i}_${sub.index}`;
      const skip = (reason: string) => {
        skipped.push({ segment: i, subpath: sub.index, reason });
      };
      const built = buildPieces(sub, m);
      if (built === null) {
        skip('bezier');
        continue;
      }
      const { pieces, ring, closed } = built;
      if (built.curves > 0) {
        notes.push({
          segment: i,
          subpath: sub.index,
          note: 'curve fit',
          deviation: round4(built.deviation),
          curves: built.curves,
          arcs: built.fitted,
        });
      }
      if (pieces.length === 0) {
        if (strokeColor === null || cap === 'butt') {
          continue;
        }
        if (cap === 'square') {
          skip('dot');
          continue;
        }
        const center = pt(toUp(apply(m, sub.start)));
        shapes.push({ id: `${id}d`, type: 'circle', center, r: round4(width / 2) });
        dotIds.push(`${id}d`);
        continue;
      }
      const fill = fillColor === null ? null : closedShape(ring, id);
      let stroke: Converted | string | null = null;
      if (strokeColor !== null) {
        if (closed) {
          stroke = fill ?? closedShape(pieces, id);
          // A round, unfilled ring draws the same when split into parts.
          if (stroke === 'mixed path' && splittable) {
            stroke = openShape(pieces, id, true);
          }
        } else if (fill !== null && pieces.some(isArc)) {
          stroke = 'mixed path';
        } else {
          stroke = openShape(pieces, id, splittable);
        }
      }
      if (typeof fill === 'string' || typeof stroke === 'string') {
        const reason = typeof fill === 'string' ? fill : (stroke as string);
        if (reason === 'mixed path') {
          const drawn = (fillColor === null ? pieces : ring).map(importPiece);
          skipped.push({ segment: i, subpath: sub.index, reason, pieces: drawn });
        } else {
          skip(reason);
        }
        continue;
      }
      // An open stroked polyline that is also filled is filled as its closed polygon.
      const separate = fill !== null && stroke !== null && fill !== stroke;
      if (stroke !== null) {
        shapes.push(...stroke.shapes);
        strokeIds.push(...stroke.ids);
      }
      if (fill?.area) {
        const fillId = separate ? `${id}f` : id;
        if (separate) {
          shapes.push(...fill.shapes.map((s) => ({ ...s, id: fillId })));
        } else if (stroke === null) {
          shapes.push(...fill.shapes);
        }
        fillLeaves.push({ id: fillId, poly: polygonOf(ring) });
      }
      const note = (fill ?? stroke)?.note;
      if (note !== undefined) {
        notes.push({ segment: i, subpath: sub.index, note });
      }
    }

    if (fillColor !== null && fillLeaves.length > 0) {
      const region =
        seg.fillRule === 'evenodd'
          ? evenOddRegion(fillLeaves)
          : unionOf(fillLeaves.map((l) => l.id));
      paint.push({ fill: region, color: fillColor });
    }
    if (strokeColor !== null && strokeIds.length > 0) {
      paint.push({
        stroke: strokeIds,
        width,
        color: strokeColor,
        cap,
        join,
        ...(dash === undefined ? {} : { dash }),
      });
    }
    if (strokeColor !== null && dotIds.length > 0) {
      paint.push({ fill: unionOf(dotIds), color: strokeColor });
    }
  });

  let spec: SpecInput | null =
    shapes.length === 0
      ? null
      : { version: 1, mode: 'icon', grid: { divisions: 12 }, shapes, paint };
  if (shapes.length > MAX_SHAPES) {
    skipped.push({ segment: -1, subpath: -1, reason: 'too many shapes' });
    spec = null;
  }
  if (paint.length > MAX_LAYERS) {
    skipped.push({ segment: -1, subpath: -1, reason: 'too many layers' });
    spec = null;
  }
  return { spec, skipped, notes, subpaths: count };
}

const escapeAttr = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Draws segments as the consumer does: viewBox 0 0 24 24, one `path` per segment, attributes
 * only when present, `transform` passed through. A missing `fill` is `none`.
 */
export function segmentsToSvg(segments: readonly ImportSegment[]): string {
  const paths = segments.map((s) => {
    const fill = s.fill ?? 'none';
    const attrs: [string, string | number | undefined][] = [
      ['d', s.d],
      ['fill', fill],
      ['stroke', s.stroke],
      ['stroke-width', s.strokeWidth],
      ['stroke-linecap', s.strokeLinecap],
      ['stroke-linejoin', s.strokeLinejoin],
      ['stroke-dasharray', s.strokeDasharray],
      ['fill-rule', s.fillRule],
      ['transform', s.transform],
    ];
    const text = attrs
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
      .join('');
    return `<path${text}/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${paths.join('')}</svg>`;
}
