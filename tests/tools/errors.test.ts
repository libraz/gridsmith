import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArrangementInvariantError, arrange } from '../../src/geom/arrangement.js';
import { EXAMPLES } from '../../src/guide/examples.js';
import { createServer } from '../../src/server.js';

vi.mock('../../src/geom/arrangement.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/geom/arrangement.js')>();
  return { ...actual, arrange: vi.fn(actual.arrange) };
});

type Block = { type: string; text?: string };
type ToolResult = { isError?: boolean; content: Block[] };
type Obj = Record<string, unknown>;
type Path = (string | number)[];
type Tool = 'gridsmith_guide' | 'gridsmith_render' | 'gridsmith_export';

let client: Client;
let closeAll: () => Promise<void>;
let workDir: string;

beforeEach(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  client = new Client({ name: 'gridsmith-test', version: '0.0.0' });
  await client.connect(clientTransport);
  closeAll = async () => {
    await client.close();
    await server.close();
  };
  workDir = await mkdtemp(join(tmpdir(), 'gridsmith-errors-'));
});

afterEach(async () => {
  await closeAll();
  await rm(workDir, { recursive: true, force: true });
});

const call = async (name: Tool, args: Obj): Promise<ToolResult> =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

const textOf = (result: ToolResult): string => result.content[0]?.text ?? '';
type Geometry = {
  id: string;
  cx: number;
  cy: number;
  contacts: { kind: string }[];
};
type Report = {
  summary: string;
  geometry: Geometry[];
  violations: { rule: string; target: string }[];
  exceptions_applied: unknown[];
  stats: { strokes: number }[];
  exportable: boolean;
};
const reportOf = (result: ToolResult) => JSON.parse(textOf(result)) as Report;

// Spec builders and mutators

const setAt = (root: Obj, path: Path, value: unknown): Obj => {
  const out = structuredClone(root);
  let node = out as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) {
    node = node[key] as Record<string | number, unknown>;
  }
  node[path[path.length - 1] as string | number] = value;
  return out;
};

const omitAt = (root: Obj, path: Path): Obj => {
  const out = structuredClone(root);
  let node = out as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) {
    node = node[key] as Record<string | number, unknown>;
  }
  delete node[path[path.length - 1] as string | number];
  return out;
};

const circle = (id: string, r: unknown = 3, center?: unknown): Obj =>
  center === undefined ? { id, type: 'circle', r } : { id, type: 'circle', center, r };

// A figure with shapes a (r 3) and b (r 2 at [1, 0]) stroked, plus extra shapes.
const fig = (extra: Obj[] = [], stroke: string[] = ['a', 'b'], width: unknown = 0.125): Obj => ({
  version: 1,
  mode: 'figure',
  grid: { divisions: 4 },
  shapes: [circle('a'), circle('b', 2, [1, 0]), ...extra],
  paint: [{ stroke, width }],
});

// A mark with discs a (R) and b (r 3 at [1, 1]), a line l, plus extra shapes.
const mk = (fill: unknown = { subtract: ['a', 'b'] }, extra: Obj[] = []): Obj => ({
  version: 1,
  mode: 'mark',
  grid: { divisions: 4 },
  shapes: [
    circle('a', 'R'),
    circle('b', 3, [1, 1]),
    { id: 'l', type: 'line', from: [0, -4], to: [0, 4] },
    ...extra,
  ],
  paint: [{ fill }],
});

const renderArgs = (spec: unknown): Obj => ({ spec, views: ['final'] });

const rejected = async (tool: Tool, args: Obj, ...fragments: string[]): Promise<string> => {
  const result = await call(tool, args);
  expect(result.isError, textOf(result)).toBe(true);
  const text = textOf(result);
  expect(text.startsWith(`${tool}: `)).toBe(true);
  for (const fragment of fragments) {
    expect(text).toContain(fragment);
  }
  return text;
};

const accepted = async (spec: unknown, views: string[] = ['final']) => {
  const result = await call('gridsmith_render', { spec, views });
  expect(result.isError, textOf(result)).toBeFalsy();
  return reportOf(result);
};

const violationRules = (report: Report, target?: string): string[] =>
  report.violations.filter((v) => target === undefined || v.target === target).map((v) => v.rule);

const REJECT_SPEC: [string, Obj, string][] = [];
const rejectSpec = (label: string, spec: Obj, path: string) => {
  REJECT_SPEC.push([label, spec, path]);
};

// Zero and negative lengths, widths
rejectSpec('r: 0', setAt(fig(), ['shapes', 0, 'r'], 0), 'spec.shapes[0].r');
rejectSpec('r: -0', setAt(fig(), ['shapes', 0, 'r'], -0), 'spec.shapes[0].r');
rejectSpec('r: -1', setAt(fig(), ['shapes', 0, 'r'], -1), 'spec.shapes[0].r');
rejectSpec('width: 0', fig([], ['a'], 0), 'spec.paint[0].width');
rejectSpec('width: 0.004', fig([], ['a'], 0.004), 'spec.paint[0].width');
rejectSpec('width: 8.1', fig([], ['a'], 8.1), 'spec.paint[0].width');

// Outside the size range, non-finite, angle size
rejectSpec('r: 0.049', setAt(fig(), ['shapes', 0, 'r'], 0.049), 'spec.shapes[0].r');
rejectSpec('r: 64.1', setAt(fig(), ['shapes', 0, 'r'], 64.1), 'spec.shapes[0].r');
rejectSpec(
  'coordinate 65',
  setAt(fig(), ['shapes', 1, 'center'], [65, 0]),
  'spec.shapes[1].center',
);
rejectSpec(
  'r: 1e999',
  setAt(fig(), ['shapes', 0, 'r'], Number.POSITIVE_INFINITY),
  'spec.shapes[0].r',
);
rejectSpec(
  'angle: 1e999',
  fig([circle('p', 0.25, { on: 'a', angle: Number.POSITIVE_INFINITY })], ['a', 'p']),
  'spec.shapes[2].center',
);
rejectSpec(
  'angle: 3601',
  fig([circle('p', 0.25, { on: 'a', angle: 3601 })], ['a', 'p']),
  'spec.shapes[2].center',
);
rejectSpec(
  'rotate: 1e18',
  fig([{ id: 'pg', type: 'polygon', in: 'a', n: 6, rotate: 1e18 }], ['a', 'pg']),
  'spec.shapes[2].rotate',
);

// null
rejectSpec('r: null', setAt(fig(), ['shapes', 0, 'r'], null), 'spec.shapes[0].r');
rejectSpec('exceptions: null', setAt(fig(), ['exceptions'], null), 'spec.exceptions');

// Missing required keys
rejectSpec('mode missing', omitAt(fig(), ['mode']), 'spec.mode');
rejectSpec('paint missing', omitAt(fig(), ['paint']), 'spec.paint');
rejectSpec('shapes missing', omitAt(fig(), ['shapes']), 'spec.shapes');
rejectSpec('grid missing', omitAt(fig(), ['grid']), 'spec.grid');
rejectSpec('grid.divisions missing', setAt(fig(), ['grid'], {}), 'spec.grid.divisions');
rejectSpec(
  'tangent_circle.near missing',
  mk('a', [{ id: 't', type: 'tangent_circle', r: 1, to: ['a', 'l'] }]),
  'spec.shapes[3].near',
);
rejectSpec('circle.r missing', omitAt(fig(), ['shapes', 0, 'r']), 'spec.shapes[0].r');

// Null inside arrays
rejectSpec('shapes: [null]', setAt(fig(), ['shapes'], [null]), 'spec.shapes[0]');
rejectSpec(
  'of: ["a", null]',
  fig([{ id: 'rp', type: 'repeat', of: ['a', null], n: 2 }], ['rp']),
  'spec.shapes[2].of[1]',
);

// Empty
rejectSpec('shapes: []', setAt(fig(), ['shapes'], []), 'spec.shapes');
rejectSpec('paint: []', setAt(fig(), ['paint'], []), 'spec.paint');
rejectSpec('stroke: []', fig([], []), 'spec.paint[0].stroke');
rejectSpec('union: []', mk({ union: [] }), 'spec.paint[0].fill');
rejectSpec(
  'of: []',
  fig([{ id: 'rp', type: 'repeat', of: [], n: 2 }], ['rp']),
  'spec.shapes[2].of',
);
rejectSpec('concept: ""', setAt(fig(), ['concept'], ''), 'spec.concept');
rejectSpec(
  'reason: ""',
  setAt(fig(), ['exceptions'], [{ rule: 'off_grid', target: 'a', reason: '' }]),
  'spec.exceptions[0].reason',
);

