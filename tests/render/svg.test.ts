import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it } from 'vitest';
import type { FillResult } from '../../src/geom/arrangement.js';
import { arrange } from '../../src/geom/arrangement.js';
import type { Circle, Vec } from '../../src/geom/primitives.js';
import { EXAMPLES } from '../../src/guide/examples.js';
import type { RgbaImage } from '../../src/render/match.js';
import { diffShare } from '../../src/render/match.js';
import { renderExportPng } from '../../src/render/png.js';
import type { SegmentSet } from '../../src/render/segments.js';
import { renderSegments, segmentPaths } from '../../src/render/segments.js';
import { chainPathData, renderFinalSvg } from '../../src/render/svg.js';
import type { ResolvedModel } from '../../src/resolve/resolve.js';
import { resolveSpec } from '../../src/resolve/resolve.js';
import type { SpecInput } from '../../src/spec/schema.js';
import { specSchema } from '../../src/spec/schema.js';
import { readPng } from '../helpers/png.js';

type Built = { model: ResolvedModel; fills: FillResult[]; svg: string };

const build = (input: unknown): Built => {
  const spec = specSchema.parse(input as SpecInput);
  const res = resolveSpec(spec);
  if (!res.ok) {
    throw new Error(`resolve failed: ${JSON.stringify(res.errors)}`);
  }
  const fills = res.model.fills.map((f) => arrange(f.region));
  return { model: res.model, fills, svg: renderFinalSvg(res.model, fills) };
};

const mark = (shapes: unknown[], fill: unknown, divisions = 4): unknown => ({
  version: 1,
  mode: 'mark',
  grid: { divisions },
  shapes,
  paint: [{ fill }],
});

const markExample = mark(
  [
    { id: 'body', type: 'circle', r: 'R' },
    { id: 'bite', type: 'circle', center: [1, 1], r: 3 },
  ],
  { subtract: ['body', 'bite'] },
);

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
};

const vesica = [
  { id: 'a', type: 'circle', center: [-1, 0], r: 2 },
  { id: 'b', type: 'circle', center: [1, 0], r: 2 },
];

const configs: [string, unknown][] = [
  ['mark example', markExample],
  ['vesica union', mark(vesica, { union: ['a', 'b'] })],
  ['vesica difference', mark(vesica, { subtract: ['a', 'b'] })],
  ['vesica intersection', mark(vesica, { intersect: ['a', 'b'] })],
  [
    'internally tangent pair',
    mark(
      [
        { id: 'big', type: 'circle', r: 4 },
        { id: 'small', type: 'circle', center: [2, 0], r: 2 },
      ],
      { subtract: ['big', 'small'] },
    ),
  ],
  [
    'externally tangent pair',
    mark(
      [
        { id: 'l', type: 'circle', center: [-2, 0], r: 2 },
        { id: 'r', type: 'circle', center: [2, 0], r: 2 },
      ],
      { union: ['l', 'r'] },
    ),
  ],
  [
    'filled repeat of circles',
    mark(
      [
        { id: 'ring', type: 'circle', r: 3 },
        { id: 'dot', type: 'circle', center: { on: 'ring', angle: 0 }, r: 1.5 },
        { id: 'dots', type: 'repeat', of: ['dot'], n: 8 },
      ],
      'dots',
    ),
  ],
  [
    'polygon intersect disc',
    mark(
      [
        { id: 'c', type: 'circle', r: 3 },
        { id: 'hex', type: 'polygon', in: 'c', n: 6 },
        { id: 'd', type: 'circle', center: [1, 0], r: 2.5 },
      ],
      { intersect: ['hex', 'd'] },
    ),
  ],
  [
    'half-plane cut',
    mark(
      [
        { id: 'body', type: 'circle', r: 'R' },
        { id: 'cut', type: 'line', from: [0, 0], to: [0, 1] },
      ],
      { intersect: ['body', { half: 'cut', toward: [1, 0] }] },
    ),
  ],
];

type Command = { cmd: string; args: number[] };

const parsePath = (d: string): Command[] =>
  [...d.matchAll(/([A-Za-z])([^A-Za-z]*)/g)].map((m) => ({
    cmd: m[1] ?? '',
    args: (m[2] ?? '').trim() === '' ? [] : (m[2] ?? '').trim().split(/\s+/).map(Number),
  }));

const pathsOf = (svg: string): string[] =>
  [...svg.matchAll(/ d="([^"]*)"/g)].map((m) => m[1] ?? '');

