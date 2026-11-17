import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  isCircleLike,
  isRegionBounded,
  paintReferences,
  type Region,
  RULE_IDS,
  type Shape,
  shapeReferences,
  specSchema,
} from '../../src/spec/schema.js';

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

  it('lists the nine rule ids', () => {
    expect(RULE_IDS).toHaveLength(9);
    expect(new Set(RULE_IDS).size).toBe(9);
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

  it('limits shapes to 64', () => {
    expect(accepted(withShapes(manyCircles(64), { paint: [{ fill: 'c0' }] }))).toBe(true);
    expectRejectedAt(withShapes(manyCircles(65), { paint: [{ fill: 'c0' }] }), 'shapes');
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
