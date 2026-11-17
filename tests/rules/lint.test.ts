import { describe, expect, it } from 'vitest';
import type { FillResult } from '../../src/geom/arrangement.js';
import { arrange } from '../../src/geom/arrangement.js';
import { resolveSpec } from '../../src/resolve/resolve.js';
import { HINTS, lint, RULES } from '../../src/rules/lint.js';
import type { RuleId, SpecInput } from '../../src/spec/schema.js';
import { RULE_IDS, specSchema } from '../../src/spec/schema.js';

type Json = Record<string, unknown>;

const figure = (shapes: Json[], paint: Json[], extra: Json = {}, divisions = 4): SpecInput =>
  ({ version: 1, mode: 'figure', grid: { divisions }, shapes, paint, ...extra }) as SpecInput;

const mark = (shapes: Json[], fill: unknown, extra: Json = {}, divisions = 4): SpecInput =>
  ({
    version: 1,
    mode: 'mark',
    grid: { divisions },
    shapes,
    paint: [{ fill }],
    ...extra,
  }) as SpecInput;

const circle = (id: string, r: number | string, center?: unknown): Json =>
  center === undefined ? { id, type: 'circle', r } : { id, type: 'circle', r, center };

const stroke = (ids: string[], width: number | string = 0.125): Json => ({ stroke: ids, width });

const run = (input: SpecInput) => {
  const spec = specSchema.parse(input);
  const resolved = resolveSpec(spec);
  if (!resolved.ok) {
    throw new Error(`resolve failed: ${JSON.stringify(resolved.errors)}`);
  }
  const fills: FillResult[] = resolved.model.fills.map((fill) => arrange(fill.region));
  return lint(spec, resolved.model, fills);
};

const rulesOf = (input: SpecInput): RuleId[] => run(input).violations.map((v) => v.rule);
const has = (input: SpecInput, rule: RuleId, target?: string): boolean =>
  run(input).violations.some(
    (v) => v.rule === rule && (target === undefined || v.target === target),
  );

const withException = (input: SpecInput, rule: RuleId, target: string): SpecInput =>
  ({ ...input, exceptions: [{ rule, target, reason: 'intentional' }] }) as SpecInput;

const concentric = (count: number, first: number, step: number): Json[] =>
  Array.from({ length: count }, (_, k) => circle(`c${k}`, first + step * k));

const ids = (shapes: Json[]): string[] => shapes.map((s) => String(s.id));

type Pair = { input: SpecInput; target: string };

// One violating spec per rule, and the exception target that silences it.
const PAIRS: Record<Exclude<RuleId, 'unused_exception'>, Pair> = {
  ratio_count: {
    input: figure(
      [circle('a', 'R/2'), circle('b', 'R/3'), circle('c', 'R/5'), circle('d', 'R/7')],
      [stroke(['a', 'b', 'c', 'd'])],
    ),
    target: 'spec',
  },
  circle_count: {
    input: mark(concentric(9, 1, 0.5), { union: ids(concentric(9, 1, 0.5)) }, {}, 8),
    target: 'spec',
  },
  off_grid: {
    input: figure([circle('a', 2.3)], [stroke(['a'])]),
    target: 'a',
  },
  angle: {
    input: figure(
      [circle('a', 3), { id: 'p', type: 'polygon', in: 'a', n: 7 }],
      [stroke(['a', 'p'])],
    ),
    target: 'p',
  },
  off_canvas: {
    input: figure([circle('a', 5)], [stroke(['a'])]),
    target: 'a',
  },
  empty_fill: {
    input: mark([circle('a', 2), circle('b', 2)], { subtract: ['a', 'b'] }),
    target: 'paint[0]',
  },
  thin_stroke: {
    input: figure([circle('a', 2)], [stroke(['a'], 0.01)]),
    target: 'paint[0]',
  },
  unused_shape: {
    input: figure([circle('a', 2), circle('b', 3)], [stroke(['a'])]),
    target: 'b',
  },
};

const pairedRules = RULE_IDS.filter((id) => id !== 'unused_exception');

describe('RULES', () => {
  it('defines every rule id and nothing else', () => {
    expect(Object.keys(RULES).sort()).toEqual([...RULE_IDS].sort());
    for (const id of RULE_IDS) {
      expect(RULES[id].description.length).toBeGreaterThan(20);
      expect(RULES[id].modes.length).toBeGreaterThan(0);
    }
  });
});

