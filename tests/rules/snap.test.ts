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

const deg = (rad: number): number => Math.round(((rad * 180) / Math.PI) * 1e4) / 1e4;

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

  it('spaces uneven steps by the rounded mean step, centred on the span', () => {
    const result = snap([polyline('p', [0, 1, 3, 4], [0, 1, 2, 3])]);
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
    const result = snap([polyline('p', [0, 10, 21, 30], [0, 1, 2, 3])]);
    expect(shapeOf(result, 'p').through).toEqual([
      [0, 0],
      [10, 1],
      [21, 2],
      [30, 3],
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
    // The line end rounds to (3, 2.5) and the circle to radius 4.
    expect(shapeOf(result, 'a').from).toBe(deg(Math.atan2(2.5, 3)));
    expect(shapeOf(result, 'a').to).toBe(135);
    expect(result.gap).toBe(Math.round(Math.abs(Math.hypot(3, 2.5) - 4) * 1e4) / 1e4);
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
    expect(shapeOf(result, 'a').to).toBe(deg(Math.atan2(2.5, 3)));
  });

  it('wraps a re-aimed angle into [0, 360)', () => {
    const r = 4.2;
    const rad = (-40 * Math.PI) / 180;
    const result = snap([
      { id: 'c', type: 'circle', center: [0, 0], r },
      arcOn(-40, 90),
      { id: 'l', type: 'line', from: [r * Math.cos(rad), r * Math.sin(rad)], to: [6, -6] },
    ]);
    // The line end rounds to (3, -2.5): about -39.8 degrees.
    expect(shapeOf(result, 'a').from).toBe(deg(Math.atan2(-2.5, 3) + 2 * Math.PI));
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

describe('snapSpec result under the rules', () => {
  it('leaves no off_grid or uneven_steps violation', () => {
    const result = snap([
      polyline('p', [0, 1.3, 2.6, 3.9], [0, 1, 2, 3]),
      polyline('q', [-4, -2.2, 0.3, 1.9], [-3, -2, -1, 0.1]),
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