// Length one where two are needed
rejectSpec('union: ["a"]', mk({ union: ['a'] }), 'spec.paint[0].fill');
rejectSpec('subtract: ["a"]', mk({ subtract: ['a'] }), 'spec.paint[0].fill');

// Nesting of intersect points: three levels inside near are rejected
const nested = (levels: number): unknown => {
  let point: unknown = [0, 3];
  for (let i = 0; i < levels; i++) {
    point = { intersect: ['a', 'b'], near: point };
  }
  return point;
};
rejectSpec(
  'near nested three deep',
  fig([{ id: 'p', type: 'point', at: nested(4) }], ['a']),
  'spec.shapes[2].at.near.near.near',
);

// Outside the range
rejectSpec('divisions: 5', setAt(fig(), ['grid', 'divisions'], 5), 'spec.grid.divisions');
rejectSpec('margin: 5', setAt(fig(), ['grid', 'margin'], 5), 'spec.grid.margin');
for (const n of [2, 37]) {
  rejectSpec(
    `polygon.n: ${n}`,
    fig([{ id: 'pg', type: 'polygon', in: 'a', n }], ['pg']),
    'spec.shapes[2].n',
  );
}
rejectSpec(
  'repeat.n: 1 without mirror',
  fig([{ id: 'rp', type: 'repeat', of: ['a'], n: 1 }], ['rp']),
  'spec.shapes[2].n',
);
rejectSpec(
  'repeat.n: 37',
  fig([{ id: 'rp', type: 'repeat', of: ['a'], n: 37 }], ['rp']),
  'spec.shapes[2].n',
);
rejectSpec(
  'shapes: 257',
  setAt(
    fig(),
    ['shapes'],
    Array.from({ length: 257 }, (_, i) => circle(`c${i}`, 3)),
  ),
  'spec.shapes',
);
rejectSpec(
  'paint: 17',
  setAt(
    fig(),
    ['paint'],
    Array.from({ length: 17 }, () => ({ stroke: ['a'], width: 0.125 })),
  ),
  'spec.paint',
);
rejectSpec(
  'exceptions: 17',
  setAt(
    fig(),
    ['exceptions'],
    Array.from({ length: 17 }, (_, i) => ({
      rule: 'off_grid',
      target: i < 1 ? 'a' : 'b',
      reason: `r${i}`,
    })),
  ),
  'spec.exceptions',
);
const deepRegion = (ops: number): unknown => {
  let region: unknown = 'b';
  for (let i = 0; i < ops; i++) {
    region = { union: ['a', region] };
  }
  return region;
};
rejectSpec('region depth 9', mk(deepRegion(9)), 'spec.paint[0].fill');
rejectSpec(
  'union with 17 terms',
  mk({ union: Array.from({ length: 17 }, () => 'a') }),
  'spec.paint[0].fill',
);
rejectSpec(
  'of: 9 entries',
  fig(
    [
      ...Array.from({ length: 7 }, (_, i) => circle(`x${i}`, 1)),
      {
        id: 'rp',
        type: 'repeat',
        of: ['a', 'b', ...Array.from({ length: 7 }, (_, i) => `x${i}`)],
        n: 2,
      },
    ],
    ['rp'],
  ),
  'spec.shapes[9].of',
);
for (const count of [2, 33]) {
  rejectSpec(
    `through: ${count} points`,
    fig(
      [
        {
          id: 'ps',
          type: 'points',
          through: Array.from({ length: count }, (_, i) => [i % 4, Math.floor(i / 4) % 5]),
        },
      ],
      ['ps'],
    ),
    'spec.shapes[2].through',
  );
}
rejectSpec('concept: 401 characters', setAt(fig(), ['concept'], 'x'.repeat(401)), 'spec.concept');
rejectSpec(
  'concept: 401 UTF-16 units with a surrogate pair',
  setAt(fig(), ['concept'], `${'x'.repeat(399)}\u{1F600}`),
  'spec.concept',
);
rejectSpec(
  'step: 0',
  fig([{ id: 'pg', type: 'polygon', in: 'a', n: 6, step: 0 }], ['pg']),
  'spec.shapes[2].step',
);
rejectSpec(
  'step at n/2',
  fig([{ id: 'pg', type: 'polygon', in: 'a', n: 6, step: 3 }], ['pg']),
  'spec.shapes[2].step',
);

// Integer limits and kinds
for (const n of [2147483648, 4294967296, 5.5]) {
  rejectSpec(
    `polygon.n: ${n}`,
    fig([{ id: 'pg', type: 'polygon', in: 'a', n }], ['pg']),
    'spec.shapes[2].n',
  );
}
rejectSpec('margin: 1.5', setAt(fig(), ['grid', 'margin'], 1.5), 'spec.grid.margin');
rejectSpec('r: true', setAt(fig(), ['shapes', 0, 'r'], true), 'spec.shapes[0].r');
rejectSpec(
  'n: "6"',
  fig([{ id: 'pg', type: 'polygon', in: 'a', n: '6' }], ['pg']),
  'spec.shapes[2].n',
);
rejectSpec('version: "1"', setAt(fig(), ['version'], '1'), 'spec.version');

// Unknown values
rejectSpec(
  'type: ellipse',
  fig([{ id: 'e', type: 'ellipse', r: 1 }], ['a']),
  'spec.shapes[2].type',
);
rejectSpec('mode: logo', setAt(fig(), ['mode'], 'logo'), 'spec.mode');
rejectSpec(
  'rule: foo',
  setAt(fig(), ['exceptions'], [{ rule: 'foo', target: 'a', reason: 'x' }]),
  'spec.exceptions[0].rule',
);
rejectSpec(
  'rule: unused_exception',
  setAt(fig(), ['exceptions'], [{ rule: 'unused_exception', target: 'a', reason: 'x' }]),
  'spec.exceptions[0].rule',
);
rejectSpec('version: 2', setAt(fig(), ['version'], 2), 'spec.version');
for (const expression of ['R/pi', '2.5', 'R/17', 'R + 1', `R${'*2'.repeat(32)}`]) {
  rejectSpec(
    `length expression ${expression.length > 20 ? 'of 65 characters' : expression}`,
    setAt(fig(), ['shapes', 0, 'r'], expression),
    'spec.shapes[0].r',
  );
}
for (const color of ['red', '#FFF']) {
  rejectSpec(`color: ${color}`, setAt(fig(), ['paint', 0, 'color'], color), 'spec.paint[0]');
}

// Duplicates
rejectSpec('duplicate id', fig([circle('a', 1)], ['a']), 'spec.shapes[2].id');
rejectSpec(
  'duplicate exception',
  setAt(
    fig(),
    ['exceptions'],
    [
      { rule: 'off_grid', target: 'a', reason: 'x' },
      { rule: 'off_grid', target: 'a', reason: 'y' },
    ],
  ),
  'spec.exceptions[1].target',
);
rejectSpec(
  'to: ["a", "a"]',
  fig([{ id: 't', type: 'tangent_circle', r: 1, to: ['a', 'a'], near: [0, 0] }], ['a']),
  'spec.shapes[2].to[1]',
);
rejectSpec(
  'intersect: ["a", "a"]',
  fig([{ id: 'p', type: 'point', at: { intersect: ['a', 'a'], near: [0, 0] } }], ['a']),
  'spec.shapes[2].at.intersect[1]',
);
rejectSpec('stroke: ["a", "a"]', fig([], ['a', 'a']), 'spec.paint[0].stroke[1]');
rejectSpec(
  'of: ["a", "a"]',
  fig([{ id: 'rp', type: 'repeat', of: ['a', 'a'], n: 2 }], ['rp']),
  'spec.shapes[2].of[1]',
);

// Reserved words and character classes
for (const id of ['spec', '円', 'A']) {
  rejectSpec(`id: ${id}`, setAt(fig(), ['shapes', 0, 'id'], id), 'spec.shapes[0].id');
}

// Mode and layer mismatch
rejectSpec(
  'stroke layer in a mark',
  setAt(mk(), ['paint'], [{ stroke: ['a'], width: 0.125 }]),
  'spec.paint[0]',
);
rejectSpec('fill layer in a figure', setAt(fig(), ['paint'], [{ fill: 'a' }]), 'spec.paint[0]');