describe('exceptions', () => {
  it.each(pairedRules)('%s is reported, and silenced by a matching exception', (rule) => {
    const pair = PAIRS[rule];
    expect(pair, `no violating spec for ${rule}`).toBeDefined();

    const plain = run(pair.input);
    expect(plain.violations.some((v) => v.rule === rule && v.target === pair.target)).toBe(true);
    expect(plain.exceptionsApplied).toEqual([]);

    const excepted = run(withException(pair.input, rule, pair.target));
    expect(excepted.violations.some((v) => v.rule === rule)).toBe(false);
    expect(excepted.violations.some((v) => v.rule === 'unused_exception')).toBe(false);
    expect(excepted.exceptionsApplied).toEqual([
      { rule, target: pair.target, reason: 'intentional' },
    ]);
  });

  it('has a pair for every rule except unused_exception', () => {
    expect(Object.keys(PAIRS).sort()).toEqual([...pairedRules].sort());
  });

  it('reports an exception that matches nothing, as unused_exception', () => {
    const input = withException(figure([circle('a', 2)], [stroke(['a'])]), 'off_grid', 'a');
    const result = run(input);
    expect(result.violations).toEqual([
      expect.objectContaining({ rule: 'unused_exception', target: 'exceptions[0]' }),
    ]);
    expect(result.exceptionsApplied).toEqual([]);
  });

  it('does not match an exception on another target or another rule', () => {
    const base = PAIRS.off_grid.input;
    expect(rulesOf(withException(base, 'off_grid', 'spec'))).toEqual([
      'off_grid',
      'unused_exception',
    ]);
    expect(rulesOf(withException(base, 'angle', 'a'))).toEqual(['off_grid', 'unused_exception']);
  });

  it('cannot be silenced: the schema rejects unused_exception as an exception rule', () => {
    const input = withException(PAIRS.off_grid.input, 'unused_exception', 'a');
    expect(specSchema.safeParse(input).success).toBe(false);
  });

  it('lists applied exceptions in spec order with their reasons', () => {
    const input = {
      ...figure([circle('a', 2.3), circle('b', 2.6)], [stroke(['a', 'b'])]),
      exceptions: [
        { rule: 'off_grid', target: 'b', reason: 'second' },
        { rule: 'off_grid', target: 'a', reason: 'first' },
      ],
    } as SpecInput;
    const result = run(input);
    expect(result.violations).toEqual([]);
    expect(result.exceptionsApplied.map((e) => e.reason)).toEqual(['second', 'first']);
  });
});

describe('violation order', () => {
  it('follows the rule table, then spec order of targets', () => {
    const input = figure(
      [
        circle('a', 2.3),
        circle('b', 2.6),
        circle('c', 'R/3'),
        circle('d', 'R/5'),
        circle('e', 'R/7'),
        circle('f', 'R/2'),
      ],
      [stroke(['a', 'b'], 0.01)],
    );
    const result = run(input);
    expect(result.violations.map((v) => `${v.rule}:${v.target}`)).toEqual([
      'ratio_count:spec',
      'off_grid:a',
      'off_grid:b',
      'thin_stroke:paint[0]',
      'unused_shape:c',
      'unused_shape:d',
      'unused_shape:e',
      'unused_shape:f',
    ]);
  });
});

describe('off_grid', () => {
  const radius = (r: number, mode: 'figure' | 'mark' = 'figure') =>
    mode === 'figure' ? figure([circle('a', r)], [stroke(['a'])]) : mark([circle('a', r)], 'a');

  it('accepts exact multiples and rejects 1e-6 off', () => {
    expect(has(radius(2.5), 'off_grid')).toBe(false);
    expect(has(radius(2.25), 'off_grid')).toBe(false);
    expect(has(radius(2.5 + 1e-6), 'off_grid', 'a')).toBe(true);
    expect(has(radius(2.5 - 1e-6), 'off_grid', 'a')).toBe(true);
  });

  it('uses a step of 0.5 in a mark and 0.25 in a figure', () => {
    expect(has(radius(2.25), 'off_grid')).toBe(false);
    expect(has(radius(2.25, 'mark'), 'off_grid', 'a')).toBe(true);
    expect(has(radius(2.5, 'mark'), 'off_grid')).toBe(false);
  });

  it('reports the measured and the allowed value', () => {
    const [v] = run(radius(2.3)).violations;
    expect(v?.message).toBe('r 2.3 is not a multiple of 0.25');
  });

  it('checks literal point coordinates', () => {
    const input = figure([circle('a', 2, [0.3, 1])], [stroke(['a'])]);
    const [v] = run(input).violations;
    expect(v).toMatchObject({ rule: 'off_grid', target: 'a' });
    expect(v?.message).toBe('center x 0.3 is not a multiple of 0.25');
  });

  it('checks coordinates of line ends, points and repeat centers', () => {
    const input = figure(
      [
        { id: 'ln', type: 'line', from: [-4, 0], to: [4, 0.1] },
        {
          id: 'pts',
          type: 'points',
          through: [
            [0, 0],
            [2, 0],
            [0.7, 2],
          ],
        },
        circle('dot', 0.5),
        { id: 'rep', type: 'repeat', of: ['dot'], n: 4, center: [0.1, 0] },
      ],
      [stroke(['ln', 'pts', 'rep'])],
    );
    const targets = run(input)
      .violations.filter((v) => v.rule === 'off_grid')
      .map((v) => v.target);
    expect(targets).toEqual(['ln', 'pts', 'rep']);
  });

  it('exempts length expressions, references, widths, near and toward', () => {
    const input = figure(
      [
        circle('a', 'R/3'),
        { id: 'p', type: 'point', at: { on: 'a', angle: 90 } },
        circle('b', 'a.r/2', 'p'),
        { id: 'l', type: 'line', from: [-4, 0], to: [4, 0] },
        { id: 't', type: 'tangent_circle', r: 1, to: ['a', 'l'], near: [0.3, 0.1] },
        { id: 'x', type: 'point', at: { intersect: ['a', 'l'], near: [0.37, 0.11] } },
      ],
      [stroke(['a', 'b', 't', 'l'], 0.0123)],
    );
    expect(has(input, 'off_grid')).toBe(false);
  });
});