const circlesOf = (model: ResolvedModel): Circle[] => {
  const out: Circle[] = [];
  for (const el of model.elements) {
    if (el.type === 'circle' || el.type === 'tangent_circle') {
      out.push(el.circle);
    } else if (el.type === 'repeat') {
      for (const c of el.copies) {
        if (c.element.type === 'circle') {
          out.push(c.element.circle);
        }
      }
    }
  }
  return out;
};

type Support = { p: Vec; d: Vec };

const supportsOf = (model: ResolvedModel): Support[] => {
  const out: Support[] = [];
  const addLoops = (loops: Vec[][]): void => {
    for (const loop of loops) {
      loop.forEach((a, i) => {
        const b = loop[(i + 1) % loop.length];
        if (b !== undefined) {
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          out.push({ p: a, d: { x: (b.x - a.x) / len, y: (b.y - a.y) / len } });
        }
      });
    }
  };
  for (const el of model.elements) {
    const parts = el.type === 'repeat' ? el.copies.map((c) => c.element) : [el];
    for (const part of parts) {
      if (part.type === 'line') {
        out.push(part.line);
      } else if (part.type === 'polygon' || part.type === 'points') {
        addLoops(part.loops);
      }
    }
  }
  return out;
};

/** Checks every `A` and `L` of the paths against the declared circles and lines; returns the edge count. */
const checkDerived = (paths: string[], circles: Circle[], supports: Support[]): number => {
  let edges = 0;
  for (const d of paths) {
    let cur: Vec | undefined;
    for (const { cmd, args } of parsePath(d)) {
      expect('MLAZ').toContain(cmd);
      if (cmd === 'Z') {
        continue;
      }
      const end: Vec = {
        x: args[args.length - 2] ?? Number.NaN,
        y: -(args[args.length - 1] ?? Number.NaN),
      };
      if (cmd === 'L' && cur !== undefined) {
        edges++;
        const from = cur;
        const onSupport = supports.some(
          (s) =>
            Math.abs(s.d.x * (from.y - s.p.y) - s.d.y * (from.x - s.p.x)) <= 1e-5 &&
            Math.abs(s.d.x * (end.y - s.p.y) - s.d.y * (end.x - s.p.x)) <= 1e-5,
        );
        expect(onSupport).toBe(true);
      } else if (cmd === 'A' && cur !== undefined) {
        edges++;
        const [rx, ry, , large] = args;
        expect(rx).toBe(ry);
        expect(large).toBe(0);
        const from = cur;
        const host = circles.find(
          (c) =>
            Math.abs(c.r - (rx ?? 0)) <= 1e-6 &&
            Math.abs(Math.hypot(from.x - c.cx, from.y - c.cy) - c.r) <= 1e-5 &&
            Math.abs(Math.hypot(end.x - c.cx, end.y - c.cy) - c.r) <= 1e-5,
        );
        expect(host).toBeDefined();
        if (host !== undefined) {
          const a0 = Math.atan2(from.y - host.cy, from.x - host.cx);
          const a1 = Math.atan2(end.y - host.cy, end.x - host.cx);
          let delta = Math.abs(a1 - a0);
          delta = Math.min(delta, 2 * Math.PI - delta);
          expect((delta * 180) / Math.PI).toBeLessThanOrEqual(120 + 1e-3);
        }
      } else {
        expect(cmd).toBe('M');
      }
      cur = end;
    }
  }
  return edges;
};

describe('existing examples keep their SVG text', () => {
  for (const example of EXAMPLES) {
    it(example.name, () => {
      const expected = readFileSync(
        fileURLToPath(new URL(`../../docs/gallery/${example.name}.svg`, import.meta.url)),
        'utf8',
      );
      expect(build(example.spec).svg).toBe(expected);
    });
  }
});

