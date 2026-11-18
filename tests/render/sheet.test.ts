import { describe, expect, it } from 'vitest';
import { arrange } from '../../src/geom/arrangement.js';
import { renderPreviewPng } from '../../src/render/png.js';
import { renderGuidesSvg, renderSheetSvg } from '../../src/render/sheet.js';
import { resolveSpec } from '../../src/resolve/resolve.js';
import type { Spec, SpecInput } from '../../src/spec/schema.js';
import { specSchema } from '../../src/spec/schema.js';

type Extras = {
  violations?: { rule: string; target: string; message: string }[];
  exceptionsApplied?: { rule: string; target: string; reason: string }[];
  underlay?: { href: string };
};

const guidesOf = (input: unknown): string => {
  const spec: Spec = specSchema.parse(input as SpecInput);
  const res = resolveSpec(spec);
  if (!res.ok) {
    throw new Error(`resolve failed: ${JSON.stringify(res.errors)}`);
  }
  return renderGuidesSvg(
    res.model,
    res.model.fills.map((f) => arrange(f.region)),
  );
};

const sheetOf = (input: unknown, extras: Extras = {}) => {
  const spec: Spec = specSchema.parse(input as SpecInput);
  const res = resolveSpec(spec);
  if (!res.ok) {
    throw new Error(`resolve failed: ${JSON.stringify(res.errors)}`);
  }
  const fills = res.model.fills.map((f) => arrange(f.region));
  return {
    spec,
    ...renderSheetSvg({
      spec,
      model: res.model,
      fills,
      violations: extras.violations ?? [],
      exceptionsApplied: extras.exceptionsApplied ?? [],
      ...(extras.underlay === undefined ? {} : { underlay: extras.underlay }),
    }),
  };
};

const CONCEPT = 'A crescent cut from one disc by a second, offset one module up and right.';

const markInput = {
  version: 1,
  mode: 'mark',
  grid: { divisions: 4 },
  concept: CONCEPT,
  shapes: [
    { id: 'body', type: 'circle', r: 'R' },
    { id: 'bite', type: 'circle', center: [1, 1], r: 3 },
  ],
  paint: [{ fill: { subtract: ['body', 'bite'] } }],
};

const figureInput = {
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
    { id: 'axis', type: 'line', from: [0, 0], to: [1, 1] },
    { id: 'hub', type: 'point', at: [1, 0] },
  ],
  paint: [{ stroke: ['outer', 'inner', 'core', 'star', 'dots'], width: 0.125 }],
};

const dataIds = (svg: string): string[] =>
  [...svg.matchAll(/data-id="([^"]*)"/g)].map((m) => m[1] ?? '');
const panelLines = (svg: string): string[] =>
  [...svg.matchAll(/<text class="line"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1] ?? '');