describe('angle', () => {
  const rotated = (rotate: number) =>
    figure(
      [circle('a', 3), { id: 'p', type: 'polygon', in: 'a', n: 5, rotate }],
      [stroke(['a', 'p'])],
    );
  const onAngle = (angle: number) =>
    figure([circle('a', 3), circle('b', 1, { on: 'a', angle })], [stroke(['a', 'b'])]);

  it('accepts 22.5, -45 and 450 and rejects 10', () => {
    for (const a of [22.5, -45, 450, 0, 72, 36, 90, -3600]) {
      expect(has(rotated(a), 'angle'), `rotate ${a}`).toBe(false);
      expect(has(onAngle(a), 'angle'), `on ${a}`).toBe(false);
    }
    expect(has(rotated(10), 'angle', 'p')).toBe(true);
    expect(has(onAngle(10), 'angle', 'b')).toBe(true);
    expect(has(onAngle(22.5 + 1e-6), 'angle', 'b')).toBe(true);
  });

  it('reports the measured value and the allowed divisors', () => {
    const [v] = run(rotated(10)).violations;
    expect(v?.message).toBe(
      'rotate 10 is not a multiple of 180/n for any n in {2, 3, 4, 5, 6, 8, 10, 12, 20, 24}',
    );
  });

  it('checks polygon.n against the divisor set', () => {
    const polygon = (n: number) =>
      figure([circle('a', 3), { id: 'p', type: 'polygon', in: 'a', n }], [stroke(['a', 'p'])]);
    expect(has(polygon(7), 'angle', 'p')).toBe(true);
    expect(run(polygon(7)).violations[0]?.message).toBe(
      'n 7 is not in {2, 3, 4, 5, 6, 8, 10, 12, 20, 24}',
    );
    for (const n of [3, 4, 5, 6, 8, 10, 12, 20, 24]) {
      expect(has(polygon(n), 'angle'), `n ${n}`).toBe(false);
    }
    expect(has(polygon(9), 'angle', 'p')).toBe(true);
  });

  it('checks repeat.n when at least 2, and repeat.axis', () => {
    const repeat = (extra: Json) =>
      figure(
        [
          circle('a', 3),
          circle('dot', 0.5, { on: 'a', angle: 0 }),
          { id: 'r', type: 'repeat', of: ['dot'], ...extra },
        ],
        [stroke(['a', 'r'])],
      );
    expect(has(repeat({ n: 7 }), 'angle', 'r')).toBe(true);
    expect(has(repeat({ n: 12 }), 'angle')).toBe(false);
    expect(has(repeat({ n: 1, mirror: true }), 'angle')).toBe(false);
    expect(has(repeat({ n: 4, mirror: true, axis: 10 }), 'angle', 'r')).toBe(true);
    expect(has(repeat({ n: 4, mirror: true, axis: 22.5 }), 'angle')).toBe(false);
  });
});

describe('ratio_count', () => {
  const lengths = (rs: string[], width: number | string = 0.125) =>
    figure(
      rs.map((r, k) => circle(`c${k}`, r)),
      [
        stroke(
          rs.map((_, k) => `c${k}`),
          width,
        ),
      ],
    );

  it('allows exactly 3 distinct ratios and rejects 4', () => {
    expect(has(lengths(['R/2', 'R/3', 'R/5']), 'ratio_count')).toBe(false);
    expect(has(lengths(['R/2', 'R/3', 'R/5', 'R/7']), 'ratio_count', 'spec')).toBe(true);
  });

  it('counts equivalent forms once', () => {
    expect(
      has(lengths(['R/2', 'R*2', 'R/phi2', 'R/phi/phi', 'R/sqrt2', 'R*sqrt2/2']), 'ratio_count'),
    ).toBe(false);
  });

  it('counts a chain of one repeated step as one ratio', () => {
    const input = figure(
      [
        circle('a', 'R/2'),
        circle('b', 'a.r/2'),
        circle('c', 'b.r/2'),
        circle('d', 'R/3'),
        circle('e', 'R/5'),
      ],
      [stroke(['a', 'b', 'c', 'd', 'e'])],
    );
    expect(has(input, 'ratio_count')).toBe(false);
  });

  it('counts widths and ignores numbers', () => {
    expect(has(lengths(['R/2', 'R/3', 'R/5'], 'R/16'), 'ratio_count', 'spec')).toBe(true);
    const plain = figure([circle('a', 2), circle('b', 1.5)], [stroke(['a', 'b'], 0.25)]);
    expect(has(plain, 'ratio_count')).toBe(false);
  });

  it('reports the count, the limit and the ratios', () => {
    const [v] = run(lengths(['R/2', 'R/3', 'R/5', 'R/7'])).violations;
    expect(v?.message).toBe('4 distinct ratios, at most 3 allowed: R/2, R/3, R/5, R/7');
  });
});