describe('final mark svg', () => {
  for (const [name, input] of configs) {
    it(`derives every edge from a declared curve: ${name}`, () => {
      const { model, svg } = build(input);
      const circles = circlesOf(model);
      const supports = supportsOf(model);
      const paths = pathsOf(svg);
      expect(paths.length).toBeGreaterThan(0);

      const edges = checkDerived(paths, circles, supports);
      expect(edges).toBeGreaterThan(0);
    });
  }

  it('splits a half circle so no arc exceeds 120 degrees', () => {
    const { svg } = build(mark([{ id: 'c', type: 'circle', r: 2 }], 'c'));
    const arcs = parsePath(pathsOf(svg).join(' ')).filter((c) => c.cmd === 'A');
    expect(arcs.length).toBeGreaterThanOrEqual(4);
  });

  it('flips y so that +y in module space is negative in svg', () => {
    const { svg } = build(mark([{ id: 'c', type: 'circle', center: [0, 2], r: 1 }], 'c'));
    const ys = parsePath(pathsOf(svg).join(' '))
      .filter((c) => c.cmd !== 'Z')
      .map((c) => c.args[c.args.length - 1] ?? 0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(-1 + 1e-6);
    expect(Math.min(...ys)).toBeCloseTo(-3, 5);
  });

  it('uses the canvas as viewBox, one evenodd path per layer and no background', () => {
    const { svg } = build(markExample);
    expect(svg).toContain('viewBox="-5 -5 10 10"');
    expect(svg.match(/<path /g)).toHaveLength(1);
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).not.toContain('<rect');
    expect(svg).not.toMatch(/\bC\b|\bQ\b/);
  });

  it('rounds numbers to six decimals', () => {
    const { svg } = build(mark([{ id: 'c', type: 'circle', center: [0.5, 0], r: 'R/3' }], 'c'));
    for (const m of svg.matchAll(/-?\d+\.\d+/g)) {
      expect((m[0].split('.')[1] ?? '').length).toBeLessThanOrEqual(6);
    }
  });
});

describe('final figure svg', () => {
  it('uses only circle, line and polygon elements with round joins and caps', () => {
    const { svg } = build(figureExample);
    const tags = [...svg.matchAll(/<(\w+)/g)].map((m) => m[1]);
    expect(new Set(tags)).toEqual(new Set(['svg', 'circle', 'polygon']));
    const shapes = [...svg.matchAll(/<(circle|line|polygon)\b[^>]*>/g)].map((m) => m[0]);
    expect(shapes.length).toBeGreaterThan(10);
    for (const el of shapes) {
      expect(el).toContain('fill="none"');
      expect(el).toContain('stroke-linejoin="round"');
      expect(el).toContain('stroke-linecap="round"');
      expect(el).toContain('stroke-width="0.125"');
    }
    expect(svg).not.toContain('<path');
  });

  it('draws a line segment as a line element', () => {
    const { svg } = build({
      version: 1,
      mode: 'figure',
      grid: { divisions: 4 },
      shapes: [{ id: 'l', type: 'line', from: [-2, 0], to: [2, 1] }],
      paint: [{ stroke: ['l'], width: 0.25 }],
    });
    expect(svg).toMatch(/<line x1="-2" y1="0" x2="2" y2="-1"/);
  });
});

const figureOf = (shapes: unknown[], paint: unknown[]): unknown => ({
  version: 1,
  mode: 'figure',
  grid: { divisions: 4 },
  shapes,
  paint,
});

describe('final figure svg arcs', () => {
  const arcInput = (from: unknown, to: unknown) =>
    figureOf(
      [
        { id: 'c', type: 'circle', center: [1, 0], r: 3 },
        { id: 'a', type: 'arc', on: 'c', from, to },
      ],
      [{ stroke: ['a'], width: 0.25 }],
    );

  it('draws an arc as one unfilled path with round caps', () => {
    const { svg } = build(arcInput(30, 120));
    const paths = svg.match(/<path [^>]*>/g) ?? [];
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain('fill="none"');
    expect(paths[0]).toContain('stroke-linecap="round"');
    expect(paths[0]).toContain('stroke-width="0.25"');
    expect(svg).not.toMatch(/<circle/);
    const commands = parsePath(pathsOf(svg).join(' '));
    expect(commands[0]).toMatchObject({ cmd: 'M' });
    expect(commands.every((c) => c.cmd === 'M' || c.cmd === 'A')).toBe(true);
  });

  it('starts at the first end and runs counter-clockwise in y-up space', () => {
    const { svg } = build(arcInput(0, 90));
    const [move, arc] = parsePath(pathsOf(svg).join(' '));
    expect(move?.args[0]).toBeCloseTo(4, 6);
    expect(move?.args[1]).toBeCloseTo(0, 6);
    // Counter-clockwise in math space is sweep-flag 0 once y is flipped.
    expect(arc?.args.slice(0, 5)).toEqual([3, 3, 0, 0, 0]);
    expect(arc?.args[5]).toBeCloseTo(1, 6);
    expect(arc?.args[6]).toBeCloseTo(-3, 6);
  });

  it('splits a long sweep into arcs of at most 120 degrees on the circle', () => {
    const { svg, model } = build(arcInput(10, 350));
    const arc = model.byId.get('a');
    expect(arc?.type).toBe('arc');
    const commands = parsePath(pathsOf(svg).join(' '));
    const arcs = commands.filter((c) => c.cmd === 'A');
    expect(arcs).toHaveLength(Math.ceil(340 / 120));
    let cur: Vec = { x: commands[0]?.args[0] ?? 0, y: -(commands[0]?.args[1] ?? 0) };
    let total = 0;
    for (const { args } of arcs) {
      expect(args[3]).toBe(0);
      const end: Vec = { x: args[5] ?? 0, y: -(args[6] ?? 0) };
      expect(Math.hypot(end.x - 1, end.y)).toBeCloseTo(3, 5);
      const a0 = Math.atan2(cur.y, cur.x - 1);
      let delta = Math.atan2(end.y, end.x - 1) - a0;
      while (delta < 0) {
        delta += 2 * Math.PI;
      }
      expect((delta * 180) / Math.PI).toBeLessThanOrEqual(120 + 1e-3);
      total += delta;
      cur = end;
    }
    expect((total * 180) / Math.PI).toBeCloseTo(340, 3);
  });

  it('keeps both ends of an arc on its circle when they are intersection points', () => {
    const { svg } = build(
      figureOf(
        [
          { id: 'a', type: 'circle', r: 4 },
          { id: 'b', type: 'circle', center: [1.5, 0], r: 3.5 },
          {
            id: 's',
            type: 'arc',
            on: 'b',
            from: { intersect: ['a', 'b'], near: [2, 3] },
            to: { intersect: ['a', 'b'], near: [2, -3] },
          },
        ],
        [{ stroke: ['s'], width: 0.125 }],
      ),
    );
    const commands = parsePath(pathsOf(svg).join(' '));
    const last = commands[commands.length - 1];
    expect(commands[0]?.args[0]).toBeCloseTo(2, 6);
    expect(last?.args[5]).toBeCloseTo(2, 6);
    expect(last?.args[6]).toBeCloseTo(Math.sqrt(12), 6);
  });
});

