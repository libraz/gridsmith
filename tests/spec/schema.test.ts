import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  iconGridStep,
  isCircleLike,
  isRegionBounded,
  paintReferences,
  type Region,
  RULE_IDS,
  type Shape,
  shapeReferences,
  specSchema,
} from '../../src/spec/schema.js';
import { specJsonSchema } from '../../src/tools/shared.js';

type Obj = Record<string, unknown>;

const circle = (id: string, extra: Obj = {}): Obj => ({ id, type: 'circle', r: 'R', ...extra });

const markSpec = (extra: Obj = {}): Obj => ({
  version: 1,
  mode: 'mark',
  grid: { divisions: 4 },
  shapes: [circle('a'), circle('b', { r: 2 })],
  paint: [{ fill: 'a' }],
  ...extra,
});

const figureSpec = (extra: Obj = {}): Obj => ({
  version: 1,
  mode: 'figure',
  grid: { divisions: 4 },
  shapes: [circle('a'), circle('b', { r: 2 })],
  paint: [{ stroke: ['a'], width: 0.125 }],
  ...extra,
});

const markExample: Obj = {
  version: 1,
  mode: 'mark',
  grid: { divisions: 4 },
  concept: 'A crescent cut from one disc by a second, offset one module up and right.',
  shapes: [
    { id: 'body', type: 'circle', r: 'R' },
    { id: 'bite', type: 'circle', center: [1, 1], r: 3 },
  ],
  paint: [{ fill: { subtract: ['body', 'bite'] } }],
};

const figureExample: Obj = {
  version: 1,
  mode: 'figure',
  grid: { divisions: 4 },
  shapes: [
    { id: 'outer', type: 'circle', r: 'R' },
    { id: 'band', type: 'circle', r: 3.5 },
    { id: 'inner', type: 'circle', r: 3 },
    { id: 'core', type: 'circle', r: 'R/2' },
    { id: 'star', type: 'polygon', in: 'inner', n: 6, step: 2, rotate: 90 },
    { id: 'dot', type: 'circle', center: { on: 'band', angle: 0 }, r: 0.25 },
    { id: 'dots', type: 'repeat', of: ['dot'], n: 12 },
  ],
  paint: [{ stroke: ['outer', 'inner', 'core', 'star', 'dots'], width: 0.125 }],
};

const paths = (input: unknown): string[] => {
  const result = specSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
};

const accepted = (input: unknown) => specSchema.safeParse(input).success;

/** Asserts rejection with at least one issue at exactly `path`. */
const expectRejectedAt = (input: unknown, path: string) => {
  expect(accepted(input)).toBe(false);
  // Union members may report at the field or at a parent; both locate the same field.
  const found = paths(input).some(
    (p) => p === path || p.startsWith(`${path}.`) || (p !== '' && path.startsWith(`${p}.`)),
  );
  expect({ path, reported: paths(input) }).toSatisfy(() => found);
};

const FILLABLE = ['circle', 'tangent_circle', 'polygon', 'points', 'repeat'];

const withShapes = (shapes: (Obj | null)[], extra: Obj = {}): Obj => {
  const first = shapes.find((s) => s !== null && FILLABLE.includes(String((s as Obj).type)));
  return markSpec({ shapes, paint: [{ fill: (first as Obj | undefined)?.id ?? 'a' }], ...extra });
};
const mutateShape = (shape: Obj): Obj => withShapes([circle('a'), shape]);