describe('circle_count', () => {
  it('allows 8 circles in a mark and rejects 9', () => {
    const eight = concentric(8, 1, 0.5);
    const nine = concentric(9, 1, 0.5);
    expect(has(mark(eight, { union: ids(eight) }, {}, 8), 'circle_count')).toBe(false);
    expect(has(mark(nine, { union: ids(nine) }, {}, 8), 'circle_count', 'spec')).toBe(true);
  });

  it('allows 16 circles in a figure and rejects 17', () => {
    const sixteen = concentric(16, 0.5, 0.5);
    const seventeen = concentric(17, 0.5, 0.5);
    expect(has(figure(sixteen, [stroke(ids(sixteen))], {}, 8), 'circle_count')).toBe(false);
    expect(has(figure(seventeen, [stroke(ids(seventeen))], {}, 8), 'circle_count', 'spec')).toBe(
      true,
    );
  });

  it('counts tangent circles and does not multiply by repeat', () => {
    const base = concentric(14, 0.5, 0.5);
    const shapes = [
      ...base,
      { id: 'dot', type: 'circle', r: 0.25, center: { on: 'c13', angle: 0 } },
      { id: 'tc', type: 'tangent_circle', r: 0.5, to: ['c13', 'dot'], near: [7.4, 0.5] },
      { id: 'ring', type: 'repeat', of: ['dot'], n: 24 },
    ];
    expect(shapes.filter((s) => s.type !== 'repeat')).toHaveLength(16);
    expect(has(figure(shapes, [stroke([...ids(base), 'ring', 'tc'])], {}, 8), 'circle_count')).toBe(
      false,
    );
  });

  it('reports the count and the limit', () => {
    const nine = concentric(9, 1, 0.5);
    const [v] = run(mark(nine, { union: ids(nine) }, {}, 8)).violations;
    expect(v?.message).toBe('9 circles declared, at most 8 allowed in mark');
  });
});

describe('off_canvas', () => {
  it('lets a figure stroke reach the canvas edge exactly', () => {
    // 4.9375 + 0.0625 = 5, the canvas half side.
    expect(has(figure([circle('a', 4.9375)], [stroke(['a'])]), 'off_canvas')).toBe(false);
  });

  it('rejects a figure stroke beyond the edge, counting half the width', () => {
    expect(has(figure([circle('a', 4.9376)], [stroke(['a'])]), 'off_canvas', 'a')).toBe(true);
    expect(has(figure([circle('a', 5)], [stroke(['a'], 0.125)]), 'off_canvas', 'a')).toBe(true);
    expect(has(figure([circle('a', 5)], [stroke(['a'], 0.005)]), 'off_canvas', 'a')).toBe(true);
  });

  it('measures lines, polygons and repeat copies, reporting the repeat', () => {
    const line = figure([{ id: 'l', type: 'line', from: [-5, 0], to: [5, 0] }], [stroke(['l'])]);
    expect(has(line, 'off_canvas', 'l')).toBe(true);
    const star = figure(
      [circle('a', 4.9), { id: 'p', type: 'polygon', in: 'a', n: 6 }],
      [stroke(['p'], 0.01)],
    );
    expect(has(star, 'off_canvas')).toBe(false);
    const ring = figure(
      [
        circle('a', 4),
        circle('dot', 1, { on: 'a', angle: 0 }),
        { id: 'ring', type: 'repeat', of: ['dot'], n: 4 },
      ],
      [stroke(['a', 'ring'], 0.125)],
    );
    expect(has(ring, 'off_canvas', 'ring')).toBe(true);
    expect(has(ring, 'off_canvas', 'dot')).toBe(false);
  });

  it('rejects a mark whose fill bounding box leaves the canvas', () => {
    const inside = mark([circle('a', 5)], 'a');
    expect(has(inside, 'off_canvas')).toBe(false);
    const outside = mark([circle('a', 5, [1, 0])], 'a');
    expect(has(outside, 'off_canvas', 'paint[0]')).toBe(true);
    expect(run(outside).violations[0]?.message).toBe(
      'fill reaches 6 from the centre, canvas half side is 5',
    );
  });
});

