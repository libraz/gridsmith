import { describe, expect, it } from 'vitest';
import type { Vec } from '../../src/geom/primitives.js';
import { distance, signedDistance } from '../../src/geom/primitives.js';
import { contains } from '../../src/geom/region.js';
import type {
  ResolvedCircle,
  ResolvedElement,
  ResolvedModel,
  ResolvedPoint,
  ResolvedPolygon,
  ResolvedRepeat,
  ResolvedTangentCircle,
  ResolveError,
} from '../../src/resolve/resolve.js';
import { resolveSpec } from '../../src/resolve/resolve.js';
import type { SpecInput } from '../../src/spec/schema.js';
import { specSchema } from '../../src/spec/schema.js';

type ShapeInput = Record<string, unknown>;

const build = (
  shapes: ShapeInput[],
  paint: unknown[] = [{ stroke: [shapes[0]?.id ?? 'a'], width: 0.125 }],
  extra: Record<string, unknown> = {},
): SpecInput =>
  ({
    version: 1,
    mode: 'figure',
    grid: { divisions: 4 },
    shapes,
    paint,
    ...extra,
  }) as SpecInput;

const run = (input: SpecInput) => resolveSpec(specSchema.parse(input));

const model = (input: SpecInput): ResolvedModel => {
  const res = run(input);
  if (!res.ok) {
    throw new Error(`expected ok: ${JSON.stringify(res.errors)}`);
  }
  return res.model;
};

const failure = (input: SpecInput): ResolveError[] => {
  const res = run(input);
  if (res.ok) {
    throw new Error('expected errors');
  }
  return res.errors;
};

const get = <T extends ResolvedElement['type']>(
  m: ResolvedModel,
  id: string,
  type: T,
): Extract<ResolvedElement, { type: T }> => {
  const el = m.byId.get(id);
  if (el === undefined || el.type !== type) {
    throw new Error(`no ${type} ${id}`);
  }
  return el as Extract<ResolvedElement, { type: T }>;
};

const nearestOf = (candidates: Vec[], near: Vec): Vec => {
  const sorted = [...candidates].sort((a, b) => distance(a, near) - distance(b, near));
  const best = sorted[0];
  if (best === undefined) {
    throw new Error('no candidates');
  }
  return best;
};

const area = (loop: Vec[]): number =>
  loop.reduce((sum, a, i) => {
    const b = loop[(i + 1) % loop.length] as Vec;
    return sum + (a.x * b.y - b.x * a.y) / 2;
  }, 0);

const circle = (id: string, cx: number, cy: number, r: number | string): ShapeInput => ({
  id,
  type: 'circle',
  center: [cx, cy],
  r,
});