describe('construction sheet', () => {
  it('has exactly one construction element per declared id, repeat copies adding none', () => {
    const { spec, svg } = sheetOf(figureInput);
    const declared = spec.shapes.map((s) => s.id);
    expect(dataIds(svg).sort()).toEqual([...declared].sort());
  });

  it('represents a repeat as one group holding its copies', () => {
    const { svg } = sheetOf(figureInput);
    const group = svg.match(/<g data-id="dots" data-kind="repeat">(.*?)<\/g>/s);
    expect(group?.[1]?.match(/<circle /g)).toHaveLength(11);
  });

  it('is 1000 wide and prints the concept, ticks and a mark sheet', () => {
    const { svg, width, height } = sheetOf(markInput);
    expect(width).toBe(1000);
    expect(svg).toContain(`width="1000" height="${height}"`);
    expect(panelLines(svg)).toContain('CONCEPT');
    expect(panelLines(svg).join(' ')).toContain(CONCEPT);
    expect(svg).toMatch(/>-4<\/text>/);
    expect(svg).toMatch(/>0<\/text>/);
    expect(svg).toMatch(/>4<\/text>/);
    expect(svg).toContain('fill-opacity="0.15"');
    expect(svg).toContain('font-family="sans-serif"');
  });

  it('sets the panel height to max(360, lines * 22 + 40)', () => {
    const small = sheetOf(markInput);
    const lines = panelLines(small.svg).length;
    expect(small.height).toBe(1000 + Math.max(360, lines * 22 + 40));
    expect(small.height).toBe(1360);

    const violations = Array.from({ length: 4 }, (_, i) => ({
      rule: 'off_grid',
      target: `v${i}`,
      message: 'm',
    }));
    const exceptionsApplied = Array.from({ length: 12 }, (_, i) => ({
      rule: 'angle',
      target: `e${i}`,
      reason: 'r',
    }));
    const big = sheetOf(figureInput, { violations, exceptionsApplied });
    const bigLines = panelLines(big.svg).length;
    expect(bigLines * 22 + 40).toBeGreaterThan(360);
    expect(big.height).toBe(1000 + bigLines * 22 + 40);
  });

  it('caps the legend at 10 rows and says how many more', () => {
    const shapes = Array.from({ length: 13 }, (_, i) => ({
      id: `c${i}`,
      type: 'circle',
      center: [(i % 5) - 2, 0],
      r: 1,
    }));
    const { svg } = sheetOf({
      version: 1,
      mode: 'figure',
      grid: { divisions: 4 },
      shapes,
      paint: [{ stroke: ['c0'], width: 0.125 }],
    });
    const lines = panelLines(svg);
    expect(lines.filter((l) => /^c\d+ {2}circle/.test(l))).toHaveLength(10);
    expect(lines).toContain('+3 more');
  });

  it('prints every exception and at most four violations with a +N more line', () => {
    const exceptionsApplied = Array.from({ length: 16 }, (_, i) => ({
      rule: 'angle',
      target: `t${i}`,
      reason: `reason ${i}`,
    }));
    const violations = Array.from({ length: 6 }, (_, i) => ({
      rule: 'off_grid',
      target: `w${i}`,
      message: `bad ${i}`,
    }));
    const { svg } = sheetOf(markInput, { violations, exceptionsApplied });
    const lines = panelLines(svg);
    for (let i = 0; i < 16; i++) {
      expect(lines).toContain(`angle  t${i}  reason ${i}`);
    }
    expect(lines.filter((l) => l.startsWith('off_grid'))).toHaveLength(4);
    expect(lines).toContain('+2 more');
  });

  it('truncates long lines with an ellipsis and escapes text', () => {
    const { svg } = sheetOf(markInput, {
      exceptionsApplied: [
        { rule: 'angle', target: 'body', reason: `<b> & "q" ${'x'.repeat(200)}` },
      ],
    });
    const line = panelLines(svg).find((l) => l.startsWith('angle'));
    expect(line?.endsWith('…')).toBe(true);
    expect(line).toContain('&lt;b&gt; &amp;');
    expect(svg).not.toContain('<b>');
  });

  it('wraps a long concept into at most three lines, the last ending in an ellipsis', () => {
    const concept = 'word '.repeat(80).trim();
    const { svg } = sheetOf({ ...markInput, concept });
    const lines = panelLines(svg);
    const start = lines.indexOf('CONCEPT');
    const legend = lines.indexOf('LEGEND');
    expect(legend - start - 1).toBe(3);
    expect(lines[legend - 1]?.endsWith('…')).toBe(true);
  });

  it('omits the CONCEPT heading when no concept is given', () => {
    const { concept: _concept, ...rest } = markInput;
    const { svg } = sheetOf(rest);
    expect(panelLines(svg)).not.toContain('CONCEPT');
  });
});

const concentric = (count: number) => ({
  version: 1,
  mode: 'figure',
  grid: { divisions: 8 },
  shapes: Array.from({ length: count }, (_, i) => ({
    id: `c${i}`,
    type: 'circle',
    r: 2 + i * 0.25,
  })),
  paint: [{ stroke: ['c0'], width: 0.125 }],
});

const tagPositions = (svg: string): { id: string; x: number; y: number }[] =>
  [
    ...svg.matchAll(/<text x="([^"]*)" y="([^"]*)" font-size="12" fill="#2a6fb0">([^<]*)<\/text>/g),
  ].map((m) => ({ id: m[3] ?? '', x: Number(m[1]), y: Number(m[2]) }));