describe('empty_fill', () => {
  it('reports a subtraction of identical circles', () => {
    expect(has(PAIRS.empty_fill.input, 'empty_fill', 'paint[0]')).toBe(true);
  });

  it('does not report a fill with an outline', () => {
    expect(
      has(mark([circle('a', 2), circle('b', 1)], { subtract: ['a', 'b'] }), 'empty_fill'),
    ).toBe(false);
  });

  it('does not report off_canvas for an empty fill', () => {
    expect(has(PAIRS.empty_fill.input, 'off_canvas')).toBe(false);
  });
});

describe('thin_stroke', () => {
  // Canvas half side 5: 512 / 10 = 51.2 px per module, so 1 px is 5/256 module.
  it('accepts a stroke of exactly 1 px and rejects one just below', () => {
    expect(has(figure([circle('a', 2)], [stroke(['a'], 5 / 256)]), 'thin_stroke')).toBe(false);
    expect(
      has(figure([circle('a', 2)], [stroke(['a'], 5 / 256 - 1e-6)]), 'thin_stroke', 'paint[0]'),
    ).toBe(true);
  });

  it('depends on the margin through the canvas size', () => {
    const wide = {
      ...figure([circle('a', 2)], [stroke(['a'], 5 / 256)]),
      grid: { divisions: 4, margin: 4 },
    } as SpecInput;
    expect(has(wide, 'thin_stroke', 'paint[0]')).toBe(true);
  });

  it('measures a width given as a length expression', () => {
    expect(has(figure([circle('a', 2)], [stroke(['a'], 'R/16')]), 'thin_stroke')).toBe(false);
    expect(has(figure([circle('a', 2)], [stroke(['a'], 0.005)]), 'thin_stroke', 'paint[0]')).toBe(
      true,
    );
  });

  it('names the layer', () => {
    const input = figure([circle('a', 2), circle('b', 1)], [stroke(['a']), stroke(['b'], 0.01)]);
    expect(run(input).violations.map((v) => v.target)).toEqual(['paint[1]']);
  });
});

describe('unused_shape', () => {
  it('reports every element of an unreferenced chain', () => {
    const input = figure(
      [circle('p', 2), circle('a', 1), circle('b', 'a.r/2'), circle('c', 'b.r/2', 'b')],
      [stroke(['p'])],
    );
    const targets = run(input)
      .violations.filter((v) => v.rule === 'unused_shape')
      .map((v) => v.target);
    expect(targets).toEqual(['a', 'b', 'c']);
  });

  it('does not report a helper referenced by a painted element', () => {
    const input = figure(
      [circle('helper', 3), circle('dot', 0.5, { on: 'helper', angle: 0 })],
      [stroke(['dot'])],
    );
    expect(has(input, 'unused_shape')).toBe(false);
  });

  it('follows references in lengths, polygons, repeats and regions', () => {
    const viaRepeat = figure(
      [
        circle('base', 3),
        circle('dot', 0.5, { on: 'base', angle: 90 }),
        { id: 'ring', type: 'repeat', of: ['dot'], n: 6 },
      ],
      [stroke(['ring'])],
    );
    expect(has(viaRepeat, 'unused_shape')).toBe(false);
    const viaRegion = mark(
      [circle('a', 3), { id: 'l', type: 'line', from: [0, -4], to: [0, 4] }, circle('b', 'a.r/2')],
      { intersect: ['b', { half: 'l', toward: [1, 0] }] },
    );
    expect(has(viaRegion, 'unused_shape')).toBe(false);
  });
});

