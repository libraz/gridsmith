import { describe, expect, it } from 'vitest';
import {
  intersectCircleCircle,
  intersectCircleLine,
  intersectLineLine,
} from '../../src/geom/intersect.js';
import type { Vec } from '../../src/geom/primitives.js';
import { distance, lineThrough } from '../../src/geom/primitives.js';

const circ = (cx: number, cy: number, r: number) => ({ cx, cy, r });
const polar = (d: number, deg: number): Vec => ({
  x: d * Math.cos((deg * Math.PI) / 180),
  y: d * Math.sin((deg * Math.PI) / 180),
});

describe('intersectCircleCircle', () => {
  it('separate circles do not meet', () => {
    expect(intersectCircleCircle(circ(0, 0, 1), circ(10, 0, 2)).kind).toBe('none');
  });

  it('external tangent gives one point', () => {
    const res = intersectCircleCircle(circ(0, 0, 1), circ(3, 0, 2));
    expect(res.kind).toBe('tangent');
    if (res.kind === 'tangent') {
      expect(res.point.x).toBeCloseTo(1, 12);
      expect(res.point.y).toBeCloseTo(0, 12);
    }
  });

  it('two crossing circles give two points on both circles', () => {
    const a = circ(0, 0, 2);
    const b = circ(3, 0, 2);
    const res = intersectCircleCircle(a, b);
    expect(res.kind).toBe('two');
    if (res.kind === 'two') {
      for (const p of res.points) {
        expect(distance(p, { x: 0, y: 0 })).toBeCloseTo(2, 12);
        expect(distance(p, { x: 3, y: 0 })).toBeCloseTo(2, 12);
      }
      expect(res.points[0].x).toBeCloseTo(1.5, 12);
    }
  });

  it('internal tangent gives one point on the larger circle side', () => {
    const res = intersectCircleCircle(circ(0, 0, 3), circ(1, 0, 2));
    expect(res.kind).toBe('tangent');
    if (res.kind === 'tangent') {
      expect(res.point.x).toBeCloseTo(3, 12);
    }
    const swapped = intersectCircleCircle(circ(1, 0, 2), circ(0, 0, 3));
    expect(swapped.kind).toBe('tangent');
    if (swapped.kind === 'tangent') {
      expect(swapped.point.x).toBeCloseTo(3, 12);
    }
  });

  it('contained circle does not meet', () => {
    expect(intersectCircleCircle(circ(0, 0, 5), circ(1, 0, 1)).kind).toBe('none');
  });

  it('identical circles are coincident, also within SNAP', () => {
    expect(intersectCircleCircle(circ(1, 2, 3), circ(1, 2, 3)).kind).toBe('coincident');
    expect(intersectCircleCircle(circ(1, 2, 3), circ(1 + 5e-8, 2, 3 - 5e-8)).kind).toBe(
      'coincident',
    );
  });

  it('concentric circles with different radii do not meet', () => {
    expect(intersectCircleCircle(circ(0, 0, 1), circ(0, 0, 2)).kind).toBe('none');
  });

  it.each([0, 37, 123.4, 211, 359])('external tangent at %d degrees is one point', (deg) => {
    const r1 = 1.3;
    const r2 = 2.7;
    const c = polar(r1 + r2, deg);
    const res = intersectCircleCircle(circ(0, 0, r1), circ(c.x, c.y, r2));
    expect(res.kind).toBe('tangent');
    if (res.kind === 'tangent') {
      expect(distance(res.point, polar(r1, deg))).toBeLessThan(1e-12);
    }
  });

  it.each([0, 37, 123.4, 211])('internal tangent at %d degrees is one point', (deg) => {
    const c = polar(2.7 - 1.3, deg);
    const res = intersectCircleCircle(circ(0, 0, 2.7), circ(c.x, c.y, 1.3));
    expect(res.kind).toBe('tangent');
    if (res.kind === 'tangent') {
      expect(distance(res.point, polar(2.7, deg))).toBeLessThan(1e-12);
    }
  });

  it('circles overlapping by 5e-7 give two points', () => {
    const res = intersectCircleCircle(circ(0, 0, 1), circ(2 - 5e-7, 0, 1));
    expect(res.kind).toBe('two');
  });

  it('circles overlapping by 5e-10 count as tangent', () => {
    const res = intersectCircleCircle(circ(0, 0, 1), circ(2 - 5e-10, 0, 1));
    expect(res.kind).toBe('tangent');
  });
});

describe('intersectCircleLine', () => {
  const xAxis = lineThrough({ x: 0, y: 0 }, { x: 1, y: 0 });

  it('secant gives two points', () => {
    const res = intersectCircleLine(circ(0, 1, 2), xAxis);
    expect(res.kind).toBe('two');
    if (res.kind === 'two') {
      const xs = res.points.map((p) => p.x).sort((a, b) => a - b);
      expect(xs[0]).toBeCloseTo(-Math.sqrt(3), 12);
      expect(xs[1]).toBeCloseTo(Math.sqrt(3), 12);
    }
  });

  it('tangent gives the foot', () => {
    const res = intersectCircleLine(circ(4, 2, 2), xAxis);
    expect(res.kind).toBe('tangent');
    if (res.kind === 'tangent') {
      expect(res.point).toEqual({ x: 4, y: 0 });
    }
  });

  it('tangent at a generic angle gives one point', () => {
    const line = lineThrough({ x: 1, y: 1 }, { x: 1 + Math.cos(0.647), y: 1 + Math.sin(0.647) });
    const normal = { x: -Math.sin(0.647), y: Math.cos(0.647) };
    const res = intersectCircleLine(circ(1 + 2.5 * normal.x, 1 + 2.5 * normal.y, 2.5), line);
    expect(res.kind).toBe('tangent');
  });

  it('miss gives none', () => {
    expect(intersectCircleLine(circ(0, 5, 2), xAxis).kind).toBe('none');
  });
});

describe('intersectLineLine', () => {
  const xAxis = lineThrough({ x: 0, y: 0 }, { x: 1, y: 0 });

  it('crossing lines give one point', () => {
    const res = intersectLineLine(xAxis, lineThrough({ x: 2, y: -1 }, { x: 2, y: 5 }));
    expect(res.kind).toBe('point');
    if (res.kind === 'point') {
      expect(res.point.x).toBeCloseTo(2, 12);
      expect(res.point.y).toBeCloseTo(0, 12);
    }
  });

  it('parallel lines give none', () => {
    expect(intersectLineLine(xAxis, lineThrough({ x: 0, y: 1 }, { x: 1, y: 1 })).kind).toBe('none');
  });

  it('the same line is coincident, also reversed', () => {
    expect(intersectLineLine(xAxis, lineThrough({ x: 5, y: 0 }, { x: -3, y: 0 })).kind).toBe(
      'coincident',
    );
  });
});