describe('sheet id tags', () => {
  it('places concentric circles at different bearings so no two tags start at one point', () => {
    const tags = tagPositions(sheetOf(concentric(8)).svg);
    expect(tags).toHaveLength(8);
    const starts = new Set(tags.map((t) => `${t.x},${t.y}`));
    expect(starts.size).toBe(8);
    for (const [i, a] of tags.entries()) {
      for (const b of tags.slice(i + 1)) {
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it('keeps tags apart when elements share an anchor', () => {
    const svg = sheetOf({
      ...concentric(1),
      shapes: [
        { id: 'a', type: 'circle', r: 3 },
        { id: 'p1', type: 'point', at: [1, 1] },
        { id: 'p2', type: 'point', at: [1, 1] },
        { id: 'p3', type: 'point', at: [1, 1] },
      ],
      paint: [{ stroke: ['a'], width: 0.125 }],
    }).svg;
    const tags = tagPositions(svg).filter((t) => t.id.startsWith('p'));
    expect(new Set(tags.map((t) => `${t.x},${t.y}`)).size).toBe(3);
  });

  it('is deterministic', () => {
    expect(sheetOf(concentric(5)).svg).toBe(sheetOf(concentric(5)).svg);
  });
});

describe('sheet figure tint', () => {
  it('draws the final figure as a light tint under the construction lines and the boxed one in full', () => {
    const { svg } = sheetOf(figureInput);
    const tint = svg.indexOf('<g opacity="0.25">');
    expect(tint).toBeGreaterThan(-1);
    expect(tint).toBeLessThan(svg.indexOf('data-id='));
    expect(svg.match(/opacity="0.25"/g)).toHaveLength(1);
    const boxed = svg.slice(svg.indexOf('stroke="#444444"'));
    expect(boxed).not.toContain('opacity="0.25"');
    expect(boxed).toContain('stroke="#000000"');
  });

  it('keeps the mark fill tint', () => {
    const { svg } = sheetOf(markInput);
    expect(svg).toContain('fill-opacity="0.15"');
    expect(svg).not.toContain('<g opacity=');
  });
});

describe('sheet arcs and erase layers', () => {
  const arcInput = {
    version: 1,
    mode: 'figure',
    grid: { divisions: 4 },
    shapes: [
      { id: 'moon', type: 'circle', r: 'R' },
      { id: 'edge', type: 'arc', on: 'moon', from: 30, to: 150 },
      { id: 'edges', type: 'repeat', of: ['edge'], n: 3 },
    ],
    paint: [{ stroke: ['edges'], width: 0.125 }],
  };

  it('shows the full parent circle thin plus the arc itself, one group per arc id', () => {
    const { svg } = sheetOf(arcInput);
    expect(dataIds(svg).sort()).toEqual(['edge', 'edges', 'moon']);
    const group = svg.match(/<g data-id="edge">(.*?)<\/g>/s)?.[1] ?? '';
    expect(group.match(/<circle /g)).toHaveLength(1);
    expect(group).toContain('r="400"');
    expect(group.match(/<path /g)).toHaveLength(1);
    expect(group).toContain('stroke-width="2"');
    expect(group).toContain('A 400 400 0 0 0');
    const copies = svg.match(/<g data-id="edges" data-kind="repeat">(.*?)<\/g>/s)?.[1] ?? '';
    expect(copies.match(/<path /g)).toHaveLength(2);
  });

  it('masks the tinted figure and the boxed figure with separate mask ids', () => {
    const { svg } = sheetOf({
      version: 1,
      mode: 'figure',
      grid: { divisions: 4 },
      shapes: [
        { id: 'a', type: 'circle', r: 'R' },
        { id: 'd', type: 'circle', center: [0, 3], r: 1 },
      ],
      paint: [{ stroke: ['a'], width: 0.125 }, { erase: ['d'] }],
    });
    const ids = [...svg.matchAll(/<mask id="([^"]*)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['area-erase-1', 'box-erase-1']);
    expect(svg).toContain('mask="url(#area-erase-1)"');
    expect(svg).toContain('mask="url(#box-erase-1)"');
  });
});

describe('guides svg', () => {
  const figureWithArc = {
    version: 1,
    mode: 'figure',
    grid: { divisions: 4 },
    shapes: [
      { id: 'moon', type: 'circle', r: 'R' },
      { id: 'edge', type: 'arc', on: 'moon', from: 30, to: 150 },
      { id: 'dot', type: 'circle', center: { on: 'moon', angle: 0 }, r: 0.5 },
      { id: 'dots', type: 'repeat', of: ['dot'], n: 4 },
      { id: 'axis', type: 'line', from: [0, 0], to: [1, 1] },
    ],
    paint: [{ stroke: ['edge', 'dots'], width: 0.125 }],
  };

  it('has the same construction elements as the sheet but no grid, ticks, tags or panel', () => {
    const svg = guidesOf(figureWithArc);
    expect(dataIds(svg)).toEqual(dataIds(sheetOf(figureWithArc).svg));
    expect(svg).toContain('viewBox="0 0 1000 1000"');
    expect(svg).not.toContain('<rect');
    expect(svg).not.toContain('<text');
    expect(svg).not.toContain('font-family');
    expect(svg).not.toContain('CONCEPT');
  });

  it('draws the final figure at full strength before the construction lines', () => {
    const svg = guidesOf(figureWithArc);
    expect(svg).not.toContain('opacity="0.25"');
    expect(svg).not.toContain('fill-opacity');
    expect(svg.indexOf('stroke="#000000"')).toBeLessThan(svg.indexOf('data-id='));
    expect(svg).toContain('stroke-width="0.125"');
  });

  it('draws the construction elements with the same code as the sheet', () => {
    const sheet = sheetOf(figureWithArc).svg;
    const guides = guidesOf(figureWithArc);
    const element = (svg: string, id: string) =>
      svg
        .match(new RegExp(`<g data-id="${id}"[^>]*>.*?</g>`, 's'))?.[0]
        ?.replace(/stroke-width="[^"]*"/g, '');
    for (const id of ['moon', 'edge', 'dots', 'axis']) {
      expect(element(guides, id)).toBe(element(sheet, id));
    }
    expect(guides.match(/<path /g)?.length).toBe(1 + 1);
  });

  it('draws the guide lines thicker than the sheet lines', () => {
    expect(guidesOf(figureWithArc)).toContain('stroke="#2a6fb0" stroke-width="1.8"');
    expect(sheetOf(figureWithArc).svg).toContain('stroke="#2a6fb0" stroke-width="0.8"');
  });

  it('extends a line guide half its length past each endpoint instead of across the canvas', () => {
    const svg = guidesOf({
      version: 1,
      mode: 'figure',
      grid: { divisions: 4 },
      shapes: [
        { id: 'frame', type: 'circle', r: 'R' },
        { id: 'tick', type: 'line', from: [3, 0], to: [4, 0] },
      ],
      paint: [{ stroke: ['frame', 'tick'], width: 0.125 }],
    });
    const group = svg.match(/<g data-id="tick">(.*?)<\/g>/s)?.[1] ?? '';
    const [x1, y1, x2, y2] = [...group.matchAll(/ (?:x1|y1|x2|y2)="([^"]+)"/g)].map((m) =>
      Number(m[1]),
    );
    // Scale is 1000 / (2 * 5) = 100 px per module, centre at 500.
    expect(x1).toBeCloseTo(500 + 2.5 * 100);
    expect(x2).toBeCloseTo(500 + 4.5 * 100);
    expect(y1).toBeCloseTo(500);
    expect(y2).toBeCloseTo(500);
  });

  it('gives every repeat placement of a line the same shortened guide', () => {
    const svg = guidesOf({
      version: 1,
      mode: 'figure',
      grid: { divisions: 4 },
      shapes: [
        { id: 'frame', type: 'circle', r: 'R' },
        { id: 'tick', type: 'line', from: [3, 0], to: [4, 0] },
        { id: 'ticks', type: 'repeat', of: ['tick'], n: 8 },
      ],
      paint: [{ stroke: ['frame', 'ticks'], width: 0.125 }],
    });
    const group = svg.match(/<g data-id="ticks"[^>]*>(.*?)<\/g>/s)?.[1] ?? '';
    const lines = [...group.matchAll(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/g)];
    expect(lines.length).toBeGreaterThan(1);
    for (const m of lines) {
      const [x1, y1, x2, y2] = m.slice(1).map(Number) as [number, number, number, number];
      expect(Math.hypot(x2 - x1, y2 - y1)).toBeCloseTo(200);
      expect(Math.min(Math.hypot(x1 - 500, y1 - 500), Math.hypot(x2 - 500, y2 - 500))).toBeCloseTo(
        250,
      );
    }
  });

  it('has a transparent background and works for a mark', () => {
    const svg = guidesOf(markInput);
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).not.toContain('fill-opacity');
    expect(dataIds(svg).sort()).toEqual(['bite', 'body']);
  });

  it('masks the figure the same way as the final svg when a layer erases', () => {
    const svg = guidesOf({
      version: 1,
      mode: 'figure',
      grid: { divisions: 4 },
      shapes: [
        { id: 'a', type: 'circle', r: 'R' },
        { id: 'd', type: 'circle', center: [0, 3], r: 1 },
      ],
      paint: [{ stroke: ['a'], width: 0.125 }, { erase: ['d'] }],
    });
    expect(svg).toContain('<mask id="erase-1"');
    expect(svg).toContain('<g mask="url(#erase-1)">');
  });
});

describe('sheet drawing area', () => {
  it('clips the final figure and the construction lines to the drawing area', () => {
    const { svg } = sheetOf({
      version: 1,
      mode: 'figure',
      grid: { divisions: 4 },
      shapes: [{ id: 'wide', type: 'circle', center: [4, 0], r: 6 }],
      paint: [{ stroke: ['wide'], width: 0.125 }],
    });
    const clip = svg.indexOf('<g clip-path="url(#drawing-area)">');
    expect(clip).toBeGreaterThan(-1);
    expect(svg).toContain(
      '<clipPath id="drawing-area"><rect x="0" y="0" width="1000" height="1000"/>',
    );
    expect(svg.indexOf('data-id="wide"')).toBeGreaterThan(clip);
  });
});

const whaleInput = {
  version: 1,
  mode: 'mark',
  grid: { divisions: 8 },
  shapes: [
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
  ],
  paint: [{ fill: { subtract: ['whale', 'eye'] } }],
};

const lensRepeatInput = {
  version: 1,
  mode: 'mark',
  grid: { divisions: 4 },
  shapes: [
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
    { id: 'ring', type: 'repeat', of: ['lens'], n: 3 },
  ],
  paint: [{ fill: 'ring' }],
};

const groupOf = (svg: string, id: string): string =>
  svg.match(new RegExp(`<g data-id="${id}"[^>]*>(.*?)</g>`, 's'))?.[1] ?? '';
const strokeOf = (el: string, attr: 'stroke' | 'stroke-width'): string | undefined =>
  el.match(new RegExp(` ${attr}="([^"]*)"`))?.[1];

describe('construction sheet outline element', () => {
  it('has one data-id group per outline holding its path and one marker per joint', () => {
    const { svg } = sheetOf(whaleInput);
    expect(dataIds(svg).filter((id) => id === 'whale')).toHaveLength(1);
    const group = groupOf(svg, 'whale');
    expect(group.match(/<path /g)).toHaveLength(1);
    // 8 pieces, 4 corners: four square markers and four round ones.
    expect(group.match(/<rect /g)).toHaveLength(4);
    expect(group.match(/<circle /g)).toHaveLength(4);
  });

  it('draws the outline in the construction colour, heavier than a plain circle', () => {
    const { svg } = sheetOf(whaleInput);
    const path = groupOf(svg, 'whale').match(/<path [^>]*>/)?.[0] ?? '';
    const circle = groupOf(svg, 'head').match(/<circle [^>]*>/)?.[0] ?? '';
    expect(strokeOf(path, 'stroke')).toBe(strokeOf(circle, 'stroke'));
    expect(Number(strokeOf(path, 'stroke-width'))).toBeGreaterThan(
      Number(strokeOf(circle, 'stroke-width')),
    );
    expect(path).toContain('fill="none"');
  });

  it('writes the outline legend line', () => {
    const { svg } = sheetOf(whaleInput);
    expect(panelLines(svg)).toContain('whale  outline  8 pieces, 4 corners');
  });

  it('draws only the paths of the copies of a repeated outline', () => {
    const { svg } = sheetOf(lensRepeatInput);
    const group = svg.match(/<g data-id="ring" data-kind="repeat">(.*?)<\/g>/s)?.[1] ?? '';
    expect(group.match(/<path /g)).toHaveLength(2);
    expect(group).not.toMatch(/<rect |<circle /);
    expect(dataIds(svg).filter((id) => id === 'ring')).toHaveLength(1);
  });

  it('draws the outline construction elements in the guides view too', () => {
    const guides = guidesOf(whaleInput);
    const group = groupOf(guides, 'whale');
    expect(group.match(/<path /g)).toHaveLength(1);
    expect(group.match(/<rect /g)).toHaveLength(4);
    expect(group.match(/<circle /g)).toHaveLength(4);
  });
});

describe('construction sheet underlay image', () => {
  const href = 'data:image/png;base64,iVBORw0KGgo=';
  const gridEnd = (svg: string): number =>
    Math.max(svg.lastIndexOf('stroke="#d9d2bf"'), svg.lastIndexOf('stroke="#b9b09a"'));

  it('covers the whole canvas inside the clipped drawing group', () => {
    const { svg } = sheetOf(markInput, { underlay: { href } });
    expect(svg.match(/<image /g)).toHaveLength(1);
    const image = svg.match(/<image [^>]*>/)?.[0] ?? '';
    expect(image).toContain('x="0" y="0" width="1000" height="1000"');
    expect(image).toContain('preserveAspectRatio="none"');
    expect(image).toContain(`href="${href}"`);
    expect(svg.indexOf('<g clip-path="url(#drawing-area)">')).toBeLessThan(svg.indexOf('<image '));
  });

  it('comes after the grid and before the tint of the final drawing', () => {
    const { svg } = sheetOf(markInput, { underlay: { href } });
    const at = svg.indexOf('<image ');
    expect(at).toBeGreaterThan(gridEnd(svg));
    expect(at).toBeLessThan(svg.indexOf('fill-opacity="0.15"'));
    expect(at).toBeLessThan(svg.indexOf('data-id='));
  });

  it('comes before the tint of a figure too', () => {
    const { svg } = sheetOf(figureInput, { underlay: { href } });
    const at = svg.indexOf('<image ');
    expect(at).toBeGreaterThan(gridEnd(svg));
    expect(at).toBeLessThan(svg.indexOf('<g opacity="0.25">'));
  });

  it('is absent without an underlay', () => {
    expect(sheetOf(markInput).svg).not.toContain('<image');
    expect(sheetOf(figureInput).svg).not.toContain('<image');
  });

  it('is absent from the guides view', () => {
    expect(guidesOf(markInput)).not.toContain('<image');
  });
});

describe('icon sheet', () => {
  const iconInput = {
    version: 1,
    mode: 'icon',
    grid: { divisions: 12 },
    concept: 'A plate, an oval and a rising line.',
    shapes: [
      {
        id: 'plate',
        type: 'rect',
        corners: [
          [-10, -8],
          [10, 6],
        ],
        r: 2,
      },
      { id: 'egg', type: 'oval', center: [0, -2], rx: 6, ry: 4 },
      {
        id: 'trend',
        type: 'polyline',
        through: [
          [-8, -6],
          [-4, -2],
          [0, -4],
          [4, 2],
          [8, 4],
        ],
      },
    ],
    paint: [
      { fill: 'plate', color: '#f3f2f1' },
      { stroke: ['egg'], width: 1, color: '#8a8f98' },
      { stroke: ['trend'], width: 1.5, color: '#107c41' },
    ],
  };

  const sheet = sheetOf(iconInput);
  const group = (svg: string, id: string): string =>
    svg.match(new RegExp(`<g data-id="${id}">.*?</g>`, 's'))?.[0] ?? '';
  const count = (s: string, re: RegExp): number => [...s.matchAll(re)].length;

  it('draws a rect outline and the centres of its corner arcs', () => {
    const g = group(sheet.svg, 'plate');
    expect(count(g, /<path /g)).toBe(1);
    expect(count(g, /<circle /g)).toBe(4);
  });

  it('draws the four construction circles and four joints of an oval', () => {
    const g = group(sheet.svg, 'egg');
    expect(count(g, /<circle [^>]*fill="none"/g)).toBe(4);
    expect(count(g, /<circle [^>]*fill="#2a6fb0"\/>/g)).toBe(4);
  });

  it('marks every vertex of a polyline', () => {
    const g = group(sheet.svg, 'trend');
    expect(count(g, /<polyline /g)).toBe(1);
    expect(count(g, /<circle /g)).toBe(5);
  });

  it('lists legend rows for the new elements', () => {
    const lines = panelLines(sheet.svg);
    expect(lines).toContain('plate  rect  20 × 14, r = 2');
    expect(
      lines.some((l) =>
        /^egg {2}oval {2}rx = 6, ry = 4, end \d+(\.\d+)?, side \d+(\.\d+)?$/.test(l),
      ),
    ).toBe(true);
    expect(lines).toContain('trend  polyline  5 points');
  });

  it('places the icon around the centre at reduced opacity, in colour', () => {
    expect(sheet.svg).toContain('<g opacity="0.35">\n<g transform="translate(-12 -12)">\n<path');
    expect(sheet.svg).toContain('fill="#f3f2f1"');
    expect(sheet.svg).toContain('stroke="#107c41"');
  });

  it('translates the icon in the guides and keeps the grid at integer lines', () => {
    const { model, fills } = (() => {
      const res = resolveSpec(specSchema.parse(iconInput as SpecInput));
      if (!res.ok) {
        throw new Error('resolve failed');
      }
      return { model: res.model, fills: res.model.fills.map((f) => arrange(f.region)) };
    })();
    expect(renderGuidesSvg(model, fills)).toContain('<g transform="translate(-12 -12)">');
    expect(count(sheet.svg, /<line x1="0" y1="[^"]*" x2="1000"/g)).toBe(25);
  });

  it('renders to PNG without error', () => {
    const png = renderPreviewPng('sheet', {
      final: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>',
      guides: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>',
      sheet: sheet,
    });
    expect(png.width).toBeGreaterThan(0);
    expect(png.png.length).toBeGreaterThan(0);
  });
});

describe('arc on an oval', () => {
  const oval = { id: 'o', type: 'oval', center: [0, 0], rx: 3, ry: 2 };
  const iconWith = (shapes: unknown[]) => ({
    version: 1,
    mode: 'icon',
    grid: { divisions: 12 },
    shapes,
    paint: [{ stroke: ['o'], width: 1, color: '#107c41' }],
  });
  const arcInput = iconWith([oval, { id: 'a', type: 'arc', on: 'o', from: 0, to: 180 }]);

  it('lists a legend row with the oval and the end directions', () => {
    expect(panelLines(sheetOf(arcInput).svg)).toContain('a  arc  on o, 0 to 180');
  });

  it('draws one open heavy path for the run', () => {
    const g = sheetOf(arcInput).svg.match(/<g data-id="a">.*?<\/g>/s)?.[0] ?? '';
    expect(g.match(/<path /g)).toHaveLength(1);
    expect(g).toContain('stroke-linecap="round"');
    expect(g).not.toContain('Z');
  });

  it('puts the tag at the middle of the run, where a point at the top of the oval would sit', () => {
    const run = tagPositions(sheetOf(arcInput).svg).find((t) => t.id === 'a');
    const pin = tagPositions(
      sheetOf(iconWith([oval, { id: 'a', type: 'point', at: [0, 2] }])).svg,
    ).find((t) => t.id === 'a');
    expect(run).toBeDefined();
    expect([run?.x, run?.y]).toEqual([pin?.x, pin?.y]);
  });
});