describe('hints', () => {
  const circles = (...rows: [string, number, [number, number]][]): Json[] =>
    rows.map(([id, r, center]) => circle(id, r, center));

  it('reports a near-tangent pair with its gap', () => {
    const input = figure(circles(['a', 2, [0, 0]], ['b', 2, [4.03, 0]]), [stroke(['a', 'b'])]);
    const { hints } = run(input);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ kind: 'near_tangent', a: 'a', b: 'b' });
    expect(hints[0]?.gap).toBeCloseTo(0.03, 12);
  });

  it('uses the inner tangency when it is closer', () => {
    const input = figure(circles(['a', 3, [0, 0]], ['b', 1, [1.98, 0]]), [stroke(['a', 'b'])]);
    expect(run(input).hints[0]?.gap).toBeCloseTo(0.02, 12);
  });

  it('reports a circle near a line, with the line as an infinite line', () => {
    const input = figure(
      [{ id: 'l', type: 'line', from: [-1, 0], to: [1, 0] }, circle('a', 1.96, [3, 2])],
      [stroke(['l', 'a'])],
    );
    const { hints } = run(input);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ a: 'l', b: 'a' });
    expect(hints[0]?.gap).toBeCloseTo(0.04, 12);
  });

  it('does not report exact tangency or pairs beyond the threshold', () => {
    const exact = figure(circles(['a', 2, [0, 0]], ['b', 2, [4, 0]]), [stroke(['a', 'b'])]);
    expect(run(exact).hints).toEqual([]);
    const far = figure(circles(['a', 2, [0, 0]], ['b', 2, [4.06, 0]]), [stroke(['a', 'b'])]);
    expect(run(far).hints).toEqual([]);
    const edge = figure(circles(['a', 2, [0, 0]], ['b', 2, [4.0499, 0]]), [stroke(['a', 'b'])]);
    expect(run(edge).hints).toHaveLength(1);
  });

  it('does not report a constructed tangent circle', () => {
    const input = figure(
      [
        ...circles(['a', 2, [0, 0]], ['b', 2, [4, 0]]),
        { id: 't', type: 'tangent_circle', r: 1, to: ['a', 'b'], near: [2, 2] },
      ],
      [stroke(['a', 'b', 't'])],
    );
    expect(run(input).hints).toEqual([]);
  });

  it('sorts by gap, smallest first', () => {
    const input = figure(
      circles(['a', 2, [0, 0]], ['b', 2, [4.04, 0]], ['c', 2, [0, 4.01]], ['d', 1, [-2.97, 0]]),
      [stroke(['a', 'b', 'c', 'd'])],
    );
    const gaps = run(input).hints.map((h) => h.gap);
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    expect(gaps).toEqual([...gaps].sort((x, y) => x - y));
    expect(run(input).hints[0]).toMatchObject({ a: 'a', b: 'c' });
  });

  it('keeps at most 16 hints', () => {
    const rings = concentric(20, 1, 0.04);
    const { hints } = run(figure(rings, [stroke(ids(rings))]));
    expect(hints).toHaveLength(HINTS.nearTangent.maxCount);
    expect(hints).toHaveLength(16);
  });
});

describe('documented examples', () => {
  const figureExample = {
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
  } as SpecInput;

  const markExample = {
    version: 1,
    mode: 'mark',
    grid: { divisions: 4 },
    concept: 'A crescent cut from one disc by a second, offset one module up and right.',
    shapes: [
      { id: 'body', type: 'circle', r: 'R' },
      { id: 'bite', type: 'circle', center: [1, 1], r: 3 },
    ],
    paint: [{ fill: { subtract: ['body', 'bite'] } }],
  } as SpecInput;

  it.each([
    ['figure', figureExample],
    ['mark', markExample],
  ])('the %s example has no violations and no hints', (_name, input) => {
    expect(run(input)).toEqual({ violations: [], exceptionsApplied: [], hints: [] });
  });
});

const arc = (id: string, on: string, from: unknown, to: unknown): Json => ({
  id,
  type: 'arc',
  on,
  from,
  to,
});