describe('specSchema examples and defaults', () => {
  it('accepts both example specs', () => {
    expect(specSchema.safeParse(markExample).success).toBe(true);
    expect(specSchema.safeParse(figureExample).success).toBe(true);
  });

  it('applies defaults', () => {
    const spec = specSchema.parse({
      version: 1,
      mode: 'figure',
      grid: { divisions: 6 },
      shapes: [
        { id: 'a', type: 'circle', r: 3 },
        { id: 'p', type: 'polygon', in: 'a', n: 5 },
        { id: 'r', type: 'repeat', of: ['p'], n: 3 },
      ],
      paint: [{ stroke: ['r'], width: 0.5 }],
    });
    expect(spec.grid.margin).toBe(1);
    expect(spec.exceptions).toEqual([]);
    expect(spec.paint[0]).toMatchObject({ color: '#000000' });
    expect(spec.shapes[0]).toMatchObject({ center: [0, 0] });
    expect(spec.shapes[1]).toMatchObject({ step: 1, rotate: 0 });
    expect(spec.shapes[2]).toMatchObject({ center: [0, 0], mirror: false, axis: 90 });
  });

  it('converts to an input JSON Schema', () => {
    const json = z.toJSONSchema(specSchema, { io: 'input' }) as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(json.type).toBe('object');
    expect(json.additionalProperties).toBe(false);
    expect(json.required).toEqual(expect.arrayContaining(['version', 'mode', 'grid', 'shapes']));
    expect(json.required).not.toContain('exceptions');
    expect(Object.keys(json.properties)).toContain('shapes');
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  it('lists the eleven rule ids', () => {
    expect(RULE_IDS).toHaveLength(11);
    expect(new Set(RULE_IDS).size).toBe(11);
  });
});

describe('numeric ranges', () => {
  it.each([
    0,
    -0,
    -1,
    0.049,
    64.1,
    Number.POSITIVE_INFINITY,
    null,
    true,
    '2.5',
    'R/pi',
    'R/17',
    'R + 1',
  ])('rejects circle r %j', (r) => {
    expectRejectedAt(mutateShape(circle('c', { r })), 'shapes.1.r');
  });

  it.each([0.05, 64, 'R', 'a.r/2*sqrt3'])('accepts circle r %j', (r) => {
    expect(accepted(mutateShape(circle('c', { r })))).toBe(true);
  });

  it('rejects a 65 character length expression', () => {
    expectRejectedAt(mutateShape(circle('c', { r: `R${'*2'.repeat(32)}` })), 'shapes.1.r');
  });

  it.each([0, -1, 0.004, 8.1, Number.POSITIVE_INFINITY, null])('rejects width %j', (width) => {
    expectRejectedAt(figureSpec({ paint: [{ stroke: ['a'], width }] }), 'paint.0.width');
  });

  it.each([0.005, 8, 'R/16', 'a.r'])('accepts width %j', (width) => {
    expect(accepted(figureSpec({ paint: [{ stroke: ['a'], width }] }))).toBe(true);
  });

  it('accepts zero, negative zero and boundary coordinates', () => {
    expect(accepted(mutateShape(circle('c', { center: [0, -0] })))).toBe(true);
    expect(accepted(mutateShape(circle('c', { center: [64, -64] })))).toBe(true);
  });

  it.each([[[65, 0]], [[0, -65]], [[Number.POSITIVE_INFINITY, 0]], [[Number.NaN, 0]]])(
    'rejects coordinates %j',
    (center) => {
      expectRejectedAt(mutateShape(circle('c', { center })), 'shapes.1.center');
    },
  );

  it.each([3600, -3600, 450, -45, 22.5, 10])('accepts angle %j', (angle) => {
    expect(accepted(mutateShape(circle('c', { center: { on: 'a', angle } })))).toBe(true);
  });

  it.each([3601, -3601, Number.POSITIVE_INFINITY])('rejects on.angle %j', (angle) => {
    expectRejectedAt(mutateShape(circle('c', { center: { on: 'a', angle } })), 'shapes.1.center');
  });

  it.each([1e18, 3601, null])('rejects polygon rotate %j', (rotate) => {
    expectRejectedAt(
      mutateShape({ id: 'p', type: 'polygon', in: 'a', n: 5, rotate }),
      'shapes.1.rotate',
    );
  });

  it('accepts a repeat axis at the limit and rejects beyond it', () => {
    const rep = (axis: number) => mutateShape({ id: 'r', type: 'repeat', of: ['a'], n: 3, axis });
    expect(accepted(rep(-3600))).toBe(true);
    expectRejectedAt(rep(3601), 'shapes.1.axis');
  });

  it('states what is wrong, the received value and what is allowed', () => {
    const result = specSchema.safeParse(mutateShape(circle('c', { r: 0.049 })));
    expect(result.success).toBe(false);
    const message = result.success ? '' : (result.error.issues[0]?.message ?? '');
    expect(message).toContain('received: 0.049');
    expect(message).toContain('allowed:');
  });
});

describe('null, missing, empty and type errors', () => {
  it('rejects null and non-object specs', () => {
    expectRejectedAt(null, '');
    expectRejectedAt([], '');
  });

  it.each([
    ['mode', 'mode'],
    ['paint', 'paint'],
    ['shapes', 'shapes'],
    ['grid', 'grid'],
    ['version', 'version'],
  ])('rejects a missing %s', (key, path) => {
    const spec = markSpec();
    delete spec[key];
    expectRejectedAt(spec, path);
  });

  it('rejects a missing tangent_circle near', () => {
    expectRejectedAt(
      mutateShape({ id: 't', type: 'tangent_circle', r: 1, to: ['a', 'a2'] }),
      'shapes.1.near',
    );
  });

  it('rejects null exceptions and null array members', () => {
    expectRejectedAt(markSpec({ exceptions: null }), 'exceptions');
    expectRejectedAt(withShapes([null]), 'shapes.0');
    expectRejectedAt(
      withShapes([circle('a'), { id: 'r', type: 'repeat', of: ['a', null], n: 3 }]),
      'shapes.1.of.1',
    );
  });

  it.each([
    ['shapes', []],
    ['paint', []],
  ])('rejects an empty %s', (key, value) => {
    expectRejectedAt(markSpec({ [key]: value }), key);
  });

  it('rejects empty stroke, union, of and strings', () => {
    expectRejectedAt(figureSpec({ paint: [{ stroke: [], width: 1 }] }), 'paint.0.stroke');
    expectRejectedAt(markSpec({ paint: [{ fill: { union: [] } }] }), 'paint.0.fill');
    expectRejectedAt(mutateShape({ id: 'r', type: 'repeat', of: [], n: 3 }), 'shapes.1.of');
    expectRejectedAt(markSpec({ concept: '' }), 'concept');
    expectRejectedAt(
      markSpec({ exceptions: [{ rule: 'off_grid', target: 'a', reason: '' }] }),
      'exceptions.0.reason',
    );
  });

  it('rejects single-operand unions and subtractions', () => {
    expectRejectedAt(markSpec({ paint: [{ fill: { union: ['a'] } }] }), 'paint.0.fill');
    expectRejectedAt(markSpec({ paint: [{ fill: { subtract: ['a'] } }] }), 'paint.0.fill');
  });

  it.each([
    ['r true', circle('c', { r: true })],
    ['polygon n string', { id: 'p', type: 'polygon', in: 'a', n: '6' }],
    ['polygon n 5.5', { id: 'p', type: 'polygon', in: 'a', n: 5.5 }],
    ['polygon n 2147483648', { id: 'p', type: 'polygon', in: 'a', n: 2147483648 }],
    ['polygon n 4294967296', { id: 'p', type: 'polygon', in: 'a', n: 4294967296 }],
    ['mirror string', { id: 'r', type: 'repeat', of: ['a'], n: 3, mirror: 'yes' }],
  ])('rejects %s', (_label, shape) => {
    expect(accepted(mutateShape(shape))).toBe(false);
  });

  it('rejects fractional margin and version as a string', () => {
    expectRejectedAt(markSpec({ grid: { divisions: 4, margin: 1.5 } }), 'grid.margin');
    expectRejectedAt(markSpec({ version: '1' }), 'version');
    expectRejectedAt(markSpec({ version: 2 }), 'version');
  });

  it('accepts a whole number written with a fraction part', () => {
    expect(accepted(markSpec({ grid: { divisions: 4.0 } }))).toBe(true);
  });
});

describe('ranges', () => {
  it.each([4, 6, 8])('accepts divisions %d', (divisions) => {
    expect(accepted(markSpec({ grid: { divisions } }))).toBe(true);
  });

  it.each([5, 0, 4.5])('rejects divisions %d', (divisions) => {
    expectRejectedAt(markSpec({ grid: { divisions } }), 'grid.divisions');
  });

  it.each([0, 4])('accepts margin %d', (margin) => {
    expect(accepted(markSpec({ grid: { divisions: 4, margin } }))).toBe(true);
  });

  it.each([5, -1])('rejects margin %d', (margin) => {
    expectRejectedAt(markSpec({ grid: { divisions: 4, margin } }), 'grid.margin');
  });

  it.each([3, 36])('accepts polygon n %d', (n) => {
    expect(accepted(mutateShape({ id: 'p', type: 'polygon', in: 'a', n }))).toBe(true);
  });

  it.each([2, 37])('rejects polygon n %d', (n) => {
    expectRejectedAt(mutateShape({ id: 'p', type: 'polygon', in: 'a', n }), 'shapes.1.n');
  });

  it('accepts polygon n 7 as input', () => {
    expect(accepted(mutateShape({ id: 'p', type: 'polygon', in: 'a', n: 7 }))).toBe(true);
  });

  it.each([2, 36])('accepts repeat n %d', (n) => {
    expect(accepted(mutateShape({ id: 'r', type: 'repeat', of: ['a'], n }))).toBe(true);
  });

  it('allows repeat n 1 only with mirror', () => {
    expect(accepted(mutateShape({ id: 'r', type: 'repeat', of: ['a'], n: 1, mirror: true }))).toBe(
      true,
    );
    expectRejectedAt(mutateShape({ id: 'r', type: 'repeat', of: ['a'], n: 1 }), 'shapes.1.n');
    expectRejectedAt(
      mutateShape({ id: 'r', type: 'repeat', of: ['a'], n: 1, mirror: false }),
      'shapes.1.n',
    );
  });

  it.each([37, 0, 2.5])('rejects repeat n %d', (n) => {
    expectRejectedAt(
      mutateShape({ id: 'r', type: 'repeat', of: ['a'], n, mirror: true }),
      'shapes.1.n',
    );
  });

  it('bounds polygon step to [1, n/2)', () => {
    const poly = (n: number, step: number) =>
      mutateShape({ id: 'p', type: 'polygon', in: 'a', n, step });
    expect(accepted(poly(6, 2))).toBe(true);
    expect(accepted(poly(7, 3))).toBe(true);
    expect(accepted(poly(36, 17))).toBe(true);
    expectRejectedAt(poly(6, 0), 'shapes.1.step');
    expectRejectedAt(poly(6, 3), 'shapes.1.step');
    expectRejectedAt(poly(7, 4), 'shapes.1.step');
    expectRejectedAt(poly(3, 2), 'shapes.1.step');
    expectRejectedAt(poly(6, 1.5), 'shapes.1.step');
  });

  const manyCircles = (count: number): Obj[] =>
    Array.from({ length: count }, (_, i) => circle(`c${i}`, { r: 1 }));

  it('limits shapes to 256', () => {
    expect(accepted(withShapes(manyCircles(256), { paint: [{ fill: 'c0' }] }))).toBe(true);
    expectRejectedAt(withShapes(manyCircles(257), { paint: [{ fill: 'c0' }] }), 'shapes');
  });

  it('limits paint layers to 16', () => {
    const layers = (count: number) => Array.from({ length: count }, () => ({ fill: 'a' }));
    expect(accepted(markSpec({ paint: layers(16) }))).toBe(true);
    expectRejectedAt(markSpec({ paint: layers(17) }), 'paint');
  });

  it('limits exceptions to 16', () => {
    const rules = [
      'ratio_count',
      'circle_count',
      'off_grid',
      'angle',
      'off_canvas',
      'empty_fill',
      'thin_stroke',
      'unused_shape',
    ];
    const list = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        rule: rules[i % rules.length],
        target: i < rules.length ? 'spec' : 'a',
        reason: 'ok',
      }));
    expect(accepted(markSpec({ exceptions: list(16) }))).toBe(true);
    expectRejectedAt(markSpec({ exceptions: list(17) }), 'exceptions');
  });

  it('limits operands to 16 and region depth to 8', () => {
    const operands = (count: number) => Array.from({ length: count }, () => 'a');
    expect(accepted(markSpec({ paint: [{ fill: { union: operands(16) } }] }))).toBe(true);
    expectRejectedAt(markSpec({ paint: [{ fill: { union: operands(17) } }] }), 'paint.0.fill');

    const nest = (depth: number): Region =>
      depth === 1 ? { union: ['a', 'b'] } : { subtract: [nest(depth - 1), 'b'] };
    expect(accepted(markSpec({ paint: [{ fill: nest(8) }] }))).toBe(true);
    const deep = paths(markSpec({ paint: [{ fill: nest(9) }] }));
    expect(deep.length).toBeGreaterThan(0);
    expect(deep.every((p) => p.startsWith('paint.0.fill'))).toBe(true);
  });

  it('limits of to 8, through to 3..32 and concept to 400 units', () => {
    const ids = (count: number) => Array.from({ length: count }, (_, i) => `c${i}`);
    const base = (): Obj[] => manyCircles(9);
    const rep = (count: number) =>
      withShapes([...base(), { id: 'r', type: 'repeat', of: ids(count), n: 3 }]);
    expect(accepted(rep(8))).toBe(true);
    expectRejectedAt(rep(9), 'shapes.9.of');

    const through = (count: number) =>
      withShapes([
        { id: 'p', type: 'points', through: Array.from({ length: count }, (_, i) => [i, 0]) },
      ]);
    expect(accepted(through(3))).toBe(true);
    expect(accepted(through(32))).toBe(true);
    expectRejectedAt(through(2), 'shapes.0.through');
    expectRejectedAt(through(33), 'shapes.0.through');

    expect(accepted(markSpec({ concept: 'x'.repeat(400) }))).toBe(true);
    expectRejectedAt(markSpec({ concept: 'x'.repeat(401) }), 'concept');
  });

  it('counts string length in UTF-16 code units and accepts non-ASCII', () => {
    expect(accepted(markSpec({ concept: '\u{1F600}'.repeat(200) }))).toBe(true);
    expectRejectedAt(markSpec({ concept: '\u{1F600}'.repeat(201) }), 'concept');
    expect(
      accepted(markSpec({ exceptions: [{ rule: 'off_grid', target: 'a', reason: '帯の装飾' }] })),
    ).toBe(true);
  });
});