describe('intersect selection', () => {
  // Candidates from closed forms, chosen by brute force.
  const ccA = { x: 0, y: 0, r: 3 };
  const ccB = { x: 4, y: 0, r: 2 };
  const ccX = (ccA.r ** 2 - ccB.r ** 2 + 16) / 8;
  const ccY = Math.sqrt(ccA.r ** 2 - ccX ** 2);

  it.each([
    [3, 1],
    [3, -1],
    [0, 7],
    [-5, -2],
  ])('circle-circle near (%d, %d) matches the brute-force nearest', (nx, ny) => {
    const m = model(
      build([
        circle('a', 0, 0, 3),
        circle('b', 4, 0, 2),
        { id: 'p', type: 'point', at: { intersect: ['a', 'b'], near: [nx, ny] } },
      ]),
    );
    const want = nearestOf(
      [
        { x: ccX, y: ccY },
        { x: ccX, y: -ccY },
      ],
      { x: nx, y: ny },
    );
    const p = get(m, 'p', 'point');
    expect(p.x).toBeCloseTo(want.x, 9);
    expect(p.y).toBeCloseTo(want.y, 9);
  });

  it.each([
    [3, 3],
    [-3, 0],
    [1, -4],
  ])('circle-line near (%d, %d) matches the brute-force nearest', (nx, ny) => {
    const h = Math.sqrt(9 - 1);
    const m = model(
      build([
        circle('a', 0, 0, 3),
        { id: 'l', type: 'line', from: [-5, 1], to: [5, 1] },
        { id: 'p', type: 'point', at: { intersect: ['l', 'a'], near: [nx, ny] } },
      ]),
    );
    const want = nearestOf(
      [
        { x: h, y: 1 },
        { x: -h, y: 1 },
      ],
      { x: nx, y: ny },
    );
    const p = get(m, 'p', 'point');
    expect(p.x).toBeCloseTo(want.x, 9);
    expect(p.y).toBeCloseTo(want.y, 9);
  });

  it('line-line yields the crossing, with near optional', () => {
    const m = model(
      build([
        { id: 'l1', type: 'line', from: [-4, -4], to: [4, 4] },
        { id: 'l2', type: 'line', from: [-4, 2], to: [4, 2] },
        { id: 'p', type: 'point', at: { intersect: ['l1', 'l2'] } },
      ]),
    );
    const p = get(m, 'p', 'point');
    expect(p.x).toBeCloseTo(2, 9);
    expect(p.y).toBeCloseTo(2, 9);
  });

  it('accepts a missing near when circles touch at one point', () => {
    const m = model(
      build([
        circle('a', 0, 0, 2),
        circle('b', 3, 0, 1),
        { id: 'p', type: 'point', at: { intersect: ['a', 'b'] } },
      ]),
    );
    expect(get(m, 'p', 'point').x).toBeCloseTo(2, 9);
  });

  it('rejects a missing near with two candidates, listing both', () => {
    const errors = failure(
      build([
        circle('a', 0, 0, 3),
        circle('b', 4, 0, 2),
        { id: 'p', type: 'point', at: { intersect: ['a', 'b'] } },
      ]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.id).toBe('p');
    expect(errors[0]?.message).toContain('near');
    expect(errors[0]?.message).toContain('1.45237');
    expect(errors[0]?.message).toContain('-1.45237');
  });

  it('rejects a tie with both candidate coordinates and distances', () => {
    const errors = failure(
      build([
        circle('a', 0, 0, 3),
        circle('b', 4, 0, 2),
        { id: 'p', type: 'point', at: { intersect: ['a', 'b'], near: [3, 0] } },
      ]),
    );
    expect(errors[0]?.message).toContain('2.625');
    expect(errors[0]?.message).toContain('1.45237');
    expect(errors[0]?.message).toContain('-1.45237');
    expect(errors[0]?.message).toContain('distance');
  });

  it('suggests the on-circle notation when circles coincide', () => {
    const errors = failure(
      build([
        circle('a', 0, 0, 2),
        circle('b', 0, 0, 2),
        { id: 'p', type: 'point', at: { intersect: ['a', 'b'] } },
      ]),
    );
    expect(errors[0]?.message).toContain('"on"');
  });

  it('reports the measured centre distance when circles do not meet', () => {
    const errors = failure(
      build([
        circle('a', 0, 0, 1),
        circle('b', 10, 0, 1),
        { id: 'p', type: 'point', at: { intersect: ['a', 'b'] } },
      ]),
    );
    expect(errors[0]?.message).toContain('centre distance 10');
    expect(errors[0]?.message).toContain('2');
  });

  it('rejects parallel lines and a line missing a circle', () => {
    const parallel = failure(
      build([
        { id: 'l1', type: 'line', from: [-4, 0], to: [4, 0] },
        { id: 'l2', type: 'line', from: [-4, 3], to: [4, 3] },
        { id: 'p', type: 'point', at: { intersect: ['l1', 'l2'] } },
      ]),
    );
    expect(parallel[0]?.message).toContain('parallel');
    expect(parallel[0]?.message).toContain('3');
    const miss = failure(
      build([
        circle('a', 0, 0, 1),
        { id: 'l', type: 'line', from: [-4, 5], to: [4, 5] },
        { id: 'p', type: 'point', at: { intersect: ['a', 'l'] } },
      ]),
    );
    expect(miss[0]?.message).toContain('distance 5');
  });

  it('evaluates a near that is itself an intersect', () => {
    const m = model(
      build([
        circle('a', 0, 0, 3),
        circle('b', 4, 0, 2),
        { id: 'l1', type: 'line', from: [-4, -4], to: [4, 4] },
        { id: 'l2', type: 'line', from: [-4, 2], to: [4, 2] },
        {
          id: 'p',
          type: 'point',
          at: { intersect: ['a', 'b'], near: { intersect: ['l1', 'l2'] } },
        },
      ]),
    );
    expect(get(m, 'p', 'point').y).toBeGreaterThan(0);
  });
});

describe('tangent_circle selection', () => {
  // Candidate centres from closed-form offset-curve intersections.
  const circleCircle = (a: Vec, ra: number, b: Vec, rb: number): Vec[] => {
    const d = distance(a, b);
    if (d > ra + rb || d < Math.abs(ra - rb) || d === 0) {
      return [];
    }
    const along = (d * d + ra * ra - rb * rb) / (2 * d);
    const h = Math.sqrt(Math.max(0, ra * ra - along * along));
    const ux = (b.x - a.x) / d;
    const uy = (b.y - a.y) / d;
    return [
      { x: a.x + ux * along - uy * h, y: a.y + uy * along + ux * h },
      { x: a.x + ux * along + uy * h, y: a.y + uy * along - ux * h },
    ];
  };

  it.each([
    [2, 5],
    [2, -5],
    [-1, 0.2],
  ])('circle-circle near (%d, %d) matches the brute-force nearest', (nx, ny) => {
    const A = { x: 0, y: 0 };
    const B = { x: 4, y: 0 };
    const all = [
      ...circleCircle(A, 2 + 1, B, 1 + 1),
      ...circleCircle(A, Math.abs(2 - 1), B, 1 + 1),
    ];
    const m = model(
      build([
        circle('a', 0, 0, 2),
        circle('b', 4, 0, 1),
        { id: 't', type: 'tangent_circle', r: 1, to: ['a', 'b'], near: [nx, ny] },
      ]),
    );
    const want = nearestOf(all, { x: nx, y: ny });
    const t = get(m, 't', 'tangent_circle');
    expect(t.circle.cx).toBeCloseTo(want.x, 9);
    expect(t.circle.cy).toBeCloseTo(want.y, 9);
    expect(t.circle.r).toBe(1);
    expect(t.contacts.map((c) => c.kind)).toEqual(['external', 'external']);
    expect(t.contacts.map((c) => c.to)).toEqual(['a', 'b']);
  });

  it.each([
    [3, 0],
    [-3, 0.5],
    [1, 8],
  ])('circle-line near (%d, %d) matches the brute-force nearest', (nx, ny) => {
    const all: Vec[] = [];
    for (const y of [1, -1]) {
      for (const R of [3, 1]) {
        const dy = y - 3;
        if (Math.abs(dy) <= R) {
          const dx = Math.sqrt(R * R - dy * dy);
          all.push({ x: dx, y }, { x: -dx, y });
        }
      }
    }
    const m = model(
      build([
        circle('a', 0, 3, 2),
        { id: 'l', type: 'line', from: [-5, 0], to: [5, 0] },
        { id: 't', type: 'tangent_circle', r: 1, to: ['a', 'l'], near: [nx, ny] },
      ]),
    );
    const want = nearestOf(all, { x: nx, y: ny });
    const t = get(m, 't', 'tangent_circle');
    expect(t.circle.cx).toBeCloseTo(want.x, 9);
    expect(t.circle.cy).toBeCloseTo(want.y, 9);
    const contact = t.contacts[1];
    expect(contact?.kind).toBe('line');
    expect(contact?.y).toBeCloseTo(0, 9);
    expect(contact?.x).toBeCloseTo(want.x, 9);
  });

  it.each([
    [2, -3],
    [-2, 3],
    [0.5, 0.5],
  ])('line-line near (%d, %d) matches the brute-force nearest', (nx, ny) => {
    const all: Vec[] = [
      { x: 1, y: 1 },
      { x: 1, y: -1 },
      { x: -1, y: 1 },
      { x: -1, y: -1 },
    ];
    const m = model(
      build([
        { id: 'h', type: 'line', from: [-5, 0], to: [5, 0] },
        { id: 'v', type: 'line', from: [0, -5], to: [0, 5] },
        { id: 't', type: 'tangent_circle', r: 1, to: ['h', 'v'], near: [nx, ny] },
      ]),
    );
    const want = nearestOf(all, { x: nx, y: ny });
    const t = get(m, 't', 'tangent_circle');
    expect(t.circle.cx).toBeCloseTo(want.x, 9);
    expect(t.circle.cy).toBeCloseTo(want.y, 9);
  });

  it('records internal contact kinds', () => {
    const m = model(
      build([
        circle('a', 0, 0, 4),
        circle('b', 4, 0, 1),
        { id: 't', type: 'tangent_circle', r: 2, to: ['a', 'b'], near: [1.4, 1.4] },
      ]),
    );
    const t: ResolvedTangentCircle = get(m, 't', 'tangent_circle');
    const dA = distance({ x: t.circle.cx, y: t.circle.cy }, { x: 0, y: 0 });
    expect(Math.abs(dA - 2)).toBeLessThan(1e-9);
    expect(t.contacts.map((c) => c.kind)).toEqual(['internal', 'external']);
    expect(t.circle.cy).toBeGreaterThan(0);
  });

  it('rejects a tie with both candidates', () => {
    const errors = failure(
      build([
        circle('a', 0, 0, 2),
        circle('b', 4, 0, 2),
        { id: 't', type: 'tangent_circle', r: 1, to: ['a', 'b'], near: [2, 0] },
      ]),
    );
    expect(errors[0]?.id).toBe('t');
    expect(errors[0]?.message).toContain('2.23607');
    expect(errors[0]?.message).toContain('-2.23607');
  });

  it('suggests the on-circle notation for infinite candidates', () => {
    const concentric = failure(
      build([
        circle('a', 0, 0, 2),
        circle('b', 0, 0, 4),
        { id: 't', type: 'tangent_circle', r: 1, to: ['a', 'b'], near: [3, 0] },
      ]),
    );
    expect(concentric[0]?.message).toContain('"on"');
    const parallel = failure(
      build([
        { id: 'l1', type: 'line', from: [-5, 0], to: [5, 0] },
        { id: 'l2', type: 'line', from: [-5, 2], to: [5, 2] },
        { id: 't', type: 'tangent_circle', r: 1, to: ['l1', 'l2'], near: [0, 1] },
      ]),
    );
    expect(parallel[0]?.message).toContain('"on"');
  });

  it('reports the measured centre distance when nothing touches both', () => {
    const errors = failure(
      build([
        circle('a', 0, 0, 1),
        circle('b', 20, 0, 1),
        { id: 't', type: 'tangent_circle', r: 1, to: ['a', 'b'], near: [10, 0] },
      ]),
    );
    expect(errors[0]?.message).toContain('centre distance 20');
    expect(errors[0]?.message).toContain('4');
  });
});

describe('error collection', () => {
  it('reports a root cause first and its dependents after, in one result', () => {
    const errors = failure(
      build(
        [
          circle('a', 0, 0, 2),
          circle('far', 10, 0, 1),
          { id: 'p', type: 'point', at: { intersect: ['a', 'far'], near: [0, 0] } },
          { id: 'q', type: 'point', at: 'p' },
          { id: 'c', type: 'circle', center: 'q', r: 1 },
          circle('fine', 1, 1, 1),
          { id: 'ring', type: 'circle', center: 'p', r: 'c.r' },
        ],
        [{ stroke: ['c', 'fine'], width: 0.125 }],
      ),
    );
    expect(errors.map((e) => e.id)).toEqual(['p', 'q', 'c', 'ring', 'paint[0]']);
    expect(errors[0]?.dependsOn).toBeUndefined();
    expect(errors[1]).toMatchObject({ id: 'q', dependsOn: 'p' });
    expect(errors[2]).toMatchObject({ id: 'c', dependsOn: 'q' });
    expect(errors[3]).toMatchObject({ id: 'ring', dependsOn: 'p' });
    expect(errors[4]).toMatchObject({ id: 'paint[0]', dependsOn: 'c' });
    expect(errors[1]?.message).toContain('"p"');
  });

  it('reports several independent failures together, roots before dependents', () => {
    const errors = failure(
      build(
        [
          { id: 'l', type: 'line', from: [1, 1], to: [1, 1] },
          circle('big', 0, 0, 'R*16*2'),
          { id: 'dep', type: 'circle', center: [0, 0], r: 'big.r/2' },
          { id: 'ok', type: 'circle', center: [0, 0], r: 1 },
        ],
        [{ stroke: ['ok'], width: 'R/16/16/16' }],
      ),
    );
    expect(errors.map((e) => e.id)).toEqual(['l', 'big', 'paint[0]', 'dep']);
    expect(errors[3]?.dependsOn).toBe('big');
  });
});

describe('length evaluation', () => {
  it('evaluates R and <id>.r bases and labels them', () => {
    const m = model(
      build(
        [
          circle('a', 0, 0, 'R/2'),
          circle('b', 0, 0, 'a.r*sqrt2'),
          circle('c', 0, 0, 2.5),
          circle('d', 0, 0, 'R*phi/2'),
        ],
        [{ stroke: ['a', 'b', 'c', 'd'], width: 'R/16' }],
      ),
    );
    expect(get(m, 'a', 'circle').circle.r).toBe(2);
    expect(get(m, 'a', 'circle').label).toBe('R/2');
    expect(get(m, 'b', 'circle').circle.r).toBeCloseTo(2 * Math.SQRT2, 12);
    expect(get(m, 'c', 'circle').label).toBe('2.5');
    expect(get(m, 'd', 'circle').circle.r).toBeCloseTo((4 * ((1 + Math.sqrt(5)) / 2)) / 2, 12);
    expect(m.strokes[0]?.width).toBe(0.25);
    expect(m.strokes[0]?.widthLabel).toBe('R/16');
    expect(m.R).toBe(4);
    expect(m.canvasHalf).toBe(5);
  });

  it('honours the grid margin and divisions', () => {
    const m = model(
      build([circle('a', 0, 0, 'R')], undefined, { grid: { divisions: 8, margin: 2 } }),
    );
    expect(m.canvasHalf).toBe(10);
    expect(m.divisions).toBe(8);
    expect(m.margin).toBe(2);
    expect(get(m, 'a', 'circle').circle.r).toBe(8);
  });

  it('rejects an evaluated radius outside 0.05 to 64', () => {
    const small = failure(build([circle('a', 0, 0, 'R/16/16')]));
    expect(small[0]).toMatchObject({ id: 'a' });
    expect(small[0]?.message).toContain('0.015625');
    const large = failure(build([circle('a', 0, 0, 'R*16*2')]));
    expect(large[0]?.message).toContain('128');
  });

  it('rejects an evaluated width outside 0.005 to 8', () => {
    const errors = failure(build([circle('a', 0, 0, 2)], [{ stroke: ['a'], width: 'R*16*16' }]));
    expect(errors[0]?.id).toBe('paint[0]');
    expect(errors[0]?.message).toContain('width');
    const thin = failure(build([circle('a', 0, 0, 2)], [{ stroke: ['a'], width: 'R/16/16/16' }]));
    expect(thin[0]?.message).toContain('0.000976563');
  });

  it('rejects a derived coordinate beyond 64 but accepts 64', () => {
    const edge = model(
      build([circle('a', 60, 0, 4), { id: 'p', type: 'point', at: { on: 'a', angle: 0 } }]),
    );
    expect(get(edge, 'p', 'point').x).toBeCloseTo(64, 9);
    const errors = failure(
      build([circle('a', 63, 0, 4), { id: 'p', type: 'point', at: { on: 'a', angle: 0 } }]),
    );
    expect(errors[0]).toMatchObject({ id: 'p' });
    expect(errors[0]?.message).toContain('67');
  });
});

describe('points', () => {
  it('places a point on a circle by angle, modulo 360', () => {
    const m = model(
      build([
        circle('c', 1, 1, 2),
        { id: 'p', type: 'point', at: { on: 'c', angle: 90 } },
        { id: 'q', type: 'point', at: { on: 'c', angle: 450 } },
        { id: 'o', type: 'point', at: 'c' },
      ]),
    );
    const p: ResolvedPoint = get(m, 'p', 'point');
    expect(p.x).toBeCloseTo(1, 12);
    expect(p.y).toBeCloseTo(3, 12);
    expect(get(m, 'q', 'point').y).toBeCloseTo(3, 12);
    expect(get(m, 'o', 'point')).toMatchObject({ x: 1, y: 1 });
  });

  it('keeps elements in declaration order and by id', () => {
    const m = model(build([circle('a', 0, 0, 1), circle('b', 0, 0, 2)]));
    expect(m.elements.map((e) => e.id)).toEqual(['a', 'b']);
    expect(m.byId.get('b')).toBe(m.elements[1]);
  });
});

describe('degenerate shapes', () => {
  it('rejects a line with coincident endpoints', () => {
    const errors = failure(build([{ id: 'l', type: 'line', from: [1, 2], to: [1, 2] }]));
    expect(errors[0]?.id).toBe('l');
  });

  it('rejects coincident adjacent points, including last and first', () => {
    const adjacent = failure(
      build([
        {
          id: 's',
          type: 'points',
          through: [
            [0, 0],
            [1, 0],
            [1, 0],
            [0, 1],
          ],
        },
      ]),
    );
    expect(adjacent[0]?.id).toBe('s');
    const wrap = failure(
      build([
        {
          id: 's',
          type: 'points',
          through: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        },
      ]),
    );
    expect(wrap[0]?.id).toBe('s');
  });

  it('rejects collinear points', () => {
    const errors = failure(
      build([
        {
          id: 's',
          type: 'points',
          through: [
            [0, 0],
            [1, 1],
            [2, 2],
            [3, 3],
          ],
        },
      ]),
    );
    expect(errors[0]?.message).toContain('collinear');
  });

  it('accepts a triangle', () => {
    const m = model(
      build([
        {
          id: 's',
          type: 'points',
          through: [
            [0, 0],
            [2, 0],
            [0, 2],
          ],
        },
      ]),
    );
    expect(get(m, 's', 'points').loops[0]).toHaveLength(3);
  });
});

describe('polygon', () => {
  const polygon = (n: number, step: number, rotate = 90): ResolvedPolygon =>
    get(
      model(build([circle('c', 0, 0, 3), { id: 'g', type: 'polygon', in: 'c', n, step, rotate }])),
      'g',
      'polygon',
    );

  it('builds a hexagram as two triangles of one orientation', () => {
    const g = polygon(6, 2);
    expect(g.loops).toHaveLength(2);
    expect(g.loops.map((l) => l.length)).toEqual([3, 3]);
    expect(g.vertices).toHaveLength(6);
    const [a, b] = g.loops.map(area);
    expect(Math.sign(a ?? 0)).toBe(Math.sign(b ?? 0));
    expect(g.loops[0]?.[0]?.x).toBeCloseTo(0, 12);
    expect(g.loops[0]?.[0]?.y).toBeCloseTo(3, 12);
    expect(g.loops[1]?.[0]?.x).toBeCloseTo(3 * Math.cos((150 * Math.PI) / 180), 12);
  });

  it('builds a pentagram as one loop of five vertices', () => {
    const g = polygon(5, 2);
    expect(g.loops).toHaveLength(1);
    expect(g.loops[0]).toHaveLength(5);
    expect(g.loops[0]?.[1]?.x).toBeCloseTo(3 * Math.cos((234 * Math.PI) / 180), 12);
  });

  it('builds an 8/2 star as two squares', () => {
    const g = polygon(8, 2);
    expect(g.loops.map((l) => l.length)).toEqual([4, 4]);
    const [a, b] = g.loops.map(area);
    expect(Math.sign(a ?? 0)).toBe(Math.sign(b ?? 0));
  });

  it('builds a plain polygon on the circle', () => {
    const g = polygon(7, 1, 0);
    expect(g.loops).toHaveLength(1);
    for (const v of g.vertices) {
      expect(Math.hypot(v.x, v.y)).toBeCloseTo(3, 12);
    }
  });
});

describe('repeat', () => {
  const dotAt = (angle: number, r = 2): ShapeInput[] => [
    circle('band', 0, 0, r),
    { id: 'dot', type: 'circle', center: { on: 'band', angle }, r: 0.25 },
  ];
  const centres = (rep: ResolvedRepeat, original: ResolvedCircle): Vec[] => [
    { x: original.circle.cx, y: original.circle.cy },
    ...rep.copies.map((c) => {
      const el = c.element as ResolvedCircle;
      return { x: el.circle.cx, y: el.circle.cy };
    }),
  ];

  it('rotates n copies about the centre', () => {
    const m = model(
      build(
        [...dotAt(0), { id: 'rep', type: 'repeat', of: ['dot'], n: 6 }],
        [{ stroke: ['rep'], width: 0.125 }],
      ),
    );
    const rep = get(m, 'rep', 'repeat');
    expect(rep.copyCount).toBe(6);
    expect(rep.copies).toHaveLength(5);
    expect(rep.copies.map((c) => c.copy)).toEqual([1, 2, 3, 4, 5]);
    expect(rep.copies.every((c) => c.of === 'dot')).toBe(true);
    const cs = centres(rep, get(m, 'dot', 'circle'));
    cs.forEach((c, k) => {
      expect(c.x).toBeCloseTo(2 * Math.cos((k * Math.PI) / 3), 9);
      expect(c.y).toBeCloseTo(2 * Math.sin((k * Math.PI) / 3), 9);
    });
    expect(m.strokes[0]?.items).toHaveLength(6);
  });

  it('rotates about an explicit centre', () => {
    const m = model(
      build([
        circle('dot', 1, 0, 0.5),
        { id: 'rep', type: 'repeat', of: ['dot'], n: 4, center: [3, 0] },
      ]),
    );
    const rep = get(m, 'rep', 'repeat');
    const cs = centres(rep, get(m, 'dot', 'circle'));
    expect(cs).toHaveLength(4);
    expect(cs[1]?.x).toBeCloseTo(3, 9);
    expect(cs[1]?.y).toBeCloseTo(-2, 9);
  });

  it('adds mirrored copies for 2n placements', () => {
    const m = model(
      build([...dotAt(20), { id: 'rep', type: 'repeat', of: ['dot'], n: 3, mirror: true }]),
    );
    const rep = get(m, 'rep', 'repeat');
    expect(rep.copyCount).toBe(6);
    expect(rep.copies).toHaveLength(5);
    const angles = centres(rep, get(m, 'dot', 'circle')).map(
      (c) => ((Math.atan2(c.y, c.x) * 180) / Math.PI + 360) % 360,
    );
    const want = [20, 140, 260, 160, 280, 40];
    for (const a of want) {
      expect(angles.some((x) => Math.abs(x - a) < 1e-7)).toBe(true);
    }
  });

  it('drops mirrored duplicates of an axis-symmetric motif', () => {
    const m = model(
      build([...dotAt(0), { id: 'rep', type: 'repeat', of: ['dot'], n: 12, mirror: true }]),
    );
    const rep = get(m, 'rep', 'repeat');
    expect(rep.copyCount).toBe(12);
    expect(rep.copies).toHaveLength(11);
  });

  it('keeps a single mirrored copy for n = 1', () => {
    const m = model(
      build([...dotAt(30), { id: 'rep', type: 'repeat', of: ['dot'], n: 1, mirror: true }]),
    );
    const rep = get(m, 'rep', 'repeat');
    expect(rep.copyCount).toBe(2);
    const el = rep.copies[0]?.element as ResolvedCircle;
    expect(Math.atan2(el.circle.cy, el.circle.cx)).toBeCloseTo((150 * Math.PI) / 180, 9);
  });

  it('copies lines, polygons and tangent circles', () => {
    const m = model(
      build([
        circle('c', 0, 0, 3),
        { id: 'l', type: 'line', from: [0, 1], to: [0, 3] },
        { id: 'g', type: 'polygon', in: 'c', n: 3, rotate: 90 },
        { id: 'rep', type: 'repeat', of: ['l', 'g'], n: 3 },
      ]),
    );
    const rep = get(m, 'rep', 'repeat');
    const lines = rep.copies.filter((c) => c.of === 'l');
    expect(lines).toHaveLength(2);
    const second = lines[0]?.element;
    expect(second?.type).toBe('line');
    if (second?.type === 'line') {
      expect(Math.hypot(second.to.x, second.to.y)).toBeCloseTo(3, 9);
      expect(Math.abs(signedDistance(second.line, second.from))).toBeLessThan(1e-9);
    }
    // A triangle rotated by 120 degrees is the same triangle.
    expect(rep.copies.filter((c) => c.of === 'g')).toHaveLength(0);
    expect(rep.copyCount).toBe(3);

    const t = model(
      build([
        circle('a', 0, 0, 2),
        circle('b', 4, 0, 1),
        { id: 'tc', type: 'tangent_circle', r: 1, to: ['a', 'b'], near: [2.5, 1] },
        { id: 'rep', type: 'repeat', of: ['tc'], n: 2 },
      ]),
    );
    const copy = get(t, 'rep', 'repeat').copies[0]?.element;
    expect(copy?.type).toBe('circle');
  });
});

describe('figure strokes', () => {
  it('expands repeats and orders items', () => {
    const m = model(
      build(
        [
          circle('band', 0, 0, 3),
          { id: 'dot', type: 'circle', center: { on: 'band', angle: 0 }, r: 0.25 },
          { id: 'rep', type: 'repeat', of: ['dot'], n: 4 },
          { id: 'l', type: 'line', from: [-3, 0], to: [3, 0] },
          {
            id: 's',
            type: 'points',
            through: [
              [0, 0],
              [1, 0],
              [0, 1],
            ],
          },
        ],
        [
          { stroke: ['band', 'l'], width: 0.25, color: '#112233' },
          { stroke: ['rep', 's'], width: 0.125 },
        ],
      ),
    );
    expect(m.fills).toEqual([]);
    const [first, second] = m.strokes;
    expect(first?.color).toBe('#112233');
    expect(first?.items.map((i) => i.kind)).toEqual(['circle', 'segment']);
    expect(second?.index).toBe(1);
    expect(second?.items.map((i) => `${i.id}:${i.copy}:${i.via}`)).toEqual([
      'dot:0:rep',
      'dot:1:rep',
      'dot:2:rep',
      'dot:3:rep',
      's:0:s',
    ]);
    expect(second?.items[4]?.kind).toBe('polygon');
  });
});

describe('mark fills', () => {
  const markSpec = (shapes: ShapeInput[], fill: unknown): SpecInput =>
    build(shapes, [{ fill, color: '#ff0000' }], { mode: 'mark' });

  it('sets a source on every leaf and unions repeat copies', () => {
    const m = model(
      markSpec([circle('dot', 2, 0, 0.5), { id: 'rep', type: 'repeat', of: ['dot'], n: 4 }], 'rep'),
    );
    const fill = m.fills[0];
    expect(fill?.color).toBe('#ff0000');
    expect(fill?.index).toBe(0);
    const region = fill?.region;
    expect(region?.kind).toBe('union');
    if (region?.kind === 'union') {
      expect(region.children.map((c) => (c.kind === 'disc' ? c.source : null))).toEqual([
        { id: 'dot', copy: 0 },
        { id: 'dot', copy: 1 },
        { id: 'dot', copy: 2 },
        { id: 'dot', copy: 3 },
      ]);
    }
    expect(fill && contains(fill.region, { x: 0, y: 2 })).toBe(true);
    expect(fill && contains(fill.region, { x: 0, y: 0 })).toBe(false);
  });

  it('builds polygon leaves with compound loops', () => {
    const m = model(
      markSpec(
        [circle('c', 0, 0, 3), { id: 'g', type: 'polygon', in: 'c', n: 6, step: 2, rotate: 90 }],
        'g',
      ),
    );
    const region = m.fills[0]?.region;
    expect(region).toMatchObject({ kind: 'poly', source: { id: 'g', copy: 0 } });
    expect(region?.kind === 'poly' && region.loops.length).toBe(2);
  });

  it('builds a half-plane on the side of toward', () => {
    const m = model(
      markSpec([circle('body', 0, 0, 3), { id: 'l', type: 'line', from: [-5, 0], to: [5, 0] }], {
        intersect: ['body', { half: 'l', toward: [0, -1] }],
      }),
    );
    const region = m.fills[0]?.region;
    expect(region && contains(region, { x: 0, y: -1 })).toBe(true);
    expect(region && contains(region, { x: 0, y: 1 })).toBe(false);
    if (region?.kind === 'intersect') {
      expect(region.children[1]).toMatchObject({ kind: 'half', source: { id: 'l', copy: 0 } });
    }
  });

  it('rejects toward on the line, attributing it to the layer', () => {
    const errors = failure(
      markSpec([circle('body', 0, 0, 3), { id: 'l', type: 'line', from: [-5, 0], to: [5, 0] }], {
        intersect: ['body', { half: 'l', toward: [1, 0] }],
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.id).toBe('paint[0]');
    expect(errors[0]?.message).toContain('toward');
  });

  it('reports an unresolved region leaf as a dependent layer', () => {
    const errors = failure(
      markSpec(
        [
          circle('a', 0, 0, 1),
          circle('b', 9, 0, 1),
          { id: 'p', type: 'point', at: { intersect: ['a', 'b'] } },
          { id: 'c', type: 'circle', center: 'p', r: 1 },
        ],
        'c',
      ),
    );
    expect(errors.map((e) => e.id)).toEqual(['p', 'c', 'paint[0]']);
    expect(errors[2]?.dependsOn).toBe('c');
  });
});

describe('example specs', () => {
  it('resolves the figure example', () => {
    const m = model({
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
    } as SpecInput);
    expect(get(m, 'dots', 'repeat').copyCount).toBe(12);
    expect(get(m, 'star', 'polygon').loops).toHaveLength(2);
    expect(m.strokes[0]?.items).toHaveLength(4 + 12);
    expect(m.strokes[0]?.width).toBe(0.125);
  });

  it('resolves the mark example, with the crescent filled and the bite empty', () => {
    const m = model({
      version: 1,
      mode: 'mark',
      grid: { divisions: 4 },
      concept: 'A crescent cut from one disc by a second, offset one module up and right.',
      shapes: [
        { id: 'body', type: 'circle', r: 'R' },
        { id: 'bite', type: 'circle', center: [1, 1], r: 3 },
      ],
      paint: [{ fill: { subtract: ['body', 'bite'] } }],
    } as SpecInput);
    const fill = m.fills[0];
    expect(fill?.color).toBe('#000000');
    expect(fill && contains(fill.region, { x: -3, y: -2 })).toBe(true);
    expect(fill && contains(fill.region, { x: 1, y: 1 })).toBe(false);
    expect(m.strokes).toEqual([]);
  });
});

describe('arc resolution', () => {
  const base = [circle('a', 0, 0, 3), circle('b', 2, 0, 3)];
  const arcOf = (from: unknown, to: unknown, on = 'a', id = 'arc'): ShapeInput => ({
    id,
    type: 'arc',
    on,
    from,
    to,
  });
  const strokeArc = (shapes: ShapeInput[], id = 'arc') =>
    build([...base, ...shapes], [{ stroke: [id], width: 0.125 }]);

  it('runs counter-clockwise from the first to the second numeric end', () => {
    const m = model(strokeArc([arcOf(30, 150)]));
    const arc = get(m, 'arc', 'arc');
    expect([arc.from, arc.to, arc.sweep]).toEqual([30, 150, 120]);
    expect(arc.start.x).toBeCloseTo(3 * Math.cos(Math.PI / 6), 12);
    expect(arc.end.y).toBeCloseTo(3 * Math.sin((150 * Math.PI) / 180), 12);
    expect(m.strokes[0]?.items).toHaveLength(1);
    expect(m.strokes[0]?.items[0]).toMatchObject({ kind: 'arc', sweep: 120 });
  });

  it('wraps through 360 and normalises angles beyond a turn', () => {
    const arc = get(model(strokeArc([arcOf(-90, 450)])), 'arc', 'arc');
    expect([arc.from, arc.to, arc.sweep]).toEqual([270, 90, 180]);
    const reverse = get(model(strokeArc([arcOf(150, 30)])), 'arc', 'arc');
    expect(reverse.sweep).toBe(240);
  });

  it('takes point ends from intersections and measures the angles from the circle centre', () => {
    const m = model(
      strokeArc([
        arcOf(
          { intersect: ['a', 'b'], near: [1, -3] },
          { intersect: ['a', 'b'], near: [1, 3] },
          'b',
        ),
      ]),
    );
    const arc = get(m, 'arc', 'arc');
    const y = Math.sqrt(9 - 1);
    expect(arc.start.x).toBeCloseTo(1, 9);
    expect(arc.start.y).toBeCloseTo(-y, 9);
    expect(arc.end.y).toBeCloseTo(y, 9);
    const expected = (Math.atan2(y, -1) * 180) / Math.PI;
    expect(arc.to).toBeCloseTo(expected, 9);
    expect(arc.circle).toEqual({ cx: 2, cy: 0, r: 3 });
    expect(arc.sweep).toBeCloseTo(2 * expected, 9);
  });

  it('rejects an end that is off the circle, stating the distance', () => {
    const [error] = failure(strokeArc([arcOf([3, 0.5], 90)]));
    expect(error?.id).toBe('arc');
    expect(error?.message).toContain('off the circle');
    expect(error?.message).toContain('distance 0.0');
    expect(error?.message).toContain('0.000001');
  });

  it('accepts an end within 1e-6 of the circle', () => {
    expect(run(strokeArc([arcOf([3 + 5e-7, 0], 90)])).ok).toBe(true);
    expect(run(strokeArc([arcOf([3 + 2e-6, 0], 90)])).ok).toBe(false);
  });

  it('rejects coincident ends and suggests a circle', () => {
    for (const [from, to] of [
      [40, 40],
      [0, 360],
      [10, 730],
      [[3, 0], 0],
    ] as const) {
      const [error] = failure(strokeArc([arcOf(from, to)]));
      expect(error?.message).toContain('coincide');
      expect(error?.message).toContain('circle');
    }
  });

  it('reports a failed circle as the cause when an arc sits on it', () => {
    const errors = failure(
      build(
        [{ id: 'bad', type: 'circle', center: [0, 0], r: 'R*16*2' }, arcOf(0, 90, 'bad')],
        [{ stroke: ['arc'], width: 0.125 }],
      ),
    );
    expect(errors.find((e) => e.id === 'arc')?.dependsOn).toBe('bad');
  });

  it('copies arcs by rotation about the centre', () => {
    const m = model(
      strokeArc([arcOf(0, 90), { id: 'ring', type: 'repeat', of: ['arc'], n: 4 }], 'ring'),
    );
    const ring = get(m, 'ring', 'repeat');
    expect(ring.copyCount).toBe(4);
    const angles = ring.copies.map((c) => (c.element.type === 'arc' ? c.element.from : Number.NaN));
    expect(angles).toEqual([90, 180, 270]);
    expect(m.strokes[0]?.items).toHaveLength(4);
  });

  it('swaps the ends of a mirrored arc so that it stays counter-clockwise', () => {
    const m = model(
      strokeArc(
        [arcOf(0, 60), { id: 'pair', type: 'repeat', of: ['arc'], n: 1, mirror: true, axis: 90 }],
        'pair',
      ),
    );
    const [copy] = get(m, 'pair', 'repeat').copies;
    expect(copy?.element.type).toBe('arc');
    if (copy?.element.type === 'arc') {
      // Mirrored across the y axis, 0..60 becomes 120..180 with the start at 120.
      expect(copy.element.from).toBeCloseTo(120, 9);
      expect(copy.element.to).toBeCloseTo(180, 9);
      expect(copy.element.sweep).toBeCloseTo(60, 9);
      expect(copy.element.start.x).toBeCloseTo(-1.5, 9);
      expect(copy.element.end.x).toBeCloseTo(-3, 9);
    }
  });

  it('drops a mirror copy that coincides with the original', () => {
    const m = model(
      strokeArc(
        [arcOf(60, 120), { id: 'pair', type: 'repeat', of: ['arc'], n: 1, mirror: true, axis: 90 }],
        'pair',
      ),
    );
    expect(get(m, 'pair', 'repeat').copyCount).toBe(1);
  });
});

describe('erase resolution', () => {
  const shapes = [
    circle('ring', 0, 0, 3),
    circle('disc', 0, 2, 1),
    { id: 'tri', type: 'polygon', in: 'ring', n: 3 },
    { id: 'discs', type: 'repeat', of: ['disc'], n: 4 },
  ];

  it('lists the closed shapes of each erase layer with repeats expanded', () => {
    const m = model(
      build(shapes, [
        { stroke: ['ring'], width: 0.125 },
        { erase: ['discs', 'tri'] },
        { stroke: ['discs'], width: 0.125 },
        { erase: ['disc'] },
      ]),
    );
    expect(m.strokes.map((s) => s.index)).toEqual([0, 2]);
    expect(m.erases.map((e) => e.index)).toEqual([1, 3]);
    expect(m.erases[0]?.shapes.map((s) => s.kind)).toEqual([
      'circle',
      'circle',
      'circle',
      'circle',
      'polygon',
    ]);
    expect(m.erases[1]?.shapes).toHaveLength(1);
    expect(m.erases[0]?.shapes[0]).toEqual({ kind: 'circle', circle: { cx: 0, cy: 2, r: 1 } });
  });

  it('has no erase layers in a mark', () => {
    expect(
      model({
        version: 1,
        mode: 'mark',
        grid: { divisions: 4 },
        shapes: [circle('a', 0, 0, 3)],
        paint: [{ fill: 'a' }],
      } as SpecInput).erases,
    ).toEqual([]);
  });
});

describe('outline element resolution', () => {
  const lens = (dx = 0): ShapeInput[] => [circle('a', dx - 3, 0, 5), circle('b', dx + 3, 0, 5)];
  const lensThrough = (dx = 0): unknown[] => [
    { on: 'a', corner: [dx, 4] },
    { on: 'b', corner: [dx, -4] },
  ];
  const line = (id: string, from: [number, number], to: [number, number]): ShapeInput => ({
    id,
    type: 'line',
    from,
    to,
  });
  const outlineSpec = (
    shapes: ShapeInput[],
    through: unknown[],
    extra: ShapeInput[] = [],
    stroke = 'o',
  ): SpecInput =>
    build(
      [...shapes, { id: 'o', type: 'outline', through }, ...extra],
      [{ stroke: [stroke], width: 0.125 }],
      { grid: { divisions: 8 } },
    );
  const outlineOf = (shapes: ShapeInput[], through: unknown[], extra: ShapeInput[] = []) =>
    get(model(outlineSpec(shapes, through, extra)), 'o', 'outline');
  const messageOf = (shapes: ShapeInput[], through: unknown[]): string =>
    failure(outlineSpec(shapes, through)).find((e) => e.id === 'o')?.message ?? '';

  const stadium: ShapeInput[] = [
    circle('cl', -2, 0, 1),
    circle('cr', 2, 0, 1),
    line('bottom', [-2, -1], [2, -1]),
    line('top', [2, 1], [-2, 1]),
  ];
  const stadiumThrough = ['bottom', 'cr', 'top', 'cl'];
  const triangle: ShapeInput[] = [
    line('l1', [-3, -3], [3, -3]),
    line('l2', [3, -3], [0, 3]),
    line('l3', [0, 3], [-3, -3]),
  ];
  const turnsOf = (o: { joints: { turn: number }[] }): number[] => o.joints.map((j) => j.turn);

  it('resolves the pieces and joints of a stadium', () => {
    const o = outlineOf(stadium, stadiumThrough);
    expect(o.pieces.map((p) => p.kind)).toEqual(['line', 'arc', 'line', 'arc']);
    const [bottom, right, top, left] = o.pieces;
    expect(bottom?.start.x).toBeCloseTo(-2, 9);
    expect(bottom?.start.y).toBeCloseTo(-1, 9);
    expect(bottom?.end.x).toBeCloseTo(2, 9);
    expect(right?.end.x).toBeCloseTo(2, 9);
    expect(right?.end.y).toBeCloseTo(1, 9);
    expect(top?.end.x).toBeCloseTo(-2, 9);
    expect(left?.end.y).toBeCloseTo(-1, 9);
    expect(o.joints.map((j) => j.kind)).toEqual(['tangent', 'tangent', 'tangent', 'tangent']);
    for (const t of turnsOf(o)) {
      expect(t).toBeCloseTo(0, 6);
    }
    expect(o.area).toBeCloseTo(Math.PI + 8, 9);
  });

  it('resolves a triangle of lines with corner joints', () => {
    const o = outlineOf(triangle, ['l1', 'l2', 'l3']);
    expect(o.area).toBeCloseTo(18, 9);
    expect(o.joints.map((j) => j.kind)).toEqual(['corner', 'corner', 'corner']);
    expect(o.joints[0]?.at.x).toBeCloseTo(3, 9);
    expect(o.joints[0]?.at.y).toBeCloseTo(-3, 9);
  });

  it('resolves the lens of two circles from two corners', () => {
    const o = outlineOf(lens(), lensThrough());
    expect(o.pieces).toHaveLength(2);
    expect(o.joints[0]?.at.x).toBeCloseTo(0, 9);
    expect(o.joints[0]?.at.y).toBeCloseTo(4, 9);
    expect(o.joints[1]?.at.y).toBeCloseTo(-4, 9);
    expect(o.joints.map((j) => j.kind)).toEqual(['corner', 'corner']);
    const turn = (Math.atan2(24, 7) * 180) / Math.PI;
    for (const t of turnsOf(o)) {
      expect(t).toBeCloseTo(turn, 6);
    }
    expect(o.area).toBeCloseTo(50 * Math.acos(0.6) - 24, 9);
  });

  it('accepts a bare id and an { on } object alike', () => {
    const plain = outlineOf(stadium, ['bottom', 'cr', 'top', 'cl']);
    const objects = outlineOf(stadium, [
      { on: 'bottom' },
      { on: 'cr' },
      { on: 'top' },
      { on: 'cl' },
    ]);
    expect(objects.area).toBeCloseTo(plain.area, 12);
  });

  it('accepts the same line twice when its ranges are apart', () => {
    const notch: ShapeInput[] = [
      line('base', [0, 0], [6, 0]),
      line('right', [6, 0], [6, 4]),
      line('top', [6, 4], [0, 4]),
      line('inner_r', [4, 4], [4, 2]),
      line('floor', [4, 2], [2, 2]),
      line('inner_l', [2, 2], [2, 4]),
      line('left', [0, 4], [0, 0]),
    ];
    const through = ['base', 'right', 'top', 'inner_r', 'floor', 'inner_l', 'top', 'left'];
    const o = outlineOf(notch, through);
    expect(o.pieces).toHaveLength(8);
    expect(o.area).toBeCloseTo(20, 9);
  });

  describe('repeat', () => {
    const repeatSpec = (shapes: ShapeInput[], through: unknown[], rep: ShapeInput) =>
      outlineSpec(shapes, through, [{ id: 'rep', type: 'repeat', of: ['o'], ...rep }], 'rep');

    it('rotates into counter-clockwise copies with the same turns', () => {
      const m = model(repeatSpec(lens(4), lensThrough(4), { n: 3, center: [0, 0] }));
      const rep = get(m, 'rep', 'repeat');
      const original = get(m, 'o', 'outline');
      expect(rep.copyCount).toBe(3);
      expect(rep.copies).toHaveLength(2);
      rep.copies.forEach((c, k) => {
        const el = c.element;
        if (el.type !== 'outline') {
          throw new Error('expected an outline copy');
        }
        expect(el.area).toBeGreaterThan(0);
        expect(el.area).toBeCloseTo(original.area, 9);
        turnsOf(el).forEach((t, i) => {
          expect(t).toBeCloseTo(turnsOf(original)[i] as number, 6);
        });
        const a = (120 * (k + 1) * Math.PI) / 180;
        const start = original.pieces[0]?.start as Vec;
        expect(el.pieces[0]?.start.x).toBeCloseTo(start.x * Math.cos(a) - start.y * Math.sin(a), 9);
        expect(el.pieces[0]?.start.y).toBeCloseTo(start.x * Math.sin(a) + start.y * Math.cos(a), 9);
      });
    });

    it('mirrors into a counter-clockwise copy with the same turns', () => {
      const dShape = [circle('a', 0, 0, 5), line('ln', [3, 4], [3, -4])];
      const through = [
        { on: 'a', corner: [3, 4] },
        { on: 'ln', corner: [3, -4] },
      ];
      const m = model(repeatSpec(dShape, through, { n: 1, mirror: true, axis: 90 }));
      const rep = get(m, 'rep', 'repeat');
      const original = get(m, 'o', 'outline');
      expect(rep.copyCount).toBe(2);
      const el = rep.copies[0]?.element;
      if (el?.type !== 'outline') {
        throw new Error('expected an outline copy');
      }
      expect(el.area).toBeGreaterThan(0);
      expect(el.area).toBeCloseTo(original.area, 9);
      const sorted = (xs: number[]): number[] => [...xs].sort((x, y) => x - y);
      sorted(turnsOf(el)).forEach((t, i) => {
        expect(t).toBeCloseTo(sorted(turnsOf(original))[i] as number, 6);
      });
      expect(el.pieces[0]?.kind).toBe('line');
      expect(el.pieces[0]?.start.x).toBeCloseTo(-3, 9);
      expect(el.pieces[0]?.start.y).toBeCloseTo(-4, 9);
      expect(el.pieces[0]?.end.y).toBeCloseTo(4, 9);
      expect(el.pieces[1]?.start.y).toBeCloseTo(4, 9);
    });

    it('drops copies of a symmetric outline', () => {
      const turned = get(model(repeatSpec(lens(), lensThrough(), { n: 2 })), 'rep', 'repeat');
      expect(turned.copyCount).toBe(1);
      expect(turned.copies).toHaveLength(0);
      const flipped = get(
        model(repeatSpec(lens(), lensThrough(), { n: 1, mirror: true, axis: 90 })),
        'rep',
        'repeat',
      );
      expect(flipped.copyCount).toBe(1);
      expect(flipped.copies).toHaveLength(0);
    });
  });

  describe('paint', () => {
    it('gives a figure stroke and erase a closed chain', () => {
      const m = model(
        build(
          [...lens(), { id: 'o', type: 'outline', through: lensThrough() }],
          [{ stroke: ['o'], width: 0.125 }, { erase: ['o'] }],
          { grid: { divisions: 8 } },
        ),
      );
      const item = m.strokes[0]?.items[0];
      expect(item?.kind).toBe('chain');
      expect(item?.kind === 'chain' ? item.pieces : []).toHaveLength(2);
      expect(m.erases[0]?.shapes[0]?.kind).toBe('chain');
    });

    it('makes a chain leaf of a mark fill', () => {
      const m = model(
        build([...lens(), { id: 'o', type: 'outline', through: lensThrough() }], [{ fill: 'o' }], {
          mode: 'mark',
          grid: { divisions: 8 },
        }),
      );
      const region = m.fills[0]?.region;
      expect(region?.kind).toBe('chain');
      expect(region !== undefined && contains(region, { x: 0, y: 0 })).toBe(true);
      expect(region !== undefined && contains(region, { x: 4, y: 0 })).toBe(false);
    });
  });

  describe('errors', () => {
    it('same_curve: names both ids of neighbouring pieces on one curve', () => {
      const shapes = [circle('a', 0, 0, 3), circle('a2', 0, 0, 3)];
      const msg = messageOf(shapes, ['a', 'a2']);
      expect(msg).toContain('same curve');
      expect(msg).toContain('"a"');
      expect(msg).toContain('"a2"');
    });

    it('same_curve: the last piece wraps to the first', () => {
      const msg = messageOf(lens(), [
        { on: 'a', corner: [0, 4] },
        { on: 'b', corner: [0, -4] },
        'a',
      ]);
      expect(msg).toContain('same curve');
      expect(msg).toContain('through[2] "a" and through[0] "a"');
    });

    it('same_curve: the same id twice in a row', () => {
      const msg = messageOf(lens(), ['a', 'a', 'b']);
      expect(msg).toContain('same curve');
    });

    it('no_contact: states the gap between apart circles', () => {
      const msg = messageOf([circle('a', -3, 0, 1), circle('b', 3, 0, 1)], ['a', 'b']);
      expect(msg).toContain('do not touch');
      expect(msg).toContain('"a"');
      expect(msg).toContain('"b"');
      expect(msg).toContain('apart by 4');
    });

    it('no_contact: states the gap of nested circles', () => {
      const msg = messageOf([circle('a', 0, 0, 4), circle('b', 0.5, 0, 1)], ['a', 'b']);
      expect(msg).toContain('do not touch');
      expect(msg).toContain('gap of 2.5');
    });

    it('no_contact: states the gap between a circle and a line', () => {
      const msg = messageOf([circle('c', 0, 3, 1), line('ln', [-3, 0], [3, 0])], ['c', 'ln']);
      expect(msg).toContain('do not touch');
      expect(msg).toContain('"c"');
      expect(msg).toContain('"ln"');
      expect(msg).toContain('2 apart');
    });

    it('no_contact: says parallel for parallel lines', () => {
      const msg = messageOf([line('p', [-3, 0], [3, 0]), line('q', [-3, 1], [3, 1])], ['p', 'q']);
      expect(msg).toContain('do not touch');
      expect(msg).toContain('parallel');
    });

    it('corner_required: lists both crossings and both ways out', () => {
      const msg = messageOf(lens(), ['a', 'b']);
      expect(msg).toContain('needs a corner');
      expect(msg).toContain('"a"');
      expect(msg).toContain('"b"');
      expect(msg).toContain('(0.000, 4.000)');
      expect(msg).toContain('(0.000, -4.000)');
      expect(msg).toContain('corner');
      expect(msg).toContain('tangent_circle');
    });

    it('corner_not_needed: a corner on a tangent joint', () => {
      const msg = messageOf(stadium, [{ on: 'bottom', corner: [2, -1] }, 'cr', 'top', 'cl']);
      expect(msg).toContain('no choice to make');
      expect(msg).toContain('"bottom"');
      expect(msg).toContain('"cr"');
      expect(msg).toContain('remove corner');
    });

    it('corner_not_needed: a corner on a line-line joint', () => {
      const msg = messageOf(triangle, [{ on: 'l1', corner: [3, -3] }, 'l2', 'l3']);
      expect(msg).toContain('no choice to make');
      expect(msg).toContain('"l1"');
      expect(msg).toContain('"l2"');
      expect(msg).toContain('remove corner');
    });

    it('corner_tie: a corner equally close to both crossings', () => {
      const msg = messageOf(lens(), [
        { on: 'a', corner: [0, 0] },
        { on: 'b', corner: [0, -4] },
      ]);
      expect(msg).toContain('undecidable');
      expect(msg).toContain('"a"');
      expect(msg).toContain('"b"');
      expect(msg).toContain('(0.000, 4.000)');
      expect(msg).toContain('(0.000, -4.000)');
    });

    it('zero_length: two tangent circles meet in one point twice', () => {
      const msg = messageOf([circle('a', -1, 0, 1), circle('b', 1, 0, 1)], ['a', 'b']);
      expect(msg).toContain('no length');
      expect(msg).toContain('"a"');
      expect(msg).toContain('(0.000, 0.000)');
    });

    it('zero_length: two lines meet in one point twice', () => {
      const msg = messageOf([line('p', [-3, 0], [3, 0]), line('q', [0, -3], [0, 3])], ['p', 'q']);
      expect(msg).toContain('no length');
      expect(msg).toContain('"p"');
      expect(msg).toContain('(0.000, 0.000)');
    });

    it('direction_mismatch: externally tangent circles swap convex and concave', () => {
      const tri = [circle('a', -1, 0, 1), circle('b', 1, 0, 1), circle('c', 0, Math.sqrt(3), 1)];
      const msg = messageOf(tri, ['a', 'b', 'c']);
      expect(msg).toContain('backwards');
      expect(msg).toContain('externally tangent');
      expect(msg).toContain('"a"');
      expect(msg).toContain('"b"');
      expect(msg).toContain('swaps convex and concave');
      expect(msg).toContain('change concave');
    });

    it('direction_mismatch: a concave circle after a line against its direction', () => {
      const msg = messageOf(stadium, ['bottom', 'cr', 'top', { on: 'cl', concave: true }]);
      expect(msg).toContain('backwards');
      expect(msg).toContain('"top"');
      expect(msg).toContain('"cl"');
      expect(msg).toContain('Change concave');
    });

    it('self_intersection: crossing pieces', () => {
      const bowtie = [
        line('l1', [-2, -2], [2, 2]),
        line('l2', [2, 2], [2, -2]),
        line('l3', [2, -2], [-2, 2]),
        line('l4', [-2, 2], [-2, -2]),
      ];
      const msg = messageOf(bowtie, ['l1', 'l2', 'l3', 'l4']);
      expect(msg).toContain('touch or cross');
      expect(msg).toContain('"l1"');
      expect(msg).toContain('"l3"');
      expect(msg).toContain('(0.000, 0.000)');
      expect(msg).toContain('counter-clockwise');
    });

    it('self_intersection: a vertex touching a non-neighbouring piece', () => {
      const pinched = [
        line('e0', [0, 0], [6, 0]),
        line('e1', [6, 0], [6, 6]),
        line('e2', [6, 6], [3, 0]),
        line('e3', [3, 0], [0, 6]),
        line('e4', [0, 6], [0, 0]),
      ];
      const msg = messageOf(pinched, ['e0', 'e1', 'e2', 'e3', 'e4']);
      expect(msg).toContain('touch or cross');
      expect(msg).toContain('"e0"');
      expect(msg).toContain('"e2"');
      expect(msg).toContain('(3.000, 0.000)');
    });

    it('clockwise: asks for a counter-clockwise order', () => {
      const msg = messageOf(triangle, ['l1', 'l3', 'l2']);
      expect(msg).toContain('clockwise');
      expect(msg).toContain('counter-clockwise');
    });

    it('returns the earlier cause when there are two', () => {
      // A corner on a line-line joint and a clockwise order: the corner is checked first.
      const corner = messageOf(triangle, [{ on: 'l1', corner: [3, -3] }, 'l3', 'l2']);
      expect(corner).toContain('no choice to make');
      // A tie and a crossing outline: the joints are checked before the pieces.
      const tie = messageOf(lens(), [{ on: 'a', corner: [0, 0] }, 'b']);
      expect(tie).toContain('undecidable');
    });

    it('blocks the paint layer that uses a failed outline', () => {
      const errors = failure(outlineSpec(lens(), ['a', 'b']));
      expect(errors.map((e) => e.id)).toEqual(['o', 'paint[0]']);
      expect(errors[1]?.dependsOn).toBe('o');
    });
  });
});

describe('icon mode resolution', () => {
  const icon = (shapes: ShapeInput[], paint: unknown[]): SpecInput =>
    build(shapes, paint, { mode: 'icon', grid: { divisions: 12 } });
  const stroked = (shapes: ShapeInput[], extra: Record<string, unknown> = {}): SpecInput =>
    icon(shapes, [{ stroke: [shapes[shapes.length - 1]?.id], width: 1, ...extra }]);
  const rect = (id: string, corners: [number, number][], r?: number): ShapeInput => ({
    id,
    type: 'rect',
    corners,
    ...(r === undefined ? {} : { r }),
  });
  const oval = (id: string, rx: number, ry: number, more: ShapeInput = {}): ShapeInput => ({
    id,
    type: 'oval',
    center: [0, 0],
    rx,
    ry,
    ...more,
  });
  const polyline = (id: string, through: unknown[]): ShapeInput => ({
    id,
    type: 'polyline',
    through,
  });
  const messages = (input: SpecInput): string[] => failure(input).map((e) => e.message);

  it('keeps fill and stroke layers in paint order', () => {
    const m = model(
      icon(
        [
          rect('plate', [
            [-11, -11],
            [11, 11],
          ]),
          polyline('trend', [
            [-4, -3],
            [0, 1],
            [4, -1],
          ]),
          circle('dot', 4, -1, 1.5),
        ],
        [
          { fill: 'plate', color: '#f3f2f1' },
          { stroke: ['trend'], width: 1.5, color: '#107c41' },
          { fill: 'dot', color: '#107c41' },
        ],
      ),
    );
    expect(m.mode).toBe('icon');
    expect(m.canvasHalf).toBe(12);
    expect(m.margin).toBe(0);
    expect(m.fills.map((f) => f.index)).toEqual([0, 2]);
    expect(m.strokes.map((s) => s.index)).toEqual([1]);
    expect(m.erases).toEqual([]);
    expect(m.fills[0]?.region).toMatchObject({ kind: 'chain', source: { id: 'plate', copy: 0 } });
    expect(m.fills[1]?.region.kind).toBe('disc');
  });

  it('resolves a polyline to its vertices in order and strokes it as points', () => {
    const m = model(
      icon(
        [{ id: 'p', type: 'point', at: [0, 1] }, polyline('z', [[-4, -3], 'p', [4, -1], [8, 5]])],
        [{ stroke: ['z'], width: 1 }],
      ),
    );
    const z = get(m, 'z', 'polyline');
    expect(z.vertices).toEqual([
      { x: -4, y: -3 },
      { x: 0, y: 1 },
      { x: 4, y: -1 },
      { x: 8, y: 5 },
    ]);
    expect(m.strokes[0]?.items).toEqual([
      { id: 'z', copy: 0, via: 'z', kind: 'polyline', points: z.vertices },
    ]);
  });

  it('resolves a sharp rect from either pair of opposite corners', () => {
    const m = model(
      stroked([
        rect('s', [
          [3, -2],
          [-1, 4],
        ]),
      ]),
    );
    const s = get(m, 's', 'rect');
    expect(s.min).toEqual({ x: -1, y: -2 });
    expect(s.max).toEqual({ x: 3, y: 4 });
    expect(s.r).toBe(0);
    expect(s.pieces.map((p) => p.kind)).toEqual(['line', 'line', 'line', 'line']);
    expect(s.joints.every((j) => j.kind === 'corner')).toBe(true);
    expect(s.pieces[0]?.start).toEqual({ x: -1, y: -2 });
    expect(s.pieces[0]?.end).toEqual({ x: 3, y: -2 });
    expect(s.area).toBeCloseTo(24, 9);
    expect(m.strokes[0]?.items[0]?.kind).toBe('chain');
  });

  it('resolves a rounded rect starting at the left end of the bottom line', () => {
    const m = model(
      stroked([
        rect(
          'r',
          [
            [-11, -7],
            [11, 7],
          ],
          2,
        ),
      ]),
    );
    const r = get(m, 'r', 'rect');
    expect(r.r).toBe(2);
    expect(r.pieces.map((p) => p.kind)).toEqual([
      'line',
      'arc',
      'line',
      'arc',
      'line',
      'arc',
      'line',
      'arc',
    ]);
    expect(r.joints.every((j) => j.kind === 'tangent')).toBe(true);
    expect(r.pieces[0]?.start).toEqual({ x: -9, y: -7 });
    expect(r.area).toBeCloseTo(22 * 14 - (4 - Math.PI) * 4, 9);
  });

  it('resolves a pill when r is half the shorter side', () => {
    const m = model(
      stroked([
        rect(
          'pill',
          [
            [-4, -1],
            [4, 1],
          ],
          1,
        ),
      ]),
    );
    const pill = get(m, 'pill', 'rect');
    expect(pill.r).toBe(1);
    expect(pill.pieces.map((p) => p.kind)).toEqual(['line', 'arc', 'line', 'arc']);
    for (const p of pill.pieces) {
      if (p.kind === 'arc') {
        expect(p.sweep).toBeCloseTo(Math.PI, 12);
      }
    }
    expect(pill.area).toBeCloseTo(8 * 2 - (4 - Math.PI), 9);
  });

  it('resolves an oval with its arc radii and degrees of rotation', () => {
    const m = model(stroked([oval('o', 6, 4)]));
    const o = get(m, 'o', 'oval');
    const d = Math.hypot(6, 4);
    expect(o.center).toEqual({ x: 0, y: 0 });
    expect([o.rx, o.ry, o.rotate]).toEqual([6, 4, 0]);
    expect(o.end).toBeCloseTo((d * (d - 2)) / 12, 12);
    expect(o.side).toBeCloseTo((d * (d + 2)) / 8, 12);
    expect(o.pieces.map((p) => p.kind)).toEqual(['arc', 'arc', 'arc', 'arc']);
    expect(o.joints.every((j) => j.kind === 'tangent')).toBe(true);
    const first = o.pieces[0];
    if (first?.kind !== 'arc') {
      throw new Error('expected an arc');
    }
    // The first arc is the right end arc, starting at its lower joint.
    expect(first.circle.cx).toBeCloseTo(6 - o.end, 12);
    expect(first.circle.cy).toBeCloseTo(0, 12);
    expect(first.start.y).toBeLessThan(0);
    expect(o.area).toBeGreaterThan(0);
    expect(m.strokes[0]?.items[0]?.kind).toBe('chain');
  });

  it('turns an oval counter-clockwise by rotate degrees', () => {
    const m = model(stroked([oval('o', 6, 4, { center: [1, 2], rotate: 90 })]));
    const o = get(m, 'o', 'oval');
    expect(o.rotate).toBe(90);
    const first = o.pieces[0];
    if (first?.kind !== 'arc') {
      throw new Error('expected an arc');
    }
    expect(first.circle.cx).toBeCloseTo(1, 12);
    expect(first.circle.cy).toBeCloseTo(2 + 6 - o.end, 12);
    expect(first.circle.r).toBeCloseTo(o.end, 12);
  });

  it('starts a taller oval at its top end arc', () => {
    const o = get(model(stroked([oval('o', 4, 6)])), 'o', 'oval');
    const first = o.pieces[0];
    if (first?.kind !== 'arc') {
      throw new Error('expected an arc');
    }
    expect(first.circle.cx).toBeCloseTo(0, 12);
    expect(first.circle.cy).toBeCloseTo(6 - o.end, 12);
  });

  it('rejects a polyline segment of zero length', () => {
    const [message] = messages(
      stroked([
        polyline('z', [
          [0, 0],
          [1, 1],
          [1, 1],
        ]),
      ]),
    );
    expect(message).toContain('polyline segment has no length');
    expect(message).toContain('through[1] (1, 1) and through[2] (1, 1)');
  });

  it('rejects a rect narrower or lower than 0.05', () => {
    const [message] = messages(
      stroked([
        rect('s', [
          [0, 0],
          [0.04, 2],
        ]),
      ]),
    );
    expect(message).toContain('rect is too small (received: width 0.04, height 2');
    expect(
      messages(
        stroked([
          rect('s', [
            [0, 0],
            [2, 0.04],
          ]),
        ]),
      )[0],
    ).toContain('rect is too small');
  });

  it('rejects a corner radius above half the shorter side', () => {
    const [message] = messages(
      stroked([
        rect(
          's',
          [
            [-4, -1],
            [4, 1],
          ],
          1.000001,
        ),
      ]),
    );
    expect(message).toContain('rect corner radius is too large');
    expect(message).toContain('allowed: up to 1,');
  });

  it('accepts a corner radius within 1e-9 above half the shorter side as a pill', () => {
    const pill = get(
      model(
        stroked([
          rect(
            'pill',
            [
              [-4, -1],
              [4, 1],
            ],
            1 + 5e-10,
          ),
        ]),
      ),
      'pill',
      'rect',
    );
    expect(pill.pieces).toHaveLength(4);
  });

  it('rejects a square whose corner radius is half its side, suggesting a circle', () => {
    const [message] = messages(
      stroked([
        rect(
          's',
          [
            [-2, -2],
            [2, 2],
          ],
          2,
        ),
      ]),
    );
    expect(message).toContain('rect is a circle');
    expect(message).toContain('Use a circle');
  });

  it('rejects an oval whose radii differ by less than 0.05, suggesting a circle', () => {
    const [message] = messages(stroked([oval('o', 3, 2.96)]));
    expect(message).toContain('oval is a circle');
    expect(message).toContain('Use a circle');
    expect(model(stroked([oval('o', 3, 2.9)])).byId.has('o')).toBe(true);
  });

  it('rejects an oval more elongated than 4 to 1', () => {
    const [message] = messages(stroked([oval('o', 2, 8.5)]));
    expect(message).toContain('oval is too elongated');
    expect(message).toContain('ratio 4.25');
    expect(model(stroked([oval('o', 2, 8)])).byId.has('o')).toBe(true);
  });

  it('copies a rect and an oval as outlines', () => {
    const m = model(
      stroked([
        rect(
          's',
          [
            [2, -1],
            [6, 1],
          ],
          0.5,
        ),
        oval('o', 2, 1, { center: [0, 4] }),
        { id: 'rep', type: 'repeat', of: ['s', 'o'], n: 4 },
      ]),
    );
    const rep = get(m, 'rep', 'repeat');
    const s = get(m, 's', 'rect');
    expect(rep.copies).toHaveLength(6);
    for (const c of rep.copies) {
      expect(c.element.type).toBe('outline');
      expect(Object.keys(c.element).sort()).toEqual(['area', 'id', 'joints', 'pieces', 'type']);
    }
    const quarter = rep.copies.find((c) => c.of === 's' && c.copy === 1)?.element;
    if (quarter?.type !== 'outline') {
      throw new Error('expected an outline');
    }
    expect(quarter.area).toBeCloseTo(s.area, 9);
    expect(quarter.pieces[0]?.start.x).toBeCloseTo(1, 9);
    expect(quarter.pieces[0]?.start.y).toBeCloseTo(2.5, 9);
    const items = m.strokes[0]?.items ?? [];
    expect(items.map((i) => `${i.id}:${i.copy}:${i.kind}`)).toEqual([
      's:0:chain',
      's:1:chain',
      's:2:chain',
      's:3:chain',
      'o:0:chain',
      'o:1:chain',
      'o:2:chain',
      'o:3:chain',
    ]);
  });

  it('drops a rect copy that lands on the original', () => {
    const rep = get(
      model(
        stroked([
          rect(
            's',
            [
              [-2, -2],
              [2, 2],
            ],
            1,
          ),
          { id: 'rep', type: 'repeat', of: ['s'], n: 4, mirror: true },
        ]),
      ),
      'rep',
      'repeat',
    );
    expect(rep.copies).toHaveLength(0);
    expect(rep.copyCount).toBe(1);
  });

  it('copies a polyline vertex by vertex and compares vertices in order', () => {
    const m = model(
      stroked([
        polyline('z', [
          [1, 0],
          [2, 1],
          [3, 0],
        ]),
        { id: 'rep', type: 'repeat', of: ['z'], n: 4 },
      ]),
    );
    const rep = get(m, 'rep', 'repeat');
    expect(rep.copies).toHaveLength(3);
    const first = rep.copies[0]?.element;
    if (first?.type !== 'polyline') {
      throw new Error('expected a polyline');
    }
    expect(first.vertices[0]?.x).toBeCloseTo(0, 9);
    expect(first.vertices[0]?.y).toBeCloseTo(1, 9);
    expect(first.vertices[1]?.x).toBeCloseTo(-1, 9);
    expect(first.vertices[1]?.y).toBeCloseTo(2, 9);
    expect(m.strokes[0]?.items.map((i) => i.kind)).toEqual([
      'polyline',
      'polyline',
      'polyline',
      'polyline',
    ]);

    // A mirror of a symmetric polyline lists the vertices in reverse, so it is a separate copy.
    const mirrored = get(
      model(
        stroked([
          polyline('v', [
            [-1, 1],
            [0, 2],
            [1, 1],
          ]),
          { id: 'rep', type: 'repeat', of: ['v'], n: 1, mirror: true },
        ]),
      ),
      'rep',
      'repeat',
    );
    expect(mirrored.copyCount).toBe(2);
    const copy = mirrored.copies[0]?.element;
    if (copy?.type !== 'polyline') {
      throw new Error('expected a polyline');
    }
    expect(copy.vertices.map((v) => [v.x, v.y].map((x) => Math.round(x * 1e9) / 1e9))).toEqual([
      [1, 1],
      [0, 2],
      [-1, 1],
    ]);
  });

  it('uses a rect and an oval as region leaves', () => {
    const m = model(
      icon(
        [
          circle('disc', 0, 0, 10),
          rect(
            'hole',
            [
              [-3, -2],
              [3, 2],
            ],
            1,
          ),
          oval('egg', 2, 1, { center: [0, 6] }),
        ],
        [{ fill: { subtract: ['disc', 'hole', 'egg'] }, color: '#000000' }],
      ),
    );
    const region = m.fills[0]?.region;
    if (region === undefined) {
      throw new Error('expected a fill');
    }
    expect(contains(region, { x: 0, y: 0 })).toBe(false);
    expect(contains(region, { x: 0, y: 6 })).toBe(false);
    expect(contains(region, { x: 0, y: -6 })).toBe(true);
    expect(contains(region, { x: 4, y: 0 })).toBe(true);
  });

  it('erases with a rect and an oval in a figure', () => {
    const m = model(
      build(
        [
          circle('c', 0, 0, 3),
          rect('s', [
            [-1, -1],
            [1, 1],
          ]),
          oval('o', 1, 0.5),
        ],
        [{ stroke: ['c'], width: 0.125 }, { erase: ['s', 'o'] }],
      ),
    );
    const s = get(m, 's', 'rect');
    expect(m.erases[0]?.shapes).toEqual([
      { kind: 'chain', pieces: s.pieces },
      { kind: 'chain', pieces: get(m, 'o', 'oval').pieces },
    ]);
  });

  it('defaults a stroke to round caps, round joins and no dash', () => {
    const [layer] = model(
      stroked([
        polyline('z', [
          [0, 0],
          [1, 1],
          [2, 0],
        ]),
      ]),
    ).strokes;
    expect(layer?.cap).toBe('round');
    expect(layer?.join).toBe('round');
    expect(layer?.dash).toBeNull();
  });

  it('carries explicit cap, join and dash', () => {
    const [layer] = model(
      stroked(
        [
          polyline('z', [
            [0, 0],
            [1, 1],
            [2, 0],
          ]),
        ],
        { cap: 'butt', join: 'miter', dash: [2, 1] },
      ),
    ).strokes;
    expect(layer?.cap).toBe('butt');
    expect(layer?.join).toBe('miter');
    expect(layer?.dash).toEqual([2, 1]);
  });

  it('carries cap, join and dash in a figure too', () => {
    const m = model(
      build(
        [circle('c', 0, 0, 2)],
        [{ stroke: ['c'], width: 0.125, cap: 'square', join: 'bevel', dash: [0.5, 0.25] }],
      ),
    );
    expect(m.mode).toBe('figure');
    const [layer] = m.strokes;
    expect([layer?.cap, layer?.join, layer?.dash]).toEqual(['square', 'bevel', [0.5, 0.25]]);
    const [plain] = model(build([circle('c', 0, 0, 2)])).strokes;
    expect([plain?.cap, plain?.join, plain?.dash]).toEqual(['round', 'round', null]);
  });
});

describe('arc on an oval', () => {
  // rx 3, ry 2: chord length d = sqrt(13), joints at ((d + 1) / 2, +-(d - 1) / 2).
  const d = Math.sqrt(13);
  const jx = (d + 1) / 2;
  const jy = (d - 1) / 2;
  const oval = { id: 'o', type: 'oval', center: [0, 0], rx: 3, ry: 2 };
  const arcOn = (from: number, to: number): ShapeInput => ({
    id: 'a',
    type: 'arc',
    on: 'o',
    from,
    to,
  });
  const icon = (shapes: ShapeInput[], paint: unknown[]): SpecInput =>
    build(shapes, paint, { mode: 'icon', grid: { divisions: 12 } });
  const stroked = (shapes: ShapeInput[], ids: string[]): SpecInput =>
    icon(shapes, [{ stroke: ids, width: 1 }]);
  const near = (p: Vec | undefined, x: number, y: number): void => {
    expect(distance(p ?? { x: Number.NaN, y: 0 }, { x, y })).toBeLessThanOrEqual(1e-9);
  };

  it('ends on the oval where the rays at from and to leave it', () => {
    const m = model(stroked([oval, arcOn(0, 180)], ['a']));
    const el = get(m, 'a', 'oval_arc');
    expect(el.on).toBe('o');
    expect(el.pieces).toHaveLength(3);
    near(el.start, 3, 0);
    near(el.end, -3, 0);
    near(el.pieces[0]?.end, jx, jy);
    near(el.pieces[1]?.end, -jx, jy);
    expect([el.from, el.to]).toEqual([0, 180]);
  });

  it('reports the directions of the ends in [0, 360)', () => {
    const el = get(model(stroked([oval, arcOn(-90, 450)], ['a'])), 'a', 'oval_arc');
    near(el.start, 0, -2);
    near(el.end, 0, 2);
    expect(el.from).toBeCloseTo(270, 9);
    expect(el.to).toBeCloseTo(90, 9);
  });

  it('fails when the ends are a whole number of turns apart', () => {
    const [error] = failure(stroked([oval, arcOn(0, 720)], ['a']));
    expect(error?.id).toBe('a');
    expect(error?.message).toContain('arc ends coincide');
    expect(error?.message).toContain('Use the oval itself.');
    expect(failure(stroked([oval, arcOn(720, 0)], ['a']))[0]?.message).toContain(
      'arc ends coincide',
    );
  });

  it('draws as an open chain item while the oval stays closed', () => {
    const m = model(stroked([oval, arcOn(0, 90)], ['o', 'a']));
    const items = m.strokes[0]?.items ?? [];
    expect(items.map((i) => (i.kind === 'chain' ? [i.id, i.closed] : null))).toEqual([
      ['o', true],
      ['a', false],
    ]);
  });

  it('turns with a rotating repeat', () => {
    const m = model(
      stroked([oval, arcOn(0, 90), { id: 'rep', type: 'repeat', of: ['a'], n: 2 }], ['rep']),
    );
    const rep = get(m, 'rep', 'repeat');
    expect(rep.copyCount).toBe(2);
    const el = rep.copies[0]?.element;
    if (el?.type !== 'oval_arc') {
      throw new Error('expected an oval_arc copy');
    }
    near(el.center, 0, 0);
    near(el.start, -3, 0);
    near(el.end, 0, -2);
    near(el.pieces[0]?.end, -jx, -jy);
    expect([el.from, el.to]).toEqual([180, 270]);
    const item = m.strokes[0]?.items[1];
    expect(item?.kind === 'chain' && item.closed).toBe(false);
  });

  it('swaps the ends and reverses the pieces under a mirroring repeat', () => {
    const m = model(
      stroked(
        [oval, arcOn(0, 90), { id: 'rep', type: 'repeat', of: ['a'], n: 1, mirror: true }],
        ['rep'],
      ),
    );
    const el = get(m, 'rep', 'repeat').copies[0]?.element;
    if (el?.type !== 'oval_arc') {
      throw new Error('expected an oval_arc copy');
    }
    expect(el.pieces).toHaveLength(2);
    near(el.start, 0, 2);
    near(el.end, -3, 0);
    near(el.pieces[0]?.end, -jx, jy);
    expect(el.pieces.every((p) => p.kind === 'arc' && p.ccw)).toBe(true);
    expect([el.from, el.to]).toEqual([90, 180]);
  });

  it('drops a mirrored copy only when it lands on the original', () => {
    const m = model(
      stroked(
        [oval, arcOn(0, 180), { id: 'rep', type: 'repeat', of: ['a'], n: 1, mirror: true }],
        ['rep'],
      ),
    );
    expect(get(m, 'rep', 'repeat').copyCount).toBe(1);
    const half = model(
      stroked(
        [oval, arcOn(90, 270), { id: 'rep', type: 'repeat', of: ['a'], n: 1, mirror: true }],
        ['rep'],
      ),
    );
    expect(get(half, 'rep', 'repeat').copyCount).toBe(2);
  });
});