describe('final figure svg erase layers', () => {
  const layered = (paint: unknown[]) =>
    figureOf(
      [
        { id: 'ring', type: 'circle', r: 3 },
        { id: 'disc', type: 'circle', center: [0, 3], r: 1 },
        { id: 'tri', type: 'polygon', in: 'ring', n: 3 },
        { id: 'discs', type: 'repeat', of: ['disc'], n: 4 },
      ],
      paint,
    );

  it('wraps the earlier layers in a masked group and leaves later layers outside it', () => {
    const { svg } = build(
      layered([
        { stroke: ['ring'], width: 0.125 },
        { erase: ['disc'] },
        { stroke: ['tri'], width: 0.125 },
      ]),
    );
    const group = svg.match(/<g mask="url\(#(erase-1)\)">\n([\s\S]*?)\n<\/g>/);
    expect(group?.[2]).toContain('<circle');
    expect(group?.[2]).not.toContain('<polygon');
    expect(svg.indexOf('<polygon')).toBeGreaterThan(svg.indexOf('</g>'));
    expect(svg).toContain('<defs>');
    expect(svg).toContain('<mask id="erase-1" maskUnits="userSpaceOnUse"');
  });

  it('paints the mask white everywhere and black inside each erased shape', () => {
    const { svg } = build(
      layered([{ stroke: ['ring'], width: 0.125 }, { erase: ['discs', 'tri'] }]),
    );
    const mask = (svg.match(/<mask [^>]*>([\s\S]*?)<\/mask>/)?.[1] ?? '').trim();
    expect(mask).toMatch(/^<rect [^>]*fill="#ffffff"/);
    expect(mask.match(/<circle [^>]*fill="#000000"/g)).toHaveLength(4);
    expect(mask.match(/<polygon [^>]*fill="#000000"/g)).toHaveLength(1);
    expect(svg).toContain('<circle cx="0" cy="-3"');
  });

  it('nests several erase layers so each hides everything before it', () => {
    const { svg } = build(
      layered([
        { stroke: ['ring'], width: 0.125 },
        { erase: ['disc'] },
        { stroke: ['tri'], width: 0.125 },
        { erase: ['discs'] },
      ]),
    );
    const outer = svg.indexOf('<g mask="url(#erase-3)">');
    const inner = svg.indexOf('<g mask="url(#erase-1)">');
    expect(outer).toBeGreaterThan(-1);
    expect(inner).toBeGreaterThan(outer);
    expect(svg.indexOf('<polygon')).toBeGreaterThan(svg.indexOf('</g>'));
    expect(svg.indexOf('<polygon')).toBeLessThan(svg.lastIndexOf('</g>'));
    expect(svg.match(/<mask /g)).toHaveLength(2);
    expect(svg.match(/<g mask=/g)).toHaveLength(2);
  });

  it('keeps the background transparent', () => {
    const { svg } = build(layered([{ stroke: ['ring'], width: 0.125 }, { erase: ['disc'] }]));
    expect(svg).not.toMatch(/<rect[^>]*fill="#(?!ffffff)/);
  });
});

const whaleShapes = [
  { id: 'head', type: 'circle', center: [-5, -1], r: 3 },
  { id: 'belly', type: 'circle', center: [-1, 4], r: 9 },
  { id: 'bay_l', type: 'circle', center: [1, 2], r: 2 },
  { id: 'bay_r', type: 'circle', center: [7, 2], r: 2 },
  { id: 'rump', type: 'tangent_circle', r: 2, to: ['belly', 'bay_r'], near: [3.5, -0.5] },
  { id: 'back', type: 'tangent_circle', r: 7, to: ['head', 'bay_l'], near: [-3.3, -4.6] },
  { id: 'fluke_l', type: 'circle', center: [2.5, 2.5], r: 3 },
  { id: 'fluke_r', type: 'circle', center: [5.5, 2.5], r: 3 },
  { id: 'eye', type: 'circle', center: [-5.5, 0], r: 0.5 },
  {
    id: 'whale',
    type: 'outline',
    through: [
      'belly',
      'rump',
      { on: 'bay_r', concave: true, corner: [8, 3.6] },
      { on: 'fluke_r', corner: [4.3, 5.2] },
      { on: 'fluke_l', corner: [0, 3.6] },
      { on: 'bay_l', concave: true },
      'back',
      { on: 'head', corner: [-7.5, -3] },
    ],
  },
];

const stadiumShapes = [
  { id: 'a', type: 'circle', center: [-1.5, 0], r: 1.5 },
  { id: 'b', type: 'circle', center: [1.5, 0], r: 1.5 },
  { id: 'top', type: 'line', from: [1.5, 1.5], to: [-1.5, 1.5] },
  { id: 'bottom', type: 'line', from: [-1.5, -1.5], to: [1.5, -1.5] },
  { id: 'stadium', type: 'outline', through: ['b', 'top', 'a', 'bottom'] },
];

const lensShapes = [
  { id: 'a', type: 'circle', center: [2.5, 0], r: 1.5 },
  { id: 'b', type: 'circle', center: [3.5, 0], r: 1.5 },
  {
    id: 'lens',
    type: 'outline',
    through: [
      { on: 'a', corner: [3, 1.4] },
      { on: 'b', corner: [3, -1.4] },
    ],
  },
];

const rotated = (c: Circle, deg: number): Circle => {
  const t = (deg * Math.PI) / 180;
  return {
    cx: c.cx * Math.cos(t) - c.cy * Math.sin(t),
    cy: c.cx * Math.sin(t) + c.cy * Math.cos(t),
    r: c.r,
  };
};

describe('final svg outline element', () => {
  it('derives every edge of a mark with an outline from a declared circle', () => {
    const { model, svg } = build(mark(whaleShapes, { subtract: ['whale', 'eye'] }, 8));
    const edges = checkDerived(pathsOf(svg), circlesOf(model), supportsOf(model));
    expect(edges).toBeGreaterThan(8);
  });

  it('derives every edge of an outline with straight pieces from declared circles and lines', () => {
    const { model, svg } = build(mark(stadiumShapes, 'stadium'));
    const edges = checkDerived(pathsOf(svg), circlesOf(model), supportsOf(model));
    expect(edges).toBeGreaterThan(4);
    expect(parsePath(pathsOf(svg).join(' ')).filter((c) => c.cmd === 'L').length).toBe(2);
  });

  it('derives every edge of a repeated outline from declared circles mapped by the repeat', () => {
    const shapes = [
      ...lensShapes,
      { id: 'ring', type: 'repeat', of: ['lens'], n: 3, mirror: true },
    ];
    const { model, svg } = build(mark(shapes, 'ring'));
    const declared = circlesOf(model);
    const mirroredCircle = (c: Circle): Circle => ({ cx: -c.cx, cy: c.cy, r: c.r });
    const allowed = declared.flatMap((c) =>
      [0, 120, 240].flatMap((deg) => [rotated(c, deg), rotated(mirroredCircle(c), deg)]),
    );
    const repeat = model.byId.get('ring');
    expect(repeat?.type === 'repeat' ? repeat.copies.length : 0).toBe(5);
    const edges = checkDerived(pathsOf(svg), allowed, supportsOf(model));
    expect(edges).toBeGreaterThan(12);
  });

  it('strokes an outline in a figure with M, A, L and Z only', () => {
    const { svg } = build(figureOf(stadiumShapes, [{ stroke: ['stadium'], width: 0.25 }]));
    const paths = pathsOf(svg);
    expect(paths).toHaveLength(1);
    const commands = parsePath(paths.join(' '));
    expect(new Set(commands.map((c) => c.cmd))).toEqual(new Set(['M', 'A', 'L', 'Z']));
    expect(commands.filter((c) => c.cmd === 'M')).toHaveLength(1);
    expect(commands[commands.length - 1]?.cmd).toBe('Z');
    expect(svg).not.toContain('<polygon');
    expect(paths[0]).not.toMatch(/[CQSTHV]/);
  });

  it('keeps every arc of a stroked outline on a declared circle within 120 degrees', () => {
    const { model, svg } = build(
      figureOf(
        whaleShapes.filter((s) => s.id !== 'eye'),
        [{ stroke: ['whale'], width: 0.25 }],
      ),
    );
    const paths = pathsOf(svg);
    expect(paths).toHaveLength(1);
    expect(checkDerived(paths, circlesOf(model), supportsOf(model))).toBeGreaterThan(8);
  });

  it('erases the earlier strokes inside an outline and keeps those outside', () => {
    const input = figureOf(
      [
        ...stadiumShapes,
        { id: 'bar', type: 'line', from: [-4.5, 0], to: [4.5, 0] },
        { id: 'post', type: 'line', from: [0, -4.5], to: [0, 4.5] },
      ],
      [{ stroke: ['bar', 'post'], width: 0.5 }, { erase: ['stadium'] }],
    );
    const { model, svg } = build(input);
    expect(svg).toMatch(/<mask [^>]*>[\s\S]*<path d="[^"]*" fill="#000000"\/>[\s\S]*<\/mask>/);
    const img = readPng(renderExportPng(svg, 512));
    const k = 512 / (2 * model.canvasHalf);
    const alphaAt = (x: number, y: number) =>
      img.rgba[(Math.round(256 - y * k) * 512 + Math.round(256 + x * k)) * 4 + 3];
    // The bar crosses the outline at its centre and through both round ends.
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(-2.5, 0)).toBe(0);
    expect(alphaAt(2.5, 0)).toBe(0);
    expect(alphaAt(0, 1.2)).toBe(0);
    // Outside the outline the strokes stay.
    expect(alphaAt(3.8, 0)).toBe(255);
    expect(alphaAt(0, 3.8)).toBe(255);
  });
});