// Reference problems
rejectSpec('unknown id in stroke', fig([], ['a', 'zzz']), 'spec.paint[0].stroke[1]');
rejectSpec(
  'forward reference',
  fig([{ id: 'late', type: 'circle', center: 'later', r: 1 }, circle('later', 1)], ['a']),
  'spec.shapes[2].center',
);
rejectSpec(
  'repeat of a repeat',
  fig(
    [
      { id: 'r1', type: 'repeat', of: ['a'], n: 2 },
      { id: 'r2', type: 'repeat', of: ['r1'], n: 2 },
    ],
    ['r2'],
  ),
  'spec.shapes[3].of[0]',
);
rejectSpec(
  'repeat of a point',
  fig(
    [
      { id: 'pt', type: 'point', at: [1, 1] },
      { id: 'rp', type: 'repeat', of: ['pt'], n: 2 },
    ],
    ['rp'],
  ),
  'spec.shapes[3].of[0]',
);
rejectSpec(
  'polygon in a line',
  fig(
    [
      { id: 'ln', type: 'line', from: [0, 0], to: [1, 1] },
      { id: 'pg', type: 'polygon', in: 'ln', n: 5 },
    ],
    ['pg'],
  ),
  'spec.shapes[3].in',
);
rejectSpec(
  'on a line',
  fig(
    [
      { id: 'ln', type: 'line', from: [0, 0], to: [1, 1] },
      circle('p', 0.25, { on: 'ln', angle: 0 }),
    ],
    ['p'],
  ),
  'spec.shapes[3].center.on',
);
rejectSpec(
  '.r on a line',
  fig([{ id: 'ln', type: 'line', from: [0, 0], to: [1, 1] }, circle('q', 'ln.r')], ['q']),
  'spec.shapes[3].r',
);
rejectSpec(
  'half on a circle',
  mk({ intersect: ['a', { half: 'b', toward: [0, 0] }] }),
  'spec.paint[0].fill.intersect[1].half',
);
rejectSpec(
  'region with a point',
  mk({ union: ['a', 'pt'] }, [{ id: 'pt', type: 'point', at: [1, 1] }]),
  'spec.paint[0].fill.union[1]',
);
rejectSpec('region with a line', mk({ union: ['a', 'l'] }), 'spec.paint[0].fill.union[1]');
rejectSpec(
  'region with a repeat of lines',
  mk({ union: ['a', 'rl'] }, [{ id: 'rl', type: 'repeat', of: ['l'], n: 3 }]),
  'spec.paint[0].fill.union[1]',
);
rejectSpec(
  'stroke a point',
  fig([{ id: 'pt', type: 'point', at: [1, 1] }], ['pt']),
  'spec.paint[0].stroke[0]',
);
rejectSpec(
  'to a polygon',
  fig(
    [
      { id: 'pg', type: 'polygon', in: 'a', n: 5 },
      { id: 't', type: 'tangent_circle', r: 1, to: ['a', 'pg'], near: [0, 0] },
    ],
    ['a'],
  ),
  'spec.shapes[3].to[1]',
);
rejectSpec(
  'intersect with a polygon',
  fig(
    [
      { id: 'pg', type: 'polygon', in: 'a', n: 5 },
      { id: 'p', type: 'point', at: { intersect: ['a', 'pg'], near: [0, 0] } },
    ],
    ['a'],
  ),
  'spec.shapes[3].at.intersect[1]',
);
rejectSpec(
  'exception target does not exist',
  setAt(fig(), ['exceptions'], [{ rule: 'off_grid', target: 'nope', reason: 'x' }]),
  'spec.exceptions[0].target',
);

// Unbounded regions
rejectSpec('fill of a half-plane', mk({ half: 'l', toward: [1, 0] }), 'spec.paint[0].fill');
rejectSpec(
  'union with a half-plane',
  mk({ union: ['a', { half: 'l', toward: [1, 0] }] }),
  'spec.paint[0].fill',
);
rejectSpec(
  'subtract from a half-plane',
  mk({ subtract: [{ half: 'l', toward: [1, 0] }, 'a'] }),
  'spec.paint[0].fill',
);

// Workload caps
const polygonRepeat = (extraCircles: number): Obj[] => [
  { id: 'pg', type: 'polygon', in: 'a', n: 36 },
  { id: 'rp', type: 'repeat', of: ['pg'], n: 7 },
  ...Array.from({ length: extraCircles }, (_, i) => circle(`x${i}`, 1)),
];
rejectSpec(
  'mark with 257 support curves',
  mk({ union: ['rp', 'a'] }, polygonRepeat(4).concat([circle('y', 1)])),
  'spec.shapes',
);

// Drawn-element caps for a figure: three full repeats, one of 216, and a remainder.
const drawnFigure = (remainder: Obj, remainderId: string): Obj => {
  const circles = Array.from({ length: 8 }, (_, i) => circle(`c${i}`, 0.5, [1 + 0.25 * i, 0.5]));
  const ids = circles.map((c) => c.id as string);
  return {
    version: 1,
    mode: 'figure',
    grid: { divisions: 4 },
    shapes: [
      ...circles,
      { id: 'big', type: 'repeat', of: ids, n: 36, mirror: true },
      { id: 'mid', type: 'repeat', of: ids.slice(0, 3), n: 36, mirror: true },
      remainder,
    ],
    paint: [
      { stroke: ['big'], width: 0.125 },
      { stroke: ['big'], width: 0.125 },
      { stroke: ['big'], width: 0.125 },
      { stroke: ['mid'], width: 0.125 },
      { stroke: [remainderId], width: 0.125 },
    ],
  };
};
rejectSpec(
  'figure with 2049 drawn elements',
  drawnFigure({ id: 'rest', type: 'repeat', of: ['c0', 'c1', 'c2'], n: 35 }, 'rest'),
  'spec.paint[4].stroke[0]',
);

// Arcs and erase layers
const arcShape = (extra: Obj = {}): Obj => ({
  id: 's',
  type: 'arc',
  on: 'a',
  from: 0,
  to: 90,
  ...extra,
});
const withPaint = (spec: Obj, paint: Obj[]): Obj => ({ ...spec, paint });
const ERASE_BASE = (extra: Obj[] = []): Obj => fig([circle('disc', 1, [2, 0]), ...extra], ['a']);
const erasing = (erase: unknown, extra: Obj[] = []): Obj =>
  withPaint(ERASE_BASE(extra), [{ stroke: ['a'], width: 0.125 }, { erase }]);

