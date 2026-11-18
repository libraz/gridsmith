/**
 * @file SVG path-data and transform parsing: subpaths of lines, arcs and cubic Beziers, and
 * the 2x3 matrices that bake translate/scale/rotate lists into points.
 */

import { elevate } from './fit.js';

export type Vec = { x: number; y: number };
export type Matrix = [number, number, number, number, number, number];

type RawCmd =
  | { kind: 'L'; to: Vec }
  | { kind: 'A'; rx: number; ry: number; phi: number; large: boolean; sweep: boolean; to: Vec }
  | { kind: 'C'; c1: Vec; c2: Vec; to: Vec };
export type RawSubpath = { index: number; start: Vec; cmds: RawCmd[]; closed: boolean };

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const COMMANDS = 'MmLlHhVvAaZzCcSsQqTt';

/** Parses SVG path data into subpaths; throws on characters outside the grammar. */
export function parsePath(d: string, segment: number): RawSubpath[] {
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
export function parseTransform(text: string): Matrix | string {
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

export const apply = (m: Matrix, p: Vec): Vec => ({
  x: m[0] * p.x + m[2] * p.y + m[4],
  y: m[1] * p.x + m[3] * p.y + m[5],
});