describe('arc rules', () => {
  it('applies the angle rule to numeric ends and ignores point ends', () => {
    const ok = figure([circle('a', 3), arc('s', 'a', 22.5, -45)], [stroke(['s'])]);
    expect(has(ok, 'angle')).toBe(false);
    const bad = figure([circle('a', 3), arc('s', 'a', 10, 90)], [stroke(['s'])]);
    const [violation] = run(bad).violations;
    expect(violation).toMatchObject({ rule: 'angle', target: 's' });
    expect(violation?.message).toContain('from 10');
    const both = figure([circle('a', 3), arc('s', 'a', 10, 95)], [stroke(['s'])]);
    expect(run(both).violations[0]?.message).toContain('to 95');
    const points = figure(
      [
        circle('a', 3),
        circle('b', 3, [1, 0]),
        arc(
          's',
          'a',
          { intersect: ['a', 'b'], near: [0, 3] },
          { intersect: ['a', 'b'], near: [0, -3] },
        ),
      ],
      [stroke(['s'])],
    );
    expect(has(points, 'angle')).toBe(false);
  });

  it('checks the angle inside a point end written as on', () => {
    const input = figure(
      [circle('a', 3), arc('s', 'a', { on: 'a', angle: 10 }, 90)],
      [stroke(['s'])],
    );
    expect(has(input, 'angle', 's')).toBe(true);
  });

  it('checks literal coordinates of a point end for off_grid', () => {
    const input = figure([circle('a', 1), arc('s', 'a', [0.6, 0.8], [1, 0])], [stroke(['s'])]);
    expect(has(input, 'off_grid', 's')).toBe(true);
  });

  it('is not counted by circle_count', () => {
    const circles = Array.from({ length: 16 }, (_, i) => circle(`c${i}`, 1 + (i % 4) * 0.25));
    const arcs = [arc('s', 'c0', 0, 90), arc('t', 'c1', 90, 180)];
    const input = figure([...circles, ...arcs], [stroke(['c0', 's', 't'])]);
    expect(has(input, 'circle_count')).toBe(false);
    expect(
      has(figure([...circles, circle('c16', 1), ...arcs], [stroke(['s'])]), 'circle_count'),
    ).toBe(true);
  });

  it('measures off_canvas by the true bounding box, not the whole circle', () => {
    // A circle of radius 5.5 leaves the canvas (half side 5), but the 30..60 degree arc does not.
    const inside = figure([circle('a', 5.5), arc('s', 'a', 30, 60)], [stroke(['s'], 0.0625)]);
    expect(has(inside, 'off_canvas')).toBe(false);
    // The sweep to 100 degrees passes the top of the circle at y = 5.5.
    const over = figure([circle('a', 5.5), arc('s', 'a', 30, 100)], [stroke(['s'], 0.0625)]);
    expect(has(over, 'off_canvas', 's')).toBe(true);
    // The reach counts the axis extreme at the arc start itself, plus half the width.
    const edge = figure([circle('a', 4.9375), arc('s', 'a', 90, 180)], [stroke(['s'], 0.125)]);
    expect(has(edge, 'off_canvas')).toBe(false);
    const past = figure([circle('a', 4.9375), arc('s', 'a', 90, 180)], [stroke(['s'], 0.25)]);
    expect(has(past, 'off_canvas', 's')).toBe(true);
    // A sweep through 0 degrees reaches the right-hand extreme.
    const wrap = figure([circle('a', 5.5), arc('s', 'a', 300, 60)], [stroke(['s'], 0.0625)]);
    expect(has(wrap, 'off_canvas', 's')).toBe(true);
    const wrapIn = figure([circle('a', 5.5), arc('s', 'a', 300, 330)], [stroke(['s'], 0.0625)]);
    expect(has(wrapIn, 'off_canvas')).toBe(false);
  });

  it('reports an arc as unused unless a stroke, repeat or erase chain reaches it', () => {
    const idle = figure([circle('a', 3), arc('s', 'a', 0, 90)], [stroke(['a'])]);
    expect(has(idle, 'unused_shape', 's')).toBe(true);
    const painted = figure([circle('a', 3), arc('s', 'a', 0, 90)], [stroke(['s'])]);
    expect(has(painted, 'unused_shape')).toBe(false);
    const repeated = figure(
      [circle('a', 3), arc('s', 'a', 0, 90), { id: 'r', type: 'repeat', of: ['s'], n: 4 }],
      [stroke(['r'])],
    );
    expect(has(repeated, 'unused_shape')).toBe(false);
    const inMark = mark([circle('a', 3), arc('s', 'a', 0, 90)], 'a');
    expect(has(inMark, 'unused_shape', 's')).toBe(true);
  });

  it('keeps the circle an arc sits on and its point ends reachable', () => {
    const input = figure(
      [
        circle('a', 3),
        circle('b', 3, [1, 0]),
        arc(
          's',
          'a',
          { intersect: ['a', 'b'], near: [0, 3] },
          { intersect: ['a', 'b'], near: [0, -3] },
        ),
      ],
      [stroke(['s'])],
    );
    expect(has(input, 'unused_shape')).toBe(false);
  });
});

describe('erase layers', () => {
  const scene = (paint: Json[]): SpecInput =>
    figure([circle('a', 4), circle('disc', 1, [0, 2]), circle('b', 'a.r/2')], paint);

  it('treats an erase target as reachable', () => {
    const erased = scene([stroke(['a']), { erase: ['disc'] }]);
    expect(has(erased, 'unused_shape', 'disc')).toBe(false);
    const unused = scene([stroke(['a'])]);
    expect(has(unused, 'unused_shape', 'disc')).toBe(true);
  });

  it('follows references from an erase target', () => {
    const input = figure(
      [circle('a', 4), circle('big', 3), circle('disc', 1, { on: 'big', angle: 90 })],
      [stroke(['a']), { erase: ['disc'] }],
    );
    expect(has(input, 'unused_shape')).toBe(false);
  });

  it('adds nothing to thin_stroke, off_canvas or the ratio count', () => {
    const input = scene([stroke(['a'], 0.125), { erase: ['disc', 'b'] }]);
    expect(rulesOf(input)).toEqual([]);
  });
});

