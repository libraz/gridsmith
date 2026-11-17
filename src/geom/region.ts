import type { Circle, Line, Vec } from './primitives.js';
import { signedDistance } from './primitives.js';

export type Source = { id: string; copy: number };

export type RegionNode =
  | { kind: 'disc'; circle: Circle; source: Source }
  | { kind: 'half'; line: Line; sign: 1 | -1; source: Source }
  | { kind: 'poly'; loops: Vec[][]; source: Source }
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

/** Bounding box of all disc and poly leaves, or null when there are none. */
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
