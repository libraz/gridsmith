import type { ChainPiece } from './chain.js';
import type { Circle, Line, Vec } from './primitives.js';
import { signedDistance } from './primitives.js';

export type Source = { id: string; copy: number };

export type RegionNode =
  | { kind: 'disc'; circle: Circle; source: Source }
  | { kind: 'half'; line: Line; sign: 1 | -1; source: Source }
  | { kind: 'poly'; loops: Vec[][]; source: Source }
  | { kind: 'chain'; pieces: ChainPiece[]; source: Source }
  | { kind: 'union' | 'intersect' | 'subtract'; children: RegionNode[] };

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/** Winding number of a closed vertex loop around a point not on its boundary. */
export function windingNumber(loop: readonly Vec[], p: Vec): number {
  let wn = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    if (a === undefined || b === undefined) {
      continue;
    }
    const side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
    if (a.y <= p.y) {
      if (b.y > p.y && side > 0) {
        wn++;
      }
    } else if (b.y <= p.y && side < 0) {
      wn--;
    }
  }
  return wn;
}

/** Membership of a point that is not on any boundary. */
export function contains(node: RegionNode, p: Vec): boolean {
  switch (node.kind) {
    case 'disc':
      return Math.hypot(p.x - node.circle.cx, p.y - node.circle.cy) < node.circle.r;
    case 'half':
      return signedDistance(node.line, p) * node.sign > 0;
    case 'poly': {
      let total = 0;
      for (const loop of node.loops) {
        total += windingNumber(loop, p);
      }
      return total !== 0;
    }
    case 'chain':
      return chainWinding(node.pieces, p) !== 0;
    case 'union':
      return node.children.some((child) => contains(child, p));
    case 'intersect':
      return node.children.every((child) => contains(child, p));
    case 'subtract': {
      const [first, ...rest] = node.children;
      return first !== undefined && contains(first, p) && !rest.some((c) => contains(c, p));
    }
  }
}

/** Structural boundedness: halves are unbounded; intersect needs one bounded child. */
export function isBounded(node: RegionNode): boolean {
  switch (node.kind) {
    case 'disc':
    case 'poly':
    case 'chain':
      return true;
    case 'half':
      return false;
    case 'union':
      return node.children.every(isBounded);
    case 'intersect':
      return node.children.some(isBounded);
    case 'subtract': {
      const first = node.children[0];
      return first !== undefined && isBounded(first);
    }
  }
}

/** Bounding box of all disc, poly and chain leaves, or null when there are none. */
export function boundsOfBoundedLeaves(node: RegionNode): Bounds | null {
  switch (node.kind) {
    case 'disc': {
      const { cx, cy, r } = node.circle;
      return { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
    }
    case 'half':
      return null;
    case 'poly': {
      let box: Bounds | null = null;
      for (const loop of node.loops) {
        for (const v of loop) {
          box = mergeBounds(box, { minX: v.x, minY: v.y, maxX: v.x, maxY: v.y });
        }
      }
      return box;
    }
    case 'chain': {
      let box: Bounds | null = null;
      for (const piece of node.pieces) {
        for (const v of [piece.start, ...axisExtremes(piece)]) {
          box = mergeBounds(box, { minX: v.x, minY: v.y, maxX: v.x, maxY: v.y });
        }
      }
      return box;
    }
    default: {
      let box: Bounds | null = null;
      for (const child of node.children) {
        box = mergeBounds(box, boundsOfBoundedLeaves(child));
      }
      return box;
    }
  }
}

function mergeBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

const TWO_PI = 2 * Math.PI;

/** Travel parameter of an angle on an arc piece, in [0, 2pi). */
function along(piece: Extract<ChainPiece, { kind: 'arc' }>, angle: number): number {
  const t = (piece.ccw ? angle - piece.from : piece.from - angle) % TWO_PI;
  return t < 0 ? t + TWO_PI : t;
}

/** Points of an arc piece at the axis directions strictly inside its range. */
function axisExtremes(piece: ChainPiece): Vec[] {
  if (piece.kind === 'line') {
    return [];
  }
  const { cx, cy, r } = piece.circle;
  const out: Vec[] = [];
  for (let k = -1; k < 3; k++) {
    const a = (k * Math.PI) / 2;
    const t = along(piece, a);
    if (t > 0 && t < piece.sweep) {
      out.push({ x: cx + r * Math.round(Math.cos(a)), y: cy + r * Math.round(Math.sin(a)) });
    }
  }
  return out;
}

/** Signed crossing of the +x ray from `p` with a y-monotone edge from `a` to `b`; half-open in y. */
function crossing(a: Vec, b: Vec, p: Vec, xAt: () => number): number {
  if (a.y <= p.y && p.y < b.y) {
    return p.x < xAt() ? 1 : 0;
  }
  if (b.y <= p.y && p.y < a.y) {
    return p.x < xAt() ? -1 : 0;
  }
  return 0;
}

/** Winding number of a chain around a point off its pieces, by crossings with the pieces. */
function chainWinding(pieces: readonly ChainPiece[], p: Vec): number {
  let wn = 0;
  for (const piece of pieces) {
    if (piece.kind === 'line') {
      const { start: a, end: b } = piece;
      wn += crossing(a, b, p, () => a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y));
      continue;
    }
    const { cx, cy, r } = piece.circle;
    const sign = piece.ccw ? 1 : -1;
    // Split at the top and bottom of the circle into y-monotone arcs.
    const cuts: { t: number; p: Vec }[] = [];
    for (const k of [1, -1]) {
      const t = along(piece, (k * Math.PI) / 2);
      if (t > 0 && t < piece.sweep) {
        cuts.push({ t, p: { x: cx, y: cy + k * r } });
      }
    }
    cuts.sort((u, v) => u.t - v.t);
    const marks = [{ t: 0, p: piece.start }, ...cuts, { t: piece.sweep, p: piece.end }];
    for (let i = 0; i + 1 < marks.length; i++) {
      const m0 = marks[i];
      const m1 = marks[i + 1];
      if (m0 === undefined || m1 === undefined) {
        continue;
      }
      const right = Math.cos(piece.from + (sign * (m0.t + m1.t)) / 2) > 0;
      wn += crossing(m0.p, m1.p, p, () => {
        const h = Math.sqrt(Math.max(0, r * r - (p.y - cy) * (p.y - cy)));
        return right ? cx + h : cx - h;
      });
    }
  }
  return wn;
}