rejectSpec(
  'arc: unknown circle',
  fig([arcShape({ on: 'ghost' })], ['a', 's']),
  'spec.shapes[2].on',
);
rejectSpec(
  'arc: on a line',
  fig([{ id: 'l', type: 'line', from: [0, 0], to: [1, 0] }, arcShape({ on: 'l' })], ['a', 's']),
  'spec.shapes[3].on',
);
rejectSpec(
  'arc: on a later circle',
  fig([arcShape({ on: 'late' }), circle('late')], ['a']),
  'spec.shapes[2].on',
);
rejectSpec('arc: from 3601', fig([arcShape({ from: 3601 })], ['a', 's']), 'spec.shapes[2].from');
rejectSpec('arc: to -3601', fig([arcShape({ to: -3601 })], ['a', 's']), 'spec.shapes[2].to');
rejectSpec('arc: from null', fig([arcShape({ from: null })], ['a', 's']), 'spec.shapes[2].from');
rejectSpec(
  'arc: from missing',
  omitAt(fig([arcShape()], ['a', 's']), ['shapes', 2, 'from']),
  'spec.shapes[2]',
);
rejectSpec('arc: unknown key', fig([arcShape({ sweep: 90 })], ['a', 's']), 'spec.shapes[2].sweep');
rejectSpec(
  'arc: duplicate id',
  fig([arcShape(), arcShape({ from: 10 })], ['a', 's']),
  'spec.shapes[3].id',
);
rejectSpec(
  'arc: unknown shape in a point end',
  fig([arcShape({ from: 'ghost' })], ['a', 's']),
  'spec.shapes[2].from',
);
rejectSpec('arc: in a region', mk('s', [arcShape()]), 'spec.paint[0].fill');
rejectSpec(
  'arc: repeat of an arc in a region',
  mk('ring', [arcShape(), { id: 'ring', type: 'repeat', of: ['s'], n: 3 }]),
  'spec.paint[0].fill',
);
rejectSpec(
  'arc: as a polygon base',
  fig([arcShape(), { id: 'pg', type: 'polygon', in: 's', n: 5 }], ['a', 'pg']),
  'spec.shapes[3].in',
);
rejectSpec(
  'arc: as a tangent_circle target',
  fig(
    [arcShape(), { id: 't', type: 'tangent_circle', r: 1, to: ['a', 's'], near: [0, 0] }],
    ['a', 't'],
  ),
  'spec.shapes[3].to[1]',
);
rejectSpec(
  'arc: in an intersect',
  fig([arcShape(), { id: 'p', type: 'point', at: { intersect: ['a', 's'], near: [3, 0] } }], ['a']),
  'spec.shapes[3].at.intersect[1]',
);
rejectSpec(
  'arc: as a length base',
  fig([arcShape(), circle('c', 's.r')], ['a', 'c']),
  'spec.shapes[3].r',
);
rejectSpec(
  'arc: as a point reference',
  fig([arcShape(), { id: 'p', type: 'point', at: 's' }], ['a']),
  'spec.shapes[3].at',
);
rejectSpec(
  'erase: first layer',
  withPaint(ERASE_BASE(), [{ erase: ['disc'] }, { stroke: ['a'], width: 0.125 }]),
  'spec.paint[0]',
);
rejectSpec('erase: in a mark', withPaint(mk(), [{ fill: 'a' }, { erase: ['b'] }]), 'spec.paint[1]');
rejectSpec('erase: duplicate target', erasing(['disc', 'disc']), 'spec.paint[1].erase[1]');
rejectSpec('erase: unknown target', erasing(['ghost']), 'spec.paint[1].erase[0]');
rejectSpec(
  'erase: a line',
  erasing(['l'], [{ id: 'l', type: 'line', from: [0, 0], to: [1, 0] }]),
  'spec.paint[1].erase[0]',
);
rejectSpec(
  'erase: a point',
  erasing(['p'], [{ id: 'p', type: 'point', at: [1, 1] }]),
  'spec.paint[1].erase[0]',
);
rejectSpec('erase: an arc', erasing(['s'], [arcShape()]), 'spec.paint[1].erase[0]');
rejectSpec(
  'erase: a repeat of an arc',
  erasing(['ring'], [arcShape(), { id: 'ring', type: 'repeat', of: ['s'], n: 3 }]),
  'spec.paint[1].erase[0]',
);
rejectSpec(
  'erase: a repeat of a line',
  erasing(
    ['ring'],
    [
      { id: 'l', type: 'line', from: [0, 0], to: [1, 0] },
      { id: 'ring', type: 'repeat', of: ['l'], n: 3 },
    ],
  ),
  'spec.paint[1].erase[0]',
);
rejectSpec('erase: empty list', erasing([]), 'spec.paint[1].erase');
rejectSpec(
  'erase: 33 targets',
  erasing(Array.from({ length: 33 }, () => 'disc')),
  'spec.paint[1].erase',
);
rejectSpec('erase: not an array', erasing('disc'), 'spec.paint[1].erase');
rejectSpec(
  'erase: extra key',
  withPaint(ERASE_BASE(), [
    { stroke: ['a'], width: 0.125 },
    { erase: ['disc'], width: 0.125 },
  ]),
  'spec.paint[1]',
);

describe('rejected spec values', () => {
  it.each(REJECT_SPEC)('render rejects %s', async (_label, spec, path) => {
    await rejected('gridsmith_render', renderArgs(spec), path);
  });

  it('rejects the same spec through export before writing', async () => {
    const dir = join(workDir, 'out');
    await rejected(
      'gridsmith_export',
      { spec: setAt(fig(), ['shapes', 0, 'r'], 0), dir, name: 'x' },
      'spec.shapes[0].r',
    );
    await expect(readdir(dir)).rejects.toThrow();
  });
});

describe('rejected tool arguments', () => {
  const cleanSpec = EXAMPLES[0]?.spec;

  it('spec: null', async () => {
    await rejected('gridsmith_render', { spec: null }, 'spec');
  });

  it('spec missing', async () => {
    await rejected('gridsmith_render', {}, 'spec');
    await rejected('gridsmith_export', { dir: workDir, name: 'x' }, 'spec');
  });

  it('spec: []', async () => {
    await rejected('gridsmith_render', { spec: [] }, 'spec');
  });

  it('views: []', async () => {
    await rejected('gridsmith_render', { spec: cleanSpec, views: [] }, 'views');
  });

  it('views: "sheet"', async () => {
    await rejected('gridsmith_render', { spec: cleanSpec, views: 'sheet' }, 'views');
  });

  it('views: eight entries', async () => {
    await rejected(
      'gridsmith_render',
      {
        spec: cleanSpec,
        views: ['sheet', 'final', 'sizes', 'svg', 'sheet_svg', 'guides', 'guides_svg', 'sheet'],
      },
      'views',
    );
  });

  it('views: seven distinct entries are accepted', async () => {
    const result = await call('gridsmith_render', {
      spec: cleanSpec,
      views: ['sheet', 'final', 'sizes', 'svg', 'sheet_svg', 'guides', 'guides_svg'],
    });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(result.content).toHaveLength(8);
  });

  it('views: duplicate entries', async () => {
    await rejected('gridsmith_render', { spec: cleanSpec, views: ['sheet', 'sheet'] }, 'views[1]');
  });

  it('views: unknown value', async () => {
    await rejected(
      'gridsmith_render',
      { spec: cleanSpec, views: ['mark'] },
      'views[0]',
      '"sheet", "final", "sizes"',
    );
  });

  it('views: sizes for a figure', async () => {
    const figure = EXAMPLES.find((e) => e.spec.mode === 'figure')?.spec;
    await rejected('gridsmith_render', { spec: figure, views: ['sizes'] }, 'views[0]');
  });

  it('views: sizes for a figure among the new views', async () => {
    const figure = EXAMPLES.find((e) => e.spec.mode === 'figure')?.spec;
    await rejected(
      'gridsmith_render',
      { spec: figure, views: ['svg', 'guides', 'sizes'] },
      'views[2]',
    );
  });

  it('views: lists the new views when a value is unknown', async () => {
    await rejected(
      'gridsmith_render',
      { spec: cleanSpec, views: ['guides_png'] },
      'views[0]',
      '"sheet_svg", "guides", "guides_svg"',
    );
  });

  it('topic: unknown value', async () => {
    await rejected('gridsmith_guide', { topic: 'x' }, 'topic', '"overview"');
  });

  it('topic: wrong kind', async () => {
    await rejected('gridsmith_guide', { topic: 5 }, 'topic');
  });

  it('name: empty, unsafe, upper case, too long', async () => {
    for (const name of ['', '../x', 'Logo', 'a'.repeat(65)]) {
      await rejected(
        'gridsmith_export',
        { spec: cleanSpec, dir: join(workDir, 'out'), name },
        'name',
      );
    }
    await expect(readdir(join(workDir, 'out'))).rejects.toThrow();
  });

  it('overwrite: "yes"', async () => {
    await rejected(
      'gridsmith_export',
      { spec: cleanSpec, dir: workDir, name: 'x', overwrite: 'yes' },
      'overwrite',
    );
  });

  it('dir: relative path', async () => {
    await rejected('gridsmith_export', { spec: cleanSpec, dir: 'out', name: 'x' }, 'dir');
  });

  it('dir: a file', async () => {
    const file = join(workDir, 'file.txt');
    await writeFile(file, 'x');
    await rejected('gridsmith_export', { spec: cleanSpec, dir: file, name: 'x' }, 'dir');
  });

  it.skipIf(process.getuid?.() === 0)('dir: not writable', async () => {
    const dir = join(workDir, 'readonly');
    await mkdir(dir);
    await chmod(dir, 0o500);
    try {
      await rejected('gridsmith_export', { spec: cleanSpec, dir, name: 'x' }, 'dir');
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await chmod(dir, 0o700);
    }
  });
});