describe('point nesting', () => {
  const chain = (levels: number): unknown =>
    levels === 0 ? [1, 1] : { intersect: ['c1', 'c2'], near: chain(levels - 1) };
  const pointSpec = (at: unknown): Obj =>
    withShapes([
      circle('c1', { r: 3 }),
      circle('c2', { r: 3, center: [2, 0] }),
      { id: 'p', type: 'point', at },
    ]);

  it('accepts two levels of intersect inside near and rejects three', () => {
    expect(accepted(pointSpec(chain(3)))).toBe(true);
    expectRejectedAt(pointSpec(chain(4)), 'shapes.2.at.near.near.near');
  });

  it('applies the same limit under toward', () => {
    const region = (toward: unknown): Obj =>
      withShapes(
        [
          circle('c1', { r: 3 }),
          circle('c2', { r: 3, center: [2, 0] }),
          { id: 'l', type: 'line', from: [0, 0], to: [1, 0] },
        ],
        { paint: [{ fill: { intersect: [{ half: 'l', toward }, 'c1'] } }] },
      );
    expect(accepted(region(chain(2)))).toBe(true);
    expect(accepted(region(chain(3)))).toBe(false);
  });

  it('allows an intersect without near', () => {
    expect(accepted(pointSpec({ intersect: ['c1', 'c2'] }))).toBe(true);
  });
});

describe('unknown keys and values', () => {
  const unknownKeys = (input: unknown) => {
    const result = specSchema.safeParse(input);
    if (result.success) {
      return [];
    }
    return result.error.issues
      .filter((i) => i.code === 'unrecognized_keys')
      .map((i) => ({ path: i.path.join('.'), keys: (i as { keys: string[] }).keys }));
  };

  it('rejects unknown keys at every level with names and paths', () => {
    expect(unknownKeys(markSpec({ shape: [] }))).toEqual([{ path: '', keys: ['shape'] }]);
    expect(unknownKeys(markSpec({ grid: { divisions: 4, division: 4 } }))).toEqual([
      { path: 'grid', keys: ['division'] },
    ]);
    expect(unknownKeys(mutateShape(circle('c', { radius: 2 })))).toEqual([
      { path: 'shapes.1', keys: ['radius'] },
    ]);
    expect(unknownKeys(markSpec({ paint: [{ fill: 'a', width: 1 }] })).length).toBeGreaterThan(0);
    expect(
      unknownKeys(markSpec({ exceptions: [{ rule: 'off_grid', target: 'a', reason: 'r', x: 1 }] })),
    ).toEqual([{ path: 'exceptions.0', keys: ['x'] }]);
    expect(
      unknownKeys(mutateShape(circle('c', { center: { on: 'a', angle: 0, extra: 1 } }))).length,
    ).toBeGreaterThan(0);
  });

  it('rejects unknown enumerated values', () => {
    expectRejectedAt(mutateShape({ id: 'e', type: 'ellipse' }), 'shapes.1.type');
    expectRejectedAt(markSpec({ mode: 'logo' }), 'mode');
    const exception = (rule: string) =>
      markSpec({ exceptions: [{ rule, target: 'spec', reason: 'x' }] });
    expectRejectedAt(exception('foo'), 'exceptions.0.rule');
    expectRejectedAt(exception('unused_exception'), 'exceptions.0.rule');
    expect(accepted(exception('ratio_count'))).toBe(true);
  });

  it.each(['red', '#FFF', '#12345g', '#1234567'])('rejects color %s', (color) => {
    expectRejectedAt(markSpec({ paint: [{ fill: 'a', color }] }), 'paint.0.color');
  });

  it('accepts upper-case colors', () => {
    expect(accepted(markSpec({ paint: [{ fill: 'a', color: '#ABCDEF' }] }))).toBe(true);
  });
});

describe('ids and duplicates', () => {
  it.each(['spec', '円', 'A', '1a', '', 'a'.repeat(33)])('rejects id %j', (id) => {
    expectRejectedAt(withShapes([circle(id)]), 'shapes.0.id');
  });

  it('accepts the longest id', () => {
    expect(accepted(withShapes([circle('a'.repeat(32))]))).toBe(true);
  });

  it('rejects duplicate ids at the later element', () => {
    expectRejectedAt(withShapes([circle('a'), circle('a', { r: 2 })]), 'shapes.1.id');
  });

  it('rejects duplicates in to, intersect, stroke, of and exceptions', () => {
    expectRejectedAt(
      mutateShape({ id: 't', type: 'tangent_circle', r: 1, to: ['a', 'a'], near: [0, 0] }),
      'shapes.1.to.1',
    );
    expectRejectedAt(
      withShapes([
        circle('a'),
        circle('b', { r: 2 }),
        { id: 'p', type: 'point', at: { intersect: ['a', 'a'], near: [0, 0] } },
      ]),
      'shapes.2.at.intersect.1',
    );
    expectRejectedAt(figureSpec({ paint: [{ stroke: ['a', 'a'], width: 1 }] }), 'paint.0.stroke.1');
    expectRejectedAt(
      mutateShape({ id: 'r', type: 'repeat', of: ['a', 'a'], n: 3 }),
      'shapes.1.of.1',
    );
    const entry = { rule: 'off_grid', target: 'a', reason: 'r' };
    expectRejectedAt(markSpec({ exceptions: [entry, entry] }), 'exceptions.1.target');
    expect(
      accepted(
        markSpec({ exceptions: [entry, { ...entry, rule: 'angle' }, { ...entry, target: 'b' }] }),
      ),
    ).toBe(true);
  });
});

describe('modes and layers', () => {
  it('rejects a stroke layer in mark and a fill layer in figure', () => {
    expectRejectedAt(markSpec({ paint: [{ stroke: ['a'], width: 1 }] }), 'paint.0');
    expectRejectedAt(figureSpec({ paint: [{ fill: 'a' }] }), 'paint.0');
  });

  it('rejects a layer with neither key', () => {
    expectRejectedAt(markSpec({ paint: [{ color: '#000000' }] }), 'paint.0');
  });
});