describe('outline cap and outline rules', () => {
  const lens = (): Json[] => [circle('a', 5, [-3, 0]), circle('b', 5, [3, 0])];
  const lensThrough = (): unknown[] => [
    { on: 'a', corner: [0, 4] },
    { on: 'b', corner: [0, -4] },
  ];
  const outline = (through: unknown[] = lensThrough()): Json => ({
    id: 'o',
    type: 'outline',
    through,
  });
  // Circles on the grid that take no part in the outline.
  const spares = (count: number): Json[] =>
    Array.from({ length: count }, (_, k) =>
      circle(`s${k}`, 0.5, [-8 + (k % 16), -8 + Math.floor(k / 16)]),
    );
  const markWith = (count: number, fill: unknown = 'o', extra: Json[] = []): SpecInput =>
    mark([...lens(), ...spares(count - 2), outline(), ...extra], fill, {}, 8);
  const circleCount = (input: SpecInput) =>
    run(input).violations.find((v) => v.rule === 'circle_count');

  it('keeps 8 circles as the cap of a mark without an outline', () => {
    const eight = concentric(8, 1, 0.5);
    const nine = concentric(9, 1, 0.5);
    expect(has(mark(eight, { union: ids(eight) }, {}, 8), 'circle_count')).toBe(false);
    expect(circleCount(mark(nine, { union: ids(nine) }, {}, 8))?.message).toBe(
      '9 circles declared, at most 8 allowed in mark',
    );
  });

  it('allows 40 circles in a mark whose fill reaches an outline and rejects 41', () => {
    expect(has(markWith(40), 'circle_count')).toBe(false);
    expect(circleCount(markWith(41))?.message).toBe(
      '41 circles declared, at most 40 allowed in mark with an outline',
    );
  });

  it('reaches the outline through a repeat and through a region tree', () => {
    const rep = { id: 'rep', type: 'repeat', of: ['o'], n: 2 };
    expect(has(markWith(41, 'rep', [rep]), 'circle_count')).toBe(true);
    expect(has(markWith(40, 'rep', [rep]), 'circle_count')).toBe(false);
    expect(has(markWith(40, { union: ['o', 's0'] }), 'circle_count')).toBe(false);
    expect(has(markWith(41, { union: ['o', 's0'] }), 'circle_count')).toBe(true);
  });

  it('keeps cap 8 when the outline is declared but no fill reaches it', () => {
    const input = mark([...lens(), ...spares(7), outline()], 'a', {}, 8);
    expect(input.shapes.filter((s) => s.type !== 'outline')).toHaveLength(9);
    expect(circleCount(input)?.message).toBe('9 circles declared, at most 8 allowed in mark');
    expect(has(input, 'unused_shape', 'o')).toBe(true);
  });

  it('keeps cap 16 for a figure with an outline', () => {
    const figureWith = (count: number): SpecInput =>
      figure([...lens(), ...spares(count - 2), outline()], [stroke(['o'])], {}, 8);
    expect(has(figureWith(16), 'circle_count')).toBe(false);
    expect(circleCount(figureWith(17))?.message).toBe(
      '17 circles declared, at most 16 allowed in figure',
    );
  });

  it('lists the cap thresholds', () => {
    expect(RULES.circle_count.maxCircles).toEqual({ mark: 8, mark_outline: 40, figure: 16 });
  });

  it('exempts a corner from off_grid', () => {
    const input = mark(
      [
        ...lens(),
        outline([
          { on: 'a', corner: [0.123, 3.77] },
          { on: 'b', corner: [0.1, -3.9] },
        ]),
      ],
      'o',
      {},
      8,
    );
    expect(has(input, 'off_grid')).toBe(false);
  });

  it('checks the angle of an { on, angle } corner', () => {
    const withAngle = (angle: number): SpecInput =>
      mark(
        [
          ...lens(),
          outline([
            { on: 'a', corner: { on: 'a', angle } },
            { on: 'b', corner: [0, -4] },
          ]),
        ],
        'o',
        {},
        8,
      );
    expect(has(withAngle(7), 'angle', 'o')).toBe(true);
    expect(has(withAngle(45), 'angle')).toBe(false);
  });

  describe('figure reach', () => {
    // A segment of a radius-5 circle right of x = 3: joints reach 4, the arc reaches 5.
    const segment = (width: number): SpecInput =>
      figure(
        [
          circle('a', 5, [0, 0]),
          { id: 'ln', type: 'line', from: [3, 4], to: [3, -4] },
          outline([
            { on: 'a', corner: [3, 4] },
            { on: 'ln', corner: [3, -4] },
          ]),
        ],
        [stroke(['o'], width)],
        {},
        4,
      );

    it('counts the axis extreme of an arc plus half the stroke width', () => {
      expect(has(segment(0.125), 'off_canvas', 'o')).toBe(true);
      expect(has(segment(0.125), 'off_canvas', 'a')).toBe(false);
    });

    it('does not report an outline that fits', () => {
      const fits = figure([...lens(), outline()], [stroke(['o'], 0.125)], {}, 4);
      expect(has(fits, 'off_canvas')).toBe(false);
      const wide = figure([...lens(), outline()], [stroke(['o'], 2.5)], {}, 4);
      expect(has(wide, 'off_canvas', 'o')).toBe(true);
    });
  });

  it('reports neither empty_fill nor off_canvas for a filled outline', () => {
    const input = mark([...lens(), outline()], 'o', {}, 8);
    expect(has(input, 'empty_fill')).toBe(false);
    expect(has(input, 'off_canvas')).toBe(false);
    expect(has(input, 'unused_shape')).toBe(false);
  });
});
