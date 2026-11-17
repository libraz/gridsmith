import { describe, expect, it } from 'vitest';
import type { FillResult } from '../../src/geom/arrangement.js';
import { arrange } from '../../src/geom/arrangement.js';
import type { Circle, Vec } from '../../src/geom/primitives.js';
import { renderFinalSvg } from '../../src/render/svg.js';
import type { ResolvedModel } from '../../src/resolve/resolve.js';
import { resolveSpec } from '../../src/resolve/resolve.js';
import type { SpecInput } from '../../src/spec/schema.js';
import { specSchema } from '../../src/spec/schema.js';

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

describe('final mark svg', () => {
  for (const [name, input] of configs) {
    it(`derives every edge from a declared curve: ${name}`, () => {
      const { model, svg } = build(input);
      const circles = circlesOf(model);
      const supports = supportsOf(model);
      const paths = pathsOf(svg);
      expect(paths.length).toBeGreaterThan(0);

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
