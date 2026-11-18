import { describe, expect, it } from 'vitest';
import { resolveSpec } from '../../src/resolve/resolve.js';
import { lint } from '../../src/rules/lint.js';
import type { SnapResult } from '../../src/rules/snap.js';
import { snapSpec } from '../../src/rules/snap.js';
import type { SpecInput } from '../../src/spec/schema.js';
import { specSchema } from '../../src/spec/schema.js';

type Json = Record<string, unknown>;

const icon = (shapes: Json[], extra: Json = {}): SpecInput =>
  ({
    version: 1,
    mode: 'icon',
    grid: { divisions: 12 },
    shapes,
    paint: [{ stroke: shapes.map((s) => String(s.id)), width: 1, color: '#107c41' }],
    ...extra,
  }) as SpecInput;

const snap = (shapes: Json[], extra: Json = {}): SnapResult => snapSpec(icon(shapes, extra));

const shapeOf = (result: SnapResult, id: string): Json => {
  const found = result.spec.shapes.find((s) => s.id === id);
  if (found === undefined) {
    throw new Error(`no shape ${id}`);
  }
  return found as Json;
};

const polyline = (id: string, xs: number[], ys: number[]): Json => ({
  id,
  type: 'polyline',
  through: xs.map((x, k) => [x, ys[k]]),
});

describe('snapSpec rounding', () => {
  it('rounds numeric coordinates to multiples of 0.5, halves away from zero', () => {
    const result = snap([
      { id: 'a', type: 'line', from: [0.2, -0.3], to: [3.26, 5.74] },
      { id: 'b', type: 'line', from: [-0.25, 0.25], to: [0.75, -0.75] },
    ]);
    expect(shapeOf(result, 'a')).toMatchObject({ from: [0, -0.5], to: [3.5, 5.5] });
    expect(shapeOf(result, 'b')).toMatchObject({ from: [-0.5, 0.5], to: [1, -1] });
  });

  it('never produces negative zero', () => {
    const result = snap([{ id: 'a', type: 'line', from: [-0.1, -0.2], to: [3, 3] }]);
    const [x, y] = shapeOf(result, 'a').from as number[];
    expect(Object.is(x, 0)).toBe(true);
    expect(Object.is(y, 0)).toBe(true);
  });

  it('keeps mirrored inputs mirrored', () => {
    const result = snap([
      { id: 'l', type: 'circle', center: [-1.25, 0.25], r: 1 },
      { id: 'r', type: 'circle', center: [1.25, -0.25], r: 1 },
    ]);
    expect(shapeOf(result, 'l').center).toEqual([-1.5, 0.5]);
    expect(shapeOf(result, 'r').center).toEqual([1.5, -0.5]);
  });

  it('rounds radii to 0.5 and lifts small ones to 0.5', () => {
    const result = snap([
      { id: 'a', type: 'circle', r: 2.3 },
      { id: 'b', type: 'circle', r: 0.2 },
      {
        id: 'c',
        type: 'rect',
        corners: [
          [0, 0],
          [6, 6],
        ],
        r: 1.2,
      },
      { id: 'd', type: 'oval', center: [0, 0], rx: 3.1, ry: 1.4 },
    ]);
    expect(shapeOf(result, 'a').r).toBe(2.5);
    expect(shapeOf(result, 'b').r).toBe(0.5);
    expect(shapeOf(result, 'c').r).toBe(1);
    expect(shapeOf(result, 'd')).toMatchObject({ rx: 3, ry: 1.5 });
  });

  it('reports the largest move of a point or radius', () => {
    const result = snap([
      { id: 'a', type: 'line', from: [0.1, 0], to: [4, 0] },
      { id: 'b', type: 'circle', r: 2.2 },
    ]);
    expect(result.moved).toBe(0.2);
  });

  it('reports no movement and no gap for a spec already on the grid', () => {
    const result = snap([{ id: 'a', type: 'line', from: [0, 0], to: [4, 0.5] }]);
    expect(result).toMatchObject({ moved: 0, gap: 0, kept: [] });
  });
});