type Cap = 'round' | 'butt' | 'square';
type Join = 'round' | 'miter' | 'bevel';
type Target =
  | 'circle'
  | 'line'
  | 'arc'
  | 'polygon'
  | 'points'
  | 'outline'
  | 'polyline'
  | 'rect'
  | 'oval'
  | 'repeat';

// Pairwise cover of cap x join x dash x target (seed 1): every pair appears at least once.
const PAIRWISE: [number, Cap, Join, 'none' | '2 1', Target][] = [
  [1, 'square', 'round', 'none', 'oval'],
  [2, 'round', 'miter', 'none', 'line'],
  [3, 'square', 'bevel', '2 1', 'repeat'],
  [4, 'butt', 'miter', '2 1', 'arc'],
  [5, 'butt', 'bevel', 'none', 'circle'],
  [6, 'square', 'miter', 'none', 'polygon'],
  [7, 'square', 'miter', '2 1', 'circle'],
  [8, 'round', 'round', 'none', 'arc'],
  [9, 'butt', 'round', 'none', 'points'],
  [10, 'butt', 'round', 'none', 'outline'],
  [11, 'butt', 'round', 'none', 'rect'],
  [12, 'round', 'bevel', '2 1', 'oval'],
  [13, 'butt', 'round', '2 1', 'line'],
  [14, 'round', 'bevel', '2 1', 'rect'],
  [15, 'butt', 'round', '2 1', 'polygon'],
  [16, 'square', 'miter', '2 1', 'outline'],
  [17, 'round', 'round', 'none', 'repeat'],
  [18, 'round', 'bevel', '2 1', 'points'],
  [19, 'round', 'round', '2 1', 'circle'],
  [20, 'square', 'bevel', 'none', 'polyline'],
  [21, 'butt', 'bevel', '2 1', 'polyline'],
  [22, 'square', 'bevel', 'none', 'arc'],
  [23, 'round', 'bevel', 'none', 'polygon'],
  [24, 'round', 'round', '2 1', 'polyline'],
  [25, 'square', 'miter', '2 1', 'points'],
  [26, 'square', 'bevel', '2 1', 'line'],
  [27, 'square', 'miter', '2 1', 'polyline'],
  [28, 'square', 'round', '2 1', 'rect'],
  [29, 'round', 'bevel', 'none', 'outline'],
  [30, 'butt', 'miter', 'none', 'oval'],
  [31, 'butt', 'bevel', '2 1', 'repeat'],
  [32, 'round', 'miter', 'none', 'rect'],
  [33, 'square', 'miter', 'none', 'repeat'],
];