describe('unknown keys', () => {
  it('suggests shapes for a top-level shape', async () => {
    const spec = { ...fig(), shape: [] };
    const text = await rejected('gridsmith_render', renderArgs(spec), 'spec.shape', 'unknown key');
    expect(text).toContain('Did you mean "shapes"?');
  });

  it('suggests r for radius on an element', async () => {
    const text = await rejected(
      'gridsmith_render',
      renderArgs(setAt(fig(), ['shapes', 1, 'radius'], 2)),
      'spec.shapes[1].radius',
    );
    expect(text).toContain('Did you mean "r"?');
  });

  it('suggests divisions for grid.division', async () => {
    const text = await rejected(
      'gridsmith_render',
      renderArgs(setAt(fig(), ['grid', 'division'], 4)),
      'spec.grid.division',
    );
    expect(text).toContain('Did you mean "divisions"?');
  });

  it('suggests views for view', async () => {
    const text = await rejected(
      'gridsmith_render',
      { spec: fig(), view: ['final'] },
      'view',
      'unknown key',
    );
    expect(text).toContain('Did you mean "views"?');
  });

  it('suggests overwrite for overwite', async () => {
    const text = await rejected(
      'gridsmith_export',
      { spec: EXAMPLES[0]?.spec, dir: workDir, name: 'x', overwite: true },
      'overwite',
    );
    expect(text).toContain('Did you mean "overwrite"?');
    expect(await readdir(workDir)).toEqual([]);
  });

  it('suggests a key for an unknown guide argument', async () => {
    const text = await rejected('gridsmith_guide', { topics: 'spec' }, 'topics');
    expect(text).toContain('Did you mean "topic"?');
  });

  it('suggests keys inside nested points and paint layers', async () => {
    const point = fig([{ id: 'p', type: 'point', at: { on: 'a', angle: 0, angel: 1 } }], ['a']);
    const text = await rejected('gridsmith_render', renderArgs(point), 'spec.shapes[2].at.angel');
    expect(text).toContain('Did you mean "angle"?');
    const layer = setAt(fig(), ['paint', 0, 'colour'], '#000000');
    const layerText = await rejected('gridsmith_render', renderArgs(layer), 'spec.paint[0].colour');
    expect(layerText).toContain('Did you mean "color"?');
  });
});

describe('error message shape', () => {
  it('reports received and allowed values', async () => {
    const text = await rejected(
      'gridsmith_render',
      renderArgs(setAt(fig(), ['shapes', 0, 'r'], 0.049)),
      'received: 0.049',
      'allowed:',
    );
    expect(text).toMatch(/^gridsmith_render: spec\.shapes\[0\]\.r: /);
  });

  it('reports at most ten input errors and counts the rest', async () => {
    const shapes = Array.from({ length: 13 }, (_, i) => circle(`c${i}`, 0));
    const text = await rejected(
      'gridsmith_render',
      renderArgs(
        setAt(setAt(fig(), ['shapes'], shapes), ['paint'], [{ stroke: ['c0'], width: 0.125 }]),
      ),
      'spec.shapes[0].r',
      'spec.shapes[9].r',
    );
    expect(text).not.toContain('spec.shapes[10].r');
    expect(text.split('\n')).toHaveLength(11);
    expect(text.endsWith('… and 3 more')).toBe(true);
  });

  it('caps long errors at 10000 characters with a count of the rest', async () => {
    const extra: Obj[] = Array.from({ length: 60 }, (_, i) => ({
      id: `t${i}`,
      type: 'tangent_circle',
      r: 0.5,
      to: ['a', 'b'],
      near: [0, 0],
    }));
    const spec = fig([circle('far', 0.5, [40, 0]), ...extra], ['a']);
    const text = await rejected('gridsmith_render', renderArgs(spec), 'spec.shapes[3]');
    expect(text.length).toBeLessThanOrEqual(10000);
    expect(text).toMatch(/\n… and \d+ more$/);
  });
});

describe('spec files', () => {
  const clean = () => EXAMPLES[0]?.spec;

  it('rejects a relative path', async () => {
    await rejected('gridsmith_render', { spec: 'specs/a.json' }, 'spec', 'absolute');
  });

  it('rejects a file that does not exist', async () => {
    await rejected('gridsmith_render', { spec: join(workDir, 'missing.json') }, 'spec');
  });

  it('rejects a file that is not JSON without quoting it', async () => {
    const path = join(workDir, 'bad.json');
    await writeFile(path, 'SECRET-MARKER is not json');
    const text = await rejected('gridsmith_render', { spec: path }, 'spec');
    expect(text).not.toContain('SECRET-MARKER');
  });

  it('rejects a JSON file that is not an object', async () => {
    const path = join(workDir, 'array.json');
    await writeFile(path, '[1, 2]');
    await rejected('gridsmith_render', { spec: path }, 'spec');
  });

  it('rejects a file over 256 KB', async () => {
    const path = join(workDir, 'big.json');
    await writeFile(path, JSON.stringify({ pad: 'x'.repeat(256 * 1024) }));
    await rejected('gridsmith_render', { spec: path }, 'spec', 'too large');
  });

  it('accepts a spec file just under 256 KB', async () => {
    const path = join(workDir, 'padded.json');
    const text = JSON.stringify(clean());
    await writeFile(path, text.padEnd(256 * 1024, ' '));
    const result = await call('gridsmith_render', { spec: path, views: ['final'] });
    expect(result.isError, textOf(result)).toBeFalsy();
  });

  it('rejects JSON text passed as the spec string', async () => {
    const text = await rejected('gridsmith_render', { spec: JSON.stringify(clean()) }, 'spec');
    expect(text).toContain('.json');
  });

  it('reports spec problems found in a file with the spec path', async () => {
    const path = join(workDir, 'spec.json');
    await writeFile(path, JSON.stringify(setAt(fig(), ['shapes', 0, 'r'], 0)));
    await rejected('gridsmith_render', { spec: path }, 'spec.shapes[0].r');
  });
});