describe('references', () => {
  it('rejects unknown and forward ids', () => {
    expectRejectedAt(withShapes([circle('a', { center: 'zz' })]), 'shapes.0.center');
    expectRejectedAt(
      withShapes([circle('a', { center: 'b' }), { id: 'b', type: 'point', at: [0, 0] }]),
      'shapes.0.center',
    );
    expectRejectedAt(
      withShapes([circle('a', { r: 'b.r/2' }), circle('b', { r: 2 })]),
      'shapes.0.r',
    );
    expectRejectedAt(markSpec({ paint: [{ fill: 'zz' }] }), 'paint.0.fill');
    const forward = specSchema.safeParse(
      withShapes([circle('a', { r: 'b.r/2' }), circle('b', { r: 2 })]),
    );
    expect(forward.success ? '' : forward.error.issues[0]?.message).toContain('forward reference');
  });

  it('accepts points referenced by id and circle centers', () => {
    expect(
      accepted(
        withShapes([
          { id: 'pt', type: 'point', at: [1, 1] },
          circle('a', { center: 'pt' }),
          circle('b', { center: 'a', r: 'a.r/2' }),
        ]),
      ),
    ).toBe(true);
  });

  it('rejects repeat of repeat or point', () => {
    const base = [circle('a'), { id: 'pt', type: 'point', at: [0, 0] }];
    expectRejectedAt(
      withShapes([...base, { id: 'r', type: 'repeat', of: ['pt'], n: 3 }]),
      'shapes.2.of.0',
    );
    expectRejectedAt(
      withShapes([
        ...base,
        { id: 'r1', type: 'repeat', of: ['a'], n: 3 },
        { id: 'r2', type: 'repeat', of: ['r1'], n: 3 },
      ]),
      'shapes.3.of.0',
    );
  });

  it('requires circle-like ids for in, on and .r bases', () => {
    const line = { id: 'l', type: 'line', from: [0, 0], to: [1, 0] };
    expectRejectedAt(
      withShapes([line, { id: 'p', type: 'polygon', in: 'l', n: 3 }]),
      'shapes.1.in',
    );
    expectRejectedAt(
      withShapes([line, circle('c', { center: { on: 'l', angle: 0 } })]),
      'shapes.1.center.on',
    );
    expectRejectedAt(withShapes([line, circle('c', { r: 'l.r/2' })]), 'shapes.1.r');
    expectRejectedAt(
      withShapes([{ id: 'pt', type: 'point', at: [0, 0] }, circle('c', { r: 'pt.r/2' })]),
      'shapes.1.r',
    );
  });

  it('requires lines for half and rejects points and lines in regions', () => {
    const line = { id: 'l', type: 'line', from: [0, 0], to: [1, 0] };
    const pt = { id: 'pt', type: 'point', at: [0, 0] };
    const shapes = [circle('a'), line, pt];
    expectRejectedAt(
      withShapes(shapes, {
        paint: [{ fill: { intersect: [{ half: 'a', toward: [0, 1] }, 'a'] } }],
      }),
      'paint.0.fill.intersect.0.half',
    );
    expectRejectedAt(
      withShapes(shapes, { paint: [{ fill: { union: ['a', 'pt'] } }] }),
      'paint.0.fill.union.1',
    );
    expectRejectedAt(
      withShapes(shapes, { paint: [{ fill: { union: ['a', 'l'] } }] }),
      'paint.0.fill.union.1',
    );
    const rep = [...shapes, { id: 'r', type: 'repeat', of: ['l'], n: 3 }];
    expectRejectedAt(
      withShapes(rep, { paint: [{ fill: { union: ['a', 'r'] } }] }),
      'paint.0.fill.union.1',
    );
  });

  it('accepts a repeat of discs, polygons and points in a region', () => {
    expect(
      accepted(
        withShapes(
          [
            circle('a', { r: 3 }),
            { id: 'd', type: 'circle', r: 1, center: [2, 0] },
            { id: 'r', type: 'repeat', of: ['d'], n: 3 },
          ],
          { paint: [{ fill: { subtract: ['a', 'r'] } }] },
        ),
      ),
    ).toBe(true);
  });

  it('rejects point stroke targets and polygon to/intersect operands', () => {
    const pt = { id: 'pt', type: 'point', at: [0, 0] };
    expectRejectedAt(
      figureSpec({ shapes: [circle('a'), pt], paint: [{ stroke: ['pt'], width: 1 }] }),
      'paint.0.stroke.0',
    );
    const poly = { id: 'p', type: 'polygon', in: 'a', n: 3 };
    expectRejectedAt(
      withShapes([
        circle('a'),
        poly,
        { id: 't', type: 'tangent_circle', r: 1, to: ['a', 'p'], near: [0, 0] },
      ]),
      'shapes.2.to.1',
    );
    expectRejectedAt(
      withShapes([
        circle('a'),
        poly,
        { id: 'q', type: 'point', at: { intersect: ['a', 'p'], near: [0, 0] } },
      ]),
      'shapes.2.at.intersect.1',
    );
  });

  it('accepts lines and circles as tangent and intersect operands', () => {
    expect(
      accepted(
        withShapes([
          circle('a', { r: 3 }),
          { id: 'l', type: 'line', from: [0, 0], to: [1, 0] },
          { id: 't', type: 'tangent_circle', r: 1, to: ['a', 'l'], near: [0, 2] },
          { id: 'q', type: 'point', at: { intersect: ['l', 't'], near: [1, 1] } },
        ]),
      ),
    ).toBe(true);
  });

  it('accepts a tangent circle whose radius equals its partner radius', () => {
    expect(
      accepted(
        withShapes([
          circle('a', { r: 2 }),
          circle('b', { r: 2, center: [3, 0] }),
          { id: 't', type: 'tangent_circle', r: 2, to: ['a', 'b'], near: [1.5, 2] },
        ]),
      ),
    ).toBe(true);
  });

  it('checks exception targets', () => {
    const target = (t: string) =>
      markSpec({ exceptions: [{ rule: 'off_grid', target: t, reason: 'r' }] });
    expect(accepted(target('a'))).toBe(true);
    expect(accepted(target('spec'))).toBe(true);
    expect(accepted(target('paint[0]'))).toBe(true);
    expectRejectedAt(target('paint[1]'), 'exceptions.0.target');
    expectRejectedAt(target('paint[00]'), 'exceptions.0.target');
    expectRejectedAt(target('nope'), 'exceptions.0.target');
    expectRejectedAt(target('exceptions[0]'), 'exceptions.0.target');
  });
});

describe('boundedness', () => {
  const line = { id: 'l', type: 'line', from: [0, 0], to: [1, 0] };
  const fill = (region: unknown) =>
    withShapes([circle('a', { r: 3 }), line], { paint: [{ fill: region }] });
  const half = { half: 'l', toward: [0, 1] };

  it.each([
    ['a lone half-plane', half],
    ['a union containing a half-plane', { union: ['a', half] }],
    ['a subtraction starting with a half-plane', { subtract: [half, 'a'] }],
    ['two half-planes', { intersect: [half, { half: 'l', toward: [0, -1] }] }],
  ])('rejects %s', (_label, region) => {
    expectRejectedAt(fill(region), 'paint.0.fill');
  });

  it.each([
    ['a half-plane clipped by a disc', { intersect: [half, 'a'] }],
    ['a disc minus a half-plane', { subtract: ['a', half] }],
  ])('accepts %s', (_label, region) => {
    expect(accepted(fill(region))).toBe(true);
  });

  it('exposes the structural test', () => {
    expect(isRegionBounded('a')).toBe(true);
    expect(isRegionBounded({ half: 'l', toward: [0, 1] })).toBe(false);
    expect(isRegionBounded({ intersect: [{ half: 'l', toward: [0, 1] }, 'a'] })).toBe(true);
  });
});

describe('processing caps', () => {
  const polygonBand = (extraCircles: number, n: number): Obj =>
    withShapes([
      circle('c0', { r: 3 }),
      { id: 'p', type: 'polygon', in: 'c0', n: 15 },
      { id: 'r', type: 'repeat', of: ['p'], n },
      ...Array.from({ length: extraCircles }, (_, i) => circle(`x${i}`, { r: 1 })),
    ]);

  it('limits mark support curves to 256 after repeat expansion', () => {
    // 1 circle + 15 edges x 17 copies = 256
    expect(accepted(polygonBand(0, 17))).toBe(true);
    expectRejectedAt(polygonBand(1, 17), 'shapes.3');
    expectRejectedAt(polygonBand(0, 18), 'shapes.2');
  });

  it('rejects a 36-fold octagon in mark but accepts it in figure', () => {
    const shapes = [
      circle('c0', { r: 3 }),
      { id: 'p', type: 'polygon', in: 'c0', n: 8 },
      { id: 'r', type: 'repeat', of: ['p'], n: 36 },
    ];
    expect(accepted(withShapes(shapes))).toBe(false);
    expect(accepted(figureSpec({ shapes, paint: [{ stroke: ['r'], width: 0.1 }] }))).toBe(true);
  });

  it('limits figure drawn elements to 2048', () => {
    const circles = Array.from({ length: 8 }, (_, i) => circle(`c${i}`, { r: 1 }));
    const ids = circles.map((c) => c.id);
    const repeats = Array.from({ length: 8 }, (_, i) => ({
      id: `r${i}`,
      type: 'repeat',
      of: ids,
      n: 32,
    }));
    const stroke = (extra: string[]) => [
      { stroke: repeats.map((r) => r.id), width: 0.1 },
      { stroke: extra, width: 0.1 },
    ];
    const shapes = [...circles, ...repeats];
    expect(accepted(figureSpec({ shapes, paint: stroke([]).slice(0, 1) }))).toBe(true);
    expectRejectedAt(figureSpec({ shapes, paint: stroke(['c0']) }), 'paint.1.stroke.0');
  });
});

describe('helpers', () => {
  const parsed = specSchema.parse(figureExample);

  it('classifies circle-like shapes', () => {
    expect(parsed.shapes.map((s) => isCircleLike(s))).toEqual([
      true,
      true,
      true,
      true,
      false,
      true,
      false,
    ]);
  });

  it('lists the ids a shape references', () => {
    const byId = (id: string): Shape => {
      const shape = parsed.shapes.find((s) => s.id === id);
      if (shape === undefined) {
        throw new Error(id);
      }
      return shape;
    };
    expect(shapeReferences(byId('outer'))).toEqual([]);
    expect(shapeReferences(byId('core'))).toEqual([]);
    expect(shapeReferences(byId('star'))).toEqual(['inner']);
    expect(shapeReferences(byId('dot'))).toEqual(['band']);
    expect(shapeReferences(byId('dots'))).toEqual(['dot']);
    expect(shapeReferences({ id: 'c', type: 'circle', center: [0, 0], r: 'a.r/2' })).toEqual(['a']);
    expect(
      shapeReferences({
        id: 't',
        type: 'tangent_circle',
        r: 'a.r',
        to: ['b', 'l'],
        near: { intersect: ['b', 'l'], near: 'pt' },
      }),
    ).toEqual(['a', 'b', 'l', 'pt']);
  });

  it('lists the ids a paint layer references', () => {
    expect(paintReferences({ stroke: ['a', 'b'], width: 'c.r/2', color: '#000000' })).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(
      paintReferences({
        fill: { subtract: ['a', { half: 'l', toward: { on: 'c', angle: 0 } }] },
        color: '#000000',
      }),
    ).toEqual(['a', 'l', 'c']);
  });
});