describe('snapSpec uneven steps', () => {
  it('evens a polyline that is equally spaced before rounding (x = 0, 1.3, 2.6, 3.9)', () => {
    const result = snap([polyline('p', [0, 1.3, 2.6, 3.9], [0, 1, 2, 3])]);
    expect(shapeOf(result, 'p').through).toEqual([
      [-0.5, 0],
      [1, 1],
      [2.5, 2],
      [4, 3],
    ]);
  });

  it('evens a polyline running downward along the axis', () => {
    const result = snap([polyline('p', [3.9, 2.6, 1.3, 0], [0, 1, 2, 3])]);
    expect(shapeOf(result, 'p').through).toEqual([
      [4, 0],
      [2.5, 1],
      [1, 2],
      [-0.5, 3],
    ]);
  });

  it('evens along y when only y runs one way', () => {
    const result = snap([
      {
        id: 'p',
        type: 'polyline',
        through: [
          [0, 0],
          [1, 1.3],
          [-1, 2.6],
          [2, 3.9],
        ],
      },
    ]);
    expect(shapeOf(result, 'p').through).toEqual([
      [0, -0.5],
      [1, 1],
      [-1, 2.5],
      [2, 4],
    ]);
  });

  it('spaces equal steps by the rounded mean step, centred on the span', () => {
    // Source steps 1.24, 1.26, 1.25 (mean 1.25) round plainly to 1, 1.5, 1.5.
    const result = snap([polyline('p', [0, 1.24, 2.5, 3.75], [0, 1, 2, 3])]);
    expect(shapeOf(result, 'p').through).toEqual([
      [-0.5, 0],
      [1, 1],
      [2.5, 2],
      [4, 3],
    ]);
  });

  it('shifts the run back inside the canvas', () => {
    const result = snap([polyline('p', [8, 10.7, 13.3, 16], [0, 1, 2, 3])]);
    expect((shapeOf(result, 'p').through as number[][]).map((v) => v[0])).toEqual([
      4.5, 7, 9.5, 12,
    ]);
  });

  it('shifts the run back inside the canvas on the negative side', () => {
    const result = snap([polyline('p', [-16, -13.3, -10.7, -8], [0, 1, 2, 3])]);
    expect((shapeOf(result, 'p').through as number[][]).map((v) => v[0])).toEqual([
      -12, -9.5, -7, -4.5,
    ]);
  });

  it('leaves a polyline that stays even under plain rounding to plain rounding', () => {
    const result = snap([polyline('p', [0.1, 1.1, 2.1, 3.1], [0.2, 1.2, 2.2, 3.2])]);
    expect(shapeOf(result, 'p').through).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it('rounds plainly and reports steps too wide when the run cannot fit the canvas', () => {
    // Steps of 10.25 round to 10.5, and three of them span 31.5 modules.
    const result = snap([polyline('p', [0, 10.25, 20.5, 30.75], [0, 1, 2, 3])]);
    expect(shapeOf(result, 'p').through).toEqual([
      [0, 0],
      [10.5, 1],
      [20.5, 2],
      [31, 3],
    ]);
    expect(result.kept).toEqual([{ id: 'p', reason: 'steps too wide' }]);
  });

  it('moves other points at an evened vertex with it', () => {
    const result = snap([
      polyline('p', [0, 1.3, 2.6, 3.9], [0, 1, 2, 3]),
      { id: 'c', type: 'circle', center: [1.3, 1], r: 1 },
      { id: 'l', type: 'line', from: [3.9, 3], to: [6, 3] },
    ]);
    expect(shapeOf(result, 'c').center).toEqual([1, 1]);
    expect(shapeOf(result, 'l').from).toEqual([4, 3]);
  });

  it('does not treat points further than a rounding error from a vertex as the same vertex', () => {
    const result = snap([
      polyline('p', [0, 1.3, 2.6, 3.9], [0, 1, 2, 3]),
      { id: 'c', type: 'circle', center: [1.3001, 1], r: 1 },
    ]);
    expect(shapeOf(result, 'c').center).toEqual([1.5, 1]);
  });
});

describe('snapSpec uneven source steps', () => {
  it('rounds plainly and reports a polyline whose source steps differ by more than 5%', () => {
    // Steps 1, 2, 1: spread 1 over mean 1.33.
    const result = snap([polyline('p', [0, 1, 3, 4], [0, 1, 2, 3])]);
    expect(shapeOf(result, 'p').through).toEqual([
      [0, 0],
      [1, 1],
      [3, 2],
      [4, 3],
    ]);
    expect(result.kept).toEqual([{ id: 'p', reason: 'uneven steps' }]);
  });

  it('evens a polyline whose source steps differ by 5% or less of their mean', () => {
    // Steps 1.23, 1.27, 1.25 spread 3.2% of the mean; steps 1.2, 1.3, 1.25 spread 8%.
    const near = snap([polyline('p', [0, 1.23, 2.5, 3.75], [0, 1, 2, 3])]);
    expect(near.kept).toEqual([]);
    const far = snap([polyline('p', [0, 1.2, 2.5, 3.75], [0, 1, 2, 3])]);
    expect(far.kept).toEqual([{ id: 'p', reason: 'uneven steps' }]);
  });

  it('does not report a polyline that plain rounding already leaves even', () => {
    const result = snap([polyline('p', [0, 1.1, 2.1, 3.2], [0, 1, 2, 3])]);
    expect(result.kept).toEqual([]);
  });

  it('lets keepDirections work on a polyline that was rounded plainly', () => {
    // Segment 0 is diagonal (0.9 by 0.9); plain rounding makes it 0.5 by 1.
    const result = snap([
      {
        id: 'p',
        type: 'polyline',
        through: [
          [0.3, 0.1],
          [1.2, 1],
          [4.1, 2.4],
          [4.7, 3.9],
        ],
      },
    ]);
    expect(result.kept).toEqual([{ id: 'p', reason: 'uneven steps' }]);
    const through = shapeOf(result, 'p').through as [number, number][];
    const [a, b] = [through[0] as [number, number], through[1] as [number, number]];
    expect(Math.abs(b[0] - a[0])).toBeCloseTo(Math.abs(b[1] - a[1]), 9);
  });
});

describe('snapSpec grid step', () => {
  const stepped = (step: number, shapes: Json[]): SnapResult =>
    snapSpec(icon(shapes, { grid: { divisions: 12, step } }));

  it('rounds to multiples of the step of the spec and leaves grid as given', () => {
    const shapes = [{ id: 'a', type: 'line', from: [0.26, -0.34], to: [3.14, 5.76] }];
    const fine = stepped(0.1, shapes);
    expect(shapeOf(fine, 'a')).toMatchObject({ from: [0.3, -0.3], to: [3.1, 5.8] });
    expect(fine.spec.grid).toEqual({ divisions: 12, step: 0.1 });
    const quarter = stepped(0.25, shapes);
    expect(shapeOf(quarter, 'a')).toMatchObject({ from: [0.25, -0.25], to: [3.25, 5.75] });
    const coarse = snap(shapes);
    expect(shapeOf(coarse, 'a')).toMatchObject({ from: [0.5, -0.5], to: [3, 6] });
    expect(coarse.spec.grid).toEqual({ divisions: 12 });
  });

  it('leaves no float residue at step 0.1', () => {
    const result = stepped(0.1, [
      { id: 'a', type: 'line', from: [0.3, 0.7], to: [2.9, -1.1] },
      { id: 'c', type: 'circle', center: [0.29, 0.31], r: 0.61 },
    ]);
    expect(shapeOf(result, 'a')).toEqual({
      id: 'a',
      type: 'line',
      from: [0.3, 0.7],
      to: [2.9, -1.1],
    });
    expect(shapeOf(result, 'c')).toMatchObject({ center: [0.3, 0.3], r: 0.6 });
  });

  it('keeps radii at least one step, whatever the step', () => {
    const result = stepped(0.1, [{ id: 'c', type: 'circle', center: [0, 0], r: 0.02 }]);
    expect(shapeOf(result, 'c').r).toBe(0.1);
  });

  it('evens a polyline at step 0.1 without float residue', () => {
    // Steps of 1.33 round to 1.3; the run 3.9 long is centred on 1.995, so it starts at 0.045 -> 0.
    const result = stepped(0.1, [polyline('p', [0, 1.33, 2.66, 3.99], [0, 1, 2, 3])]);
    const xs = (shapeOf(result, 'p').through as number[][]).map((v) => v[0]);
    expect(xs).toEqual([0, 1.3, 2.6, 3.9]);
    expect(result.kept).toEqual([]);
  });

  it('leaves a half turn 12.4 apart alone at step 0.1', () => {
    const result = stepped(0.1, [
      { id: 'c', type: 'circle', center: [0, 0], r: 6.2 },
      { id: 'u', type: 'line', from: [-8, 6.2], to: [0, 6.2] },
      { id: 'd', type: 'line', from: [-8, -6.2], to: [0, -6.2] },
      { id: 'h', type: 'arc', on: 'c', from: 270, to: 90 },
    ]);
    expect(shapeOf(result, 'u')).toMatchObject({ from: [-8, 6.2], to: [0, 6.2] });
    expect(shapeOf(result, 'd')).toMatchObject({ from: [-8, -6.2], to: [0, -6.2] });
  });

  it('does not widen a half turn 12.5 apart at step 0.25', () => {
    const result = stepped(0.25, [
      { id: 'c', type: 'circle', center: [0, 0], r: 6.25 },
      { id: 'u', type: 'line', from: [-8, 6.25], to: [0, 6.25] },
      { id: 'd', type: 'line', from: [-8, -6.25], to: [0, -6.25] },
      { id: 'h', type: 'arc', on: 'c', from: 270, to: 90 },
    ]);
    expect(shapeOf(result, 'u')).toMatchObject({ from: [-8, 6.25], to: [0, 6.25] });
    expect(shapeOf(result, 'd')).toMatchObject({ from: [-8, -6.25], to: [0, -6.25] });
  });
});

describe('snapSpec collapsed figures', () => {
  it('keeps a line whose ends coincide', () => {
    const result = snap([{ id: 'a', type: 'line', from: [1.1, 1.1], to: [1.2, 1.2] }]);
    expect(shapeOf(result, 'a')).toMatchObject({ from: [1.1, 1.1], to: [1.2, 1.2] });
    expect(result.kept).toEqual([{ id: 'a', reason: 'zero length' }]);
    expect(result.moved).toBe(0);
  });

  it('keeps a polyline with coincident neighbours', () => {
    const result = snap([
      {
        id: 'a',
        type: 'polyline',
        through: [
          [0, 0],
          [0.2, 0.1],
          [3, 3],
        ],
      },
    ]);
    expect(shapeOf(result, 'a').through).toEqual([
      [0, 0],
      [0.2, 0.1],
      [3, 3],
    ]);
    expect(result.kept).toEqual([{ id: 'a', reason: 'coincident vertices' }]);
  });

  it('treats the last and first vertex of points as neighbours', () => {
    const result = snap([
      {
        id: 'a',
        type: 'points',
        through: [
          [0, 0],
          [3, 0],
          [0.2, 0.1],
        ],
      },
    ]);
    expect(result.kept).toEqual([{ id: 'a', reason: 'coincident vertices' }]);
  });

  it('keeps points that become collinear', () => {
    const result = snap([
      {
        id: 'a',
        type: 'points',
        through: [
          [0, 0],
          [2, 2.2],
          [4, 3.9],
        ],
      },
    ]);
    expect(shapeOf(result, 'a').through).toEqual([
      [0, 0],
      [2, 2.2],
      [4, 3.9],
    ]);
    expect(result.kept).toEqual([{ id: 'a', reason: 'collinear' }]);
  });

  it('keeps a rect that rounds flat', () => {
    const result = snap([
      {
        id: 'a',
        type: 'rect',
        corners: [
          [0, 0],
          [3, 0.2],
        ],
      },
    ]);
    expect(shapeOf(result, 'a').corners).toEqual([
      [0, 0],
      [3, 0.2],
    ]);
    expect(result.kept).toEqual([{ id: 'a', reason: 'flat rect' }]);
  });

  it('shrinks a rect corner radius to the largest multiple of 0.5 within half the short side', () => {
    const result = snap([
      {
        id: 'a',
        type: 'rect',
        corners: [
          [0, 0],
          [4, 2],
        ],
        r: 3,
      },
      {
        id: 'b',
        type: 'rect',
        corners: [
          [0, 0],
          [4, 1],
        ],
        r: 2,
      },
    ]);
    expect(shapeOf(result, 'a').r).toBe(1);
    expect(shapeOf(result, 'b').r).toBe(0.5);
  });

  it('drops a rect corner radius that shrinks to zero', () => {
    const result = snap([
      {
        id: 'a',
        type: 'rect',
        corners: [
          [0, 0],
          [4, 0.5],
        ],
        r: 1,
      },
    ]);
    expect('r' in shapeOf(result, 'a')).toBe(false);
  });

  it('turns a square with r equal to half its side into a circle', () => {
    const result = snap([
      {
        id: 'a',
        type: 'rect',
        corners: [
          [0, 0],
          [4, 4],
        ],
        r: 2,
      },
      {
        id: 'b',
        type: 'rect',
        corners: [
          [0.1, 0.1],
          [1.1, 0.9],
        ],
        r: 0.6,
      },
    ]);
    expect(shapeOf(result, 'a')).toEqual({ id: 'a', type: 'circle', center: [2, 2], r: 2 });
    expect(shapeOf(result, 'b')).toEqual({ id: 'b', type: 'circle', center: [0.5, 0.5], r: 0.5 });
  });

  it('turns an oval with equal radii into a circle and drops its rotation', () => {
    const result = snap([{ id: 'a', type: 'oval', center: [1, 1], rx: 2.1, ry: 1.9, rotate: 45 }]);
    expect(shapeOf(result, 'a')).toEqual({ id: 'a', type: 'circle', center: [1, 1], r: 2 });
  });

  it('restores the radii of an oval whose ratio exceeds 4', () => {
    const result = snap([{ id: 'a', type: 'oval', center: [0.1, 0], rx: 5, ry: 1.1 }]);
    expect(shapeOf(result, 'a')).toMatchObject({ center: [0, 0], rx: 5, ry: 1.1 });
    expect(result.kept).toEqual([{ id: 'a', reason: 'oval ratio' }]);
  });
});

describe('snapSpec arc angles', () => {
  const arcOn = (from: unknown, to: unknown, id = 'a'): Json => ({
    id,
    type: 'arc',
    on: 'c',
    from,
    to,
  });

  it('re-aims an arc end at the rounded position of the vertex it met, and reports the gap', () => {
    const r = 4.2;
    const rad = (40 * Math.PI) / 180;
    const result = snap([
      { id: 'c', type: 'circle', center: [0, 0], r },
      arcOn(40, 135),
      { id: 'l', type: 'line', from: [r * Math.cos(rad), r * Math.sin(rad)], to: [6, 6] },
    ]);
    // The line end rounds to (3, 2.5); the closest circle is centred (-0.5, 0.5) with radius 4.
    expect(shapeOf(result, 'c')).toMatchObject({ center: [-0.5, 0.5], r: 4 });
    // The end then aims at 29.74 degrees, which is within 0.5 of the allowed 30.
    expect(shapeOf(result, 'a').from).toBe(30);
    expect(shapeOf(result, 'a').to).toBe(135);
    expect(result.gap).toBe(Math.round(Math.abs(Math.hypot(3.5, 2) - 4) * 1e4) / 1e4);
  });

  it('follows a polyline vertex too', () => {
    const r = 4.2;
    const rad = (40 * Math.PI) / 180;
    const result = snap([
      { id: 'c', type: 'circle', center: [0, 0], r },
      arcOn(135, 40),
      {
        id: 'p',
        type: 'polyline',
        through: [
          [6, 6],
          [6, 0],
          [r * Math.cos(rad), r * Math.sin(rad)],
        ],
      },
    ]);
    expect(shapeOf(result, 'a').to).toBe(30);
  });

  it('wraps a re-aimed angle into [0, 360)', () => {
    const r = 4.2;
    const rad = (-40 * Math.PI) / 180;
    const result = snap([
      { id: 'c', type: 'circle', center: [0, 0], r },
      arcOn(-40, 90),
      { id: 'l', type: 'line', from: [r * Math.cos(rad), r * Math.sin(rad)], to: [6, -6] },
    ]);
    // The line end rounds to (3, -2.5); the circle is centred (-0.5, -0.5), so the end aims at 330.26 and pulls to 330.
    expect(shapeOf(result, 'a').from).toBe(330);
  });

  it('leaves an end that touches nothing alone when it is far from an allowed angle', () => {
    const result = snap([{ id: 'c', type: 'circle', center: [0, 0], r: 4 }, arcOn(100, 170)]);
    expect(shapeOf(result, 'a')).toMatchObject({ from: 100, to: 170 });
    expect(result.gap).toBe(0);
  });

  it('pulls an end within 0.5 degrees onto the allowed angle', () => {
    const result = snap([{ id: 'c', type: 'circle', center: [0, 0], r: 4 }, arcOn(89.7, 180.4)]);
    expect(shapeOf(result, 'a')).toMatchObject({ from: 90, to: 180 });
  });

  it('does not pull an end more than 0.5 degrees away', () => {
    const result = snap([{ id: 'c', type: 'circle', center: [0, 0], r: 4 }, arcOn(90.6, 179)]);
    expect(shapeOf(result, 'a')).toMatchObject({ from: 90.6, to: 179 });
  });

  it('restores the angles when pulling would make both ends equal', () => {
    const result = snap([{ id: 'c', type: 'circle', center: [0, 0], r: 4 }, arcOn(89.8, 90.2)]);
    expect(shapeOf(result, 'a')).toMatchObject({ from: 89.8, to: 90.2 });
  });

  it('leaves point ends untouched', () => {
    const result = snap([{ id: 'c', type: 'circle', center: [0, 0], r: 4 }, arcOn([4.1, 0], 89.8)]);
    expect(shapeOf(result, 'a')).toMatchObject({ from: [4.1, 0], to: 90 });
  });
});

describe('snapSpec oval proportions', () => {
  const radii = (rx: number, ry: number): Json => {
    const result = snap([{ id: 'o', type: 'oval', center: [0, 0], rx, ry }]);
    const { rx: x, ry: y } = shapeOf(result, 'o') as { rx: number; ry: number };
    return { rx: x, ry: y };
  };

  it('rounds each radius of an oval to the nearest grid value', () => {
    expect(radii(2.24, 2.8)).toEqual({ rx: 2, ry: 3 });
    expect(radii(1.98, 2.8)).toEqual({ rx: 2, ry: 3 });
    expect(radii(4.2, 1.6)).toEqual({ rx: 4, ry: 1.5 });
    expect(radii(4.1, 4.8)).toEqual({ rx: 4, ry: 5 });
  });

  it('lifts a short radius to one step', () => {
    expect(radii(1.4, 0.2)).toEqual({ rx: 1.5, ry: 0.5 });
  });

  it('keeps the original radii when rounding pushes the ratio past 4', () => {
    // 4.6 / 1.2 = 3.83 rounds to 4.5 / 1 = 4.5.
    const result = snap([{ id: 'o', type: 'oval', center: [0, 0], rx: 4.6, ry: 1.2 }]);
    expect(shapeOf(result, 'o')).toMatchObject({ rx: 4.6, ry: 1.2 });
    expect(result.kept).toEqual([{ id: 'o', reason: 'oval ratio' }]);
  });
});

describe('arc on an oval', () => {
  const arcOn = (from: number, to: number): Json => ({ id: 'a', type: 'arc', on: 'o', from, to });

  it('moves both ends to the nearest allowed angle on the rounded oval', () => {
    const result = snap([
      { id: 'o', type: 'oval', center: [-6.4, -5.2], rx: 2.24, ry: 2.8 },
      arcOn(48.3, 311.7),
    ]);
    // Rounded oval: centre (-6.5, -5), rx 2, ry 3. The end at 48.3 is about 0.15 from the one at 45.
    expect(shapeOf(result, 'o')).toMatchObject({ center: [-6.5, -5], rx: 2, ry: 3 });
    expect(shapeOf(result, 'a')).toMatchObject({ from: 45, to: 315 });
    expect(result.kept).toEqual([]);
  });

  it('keeps an end whose move would exceed a quarter of a module', () => {
    const result = snap([{ id: 'o', type: 'oval', center: [0, 0], rx: 8, ry: 4 }, arcOn(3, 180)]);
    // 3 degrees is nearest to 0; the points are (7.968, 0.418) and (8, 0), about 0.42 apart.
    expect(shapeOf(result, 'a')).toMatchObject({ from: 3, to: 180 });
    expect(result.kept).toEqual([{ id: 'a', reason: 'arc angle' }]);
  });

  it('moves an end up to a quarter of a module at step 0.1 too', () => {
    const result = snapSpec(
      icon([{ id: 'o', type: 'oval', center: [0, 0], rx: 4, ry: 2 }, arcOn(2, 180)], {
        grid: { divisions: 12, step: 0.1 },
      }),
    );
    // The end seen at 2 degrees lies about 4 * sin(2 deg) = 0.14 from the axis end at 0.
    expect(shapeOf(result, 'a')).toMatchObject({ from: 0, to: 180 });
    expect(result.kept).toEqual([]);
  });

  it('treats an oval that rounds to a circle as a circle', () => {
    const result = snap([
      { id: 'o', type: 'oval', center: [0, 0], rx: 2.2, ry: 2.1 },
      arcOn(48.3, 311.7),
    ]);
    // Both radii round to 2; the chord between the ends is 2 * 2 * sin(1.65 deg), about 0.115.
    expect(shapeOf(result, 'o')).toMatchObject({ type: 'circle', r: 2 });
    expect(shapeOf(result, 'a')).toMatchObject({ from: 45, to: 315 });
    expect(result.kept).toEqual([]);
  });
});

describe('snapSpec seams', () => {
  const circleAt = (id: string, center: number[], r: number): Json => ({
    id,
    type: 'circle',
    center,
    r,
  });
  const arcOf = (id: string, on: string, from: unknown, to: unknown): Json => ({
    id,
    type: 'arc',
    on,
    from,
    to,
  });

  it('picks the circle that closes both seams', () => {
    const result = snap([
      circleAt('c', [0.2, 0.2], 2.2),
      arcOf('a', 'c', 0, 90),
      { id: 'h', type: 'line', from: [2.4, 0.2], to: [6, 0.2] },
      { id: 'v', type: 'line', from: [0.2, 2.4], to: [0.2, 6] },
    ]);
    expect(shapeOf(result, 'c')).toMatchObject({ center: [0, 0], r: 2.5 });
    expect(shapeOf(result, 'a')).toMatchObject({ from: 0, to: 90 });
    expect(shapeOf(result, 'h').from).toEqual([2.5, 0]);
    expect(shapeOf(result, 'v').from).toEqual([0, 2.5]);
    expect(result.gap).toBe(0);
  });

  it('breaks ties by the smaller centre move', () => {
    const result = snap([
      circleAt('c', [0, 0.2], 2.2),
      arcOf('a', 'c', 90, 180),
      { id: 'l', type: 'line', from: [0, 2.4], to: [4, 2.4] },
    ]);
    // Centre (0, 0.5) with radius 2 also closes the seam, but moves 0.3 rather than 0.2.
    expect(shapeOf(result, 'c')).toMatchObject({ center: [0, 0], r: 2.5 });
    expect(shapeOf(result, 'a')).toMatchObject({ from: 90, to: 180 });
    expect(result.gap).toBe(0);
  });

  it('joins two arcs at the rounded joint', () => {
    const result = snap([
      circleAt('p', [0.1, 0.1], 2.2),
      circleAt('q', [4.5, 0.1], 2.2),
      arcOf('a', 'p', 270, 0),
      arcOf('b', 'q', 180, 90),
    ]);
    // The ends meet at (2.3, 0.1), which rounds to (2.5, 0).
    expect(shapeOf(result, 'p')).toMatchObject({ center: [0, 0], r: 2.5 });
    expect(shapeOf(result, 'q')).toMatchObject({ center: [4.5, 0], r: 2 });
    expect(shapeOf(result, 'a')).toMatchObject({ from: 270, to: 0 });
    expect(shapeOf(result, 'b')).toMatchObject({ from: 180, to: 90 });
    expect(result.gap).toBe(0);
  });

  it('writes a seam end as a point when the angle is not allowed', () => {
    const angle = (Math.atan2(4, 3) * 180) / Math.PI;
    const result = snap([
      circleAt('c', [0, 0], 5),
      arcOf('a', 'c', 0, angle),
      { id: 'l', type: 'line', from: [3, 4], to: [6, 4] },
    ]);
    expect(shapeOf(result, 'a')).toMatchObject({ from: 0, to: [3, 4] });
    const spec = specSchema.parse(result.spec);
    const resolved = resolveSpec(spec);
    if (!resolved.ok) {
      throw new Error(`resolve failed: ${JSON.stringify(resolved.errors)}`);
    }
    const { violations } = lint(spec, resolved.model, []);
    expect(violations.filter((v) => v.rule === 'angle')).toEqual([]);
  });

  it('keeps degrees when a gap remains', () => {
    const angle = (Math.atan2(2.4, 3.2) * 180) / Math.PI;
    const result = snap([
      circleAt('c', [0, 0], 4),
      arcOf('a', 'c', angle, 135),
      { id: 'l', type: 'line', from: [3.2, 2.4], to: [6, 6] },
    ]);
    // The line end rounds to (3, 2.5); no candidate closes it, the best is centre (-0.5, 0.5) with radius 4.
    expect(shapeOf(result, 'c')).toMatchObject({ center: [-0.5, 0.5], r: 4 });
    expect(result.gap).toBe(Math.round(Math.abs(Math.hypot(3.5, 2) - 4) * 1e4) / 1e4);
    expect(shapeOf(result, 'a')).toMatchObject({ from: 30, to: 135 });
  });

  it('still picks a circle that closes the seams at step 0.1', () => {
    const result = snapSpec(
      icon(
        [
          circleAt('c', [0.04, 0.04], 2.02),
          arcOf('a', 'c', 0, 90),
          { id: 'h', type: 'line', from: [2.06, 0.04], to: [6, 0.04] },
          { id: 'v', type: 'line', from: [0.04, 2.06], to: [0.04, 6] },
        ],
        { grid: { divisions: 12, step: 0.1 } },
      ),
    );
    // The ends round to (2.1, 0) and (0, 2.1): the rounded radius 2 misses them by 0.1, radius 2.1
    // meets both.
    expect(shapeOf(result, 'c')).toMatchObject({ center: [0, 0], r: 2.1 });
    expect(shapeOf(result, 'a')).toMatchObject({ from: 0, to: 90 });
    expect(result.gap).toBe(0);
  });

  it('widens a half turn to a whole diameter', () => {
    const result = snap([
      circleAt('c', [0.2, 0.2], 2.8),
      arcOf('a', 'c', 90, 270),
      { id: 'u', type: 'line', from: [3.4, 3.0], to: [0.2, 3.0] },
      { id: 'd', type: 'line', from: [3.4, -2.6], to: [0.2, -2.6] },
    ]);
    // The rounded spacing 5.5 becomes 6; the lower end is nearer its original (0.4 against 0.5).
    expect(shapeOf(result, 'u')).toMatchObject({ from: [3.5, 3], to: [0, 3] });
    expect(shapeOf(result, 'd')).toMatchObject({ from: [3.5, -3], to: [0, -3] });
    expect(shapeOf(result, 'c')).toMatchObject({ center: [0, 0], r: 3 });
    expect(shapeOf(result, 'a')).toMatchObject({ from: 90, to: 270 });
    expect(result.gap).toBe(0);
  });
});

describe('snapSpec directions', () => {
  it('keeps a diagonal line diagonal', () => {
    const result = snap([{ id: 'a', type: 'line', from: [0.2, 0.4], to: [4.0, 4.2] }]);
    // Plain rounding gives 4 across and 3.5 up; moving the end's y is the nearest of the four fixes.
    expect(shapeOf(result, 'a')).toMatchObject({ from: [0, 0.5], to: [4, 4.5] });
  });

  it('does not tilt a level line to straighten a diagonal', () => {
    const result = snap([
      { id: 'a', type: 'line', from: [0.2, 0.4], to: [4.0, 4.2] },
      { id: 'b', type: 'line', from: [4.0, 4.2], to: [8.0, 4.2] },
    ]);
    // Raising the shared end would tilt the level line, so the start's x moves instead.
    expect(shapeOf(result, 'a')).toMatchObject({ from: [0.5, 0.5], to: [4, 4] });
    expect(shapeOf(result, 'b')).toMatchObject({ from: [4, 4], to: [8, 4] });
  });

  it('straightens a tilted capsule', () => {
    const r = 2.6021;
    const result = snap([
      { id: 'a', type: 'line', from: [-4.56, -6.84], to: [-0.36, -2.64] },
      { id: 'p', type: 'circle', center: [-2.2, -0.8], r },
      { id: 'u', type: 'arc', on: 'p', from: 315, to: 135 },
      { id: 'c', type: 'line', from: [-4.04, 1.04], to: [-8.24, -3.16] },
      { id: 'q', type: 'circle', center: [-6.4, -5.0], r },
      { id: 'd', type: 'arc', on: 'q', from: 135, to: 315 },
    ]);
    expect(shapeOf(result, 'a')).toMatchObject({ from: [-4.5, -6.5], to: [-0.5, -2.5] });
    expect(shapeOf(result, 'c')).toMatchObject({ from: [-4, 1], to: [-8, -3] });
    expect(shapeOf(result, 'p')).toMatchObject({ center: [-2.5, -1], r: 2.5 });
    expect(shapeOf(result, 'q')).toMatchObject({ center: [-6.5, -5], r: 2.5 });
    expect(result.gap).toBe(0);
  });
});

describe('snapSpec arrow shafts', () => {
  const arrow = (head: number[][], fillColor = '#2f75b5'): SnapResult =>
    snap(
      [
        { id: 's', type: 'line', from: [5, -4.5], to: [0, -4.5] },
        { id: 'h', type: 'points', through: head },
      ],
      {
        paint: [
          { stroke: ['s'], width: 1, color: '#2f75b5' },
          { fill: 'h', color: fillColor },
        ],
      },
    );
  const head = [
    [-1.5, -4.5],
    [0.5, -3],
    [0.5, -6],
  ];

  it('stops a shaft at the base of its arrowhead', () => {
    expect(shapeOf(arrow(head), 's')).toMatchObject({ from: [5, -4.5], to: [0.5, -4.5] });
  });

  it('leaves a shaft of another colour', () => {
    expect(shapeOf(arrow(head, '#c00000'), 's')).toMatchObject({ from: [5, -4.5], to: [0, -4.5] });
  });

  it('leaves a shaft whose crossing is off the grid', () => {
    const skewed = [
      [-1.5, -4.5],
      [0.5, -3.5],
      [1, -6],
    ];
    expect(shapeOf(arrow(skewed), 's')).toMatchObject({ from: [5, -4.5], to: [0, -4.5] });
  });

  it('counts a shortened shaft end in moved as far as plain rounding moves it', () => {
    const result = snap(
      [
        { id: 's', type: 'line', from: [5, -4.5], to: [0.1, -4.5] },
        { id: 'h', type: 'points', through: head },
      ],
      {
        paint: [
          { stroke: ['s'], width: 1, color: '#2f75b5' },
          { fill: 'h', color: '#2f75b5' },
        ],
      },
    );
    // The end goes to the head base at x 0.5, 0.4 from where it was drawn; rounding alone moves it 0.1.
    expect(shapeOf(result, 's')).toMatchObject({ to: [0.5, -4.5] });
    expect(result.moved).toBe(0.1);
  });
});

describe('snapSpec scope', () => {
  it('leaves references, expressions and anchored points alone', () => {
    const shapes: Json[] = [
      { id: 'p', type: 'point', at: [1.2, 1.2] },
      { id: 'c', type: 'circle', center: 'p', r: 'R/2' },
      { id: 'q', type: 'point', at: { on: 'c', angle: 33 } },
      { id: 'l', type: 'line', from: 'p', to: { intersect: ['c', 'c'], near: [1.2, 1.2] } },
    ];
    const result = snap(shapes);
    expect(shapeOf(result, 'p').at).toEqual([1, 1]);
    expect(shapeOf(result, 'c')).toMatchObject({ center: 'p', r: 'R/2' });
    expect(shapeOf(result, 'q').at).toEqual({ on: 'c', angle: 33 });
    expect(shapeOf(result, 'l')).toMatchObject({
      from: 'p',
      to: { intersect: ['c', 'c'], near: [1.2, 1.2] },
    });
  });

  it('does not change paint, widths, colours or exceptions', () => {
    const extra = { exceptions: [{ rule: 'off_grid', target: 'a', reason: 'kept' }] };
    const input = icon([{ id: 'a', type: 'circle', r: 2.3 }], extra);
    const result = snapSpec(input);
    expect(result.spec.paint).toEqual(input.paint);
    expect(result.spec.exceptions).toEqual(input.exceptions);
  });

  it('does not modify its input and returns a copy', () => {
    const input = icon([
      polyline('p', [0, 1.3, 2.6, 3.9], [0, 1, 2, 3]),
      { id: 'a', type: 'arc', on: 'c', from: 89.8, to: 180.2 },
      { id: 'c', type: 'circle', center: [0.1, 0.1], r: 2.3 },
    ]);
    const before = JSON.stringify(input);
    const result = snapSpec(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(result.spec).not.toBe(input);
    expect(result.spec.shapes[0]).not.toBe(input.shapes[0]);
  });

  it('throws for a spec that is not an icon', () => {
    const mark = { version: 1, mode: 'mark', grid: { divisions: 4 }, shapes: [], paint: [] };
    const figure = { ...mark, mode: 'figure' };
    expect(() => snapSpec(mark as unknown as SpecInput)).toThrow(/icon/);
    expect(() => snapSpec(figure as unknown as SpecInput)).toThrow(/icon/);
  });
});

describe('snapSpec oval ends', () => {
  // Centre (5.2, -7.8), rx 4.2, ry 1.6 rounds to (5, -8), rx 4, ry 1.5 (4 * 1.6 / 4.2 = 1.52):
  // right end (9.4, -7.8) -> (9, -8), bottom end (5.2, -9.4) -> (5, -9.5), left end (1, -7.8) -> (1, -8).
  const lower = { id: 'a', type: 'oval', center: [5.2, -7.8], rx: 4.2, ry: 1.6 };

  it('moves a polyline end and a polygon vertex onto the rounded oval ends', () => {
    // The upper oval's right end (9.4, -6.6) rounds to (9, -6.5); plain rounding would give x = 9.5.
    const upper = { id: 'b', type: 'oval', center: [5.2, -6.6], rx: 4.2, ry: 1.6 };
    const result = snap([
      lower,
      upper,
      polyline('s', [9.4, 9.4], [-7.8, -6.6]),
      {
        id: 'h',
        type: 'points',
        through: [
          [9.4, -7.8],
          [5.2, -9.4],
          [1, -7.8],
        ],
      },
    ]);
    expect(shapeOf(result, 'a')).toMatchObject({ center: [5, -8], rx: 4, ry: 1.5 });
    expect(shapeOf(result, 'b')).toMatchObject({ center: [5, -6.5], rx: 4, ry: 1.5 });
    expect(shapeOf(result, 's').through).toEqual([
      [9, -8],
      [9, -6.5],
    ]);
    expect(shapeOf(result, 'h').through).toEqual([
      [9, -8],
      [5, -9.5],
      [1, -8],
    ]);
    // Largest move: (9.4, -7.8) -> (9, -8), sqrt(0.2).
    expect(result.moved).toBe(0.4472);
  });

  it('moves rect corners, stored or implied, onto the rounded oval ends', () => {
    // (1, -7.8) is the lower oval's left end -> (1, -8); (9.4, -6.6) the upper's right end -> (9, -6.5);
    // the implied (9.4, -7.8) and (1, -6.6) agree (x 9, y -8; x 1, y -6.5). Plain rounding gives x 9.5.
    const result = snap([
      lower,
      { id: 'b', type: 'oval', center: [5.2, -6.6], rx: 4.2, ry: 1.6 },
      {
        id: 'r',
        type: 'rect',
        corners: [
          [1, -7.8],
          [9.4, -6.6],
        ],
      },
    ]);
    expect(shapeOf(result, 'r').corners).toEqual([
      [1, -8],
      [9, -6.5],
    ]);
  });

  it('rounds a point 0.01 away from an oval end as usual', () => {
    const result = snap([lower, { id: 'l', type: 'line', from: [9.41, -7.8], to: [9.41, -5] }]);
    expect(shapeOf(result, 'l')).toMatchObject({ from: [9.5, -8], to: [9.5, -5] });
  });

  it('rounds a point on the ends of two ovals as usual when the rounded oval ends differ', () => {
    // Bottom end of centre (9.4, -6.6), rx 2.4, ry 1.2 is (9.4, -7.8); it rounds to centre (9.5, -6.5),
    // rx 2.5, ry 1 (2.5 * 1.2 / 2.4 = 1.25, the smaller on a tie), so to (9.5, -7.5), not (9, -8).
    const result = snap([
      lower,
      { id: 'c', type: 'oval', center: [9.4, -6.6], rx: 2.4, ry: 1.2 },
      { id: 'l', type: 'line', from: [9.4, -7.8], to: [9.4, -3] },
    ]);
    expect(shapeOf(result, 'c')).toMatchObject({ center: [9.5, -6.5], rx: 2.5, ry: 1 });
    expect(shapeOf(result, 'l')).toMatchObject({ from: [9.5, -8], to: [9.5, -3] });
  });

  it('keeps a diagonal by moving the end that is not on an oval end', () => {
    // (9.4, -7.8) -> (9, -8) and (5.4, -3.8) -> (5.5, -4) give 3.5 across, 4 down. Moving the free
    // end's x to 5 (0.447 from its original) beats its y to -4.5 (0.707); the oval end stays.
    const result = snap([lower, { id: 'l', type: 'line', from: [9.4, -7.8], to: [5.4, -3.8] }]);
    expect(shapeOf(result, 'l')).toMatchObject({ from: [9, -8], to: [5, -4] });
  });
});

describe('filled outlines', () => {
  const line = (id: string, from: number[], to: number[]): Json => ({ id, type: 'line', from, to });
  const circle = (id: string, center: number[], r: number): Json => ({
    id,
    type: 'circle',
    center,
    r,
  });
  const outline = (through: unknown[]): Json => ({ id: 'o', type: 'outline', through });
  const resolves = (result: SnapResult): void => {
    const resolved = resolveSpec(specSchema.parse(result.spec));
    if (!resolved.ok) {
      throw new Error(`resolve failed: ${JSON.stringify(resolved.errors)}`);
    }
  };
  // Bottom line, right arc, top line, left line, counter-clockwise; the top joint is the one under test.
  const tombstone = (
    bottom: number,
    top: number,
    center: number[],
    r: number,
    through: unknown[],
  ) =>
    snap(
      [
        line('b', [-6, bottom], [4.5, bottom]),
        circle('c', center, r),
        line('t', [-6, top], [0, top]),
        line('l', [-6, bottom], [-6, top]),
        outline(through),
      ],
      { paint: [{ fill: 'o' }] },
    );

  it('keeps a tangent D shape tangent with no corners', () => {
    // Lines y = -5.9 and 6.1 touch the circle at (-1.9, 0.1), r 6; all round to the D at (-2, 0), r 6.
    const result = snap(
      [
        line('b', [-7.9, -5.9], [-1.9, -5.9]),
        circle('a', [-1.9, 0.1], 6),
        line('t', [-1.9, 6.1], [-7.9, 6.1]),
        line('l', [-7.9, 6.1], [-7.9, -5.9]),
        outline(['b', 'a', 't', 'l']),
      ],
      { paint: [{ fill: 'o' }] },
    );
    expect(shapeOf(result, 'a')).toMatchObject({ center: [-2, 0], r: 6 });
    expect(shapeOf(result, 'b')).toMatchObject({ from: [-8, -6], to: [-2, -6] });
    expect(shapeOf(result, 't')).toMatchObject({ from: [-2, 6], to: [-8, 6] });
    expect(shapeOf(result, 'o').through).toEqual(['b', 'a', 't', 'l']);
    expect(result.kept).toEqual([]);
    resolves(result);
  });

  it('drops the corner where a crossing becomes tangent', () => {
    // Before: y = 6.1 is 6 from (0, 0.1) < 6.01, crossing at x = +-0.347; y = -4 crosses at x = +-4.394.
    // After: y = 6 touches (0, 0), r 6 at (0, 6); y = -4 crosses at x = +-sqrt(20).
    // Joints move 0.078, 0.361, 0.1 and 0.
    const result = tombstone(-4, 6.1, [0, 0.1], 6.01, [
      { on: 'b', corner: [4.39, -4] },
      { on: 'c', corner: [0.35, 6.1] },
      't',
      'l',
    ]);
    expect(shapeOf(result, 'c')).toMatchObject({ center: [0, 0], r: 6 });
    expect(shapeOf(result, 'o').through).toEqual([
      { on: 'b', corner: [4.472135955, -4] },
      { on: 'c' },
      't',
      'l',
    ]);
    expect(result.kept).toEqual([]);
    resolves(result);
  });

  it('reverts an outline whose joint would jump more than a grid step', () => {
    // Before: y = 5.7 touches (0, 0.3), r 5.4 at (0, 5.7); y = -3 crosses at x = +-4.274.
    // After: (0, 0.5), r 5.5 crosses y = 5.5 at x = +-sqrt(5.25), so the top joint moves about 2.30.
    const through = [{ on: 'b', corner: [4.27, -3] }, 'c', 't', 'l'];
    const result = tombstone(-3, 5.7, [0, 0.3], 5.4, through);
    expect(shapeOf(result, 'c')).toEqual(circle('c', [0, 0.3], 5.4));
    expect(shapeOf(result, 'b')).toEqual(line('b', [-6, -3], [4.5, -3]));
    expect(shapeOf(result, 't')).toEqual(line('t', [-6, 5.7], [0, 5.7]));
    expect(shapeOf(result, 'l')).toEqual(line('l', [-6, -3], [-6, 5.7]));
    expect(shapeOf(result, 'o').through).toEqual(through);
    expect(result.kept).toEqual([{ id: 'o', reason: 'outline' }]);
    resolves(result);
  });

  // Circles (0, 0) and (2.3, 0), r 1.2, cross at (1.15, +-0.343); rounded to r 1 at 2.5 apart they part.
  const lobes = [circle('p', [0, 0], 1.2), circle('q', [2.3, 0], 1.2)];

  it('rounds an unrelated line that shares an end with a support of a reverted outline', () => {
    // Left lobe down to y = -1 at x = -0.663, the line to x = 2.963, the right lobe up to (1.15, 0.343).
    const original = line('f', [-1.2, -1], [3.4, -1]);
    const result = snap(
      [
        ...lobes,
        original,
        line('u', [3.4, -1], [6.3, 2.1]),
        outline([
          { on: 'p', corner: [-0.66, -1] },
          { on: 'f', corner: [2.96, -1] },
          { on: 'q', corner: [1.15, 0.34] },
        ]),
      ],
      {
        paint: [{ fill: 'o' }, { stroke: ['u'], width: 1 }],
      },
    );
    expect(shapeOf(result, 'f')).toEqual(original);
    expect(shapeOf(result, 'u')).toMatchObject({ from: [3.5, -1], to: [6.5, 2] });
    expect(result.kept).toEqual([{ id: 'o', reason: 'outline' }]);
    resolves(result);
  });

  it('reverts an outline whose circles come apart, with its supports, and rounds the rest', () => {
    const through = [
      { on: 'p', corner: [1.15, -0.34] },
      { on: 'q', corner: [1.15, 0.34] },
    ];
    const result = snap([...lobes, circle('x', [5.1, 5.1], 1.1), outline(through)], {
      paint: [{ fill: 'o' }, { fill: 'x' }],
    });
    expect(shapeOf(result, 'p')).toEqual(lobes[0]);
    expect(shapeOf(result, 'q')).toEqual(lobes[1]);
    expect(shapeOf(result, 'o').through).toEqual(through);
    expect(shapeOf(result, 'x')).toMatchObject({ center: [5, 5], r: 1 });
    expect(result.kept).toEqual([{ id: 'o', reason: 'outline' }]);
    // Only x moves: its centre by hypot(0.1, 0.1).
    expect(result.moved).toBe(0.1414);
    resolves(result);
  });
});

describe('snapSpec result under the rules', () => {
  it('leaves no off_grid or uneven_steps violation', () => {
    const result = snap([
      polyline('p', [0, 1.3, 2.6, 3.9], [0, 1, 2, 3]),
      polyline('q', [-4, -2.1, -0.2, 1.7], [-3, -2, -1, 0.1]),
      { id: 'c', type: 'circle', center: [1.3, 1], r: 2.3 },
      {
        id: 'r',
        type: 'rect',
        corners: [
          [-5.1, 4.2],
          [-1.9, 7.1],
        ],
        r: 0.7,
      },
      { id: 'o', type: 'oval', center: [5.2, -4.8], rx: 3.2, ry: 1.3 },
      { id: 'l', type: 'line', from: [-0.4, 6.3], to: [5.7, 7.2] },
    ]);
    const spec = specSchema.parse(result.spec);
    const resolved = resolveSpec(spec);
    if (!resolved.ok) {
      throw new Error(`resolve failed: ${JSON.stringify(resolved.errors)}`);
    }
    const { violations } = lint(spec, resolved.model, []);
    expect(violations.filter((v) => v.rule === 'off_grid' || v.rule === 'uneven_steps')).toEqual(
      [],
    );
  });
});

describe('snapSpec capsule rect', () => {
  const bar = (r: number): Json => ({
    id: 'bar',
    type: 'rect',
    corners: [
      [-4.25, 5.6],
      [8.2, 7.1],
    ],
    r,
  });

  it('keeps half-circle ends on a capsule rect', () => {
    // Corners round to [-4.5, 5.5] and [8, 7]: the short side is 1.5, so r is 0.75.
    const result = snap([bar(0.75)]);
    expect(shapeOf(result, 'bar')).toMatchObject({
      corners: [
        [-4.5, 5.5],
        [8, 7],
      ],
      r: 0.75,
    });
  });

  it('rounds a capsule rect radius that is not near half the short side', () => {
    const result = snap([bar(0.6)]);
    expect(shapeOf(result, 'bar')).toMatchObject({ r: 0.5 });
  });
});