describe('resolve errors', () => {
  it('rejects a length expression that evaluates above 64', async () => {
    await rejected(
      'gridsmith_render',
      renderArgs(setAt(fig(), ['shapes', 0, 'r'], 'R*16*16')),
      'spec.shapes[0]',
      '"a"',
    );
  });

  it('rejects a stroke width expression that evaluates out of range', async () => {
    await rejected('gridsmith_render', renderArgs(fig([], ['a'], 'R*16*16')), 'spec.paint[0]');
  });

  it('rejects a tangent circle with no candidate', async () => {
    const spec = fig(
      [
        circle('c', 0.5, [-4, 0]),
        circle('d', 0.5, [4, 0]),
        { id: 't', type: 'tangent_circle', r: 1, to: ['c', 'd'], near: [0, 0] },
      ],
      ['a'],
    );
    await rejected('gridsmith_render', renderArgs(spec), 'spec.shapes[4]', '"t"');
  });

  it('rejects the intersection of circles that do not meet', async () => {
    const spec = fig(
      [
        circle('c', 0.5, [-4, 0]),
        circle('d', 0.5, [4, 0]),
        { id: 'p', type: 'point', at: { intersect: ['c', 'd'], near: [0, 0] } },
      ],
      ['a'],
    );
    await rejected('gridsmith_render', renderArgs(spec), 'spec.shapes[4]');
  });

  it('rejects the intersection of parallel lines', async () => {
    const spec = fig(
      [
        { id: 'l1', type: 'line', from: [0, 0], to: [1, 0] },
        { id: 'l2', type: 'line', from: [0, 1], to: [1, 1] },
        { id: 'p', type: 'point', at: { intersect: ['l1', 'l2'] } },
      ],
      ['a'],
    );
    await rejected('gridsmith_render', renderArgs(spec), 'spec.shapes[4]');
  });

  it('rejects the intersection of coincident circles with an alternative', async () => {
    const spec = fig(
      [circle('c', 3), { id: 'p', type: 'point', at: { intersect: ['a', 'c'], near: [0, 3] } }],
      ['a'],
    );
    const text = await rejected('gridsmith_render', renderArgs(spec), 'spec.shapes[3]');
    expect(text).toContain('on');
  });

  it('rejects a tangent circle squeezed between concentric circles', async () => {
    const spec = fig(
      [
        circle('c1', 1),
        circle('c3', 3),
        { id: 't', type: 'tangent_circle', r: 1, to: ['c1', 'c3'], near: [2, 0] },
      ],
      ['a'],
    );
    await rejected('gridsmith_render', renderArgs(spec), 'spec.shapes[4]');
  });

  it('rejects a tangent circle between lines 2r apart', async () => {
    const spec = fig(
      [
        { id: 'l1', type: 'line', from: [0, 1], to: [1, 1] },
        { id: 'l2', type: 'line', from: [0, -1], to: [1, -1] },
        { id: 't', type: 'tangent_circle', r: 1, to: ['l1', 'l2'], near: [0, 0] },
      ],
      ['a'],
    );
    await rejected('gridsmith_render', renderArgs(spec), 'spec.shapes[4]');
  });

  it('rejects two candidates equidistant from near', async () => {
    const spec = fig(
      [
        circle('c', 3, [3, 0]),
        { id: 'p', type: 'point', at: { intersect: ['a', 'c'], near: [1.5, 0] } },
      ],
      ['a'],
    );
    const text = await rejected('gridsmith_render', renderArgs(spec), 'spec.shapes[3]');
    expect(text).toMatch(/\(-?\d/);
  });

  it('rejects two candidates with no near', async () => {
    const spec = fig(
      [circle('c', 3, [3, 0]), { id: 'p', type: 'point', at: { intersect: ['a', 'c'] } }],
      ['a'],
    );
    const text = await rejected('gridsmith_render', renderArgs(spec), 'spec.shapes[3]');
    expect(text).toMatch(/\(-?\d/);
  });

  it('rejects a line through one point twice', async () => {
    const spec = fig([{ id: 'l', type: 'line', from: [1, 1], to: [1, 1] }], ['a']);
    await rejected('gridsmith_render', renderArgs(spec), 'spec.shapes[2]');
  });

  it('rejects points with equal neighbours', async () => {
    const spec = fig(
      [
        {
          id: 'ps',
          type: 'points',
          through: [
            [0, 0],
            [0, 0],
            [2, 2],
          ],
        },
      ],
      ['ps'],
    );
    await rejected('gridsmith_render', renderArgs(spec), 'spec.shapes[2]');
  });

  it('rejects collinear points', async () => {
    const spec = fig(
      [
        {
          id: 'ps',
          type: 'points',
          through: [
            [0, 0],
            [1, 0],
            [2, 0],
          ],
        },
      ],
      ['ps'],
    );
    await rejected('gridsmith_render', renderArgs(spec), 'spec.shapes[2]');
  });

  it('rejects toward on the line', async () => {
    const spec = mk({ intersect: ['a', { half: 'l', toward: [0, 1] }] });
    await rejected('gridsmith_render', renderArgs(spec), 'spec.paint[0]');
  });

  it('lists every failure, root causes before dependants', async () => {
    const spec = fig(
      [
        circle('c', 0.5, [-4, 0]),
        circle('d', 0.5, [4, 0]),
        { id: 'bad1', type: 'tangent_circle', r: 1, to: ['c', 'd'], near: [0, 0] },
        circle('child', 1, 'bad1'),
        { id: 'bad2', type: 'tangent_circle', r: 1, to: ['c', 'd'], near: [0, 1] },
      ],
      ['a'],
    );
    const text = await rejected('gridsmith_render', renderArgs(spec), 'bad1', 'bad2', 'child');
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('child');
    expect(lines[2]).toContain('depends on "bad1"');
  });
});

describe('accepted edge values', () => {
  it('accepts width 0.005 and reports thin_stroke', async () => {
    const report = await accepted(fig([], ['a'], 0.005));
    expect(violationRules(report, 'paint[0]')).toContain('thin_stroke');
  });

  it('accepts width 8', async () => {
    await accepted(fig([], ['a'], 8));
  });

  it('accepts center [0, -0]', async () => {
    const report = await accepted(setAt(fig(), ['shapes', 1, 'center'], [0, -0]));
    const b = report.geometry.find((g) => g.id === 'b');
    expect([b?.cx, b?.cy]).toEqual([0, 0]);
  });

  it('accepts r 0.05, r 64 and coordinate 64', async () => {
    const report = await accepted(
      fig([circle('small', 0.05), circle('huge', 64), circle('far', 1, [64, -64])], ['a', 'small']),
    );
    expect(violationRules(report, 'small')).toContain('off_grid');
    const far = report.geometry.find((g) => g.id === 'far');
    expect([far?.cx, far?.cy]).toEqual([64, -64]);
  });

  it('accepts angles 3600 and -3600', async () => {
    for (const angle of [3600, -3600]) {
      await accepted(fig([circle('p', 0.25, { on: 'a', angle })], ['a', 'p']));
    }
  });

  it('accepts the defaults left out', async () => {
    const spec = {
      version: 1,
      mode: 'figure',
      grid: { divisions: 4 },
      shapes: [
        { id: 'a', type: 'circle', r: 'R' },
        { id: 'pg', type: 'polygon', in: 'a', n: 6 },
        { id: 'rp', type: 'repeat', of: ['pg'], n: 3 },
      ],
      paint: [{ stroke: ['a', 'rp'], width: 0.125 }],
    };
    const report = await accepted(spec);
    expect(report.exportable).toBe(true);
    const defaultViews = await call('gridsmith_render', { spec });
    expect(defaultViews.content.filter((b) => b.type === 'image')).toHaveLength(2);
    const guide = await call('gridsmith_guide', {});
    expect(JSON.parse(textOf(guide)).topic).toBe('overview');
    const bare = await client.callTool({ name: 'gridsmith_guide' });
    expect(bare.isError).toBeFalsy();
  });

  it('applies the default overwrite of false', async () => {
    const args = { spec: EXAMPLES[0]?.spec, dir: workDir, name: 'x' };
    expect((await call('gridsmith_export', args)).isError).toBeFalsy();
    expect((await call('gridsmith_export', args)).isError).toBe(true);
  });

  it('accepts one shape, one paint layer and one view', async () => {
    const spec = {
      version: 1,
      mode: 'figure',
      grid: { divisions: 4 },
      shapes: [circle('a', 3)],
      paint: [{ stroke: ['a'], width: 0.125 }],
    };
    const result = await call('gridsmith_render', { spec, views: ['sheet'] });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(result.content.filter((b) => b.type === 'image')).toHaveLength(1);
  });

  it('accepts a near that nests intersect points two deep', async () => {
    const report = await accepted(fig([{ id: 'p', type: 'point', at: nested(3) }], ['a']));
    expect(report.geometry.find((g) => g.id === 'p')).toBeDefined();
  });

  it('accepts the range ends of the grid and shapes', async () => {
    for (const divisions of [4, 6, 8]) {
      await accepted(setAt(fig(), ['grid', 'divisions'], divisions));
    }
    for (const margin of [0, 4]) {
      await accepted(setAt(fig(), ['grid', 'margin'], margin));
    }
    await accepted(setAt(fig(), ['grid', 'divisions'], 4.0));
  });

  it('accepts polygon.n 3 and 36', async () => {
    for (const n of [3, 36]) {
      await accepted(fig([{ id: 'pg', type: 'polygon', in: 'a', n }], ['pg']));
    }
  });

  it('accepts repeat.n 2 and 36, and 1 with mirror', async () => {
    for (const [n, mirror] of [
      [2, false],
      [36, false],
      [1, true],
    ] as const) {
      const report = await accepted(
        fig([{ id: 'rp', type: 'repeat', of: ['b'], n, mirror }], ['a', 'rp']),
      );
      expect(report.geometry.find((g) => g.id === 'rp')).toBeDefined();
    }
  });

  it('accepts 256 shapes', async () => {
    const shapes = Array.from({ length: 256 }, (_, i) => circle(`c${i}`, 3));
    const report = await accepted(
      setAt(setAt(fig(), ['shapes'], shapes), ['paint'], [{ stroke: ['c0'], width: 0.125 }]),
    );
    expect(report.summary).toContain('with 256 shapes');
  });

  it('accepts 16 paint layers and 16 exceptions', async () => {
    const paint = Array.from({ length: 16 }, () => ({ stroke: ['a'], width: 0.125 }));
    await accepted(setAt(fig(), ['paint'], paint));
    const shapes = Array.from({ length: 16 }, (_, i) => circle(`c${i}`, 3.1));
    const exceptions = shapes.map((s) => ({ rule: 'off_grid', target: s.id, reason: 'intended' }));
    const report = await accepted({
      ...fig(),
      shapes,
      paint: [{ stroke: shapes.map((s) => s.id), width: 0.125 }],
      exceptions,
    });
    expect(report.exceptions_applied).toHaveLength(16);
  });

  it('accepts region depth 8, of with 8 entries and through with 3 and 32 points', async () => {
    await accepted(mk(deepRegion(8)), ['final']);
    const circles = Array.from({ length: 8 }, (_, i) => circle(`x${i}`, 1));
    await accepted(
      fig([...circles, { id: 'rp', type: 'repeat', of: circles.map((c) => c.id), n: 2 }], ['rp']),
    );
    for (const count of [3, 32]) {
      const through = Array.from({ length: count }, (_, i) => {
        const angle = (2 * Math.PI * i) / count;
        return [Math.cos(angle) * 3, Math.sin(angle) * 3];
      });
      await accepted(fig([{ id: 'ps', type: 'points', through }], ['ps']));
    }
  });

  it('accepts a concept of 400 characters and an emoji counted in UTF-16 units', async () => {
    await accepted(setAt(fig(), ['concept'], 'x'.repeat(400)));
    await accepted(setAt(fig(), ['concept'], `${'x'.repeat(398)}\u{1F600}`));
  });

  it('accepts a non-ASCII reason and applies the exception', async () => {
    const spec = setAt(fig([], ['a', 'c']), ['shapes'], [circle('a', 3.3), circle('c', 3)]);
    const withException = setAt(
      spec,
      ['exceptions'],
      [{ rule: 'off_grid', target: 'a', reason: '帯の装飾' }],
    );
    const report = await accepted(withException);
    expect(report.exportable).toBe(true);
    expect(report.exceptions_applied).toEqual([
      { rule: 'off_grid', target: 'a', reason: '帯の装飾' },
    ]);
  });

  it('accepts an upper-case colour', async () => {
    await accepted(setAt(fig(), ['paint', 0, 'color'], '#ABCDEF'));
  });

  it('accepts a figure of 36 repeated octagons', async () => {
    const report = await accepted(
      fig(
        [
          { id: 'oct', type: 'polygon', in: 'b', n: 8 },
          { id: 'rp', type: 'repeat', of: ['oct'], n: 36 },
        ],
        ['a', 'rp'],
      ),
    );
    expect(report.stats[0]?.strokes).toBe(37);
  });

  it('accepts a figure with exactly 2048 drawn elements', async () => {
    const spec = drawnFigure(
      { id: 'rest', type: 'repeat', of: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'], n: 13 },
      'rest',
    );
    const report = await accepted(spec);
    expect(report.stats.reduce((sum, s) => sum + s.strokes, 0)).toBe(2048);
  });

  it('accepts a tangent circle with the radius of both neighbours and skips the internal contact', async () => {
    const spec = fig(
      [
        circle('l', 2, [-2, 0]),
        circle('r', 2, [2, 0]),
        { id: 't', type: 'tangent_circle', r: 2, to: ['l', 'r'], near: [0, 3] },
      ],
      ['t'],
    );
    const report = await accepted(spec);
    const t = report.geometry.find((g) => g.id === 't');
    expect(t?.cx).toBeCloseTo(0, 6);
    expect(t?.cy).toBeCloseTo(Math.sqrt(12), 4);
    expect(t?.contacts.map((c) => c.kind)).toEqual(['external', 'external']);
  });

  it('reports angle violations for polygon.n 7 and angle 10, and none for -45, 450, 22.5', async () => {
    const polygon = await accepted(
      fig([{ id: 'pg', type: 'polygon', in: 'a', n: 7 }], ['a', 'pg']),
    );
    expect(violationRules(polygon, 'pg')).toContain('angle');
    const ten = await accepted(fig([circle('p', 0.25, { on: 'a', angle: 10 })], ['a', 'p']));
    expect(violationRules(ten, 'p')).toContain('angle');
    for (const angle of [-45, 450, 22.5]) {
      const report = await accepted(fig([circle('p', 0.25, { on: 'a', angle })], ['a', 'p']));
      expect(violationRules(report, 'p')).not.toContain('angle');
    }
  });
});

describe('unexpected failures', () => {
  const clean = () => EXAMPLES[0]?.spec;

  it('reports an arrangement invariant failure with a hash of the spec', async () => {
    vi.mocked(arrange).mockImplementationOnce(() => {
      throw new ArrangementInvariantError(3);
    });
    const spec = clean();
    const text = await rejected('gridsmith_render', renderArgs(spec), 'internal error');
    const hash = createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 12);
    expect(text).toContain(hash);
    expect(text).not.toContain('    at ');
  });

  it('catches other exceptions, returns kind and message, and logs the stack to stderr', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(arrange).mockImplementationOnce(() => {
      throw new TypeError('boom');
    });
    const text = await rejected(
      'gridsmith_render',
      renderArgs(clean()),
      'internal error (TypeError: boom)',
    );
    expect(text).not.toContain('    at ');
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toContain('TypeError: boom');
    expect(String(log.mock.calls[0]?.[0])).toContain('    at ');
  });
});

describe('arcs and erase layers through the tools', () => {
  it('rejects an arc end that is off the circle and states the distance', async () => {
    const text = await rejected(
      'gridsmith_render',
      renderArgs(fig([arcShape({ from: [3, 0.5] })], ['a', 's'])),
      'spec.shapes[2] (id "s")',
      'off the circle',
      'distance 0.04',
    );
    expect(text).toContain('0.000001');
  });

  it('rejects coincident arc ends and suggests a circle', async () => {
    await rejected(
      'gridsmith_render',
      renderArgs(fig([arcShape({ from: 90, to: 450 })], ['a', 's'])),
      'spec.shapes[2] (id "s")',
      'coincide',
      'circle',
    );
  });

  it('reports an arc on a circle that did not resolve as dependent', async () => {
    const spec = fig([circle('bad', 'R*16*16'), arcShape({ on: 'bad' })], ['a', 's']);
    await rejected('gridsmith_render', renderArgs(spec), '"bad"', 'spec.shapes[3] (id "s")');
  });

  it('accepts an arc, counts it as one drawn element and describes it in the geometry', async () => {
    const report = (await accepted(
      fig([arcShape({ from: 30, to: 150 })], ['a', 's']),
    )) as Report & {
      geometry: Record<string, number | string>[];
    };
    const arc = report.geometry.find((g) => g.id === 's');
    expect(arc).toMatchObject({
      type: 'arc',
      cx: 0,
      cy: 0,
      r: 3,
      from: 30,
      to: 150,
      x1: 2.5981,
      y1: 1.5,
      x2: -2.5981,
      y2: 1.5,
    });
    expect(report.stats[0]?.strokes).toBe(2);
  });

  it('accepts an arc with angle 3600 and one with a point end on the circle', async () => {
    await accepted(fig([arcShape({ from: -3600, to: 3600 - 90 })], ['a', 's']));
    await accepted(fig([arcShape({ from: [3, 0], to: { on: 'a', angle: 90 } })], ['a', 's']));
  });

  it('accepts an erase layer and reports it in the stats next to the strokes', async () => {
    const report = await accepted(
      withPaint(ERASE_BASE(), [
        { stroke: ['a', 'b'], width: 0.125 },
        { erase: ['disc'] },
        { stroke: ['disc'], width: 0.125 },
      ]),
    );
    expect(report.stats).toEqual([
      { paint: 0, strokes: 2 },
      { paint: 1, erases: 1 },
      { paint: 2, strokes: 1 },
    ]);
    expect(violationRules(report)).toEqual([]);
  });

  it('exports a spec with an arc and an erase layer', async () => {
    const dir = join(workDir, 'out');
    const spec = withPaint(
      { ...ERASE_BASE([arcShape({ id: 'edge', on: 'disc', from: 90, to: 270 })]) },
      [{ stroke: ['a', 'b', 'edge'], width: 0.125 }, { erase: ['disc'] }],
    );
    const result = await call('gridsmith_export', { spec, dir, name: 'sigil' });
    expect(result.isError, textOf(result)).toBeFalsy();
  });
});

describe('outline element through the tools', () => {
  const outline = (through: unknown[], id = 'o'): Obj => ({ id, type: 'outline', through });

  const WHALE: Obj = {
    version: 1,
    mode: 'mark',
    grid: { divisions: 8 },
    shapes: [
      circle('head', 3, [-5, -1]),
      circle('belly', 9, [-1, 4]),
      circle('bay_l', 2, [1, 2]),
      circle('bay_r', 2, [7, 2]),
      { id: 'rump', type: 'tangent_circle', r: 2, to: ['belly', 'bay_r'], near: [3.5, -0.5] },
      { id: 'back', type: 'tangent_circle', r: 7, to: ['head', 'bay_l'], near: [-3.3, -4.6] },
      circle('fluke_l', 3, [2.5, 2.5]),
      circle('fluke_r', 3, [5.5, 2.5]),
      circle('eye', 0.5, [-5.5, 0]),
      outline(
        [
          'belly',
          'rump',
          { on: 'bay_r', concave: true, corner: [8, 3.6] },
          { on: 'fluke_r', corner: [4.3, 5.2] },
          { on: 'fluke_l', corner: [0, 3.6] },
          { on: 'bay_l', concave: true },
          'back',
          { on: 'head', corner: [-7.5, -3] },
        ],
        'whale',
      ),
    ],
    paint: [{ fill: { subtract: ['whale', 'eye'] } }],
  };

  it('reports pieces that do not touch as a tool error naming the piece ids', async () => {
    const spec = mk('o', [
      circle('c1', 1, [-3, 0]),
      circle('c2', 1, [3, 0]),
      outline(['c1', 'c2']),
    ]);
    await rejected(
      'gridsmith_render',
      renderArgs(spec),
      'spec.shapes[5] (id "o")',
      'do not touch',
      '"c1"',
      '"c2"',
    );
  });

  it('asks for a corner where two circles cross', async () => {
    const spec = mk('o', [
      circle('c1', 3, [-1, 0]),
      circle('c2', 3, [1, 0]),
      outline(['c1', 'c2']),
    ]);
    await rejected(
      'gridsmith_render',
      renderArgs(spec),
      'spec.shapes[5] (id "o")',
      'needs a corner',
      '"c1"',
      '"c2"',
    );
  });

  it('lists the outline in the geometry with its piece count, corners and area', async () => {
    const result = await call('gridsmith_render', renderArgs(WHALE));
    expect(result.isError, textOf(result)).toBeFalsy();
    const geometry = (JSON.parse(textOf(result)) as { geometry: Obj[] }).geometry;
    const entry = geometry.find((g) => g.id === 'whale') as Obj;
    expect(entry.type).toBe('outline');
    expect(entry.pieces).toBe(8);
    const corners = entry.corners as number[][];
    expect(corners).toHaveLength(4);
    for (const corner of corners) {
      expect(corner).toHaveLength(3);
      expect(Math.abs(corner[2] ?? 0)).toBeGreaterThan(0);
      expect(Math.abs(corner[2] ?? 0)).toBeLessThanOrEqual(180);
    }
    expect(entry.area as number).toBeCloseTo(88.694866, 3);
    expect(Object.keys(entry).sort()).toEqual(['area', 'corners', 'id', 'pieces', 'type']);
  });
});

describe('icon mode errors', () => {
  const iconSpec = (extra: Obj = {}): Obj => ({
    version: 1,
    mode: 'icon',
    grid: { divisions: 12 },
    shapes: [
      {
        id: 'bar',
        type: 'polyline',
        through: [
          [-4, 0],
          [0, 2],
          [4, 0],
        ],
      },
    ],
    paint: [{ stroke: ['bar'], width: 1, color: '#107c41' }],
    ...extra,
  });

  it('segments view: a mark and a figure', async () => {
    const mark = EXAMPLES.find((e) => e.spec.mode === 'mark')?.spec;
    const figure = EXAMPLES.find((e) => e.spec.mode === 'figure')?.spec;
    await rejected(
      'gridsmith_render',
      { spec: mark, views: ['segments'] },
      'views[0]',
      'view is not available for a mark',
      '"segments" only when mode is "icon"',
    );
    await rejected(
      'gridsmith_render',
      { spec: figure, views: ['sheet', 'segments'] },
      'views[1]',
      'view is not available for a figure',
      '"segments" only when mode is "icon"',
    );
  });

  it('views: ten entries are rejected', async () => {
    const all = ['sheet', 'final', 'sizes', 'svg', 'sheet_svg', 'guides', 'guides_svg', 'segments'];
    await rejected(
      'gridsmith_render',
      { spec: iconSpec(), views: [...all, 'match', 'sheet'] },
      'views',
      'an array of 1 to 9 distinct values',
    );
  });

  it('views: sizes is available for an icon and listed with segments', async () => {
    const report = await accepted(iconSpec(), ['sizes', 'segments']);
    expect(report.exportable).toBe(true);
    await rejected(
      'gridsmith_render',
      { spec: iconSpec(), views: ['pixels'] },
      'views[0]',
      '"match", "segments"',
    );
  });

  it('topic: lists icon', async () => {
    await rejected('gridsmith_guide', { topic: 'x' }, 'topic', '"examples", "icon"');
  });

  it('mode, divisions and margin of an icon', async () => {
    await rejected(
      'gridsmith_render',
      renderArgs(iconSpec({ mode: 'ring' })),
      'mode',
      '"mark", "figure" or "icon"',
    );
    await rejected(
      'gridsmith_render',
      renderArgs(iconSpec({ grid: { divisions: 8 } })),
      'grid.divisions',
      '12 when mode is "icon"',
    );
    await rejected(
      'gridsmith_render',
      renderArgs(iconSpec({ grid: { divisions: 12, margin: 1 } })),
      'grid.margin',
      '0 or omitted when mode is "icon"',
    );
    await rejected(
      'gridsmith_render',
      renderArgs({ ...fig(), grid: { divisions: 12 } }),
      'grid.divisions',
      '4, 6 or 8 unless mode is "icon"',
    );
  });

  it('erase layers and a one-point polyline', async () => {
    await rejected(
      'gridsmith_render',
      renderArgs(iconSpec({ paint: [{ erase: ['bar'] }] })),
      'paint[0]',
      '"fill" or "stroke" layers when mode is "icon"',
    );
    await rejected(
      'gridsmith_render',
      renderArgs(
        iconSpec({
          shapes: [
            {
              id: 'bar',
              type: 'polyline',
              through: [
                [0, 0],
                [1, 1],
              ],
            },
          ],
        }),
      ),
      'an array of 3 to 32 points',
    );
  });

  it('stroke attributes: cap, join and dash', async () => {
    const layer = (extra: Obj): Obj => ({
      paint: [{ stroke: ['bar'], width: 1, color: '#107c41', ...extra }],
    });
    await rejected(
      'gridsmith_render',
      renderArgs(iconSpec(layer({ cap: 'flat' }))),
      'cap',
      '"round", "butt" or "square"',
    );
    await rejected(
      'gridsmith_render',
      renderArgs(iconSpec(layer({ join: null }))),
      'join',
      '"round", "miter" or "bevel"',
    );
    await rejected(
      'gridsmith_render',
      renderArgs(iconSpec(layer({ dash: [2] }))),
      'dash',
      'an array of 2 lengths: dash, gap',
    );
  });

  it('draws an icon with violations and refuses to export it', async () => {
    const spec = iconSpec({
      shapes: [
        {
          id: 'bar',
          type: 'polyline',
          through: [
            [-4, 0],
            [-0.3, 2],
            [4, 0],
          ],
        },
      ],
      paint: [{ stroke: ['bar'], width: 0.25, color: '#107c41' }],
    });
    const report = await accepted(spec, ['sizes']);
    expect(violationRules(report)).toEqual(expect.arrayContaining(['off_grid', 'thin_stroke']));
    await rejected(
      'gridsmith_export',
      { spec, dir: workDir, name: 'bad' },
      'violation(s)',
      'Nothing was written',
    );
    expect(await readdir(workDir)).toEqual([]);
  });
});

describe('arc on an oval', () => {
  const spec = (from: number, to: number): Obj => ({
    version: 1,
    mode: 'icon',
    grid: { divisions: 12 },
    shapes: [
      { id: 'o', type: 'oval', center: [0, 0], rx: 3, ry: 2 },
      { id: 'a', type: 'arc', on: 'o', from, to },
    ],
    paint: [{ stroke: ['a'], width: 1, color: '#107c41' }],
  });

  it('rejects ends a whole number of turns apart', async () => {
    await rejected(
      'gridsmith_render',
      renderArgs(spec(0, 720)),
      'spec.shapes[1]',
      '"a"',
      'arc ends coincide (received: from 0 and to 720',
      'allowed:',
      'Use the oval itself.',
    );
  });

  it('accepts a run just short of a whole turn', async () => {
    const report = await accepted(spec(0, 359));
    expect(report.geometry.find((g) => g.id === 'a')).toBeDefined();
  });
});