const arcFigure = (shapes: Obj[], paint: Obj[] = [{ stroke: ['arc'], width: 0.125 }]): Obj =>
  figureSpec({ shapes, paint });

const arcOf = (extra: Obj = {}): Obj => ({
  id: 'arc',
  type: 'arc',
  on: 'a',
  from: 30,
  to: 150,
  ...extra,
});

describe('arc shapes', () => {
  it('accepts numeric and point ends and strokes them', () => {
    expect(accepted(arcFigure([circle('a'), arcOf()]))).toBe(true);
    expect(
      accepted(
        arcFigure([
          circle('a'),
          circle('b', { center: [1, 0] }),
          arcOf({
            from: { intersect: ['a', 'b'], near: [0, 3] },
            to: { on: 'a', angle: 180 },
          }),
        ]),
      ),
    ).toBe(true);
    expect(accepted(arcFigure([circle('a'), arcOf({ from: [4, 0], to: 'a' })]))).toBe(true);
  });

  it('keeps the angle range at 3600 degrees', () => {
    expect(accepted(arcFigure([circle('a'), arcOf({ from: -3600, to: 3600 })]))).toBe(true);
    expectRejectedAt(arcFigure([circle('a'), arcOf({ from: 3601 })]), 'shapes.1.from');
    expectRejectedAt(arcFigure([circle('a'), arcOf({ to: -3601 })]), 'shapes.1.to');
  });

  it('rejects missing, mistyped and unknown keys', () => {
    const { to: _to, ...noTo } = arcOf();
    expectRejectedAt(arcFigure([circle('a'), noTo]), 'shapes.1.to');
    expectRejectedAt(arcFigure([circle('a'), arcOf({ from: null })]), 'shapes.1.from');
    expectRejectedAt(arcFigure([circle('a'), arcOf({ from: true })]), 'shapes.1.from');
    expectRejectedAt(arcFigure([circle('a'), arcOf({ sweep: 90 })]), 'shapes.1');
  });

  it('requires an earlier circle or tangent_circle in on', () => {
    expectRejectedAt(arcFigure([arcOf({ on: 'ghost' })]), 'shapes.0.on');
    expectRejectedAt(arcFigure([arcOf(), circle('a')]), 'shapes.0.on');
    expectRejectedAt(
      arcFigure([{ id: 'l', type: 'line', from: [0, 0], to: [1, 0] }, arcOf({ on: 'l' })]),
      'shapes.1.on',
    );
    expectRejectedAt(
      arcFigure([circle('a'), arcOf({ id: 'arc2' }), arcOf({ on: 'arc' })]),
      'shapes.2.on',
    );
  });

  it('checks the references inside point ends', () => {
    expectRejectedAt(arcFigure([circle('a'), arcOf({ from: 'ghost' })]), 'shapes.1.from');
    expectRejectedAt(
      arcFigure([circle('a'), arcOf({ to: { intersect: ['a', 'a'], near: [0, 3] } })]),
      'shapes.1.to.intersect.1',
    );
  });

  it('can be repeated and stroked but not used as a region, base or reference', () => {
    const repeated = [
      circle('a'),
      arcOf({ id: 'piece' }),
      { id: 'ring', type: 'repeat', of: ['piece'], n: 4 },
    ];
    expect(accepted(arcFigure(repeated, [{ stroke: ['ring'], width: 0.125 }]))).toBe(true);
    expectRejectedAt(
      markSpec({ shapes: [circle('a'), arcOf()], paint: [{ fill: 'arc' }] }),
      'paint.0.fill',
    );
    expectRejectedAt(markSpec({ shapes: repeated, paint: [{ fill: 'ring' }] }), 'paint.0.fill');
    expectRejectedAt(
      arcFigure([circle('a'), arcOf(), { id: 'p', type: 'polygon', in: 'arc', n: 3 }]),
      'shapes.2.in',
    );
    expectRejectedAt(
      arcFigure([circle('a'), arcOf(), circle('b', { r: 'arc.r/2' })]),
      'shapes.2.r',
    );
    expectRejectedAt(
      arcFigure([circle('a'), arcOf(), { id: 'p', type: 'point', at: 'arc' }]),
      'shapes.2.at',
    );
    expectRejectedAt(
      arcFigure([
        circle('a'),
        arcOf(),
        { id: 't', type: 'tangent_circle', r: 1, to: ['a', 'arc'], near: [0, 0] },
      ]),
      'shapes.2.to.1',
    );
    expectRejectedAt(
      arcFigure([
        circle('a'),
        arcOf(),
        { id: 'p', type: 'point', at: { intersect: ['a', 'arc'], near: [0, 3] } },
      ]),
      'shapes.2.at.intersect.1',
    );
  });

  it('lists the ids an arc references', () => {
    expect(shapeReferences(arcOf() as Shape)).toEqual(['a']);
    expect(
      shapeReferences(arcOf({ from: { intersect: ['a', 'b'], near: [0, 3] }, to: 'c' }) as Shape),
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('arc on an oval', () => {
  const oval = { id: 'o', type: 'oval', center: [0, 0], rx: 6, ry: 4 };
  const onOval = (extra: Obj = {}): Obj => arcOf({ on: 'o', ...extra });
  const iconArc = (shapes: Obj[], paint: Obj[] = [{ stroke: ['arc'], width: 1 }]): Obj => ({
    version: 1,
    mode: 'icon',
    grid: { divisions: 12 },
    shapes,
    paint,
  });
  const messages = (input: unknown): string[] => {
    const result = specSchema.safeParse(input);
    return result.success ? [] : result.error.issues.map((i) => i.message);
  };

  it('accepts degree ends', () => {
    expect(accepted(iconArc([oval, onOval({ from: 45, to: 315 })]))).toBe(true);
    expect(accepted(iconArc([oval, onOval({ from: -3600, to: 3600 })]))).toBe(true);
    expectRejectedAt(iconArc([oval, onOval({ from: 3601 })]), 'shapes.1.from');
  });

  it('rejects a point end and names degrees', () => {
    for (const end of [[4, 0], 'o', { on: 'o', angle: 90 }]) {
      for (const key of ['from', 'to']) {
        const input = iconArc([oval, onOval({ [key]: end })]);
        expectRejectedAt(input, `shapes.1.${key}`);
        expect(messages(input)[0]).toContain('allowed: degrees when "on" names an oval)');
      }
    }
  });

  it('rejects an on that is not a circle, tangent_circle or oval and lists the oval', () => {
    const rect = {
      id: 'r',
      type: 'rect',
      corners: [
        [-3, -3],
        [3, 3],
      ],
    };
    const input = iconArc([rect, onOval({ on: 'r' })]);
    expectRejectedAt(input, 'shapes.1.on');
    expect(messages(input)[0]).toContain('allowed: the id of a circle, tangent_circle or oval)');
  });

  it('requires the oval to be declared earlier', () => {
    expectRejectedAt(iconArc([onOval(), oval]), 'shapes.0.on');
  });

  it('can be stroked and repeated but not used as a region or erased', () => {
    const repeated = [
      oval,
      onOval({ id: 'piece' }),
      { id: 'ring', type: 'repeat', of: ['piece'], n: 4 },
    ];
    expect(accepted(iconArc([oval, onOval()]))).toBe(true);
    expect(accepted(iconArc(repeated, [{ stroke: ['ring'], width: 1 }]))).toBe(true);
    expectRejectedAt(iconArc([oval, onOval()], [{ fill: 'arc' }]), 'paint.0.fill');
    expectRejectedAt(iconArc(repeated, [{ fill: 'ring' }]), 'paint.0.fill');
    expectRejectedAt(
      figureSpec({
        shapes: [oval, onOval()],
        paint: [{ stroke: ['o'], width: 0.125 }, { erase: ['arc'] }],
      }),
      'paint.1.erase.0',
    );
  });
});

describe('erase layers', () => {
  const scene = [
    circle('a'),
    circle('b', { r: 2 }),
    { id: 'l', type: 'line', from: [0, 0], to: [1, 0] },
    { id: 'tri', type: 'polygon', in: 'b', n: 3 },
    { id: 'fan', type: 'repeat', of: ['b'], n: 3, center: [1, 0] },
    { id: 'rays', type: 'repeat', of: ['l'], n: 3 },
    { id: 'p', type: 'point', at: [1, 1] },
  ];
  const withErase = (erase: unknown, paint: Obj[] = []): Obj =>
    figureSpec({
      shapes: scene,
      paint: [{ stroke: ['a'], width: 0.125 }, ...paint, { erase }],
    });

  it('accepts circles, polygons and repeats of those after a stroke layer', () => {
    expect(accepted(withErase(['b', 'tri', 'fan']))).toBe(true);
    expect(specSchema.parse(withErase(['b'])).paint[1]).toEqual({ erase: ['b'] });
  });

  it('rejects an erase layer as the first layer', () => {
    const spec = figureSpec({
      shapes: scene,
      paint: [{ erase: ['b'] }, { stroke: ['a'], width: 0.1 }],
    });
    expectRejectedAt(spec, 'paint.0');
  });

  it('rejects an erase layer in a mark', () => {
    expectRejectedAt(
      markSpec({ shapes: scene, paint: [{ fill: 'a' }, { erase: ['b'] }] }),
      'paint.1',
    );
  });

  it('rejects duplicate, unknown, forward and wrong-kind targets', () => {
    expectRejectedAt(withErase(['b', 'b']), 'paint.1.erase.1');
    expectRejectedAt(withErase(['ghost']), 'paint.1.erase.0');
    expectRejectedAt(withErase(['l']), 'paint.1.erase.0');
    expectRejectedAt(withErase(['p']), 'paint.1.erase.0');
    expectRejectedAt(withErase(['rays']), 'paint.1.erase.0');
    expectRejectedAt(
      figureSpec({
        shapes: [circle('a'), arcOf({ id: 'arc' })],
        paint: [{ stroke: ['a'], width: 0.125 }, { erase: ['arc'] }],
      }),
      'paint.1.erase.0',
    );
  });

  it('rejects an empty list, more than 32 targets and extra keys', () => {
    expectRejectedAt(withErase([]), 'paint.1.erase');
    expectRejectedAt(withErase(Array.from({ length: 33 }, () => 'b')), 'paint.1.erase');
    expectRejectedAt(
      figureSpec({
        shapes: scene,
        paint: [
          { stroke: ['a'], width: 0.125 },
          { erase: ['b'], width: 0.125 },
        ],
      }),
      'paint.1',
    );
  });

  it('lists the targets of an erase layer in paintReferences', () => {
    expect(paintReferences({ erase: ['b', 'tri'] })).toEqual(['b', 'tri']);
  });
});

describe('outline element', () => {
  const baseShapes = (): Obj[] => [
    circle('a'),
    circle('b', { r: 2 }),
    { id: 'l', type: 'line', from: [0, 0], to: [1, 0] },
  ];
  const OUTLINE_AT = 3;
  const outlineOf = (through: unknown, extra: Obj = {}): Obj => ({
    id: 'o',
    type: 'outline',
    through,
    ...extra,
  });
  const markWith = (through: unknown, more: Obj[] = []): Obj =>
    markSpec({ shapes: [...baseShapes(), ...more, outlineOf(through)], paint: [{ fill: 'o' }] });
  const messages = (input: unknown): string[] => {
    const result = specSchema.safeParse(input);
    return result.success ? [] : result.error.issues.map((i) => i.message);
  };
  const chain = (levels: number): unknown =>
    levels === 0 ? [1, 1] : { intersect: ['a', 'b'], near: chain(levels - 1) };

  it('accepts id and { on, concave, corner } pieces', () => {
    const through = [
      'a',
      { on: 'b', concave: true },
      { on: 'l' },
      { on: 'a', concave: false, corner: [1, 1] },
    ];
    expect(accepted(markWith(through))).toBe(true);
    expect(accepted(markWith(['a', 'b']))).toBe(true);
  });

  it('accepts a tangent_circle piece and corner references', () => {
    const tangent = { id: 't', type: 'tangent_circle', r: 1, to: ['a', 'b'], near: [0, 2] };
    const pt = { id: 'pt', type: 'point', at: [1, 1] };
    expect(
      accepted(
        markWith(
          ['a', { on: 't', corner: 'pt' }, { on: 'b', corner: { on: 'a', angle: 0 } }],
          [tangent, pt],
        ),
      ),
    ).toBe(true);
  });

  it('requires 2 to 64 pieces', () => {
    expectRejectedAt(markWith(['a']), `shapes.${OUTLINE_AT}.through`);
    expectRejectedAt(markWith([]), `shapes.${OUTLINE_AT}.through`);
    expect(accepted(markWith(['a', 'b']))).toBe(true);
    expect(accepted(markWith(Array.from({ length: 64 }, () => 'a')))).toBe(true);
    expectRejectedAt(
      markWith(Array.from({ length: 65 }, () => 'a')),
      `shapes.${OUTLINE_AT}.through`,
    );
  });

  it('rejects unknown, forward and self ids', () => {
    expectRejectedAt(markWith(['a', 'zz']), `shapes.${OUTLINE_AT}.through.1`);
    expectRejectedAt(markWith(['a', { on: 'zz' }]), `shapes.${OUTLINE_AT}.through.1.on`);
    expectRejectedAt(markWith(['a', 'o']), `shapes.${OUTLINE_AT}.through.1`);
    expectRejectedAt(markWith(['a', { on: 'o' }]), `shapes.${OUTLINE_AT}.through.1.on`);
    const forward = markSpec({
      shapes: [...baseShapes(), outlineOf(['a', 'late']), circle('late')],
      paint: [{ fill: 'o' }],
    });
    expectRejectedAt(forward, `shapes.${OUTLINE_AT}.through.1`);
    expect(messages(forward).join('\n')).toContain('forward reference');
  });

  it('rejects an on that is not a circle, tangent_circle or line', () => {
    const others: Obj[] = [
      { id: 'pt', type: 'point', at: [0, 0] },
      { id: 'pg', type: 'polygon', in: 'a', n: 3 },
      {
        id: 'ps',
        type: 'points',
        through: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
      },
      { id: 'ar', type: 'arc', on: 'a', from: 30, to: 150 },
      { id: 'rp', type: 'repeat', of: ['a'], n: 3 },
      outlineOf(['a', 'b'], { id: 'prev' }),
    ];
    for (const other of others) {
      const id = String(other.id);
      expectRejectedAt(markWith(['a', { on: id }], [other]), 'shapes.4.through.1.on');
      expectRejectedAt(markWith(['a', id], [other]), 'shapes.4.through.1');
    }
  });

  it('rejects concave on a line piece but accepts it on circles', () => {
    expectRejectedAt(markWith(['a', { on: 'l', concave: true }]), 'shapes.3.through.1.concave');
    expectRejectedAt(markWith(['a', { on: 'l', concave: false }]), 'shapes.3.through.1.concave');
    expect(accepted(markWith(['a', { on: 'l' }]))).toBe(true);
  });

  it('rejects a non-boolean concave', () => {
    for (const concave of [1, 'true', null, 0]) {
      expectRejectedAt(markWith(['a', { on: 'b', concave }]), 'shapes.3.through.1');
    }
  });

  it('rejects unknown piece keys and a missing on', () => {
    expectRejectedAt(markWith(['a', { on: 'b', bulge: 1 }]), 'shapes.3.through.1');
    expectRejectedAt(markWith(['a', { concave: true }]), 'shapes.3.through.1');
    expectRejectedAt(markWith(['a', 5]), 'shapes.3.through.1');
  });

  it('checks corner like other points', () => {
    expectRejectedAt(markWith(['a', { on: 'b', corner: [1] }]), 'shapes.3.through.1');
    expectRejectedAt(markWith(['a', { on: 'b', corner: [99, 0] }]), 'shapes.3.through.1');
    expectRejectedAt(markWith(['a', { on: 'b', corner: 'zz' }]), 'shapes.3.through.1.corner');
    expectRejectedAt(markWith(['a', { on: 'b', corner: 'o' }]), 'shapes.3.through.1.corner');
    expectRejectedAt(
      markWith(['a', { on: 'b', corner: { on: 'l', angle: 0 } }]),
      'shapes.3.through.1.corner.on',
    );
  });

  it('counts corner nesting from 1 like near', () => {
    expect(accepted(markWith(['a', { on: 'b', corner: chain(2) }]))).toBe(true);
    expectRejectedAt(
      markWith(['a', { on: 'b', corner: chain(3) }]),
      'shapes.3.through.1.corner.near.near',
    );
  });

  it('is allowed as a region leaf, stroke, erase and repeat target', () => {
    const shapes = [...baseShapes(), outlineOf(['a', 'b'])];
    expect(accepted(markSpec({ shapes, paint: [{ fill: { subtract: ['a', 'o'] } }] }))).toBe(true);
    expect(
      accepted(figureSpec({ shapes, paint: [{ stroke: ['o'], width: 0.125 }, { erase: ['o'] }] })),
    ).toBe(true);
    const repeated = [...shapes, { id: 'rp', type: 'repeat', of: ['o'], n: 3 }];
    expect(accepted(markSpec({ shapes: repeated, paint: [{ fill: 'rp' }] }))).toBe(true);
    expect(
      accepted(figureSpec({ shapes: repeated, paint: [{ stroke: ['rp'], width: 0.125 }] })),
    ).toBe(true);
  });

  it('is rejected in tangent_circle.to, intersect, on, in and .r', () => {
    const o = outlineOf(['a', 'b']);
    const withOutlineFirst = (shape: Obj): Obj =>
      markSpec({ shapes: [...baseShapes(), o, shape], paint: [{ fill: 'a' }] });
    expectRejectedAt(
      withOutlineFirst({ id: 't', type: 'tangent_circle', r: 1, to: ['a', 'o'], near: [0, 2] }),
      'shapes.4.to.1',
    );
    expectRejectedAt(
      withOutlineFirst({ id: 'p', type: 'point', at: { intersect: ['a', 'o'] } }),
      'shapes.4.at.intersect.1',
    );
    expectRejectedAt(
      withOutlineFirst(circle('c', { center: { on: 'o', angle: 0 } })),
      'shapes.4.center.on',
    );
    expectRejectedAt(withOutlineFirst({ id: 'pg', type: 'polygon', in: 'o', n: 3 }), 'shapes.4.in');
    expectRejectedAt(withOutlineFirst(circle('c', { r: 'o.r/2' })), 'shapes.4.r');
  });

  it('lists the ids and corner references of a piece list', () => {
    const shape = specSchema
      .parse(
        markWith(
          ['a', { on: 'b', corner: { intersect: ['a', 'l'], near: 'pt' } }, { on: 'l' }],
          [{ id: 'pt', type: 'point', at: [1, 1] }],
        ),
      )
      .shapes.find((s) => s.id === 'o');
    expect(shape).toBeDefined();
    expect(shapeReferences(shape as Shape)).toEqual(['a', 'b', 'l', 'pt']);
  });

  it('is a bounded region leaf', () => {
    expect(isRegionBounded('o')).toBe(true);
    expect(isRegionBounded({ intersect: ['o', { half: 'l', toward: [0, 1] }] })).toBe(true);
  });

  it('adds its piece count to the mark support curves', () => {
    const pieces = (n: number) => Array.from({ length: n }, () => 'a');
    const spec = (n: number): Obj =>
      markSpec({
        shapes: [circle('a'), outlineOf(pieces(n))],
        paint: [{ fill: 'o' }],
      });
    // 1 circle + 64 pieces per outline copy; 4 repeated copies reach 4 * 64 = 256 plus the circle.
    const repeated = (n: number): Obj =>
      markSpec({
        shapes: [circle('a'), outlineOf(pieces(64)), { id: 'rp', type: 'repeat', of: ['o'], n }],
        paint: [{ fill: 'rp' }],
      });
    expect(accepted(spec(64))).toBe(true);
    expect(accepted(repeated(3))).toBe(true);
    expectRejectedAt(repeated(4), 'shapes.2');
  });
});

describe('icon mode', () => {
  const iconSpec = (extra: Obj = {}): Obj => ({
    version: 1,
    mode: 'icon',
    grid: { divisions: 12 },
    shapes: [
      {
        id: 'plate',
        type: 'rect',
        corners: [
          [-11, -11],
          [11, 11],
        ],
        r: 3,
      },
      {
        id: 'axis',
        type: 'polyline',
        through: [
          [-7, 7],
          [-7, -7],
          [7, -7],
        ],
      },
      { id: 'face', type: 'oval', center: [0, 0], rx: 6, ry: 4, rotate: 30 },
    ],
    paint: [
      { fill: 'plate', color: '#f3f2f1' },
      { stroke: ['axis', 'face'], width: 1, cap: 'butt', join: 'miter', dash: [2, 1] },
      { fill: 'face' },
    ],
    ...extra,
  });
  const messages = (input: unknown): string[] => {
    const result = specSchema.safeParse(input);
    return result.success ? [] : result.error.issues.map((i) => i.message);
  };
  const expectMessage = (input: unknown, path: string, allowed: string) => {
    expectRejectedAt(input, path);
    expect(messages(input).some((m) => m.endsWith(`allowed: ${allowed})`))).toBe(true);
  };
  const withShape = (shape: Obj): Obj =>
    iconSpec({ shapes: [shape], paint: [{ stroke: [shape.id], width: 1 }] });
  const strokeWith = (extra: Obj): Obj =>
    iconSpec({
      shapes: [{ id: 'l', type: 'line', from: [0, 0], to: [4, 0] }],
      paint: [{ stroke: ['l'], width: 1, ...extra }],
    });

  it('accepts fill and stroke layers in any order and keeps the new options', () => {
    const spec = specSchema.parse(iconSpec());
    expect(spec.paint[1]).toMatchObject({ cap: 'butt', join: 'miter', dash: [2, 1] });
    expect(spec.shapes[2]).toMatchObject({ rotate: 30 });
    expect(accepted(iconSpec({ paint: [{ stroke: ['axis'], width: 1 }, { fill: 'plate' }] }))).toBe(
      true,
    );
  });

  it('defaults margin by mode and keeps it a number', () => {
    expect(specSchema.parse(iconSpec()).grid.margin).toBe(0);
    expect(specSchema.parse(iconSpec({ grid: { divisions: 12, margin: 0 } })).grid.margin).toBe(0);
    expect(specSchema.parse(markSpec()).grid.margin).toBe(1);
    expect(specSchema.parse(figureSpec({ grid: { divisions: 8, margin: 2 } })).grid.margin).toBe(2);
  });

  it('builds the input JSON Schema with margin optional', () => {
    const json = specJsonSchema() as {
      properties: { grid: { required?: string[]; properties: Record<string, unknown> } };
    };
    expect(Object.keys(json.properties.grid.properties)).toContain('margin');
    expect(json.properties.grid.required ?? []).not.toContain('margin');
    expect(json.properties.grid.required).toContain('divisions');
  });

  it('lists the modes and divisions it allows', () => {
    expectMessage(markSpec({ mode: 'sketch' }), 'mode', '"mark", "figure" or "icon"');
    expectMessage(
      markSpec({ grid: { divisions: 5 } }),
      'grid.divisions',
      '4, 6 or 8, or 12 for an icon',
    );
  });

  it('ties divisions 12 to the icon mode', () => {
    expectMessage(iconSpec({ grid: { divisions: 8 } }), 'grid.divisions', '12 when mode is "icon"');
    expectMessage(
      markSpec({ grid: { divisions: 12 } }),
      'grid.divisions',
      '4, 6 or 8 unless mode is "icon"',
    );
    expectMessage(
      figureSpec({ grid: { divisions: 12 } }),
      'grid.divisions',
      '4, 6 or 8 unless mode is "icon"',
    );
  });

  it('allows only margin 0 or none in an icon', () => {
    expectMessage(
      iconSpec({ grid: { divisions: 12, margin: 1 } }),
      'grid.margin',
      '0 or omitted when mode is "icon"',
    );
  });

  it('rejects an erase layer in an icon and keeps the mark and figure messages', () => {
    expectMessage(
      iconSpec({ paint: [{ stroke: ['axis'], width: 1 }, { erase: ['plate'] }] }),
      'paint.1',
      '"fill" or "stroke" layers when mode is "icon"',
    );
    expect(messages(markSpec({ paint: [{ stroke: ['a'], width: 1 }] }))).toEqual([
      'stroke layer in a mark spec (received: stroke; allowed: fill layers when mode is "mark")',
    ]);
    expect(messages(figureSpec({ paint: [{ fill: 'a' }] }))).toEqual([
      'fill layer in a figure spec (received: fill; allowed: stroke layers when mode is "figure")',
    ]);
  });

  it('requires 3 to 32 polyline points', () => {
    const through = (n: number) => Array.from({ length: n }, (_, i) => [i, 0]);
    for (const n of [0, 2, 33]) {
      expectMessage(
        withShape({ id: 'p', type: 'polyline', through: through(n) }),
        'shapes.0.through',
        'an array of 3 to 32 points',
      );
    }
    expect(accepted(withShape({ id: 'p', type: 'polyline', through: through(3) }))).toBe(true);
    expect(accepted(withShape({ id: 'p', type: 'polyline', through: through(32) }))).toBe(true);
  });

  it('rejects a polyline or a repeat of one as a fill region or erase target', () => {
    const shapes = [
      {
        id: 'p',
        type: 'polyline',
        through: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      },
      { id: 'r', type: 'repeat', of: ['p'], n: 3 },
    ];
    expect(messages(iconSpec({ shapes, paint: [{ fill: 'p' }] }))[0]).toContain(
      'wrong kind of element (received: "p", a polyline; allowed: the id of a circle, tangent_circle, polygon, points, outline, rect, oval or repeat)',
    );
    expect(messages(iconSpec({ shapes, paint: [{ fill: 'r' }] }))[0]).toContain(
      'region uses a repeat of a polyline',
    );
    expect(
      messages(figureSpec({ shapes, paint: [{ stroke: ['p'], width: 1 }, { erase: ['p'] }] }))[0],
    ).toContain('a polyline');
    expect(
      messages(figureSpec({ shapes, paint: [{ stroke: ['p'], width: 1 }, { erase: ['r'] }] }))[0],
    ).toContain('erase uses a repeat of a polyline');
    expect(accepted(iconSpec({ shapes, paint: [{ stroke: ['r'], width: 1 }] }))).toBe(true);
  });

  it('places rect and oval as region leaves, strokes, erase targets and repeat members', () => {
    const shapes = [
      {
        id: 'q',
        type: 'rect',
        corners: [
          [-3, -2],
          [3, 2],
        ],
      },
      { id: 'o', type: 'oval', center: [0, 0], rx: 5, ry: 3 },
      { id: 'rq', type: 'repeat', of: ['q', 'o'], n: 4 },
    ];
    expect(accepted(iconSpec({ shapes, paint: [{ fill: { union: ['q', 'o', 'rq'] } }] }))).toBe(
      true,
    );
    expect(accepted(iconSpec({ shapes, paint: [{ stroke: ['q', 'o', 'rq'], width: 1 }] }))).toBe(
      true,
    );
    expect(
      accepted(
        figureSpec({ shapes, paint: [{ stroke: ['q'], width: 1 }, { erase: ['o', 'rq'] }] }),
      ),
    ).toBe(true);
  });

  it('requires two rect corners and a valid radius', () => {
    const rect = (extra: Obj) =>
      withShape({
        id: 'q',
        type: 'rect',
        corners: [
          [0, 0],
          [2, 2],
        ],
        ...extra,
      });
    for (const corners of [
      [[0, 0]],
      [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
    ]) {
      expectMessage(rect({ corners }), 'shapes.0.corners', 'an array of 2 points');
    }
    for (const r of [0, -1, Number.NaN]) {
      expectRejectedAt(rect({ r }), 'shapes.0.r');
    }
    expect(accepted(rect({ r: 1 }))).toBe(true);
    expect(accepted(rect({ r: 'R/2' }))).toBe(true);
  });

  it('bounds oval.rotate with the angle range', () => {
    const oval = (rotate: number) =>
      withShape({ id: 'o', type: 'oval', center: [0, 0], rx: 5, ry: 3, rotate });
    expect(accepted(oval(3600))).toBe(true);
    for (const rotate of [3601, -3601, Number.NaN]) {
      expectMessage(oval(rotate), 'shapes.0.rotate', 'a finite number from -3600 to 3600');
    }
  });

  it('checks references inside the new shapes', () => {
    expectRejectedAt(
      withShape({ id: 'q', type: 'rect', corners: ['nope', [1, 1]] }),
      'shapes.0.corners.0',
    );
    expectRejectedAt(
      withShape({ id: 'o', type: 'oval', center: [0, 0], rx: 'ghost.r', ry: 3 }),
      'shapes.0.rx',
    );
    const shapes = shapeReferences(
      specSchema.parse(
        iconSpec({
          shapes: [
            { id: 'a', type: 'circle', r: 4 },
            { id: 'p', type: 'point', at: [1, 1] },
            { id: 'q', type: 'rect', corners: ['p', [3, 3]], r: 'a.r' },
            { id: 'o', type: 'oval', center: 'p', rx: 'a.r', ry: 1 },
          ],
          paint: [{ stroke: ['q', 'o'], width: 1 }],
        }),
      ).shapes[2] as Shape,
    );
    expect(shapes).toEqual(['p', 'a']);
  });

  it('accepts cap, join and dash on stroke layers of every mode', () => {
    expect(accepted(strokeWith({ cap: 'square', join: 'bevel', dash: [0.5, 0.25] }))).toBe(true);
    expect(
      accepted(figureSpec({ paint: [{ stroke: ['a'], width: 0.125, cap: 'butt', dash: [1, 1] }] })),
    ).toBe(true);
  });

  it('rejects bad cap, join and dash values', () => {
    for (const cap of ['flat', null, true, 1]) {
      expectMessage(strokeWith({ cap }), 'paint.0.cap', '"round", "butt" or "square"');
    }
    for (const join of ['sharp', null, false, 1]) {
      expectMessage(strokeWith({ join }), 'paint.0.join', '"round", "miter" or "bevel"');
    }
    const lengths = 'an array of 2 lengths: dash, gap';
    for (const dash of [[1], [1, 1, 1], [0, 1], [1, 0], [-1, 1], [1, Number.NaN], null, 2]) {
      expectMessage(strokeWith({ dash }), 'paint.0.dash', lengths);
    }
  });

  it('rejects cap, join and dash on a fill layer', () => {
    for (const key of ['cap', 'join', 'dash']) {
      expect(accepted(markSpec({ paint: [{ fill: 'a', [key]: 'round' }] }))).toBe(false);
      expect(accepted(iconSpec({ paint: [{ fill: 'plate', [key]: 'round' }] }))).toBe(false);
    }
  });

  it('keeps the paint cap at 16 layers', () => {
    const layers = (n: number) => Array.from({ length: n }, () => ({ fill: 'plate' }));
    expect(accepted(iconSpec({ paint: layers(16) }))).toBe(true);
    expectRejectedAt(iconSpec({ paint: layers(17) }), 'paint');
  });

  it('counts rect as 8, oval as 4 and polyline as its segments toward 256 support curves', () => {
    const rects = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `q${i}`,
        type: 'rect',
        corners: [
          [0, 0],
          [1, 1],
        ],
      }));
    // 32 rects = 256 curves
    expect(accepted(iconSpec({ shapes: rects(32), paint: [{ fill: 'q0' }] }))).toBe(true);
    expect(messages(iconSpec({ shapes: rects(33), paint: [{ fill: 'q0' }] }))).toEqual([
      'too many support curves after repeat expansion (received: at least 264; allowed: at most 256)',
    ]);
    const ovals = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `o${i}`,
        type: 'oval',
        center: [0, 0],
        rx: 3,
        ry: 2,
      }));
    expect(accepted(iconSpec({ shapes: ovals(64), paint: [{ fill: 'o0' }] }))).toBe(true);
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `p${i}`,
        type: 'polyline',
        through: Array.from({ length: 32 }, (_, k) => [k, 0]),
      }));
    // 31 segments each: 8 polylines = 248, 9 = 279
    const poly = (n: number) =>
      iconSpec({ shapes: lines(n), paint: [{ stroke: ['p0'], width: 1 }] });
    expect(accepted(poly(8))).toBe(true);
    expectRejectedAt(poly(9), 'shapes.8');
  });

  it('checks the drawn-element cap of 2048 in an icon too', () => {
    const shapes = [
      ...Array.from({ length: 8 }, (_, i) => circle(`c${i}`, { r: 1 })),
      {
        id: 'r',
        type: 'repeat',
        of: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'],
        n: 12,
        mirror: true,
      },
    ];
    const layers = (n: number) => Array.from({ length: n }, () => ({ stroke: ['r'], width: 1 }));
    // 192 curves; 10 layers draw 1920 elements, 11 draw 2112
    expect(accepted(iconSpec({ shapes, paint: layers(10) }))).toBe(true);
    expect(messages(iconSpec({ shapes, paint: layers(11) }))).toEqual([
      'too many drawn elements after repeat expansion (received: at least 2112; allowed: at most 2048)',
    ]);
    expectRejectedAt(iconSpec({ shapes, paint: layers(11) }), 'paint.10.stroke.0');
  });
});

describe('grid.step', () => {
  const stepSpec = (mode: string, step: unknown): Obj => ({
    version: 1,
    mode,
    grid: { divisions: mode === 'icon' ? 12 : 4, step },
    shapes: [{ id: 'a', type: 'circle', r: 1 }],
    paint: [{ fill: 'a', color: '#107c41' }],
  });

  it.each([0.5, 0.25, 0.1])('accepts step %d for an icon', (step) => {
    expect(accepted(stepSpec('icon', step))).toBe(true);
  });

  it('keeps an omitted step omitted', () => {
    const parsed = specSchema.parse(stepSpec('icon', undefined));
    expect(parsed.grid.step).toBeUndefined();
    expect(iconGridStep(parsed.grid)).toBe(0.5);
    expect(iconGridStep({ step: 0.1 })).toBe(0.1);
  });

  it.each([0.2, 0, -0.5, '0.1', null])('rejects step %j for an icon', (step) => {
    expectRejectedAt(stepSpec('icon', step), 'grid.step');
  });

  it.each(['mark', 'figure'])('rejects a step in a %s', (mode) => {
    expectRejectedAt(stepSpec(mode, 0.5), 'grid.step');
  });
});