/** Shapes for each target; the stroked element is always `t`. */
const TARGET_SHAPES: Record<Target, unknown[]> = {
  circle: [{ id: 't', type: 'circle', center: [1, 0.5], r: 7 }],
  line: [{ id: 't', type: 'line', from: [-8, -5], to: [7, 6] }],
  arc: [
    { id: 'c', type: 'circle', r: 8 },
    { id: 't', type: 'arc', on: 'c', from: 30, to: 300 },
  ],
  polygon: [
    { id: 'c', type: 'circle', r: 8 },
    { id: 't', type: 'polygon', in: 'c', n: 5, rotate: 10 },
  ],
  points: [
    {
      id: 't',
      type: 'points',
      through: [
        [-8, -6],
        [8, -6],
        [3, 7],
        [-4, 2],
      ],
    },
  ],
  outline: [
    { id: 'a', type: 'circle', center: [-4, 0], r: 4 },
    { id: 'b', type: 'circle', center: [4, 0], r: 4 },
    { id: 'top', type: 'line', from: [4, 4], to: [-4, 4] },
    { id: 'bottom', type: 'line', from: [-4, -4], to: [4, -4] },
    { id: 't', type: 'outline', through: ['b', 'top', 'a', 'bottom'] },
  ],
  polyline: [
    {
      id: 't',
      type: 'polyline',
      through: [
        [-9, -6],
        [-4, 5],
        [1, -4],
        [5, 6],
        [9, 0],
      ],
    },
  ],
  rect: [
    {
      id: 't',
      type: 'rect',
      corners: [
        [-9, -6],
        [9, 6],
      ],
    },
  ],
  oval: [{ id: 't', type: 'oval', center: [0, 0], rx: 9, ry: 5, rotate: 30 }],
  repeat: [
    // Copies stay apart: overlapping strokes blend once in one path but twice across elements.
    {
      id: 'r',
      type: 'rect',
      corners: [
        [3, -2],
        [10, 2],
      ],
      r: 1,
    },
    { id: 't', type: 'repeat', of: ['r'], n: 4 },
  ],
};

const SIDE = 256;

const raster = (svg: string): RgbaImage => {
  const image = new Resvg(svg, {
    background: '#ffffff',
    fitTo: { mode: 'width', value: SIDE },
    font: { loadSystemFonts: false },
  }).render();
  return { width: image.width, height: image.height, data: new Uint8Array(image.pixels) };
};

const kebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Segments assembled as a consumer does: a path per segment, only the attributes present. */
const consumerSvg = (set: SegmentSet): string => {
  const paths = set.segments.map((s) => {
    const attrs = Object.entries(s)
      .filter(([key]) => key !== 'd')
      .map(([key, value]) => ` ${kebab(key)}="${value}"`)
      .join('');
    const fill = 'fill' in s ? '' : ' fill="none"';
    return `<path d="${s.d}"${attrs}${fill}/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${set.canvas} ${set.canvas}">${paths.join('')}</svg>`;
};

/** Share of pixels off by more than 2, and by more than 32, in any RGBA channel. */
const differences = (a: string, b: string): { slight: number; large: number } => {
  const ia = raster(a);
  const ib = raster(b);
  return { slight: diffShare(ia, ib, 2), large: diffShare(ia, ib, 32) };
};

describe('icon drawing', () => {
  const iconOf = (shapes: unknown[], paint: unknown[]): unknown => ({
    version: 1,
    mode: 'icon',
    grid: { divisions: 12 },
    shapes,
    paint,
  });

  it('uses a 24 viewBox and one path per layer in paint order', () => {
    const { model, fills, svg } = build(
      iconOf(
        [
          {
            id: 'plate',
            type: 'rect',
            corners: [
              [-10, -10],
              [10, 10],
            ],
            r: 3,
          },
          {
            id: 'trend',
            type: 'polyline',
            through: [
              [-6, -3],
              [-2, 1],
              [2, -1],
              [6, 5],
            ],
          },
          { id: 'dot', type: 'circle', center: [6, 5], r: 1.5 },
        ],
        [
          { fill: 'plate', color: '#f3f2f1' },
          { stroke: ['trend'], width: 1.5, color: '#107c41' },
          { fill: 'dot', color: '#107c41' },
        ],
      ),
    );
    expect(svg.split('\n')[0]).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">');
    const paths = svg.match(/<path [^>]*>/g) ?? [];
    expect(paths).toHaveLength(3);
    expect(paths[0]).toContain('fill="#f3f2f1"');
    expect(paths[1]).toContain('stroke="#107c41"');
    expect(paths[1]).toContain('fill="none"');
    expect(paths[2]).toContain('fill="#107c41"');
    expect(svg).toContain(segmentPaths(renderSegments(model, fills)));
  });

  it('writes non-default caps, joins and dashes on figure elements', () => {
    const { svg } = build(
      figureOf(
        [
          {
            id: 'p',
            type: 'polyline',
            through: [
              [-2, -1],
              [0, 1],
              [2, -1],
            ],
          },
        ],
        [{ stroke: ['p'], width: 0.25, cap: 'butt', join: 'miter', dash: [0.5, 0.25] }],
      ),
    );
    expect(svg).toContain(
      '<polyline points="-2 1 0 -1 2 1" fill="none" stroke-linejoin="miter" stroke-linecap="butt" stroke="#000000" stroke-width="0.25" stroke-dasharray="0.5 0.25"/>',
    );
  });

  for (const [row, cap, join, dash, target] of PAIRWISE) {
    it(`row ${row}: ${target}, cap ${cap}, join ${join}, dash ${dash}`, () => {
      const layer = {
        stroke: ['t'],
        width: 1,
        color: '#1a5fb4',
        cap,
        join,
        ...(dash === 'none' ? {} : { dash: [2, 1] }),
      };
      const shapes = TARGET_SHAPES[target];
      const { model, fills, svg } = build(iconOf(shapes, [layer]));

      expect(svg).toContain('viewBox="0 0 24 24"');
      const paths = svg.match(/<path [^>]*>/g) ?? [];
      expect(paths).toHaveLength(1);
      const attr = (name: string) => paths[0]?.match(new RegExp(` ${name}="([^"]*)"`))?.[1];
      expect(attr('fill')).toBe('none');
      expect(attr('stroke')).toBe('#1a5fb4');
      expect(attr('stroke-width')).toBe('1');
      expect(attr('stroke-linecap')).toBe(cap);
      expect(attr('stroke-linejoin')).toBe(join);
      expect(attr('stroke-dasharray')).toBe(dash === 'none' ? undefined : '2 1');

      const consumer = differences(consumerSvg(renderSegments(model, fills)), svg);
      expect(consumer.slight).toBeLessThanOrEqual(0.0005);
      expect(consumer.large).toBe(0);

      const figure = build({
        version: 1,
        mode: 'figure',
        grid: { divisions: 8, margin: 4 },
        shapes,
        paint: [layer],
      });
      const independent = differences(figure.svg, svg);
      expect(independent.slight).toBeLessThanOrEqual(0.0005);
      expect(independent.large).toBe(0);
    });
  }
});

describe('arc on an oval', () => {
  const input = {
    version: 1,
    mode: 'icon',
    grid: { divisions: 12 },
    shapes: [
      { id: 'o', type: 'oval', center: [0, 0], rx: 3, ry: 2 },
      { id: 'a', type: 'arc', on: 'o', from: 0, to: 180 },
    ],
    paint: [{ stroke: ['a'], width: 1, color: '#107c41' }],
  };

  it('draws an open path in the final icon svg', () => {
    const { svg } = build(input);
    const paths = svg.match(/<path [^>]*>/g) ?? [];
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/ d="M15 12A[^"]*9 12"\/>$/);
    expect(paths[0]?.match(/A/g)).toHaveLength(15);
    expect(paths[0]).not.toContain('Z');
  });

  it('writes chain pieces without Z when open and with Z when closed', () => {
    const { model } = build(input);
    const run = model.byId.get('a');
    if (run?.type !== 'oval_arc') {
      throw new Error('expected an oval_arc');
    }
    const open = chainPathData(run.pieces, undefined, 1, false);
    const closed = chainPathData(run.pieces);
    expect(open.startsWith('M 3 0 A ')).toBe(true);
    expect(open.endsWith(' -3 0')).toBe(true);
    expect(open.match(/A/g)).toHaveLength(15);
    expect(open).not.toContain('Z');
    expect(closed).toBe(`${open} Z`);
  });
});
