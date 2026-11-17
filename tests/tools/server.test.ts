import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXAMPLES } from '../../src/guide/examples.js';
import { RULES } from '../../src/rules/lint.js';
import { createServer } from '../../src/server.js';
import { readPng } from '../helpers/png.js';

type Block = { type: string; text?: string; data?: string; mimeType?: string };
type ToolResult = { isError?: boolean; content: Block[] };

const example = (name: string) => {
  const found = EXAMPLES.find((e) => e.name === name);
  if (found === undefined) {
    throw new Error(`no example ${name}`);
  }
  return found.spec;
};

const offGridFigure = {
  version: 1,
  mode: 'figure',
  grid: { divisions: 4 },
  shapes: [{ id: 'outer', type: 'circle', r: 3.3 }],
  paint: [{ stroke: ['outer'], width: 0.125 }],
};

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
  workDir = await mkdtemp(join(tmpdir(), 'gridsmith-server-'));
});

afterEach(async () => {
  await closeAll();
  await rm(workDir, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

const textOf = (result: ToolResult): string => {
  const first = result.content[0];
  if (first?.type !== 'text' || first.text === undefined) {
    throw new Error('first block is not text');
  }
  return first.text;
};

const jsonOf = (result: ToolResult) => JSON.parse(textOf(result)) as Record<string, unknown>;

const imagesOf = (result: ToolResult) =>
  result.content
    .filter((b) => b.type === 'image')
    .map((b) => ({ mimeType: b.mimeType, bytes: Buffer.from(b.data ?? '', 'base64') }));

// The guides view draws construction lines in blue over the drawing.
const expectBlueGuides = (rgba: Uint8Array) => {
  let blue = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if ((rgba[i + 2] ?? 0) > (rgba[i] ?? 0) + 40) {
      blue++;
    }
  }
  expect(blue).toBeGreaterThan(100);
};

const listing = async (dir: string): Promise<string[]> => (await readdir(dir)).sort();

describe('tools/list', () => {
  it('lists the three tools with their annotations', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect([...byName.keys()].sort()).toEqual([
      'gridsmith_export',
      'gridsmith_guide',
      'gridsmith_render',
    ]);
    expect(byName.get('gridsmith_guide')?.annotations).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(byName.get('gridsmith_render')?.annotations).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(byName.get('gridsmith_export')?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(0);
      expect(tool.outputSchema).toBeUndefined();
    }
  });

  it('exposes every argument as an optional property', async () => {
    const { tools } = await client.listTools();
    const keys = (name: string) =>
      Object.keys(
        (tools.find((t) => t.name === name)?.inputSchema.properties ?? {}) as Record<
          string,
          unknown
        >,
      ).sort();
    expect(keys('gridsmith_guide')).toEqual(['topic']);
    expect(keys('gridsmith_render')).toEqual(['spec', 'views']);
    expect(keys('gridsmith_export')).toEqual(['dir', 'name', 'overwrite', 'spec']);
    for (const tool of tools) {
      expect(tool.inputSchema.required ?? []).toEqual([]);
    }
  });

  it('sends the server instructions', () => {
    const instructions = client.getInstructions() ?? '';
    expect(instructions.split(/(?<=\.)\s+/)).toHaveLength(3);
    expect(instructions).toContain('gridsmith_guide');
    expect(instructions).toContain('gridsmith_render');
    expect(instructions).toContain('gridsmith_export');
  });
});

describe('gridsmith_guide', () => {
  it('serves every topic within the size budget', async () => {
    for (const topic of ['overview', 'spec', 'rules', 'examples']) {
      const result = await call('gridsmith_guide', { topic });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text.length).toBeLessThanOrEqual(20000);
      expect(JSON.parse(text).topic).toBe(topic);
      expect(text).toBe(JSON.stringify(JSON.parse(text)));
    }
  });

  it('defaults to a cheat sheet of at most 6000 characters', async () => {
    const doc = jsonOf(await call('gridsmith_guide', {}));
    expect(doc.topic).toBe('overview');
    expect(String(doc.text).length).toBeLessThanOrEqual(6000);
  });

  it('derives the rules topic from the rule table', async () => {
    const doc = jsonOf(await call('gridsmith_guide', { topic: 'rules' })) as {
      rules: { id: string; modes: string[]; description: string }[];
    };
    expect(doc.rules.map((r) => r.id)).toEqual(Object.keys(RULES));
    for (const rule of doc.rules) {
      const source = RULES[rule.id as keyof typeof RULES];
      expect(rule.description).toBe(source.description);
      expect(rule.modes).toEqual(source.modes);
    }
  });

  it('documents arcs, erase layers and the new views in the overview and the spec topic', async () => {
    const overview = String(jsonOf(await call('gridsmith_guide', { topic: 'overview' })).text);
    for (const word of ['erase', 'arc', 'intersection', 'guides_svg', 'sheet_svg']) {
      expect(overview).toContain(word);
    }
    const spec = jsonOf(await call('gridsmith_guide', { topic: 'spec' })) as {
      elements: Record<string, string>;
      layers: Record<string, string>;
      schema: unknown;
    };
    expect(spec.elements.arc).toContain('counter-clockwise');
    expect(spec.layers.erase).toContain('earlier');
    const schema = JSON.stringify(spec.schema);
    expect(schema).toContain('"arc"');
    expect(schema).toContain('"erase"');
  });

  it('lists the new views in the tool descriptions', async () => {
    const { tools } = await client.listTools();
    const render = tools.find((t) => t.name === 'gridsmith_render');
    const views = JSON.stringify(render?.inputSchema.properties) + (render?.description ?? '');
    for (const view of ['svg', 'sheet_svg', 'guides', 'guides_svg']) {
      expect(views).toContain(view);
    }
    const exported = tools.find((t) => t.name === 'gridsmith_export');
    expect(exported?.description).toContain('-guides.svg');
  });

  it('serves the spec schema and every example', async () => {
    const spec = jsonOf(await call('gridsmith_guide', { topic: 'spec' })) as {
      schema: { properties: Record<string, unknown>; $defs: Record<string, unknown> };
    };
    expect(Object.keys(spec.schema.properties)).toContain('shapes');
    expect(Object.keys(spec.schema.$defs).sort()).toEqual(['Point', 'Region']);
    const examples = jsonOf(await call('gridsmith_guide', { topic: 'examples' })) as {
      examples: { name: string; description: string; spec: unknown }[];
    };
    expect(examples.examples).toEqual(JSON.parse(JSON.stringify(EXAMPLES)));
  });
});

describe('gridsmith_render', () => {
  const REPORT_KEYS = [
    'exceptions_applied',
    'exportable',
    'geometry',
    'hints',
    'stats',
    'summary',
    'truncated',
    'violations',
  ];

  const expectInkOnOpaque = (rgba: Uint8Array) => {
    let inked = false;
    for (let i = 0; i < rgba.length; i += 4) {
      expect(rgba[i + 3]).toBe(255);
      if (rgba[i] !== rgba[0] || rgba[i + 1] !== rgba[1] || rgba[i + 2] !== rgba[2]) {
        inked = true;
      }
    }
    expect(inked).toBe(true);
  };

  it('returns the sheet and sizes for a mark by default', async () => {
    const result = await call('gridsmith_render', { spec: example('crescent') });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text.length).toBeLessThanOrEqual(20000);
    const report = JSON.parse(text);
    expect(Object.keys(report).sort()).toEqual(REPORT_KEYS);
    expect(report.exportable).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.truncated).toEqual([]);
    expect(report.stats).toHaveLength(1);
    expect(report.stats[0].loops).toBe(1);
    expect(report.stats[0].area).toBeGreaterThan(0);

    const images = imagesOf(result);
    expect(images).toHaveLength(2);
    const [sheet, sizes] = images.map((i) => ({ ...i, png: readPng(i.bytes) }));
    expect(sheet?.png.height).toBe(1024);
    expect(sheet?.png.width).toBeLessThan(1024);
    expect([sizes?.png.width, sizes?.png.height]).toEqual([384, 128]);
    for (const image of images) {
      expect(image.mimeType).toBe('image/png');
      expect(image.bytes.length).toBeLessThanOrEqual(300 * 1024);
      const png = readPng(image.bytes);
      expect(Math.max(png.width, png.height)).toBeLessThanOrEqual(1024);
      expectInkOnOpaque(png.rgba);
    }
  });

  it('returns the sheet and final drawing for a figure by default', async () => {
    const result = await call('gridsmith_render', { spec: example('hexagram-circle') });
    expect(result.isError).toBeFalsy();
    const images = imagesOf(result).map((i) => readPng(i.bytes));
    expect(images).toHaveLength(2);
    expect(images[0]?.height).toBe(1024);
    expect([images[1]?.width, images[1]?.height]).toEqual([512, 512]);
    const report = jsonOf(result) as { stats: { strokes: number }[] };
    expect(report.stats[0]?.strokes).toBeGreaterThan(0);
  });

  it('returns images in the order of views', async () => {
    const result = await call('gridsmith_render', {
      spec: example('crescent'),
      views: ['sizes', 'final', 'sheet'],
    });
    const sizes = imagesOf(result).map((i) => readPng(i.bytes));
    expect(sizes.map((p) => [p.width, p.height])).toEqual([
      [384, 128],
      [512, 512],
      [sizes[2]?.width, 1024],
    ]);
    const single = await call('gridsmith_render', { spec: example('crescent'), views: ['final'] });
    expect(imagesOf(single)).toHaveLength(1);
  });

  it('reports resolved geometry with tangent contacts', async () => {
    const report = jsonOf(
      await call('gridsmith_render', { spec: example('taiji'), views: ['final'] }),
    ) as {
      geometry: {
        id: string;
        type: string;
        cx?: number;
        cy?: number;
        r?: number;
        contacts?: unknown[];
      }[];
    };
    const upper = report.geometry.find((g) => g.id === 'upper');
    expect(upper).toMatchObject({ type: 'tangent_circle', cx: 0, cy: 2, r: 2 });
    expect(upper?.contacts).toHaveLength(2);
  });

  it('draws a violating spec and marks it not exportable', async () => {
    const result = await call('gridsmith_render', { spec: offGridFigure, views: ['final'] });
    expect(result.isError).toBeFalsy();
    const report = jsonOf(result) as { exportable: boolean; violations: { rule: string }[] };
    expect(report.exportable).toBe(false);
    expect(report.violations.map((v) => v.rule)).toContain('off_grid');
    expect(imagesOf(result)).toHaveLength(1);
  });

  it('gives the same result for a spec passed as a file path', async () => {
    const path = join(workDir, 'spec.json');
    await writeFile(path, JSON.stringify(example('crescent')));
    const byObject = await call('gridsmith_render', { spec: example('crescent') });
    const byPath = await call('gridsmith_render', { spec: path });
    expect(textOf(byPath)).toBe(textOf(byObject));
    expect(imagesOf(byPath).map((i) => i.bytes.toString('base64'))).toEqual(
      imagesOf(byObject).map((i) => i.bytes.toString('base64')),
    );
  });
});

describe('gridsmith_render svg and guides views', () => {
  const moonViews = ['svg', 'sheet_svg', 'guides_svg'];

  const textBlocks = (result: ToolResult) => result.content.filter((b) => b.type === 'text');

  it('returns the JSON first, then one block per view in order: images for PNG views, markup for SVG views', async () => {
    const result = await call('gridsmith_render', {
      spec: example('crescent-moon'),
      views: ['svg', 'final', 'sheet_svg', 'guides', 'guides_svg', 'sheet'],
    });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(result.content.map((b) => b.type)).toEqual([
      'text',
      'text',
      'image',
      'text',
      'image',
      'text',
      'image',
    ]);
    expect(JSON.parse(textOf(result)).truncated).toEqual([]);
    const [, svg, , sheetSvg, , guidesSvg] = result.content;
    expect(svg?.text).toMatch(/^<svg [^>]*viewBox="-5 -5 10 10"/);
    expect(sheetSvg?.text).toMatch(/^<svg [^>]*width="1000"/);
    expect(guidesSvg?.text).toMatch(/^<svg [^>]*viewBox="0 0 1000 1000"/);
  });

  it('returns only the SVG markup in a text block, ready to save as a file', async () => {
    const result = await call('gridsmith_render', {
      spec: example('crescent-moon'),
      views: moonViews,
    });
    expect(imagesOf(result)).toHaveLength(0);
    for (const block of textBlocks(result).slice(1)) {
      const text = block.text ?? '';
      expect(text.startsWith('<svg ')).toBe(true);
      expect(text.endsWith('</svg>')).toBe(true);
      expect(text).not.toContain('"summary"');
      expect(text.length).toBeLessThanOrEqual(60000);
    }
  });

  it('returns a sheet_svg that matches what export writes', async () => {
    const result = await call('gridsmith_render', {
      spec: example('sigil-medallions'),
      views: ['sheet_svg', 'svg', 'guides_svg'],
    });
    const [, sheet, svg, guides] = result.content;
    const dir = join(workDir, 'same');
    await call('gridsmith_export', { spec: example('sigil-medallions'), dir, name: 'm' });
    expect(await readFile(join(dir, 'm-sheet.svg'), 'utf8')).toBe(sheet?.text);
    expect(await readFile(join(dir, 'm.svg'), 'utf8')).toBe(svg?.text);
    expect(await readFile(join(dir, 'm-guides.svg'), 'utf8')).toBe(guides?.text);
  });

  it('returns guides as a 512 px PNG on white and guides_svg as transparent markup', async () => {
    const result = await call('gridsmith_render', {
      spec: example('hexagram-circle'),
      views: ['guides', 'guides_svg'],
    });
    const [image] = imagesOf(result);
    const png = readPng(image?.bytes ?? new Uint8Array());
    expect([png.width, png.height]).toEqual([512, 512]);
    expect([...png.rgba.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    expectBlueGuides(png.rgba);
    const markup = result.content[2]?.text ?? '';
    expect(markup).not.toContain('<rect');
    expect(markup).toContain('data-id="outer"');
  });

  it('returns the sheet_svg and the guides of a spec that still has violations', async () => {
    const result = await call('gridsmith_render', {
      spec: offGridFigure,
      views: ['sheet_svg', 'guides', 'guides_svg', 'svg'],
    });
    expect(result.isError).toBeFalsy();
    const report = jsonOf(result) as { exportable: boolean; truncated: string[] };
    expect(report.exportable).toBe(false);
    expect(report.truncated).toEqual([]);
    expect(result.content.map((b) => b.type)).toEqual(['text', 'text', 'image', 'text', 'text']);
    expect(result.content[1]?.text).toContain('off_grid');
  });

  it('leaves out an SVG over 60000 characters and says so in truncated', async () => {
    const circles = Array.from({ length: 8 }, (_, k) => ({
      id: `c${k}`,
      type: 'circle',
      center: [0.5 + k * 0.25, 0],
      r: 0.25,
    }));
    const spec = {
      version: 1,
      mode: 'figure',
      grid: { divisions: 4 },
      shapes: [
        ...circles,
        {
          id: 'swarm',
          type: 'repeat',
          of: circles.map((c) => c.id),
          n: 36,
          mirror: true,
          axis: 3,
        },
      ],
      paint: [{ stroke: ['swarm'], width: 0.0625 }],
    };
    const result = await call('gridsmith_render', {
      spec,
      views: ['svg', 'final', 'sheet_svg', 'guides_svg'],
    });
    expect(result.isError, textOf(result)).toBeFalsy();
    const report = jsonOf(result) as { truncated: string[] };
    expect(report.truncated).toEqual([
      'svg: too large, use gridsmith_export',
      'sheet_svg: too large, use gridsmith_export',
      'guides_svg: too large, use gridsmith_export',
    ]);
    expect(result.content.map((b) => b.type)).toEqual(['text', 'image']);
  });

  it('serves svg views for an erase layer and an arc', async () => {
    const result = await call('gridsmith_render', {
      spec: example('sigil-medallions'),
      views: ['svg', 'sheet_svg'],
    });
    const [, svg, sheet] = result.content;
    expect(svg?.text).toContain('<mask id="erase-1"');
    expect(sheet?.text).toContain('area-erase-1');
    const moon = await call('gridsmith_render', { spec: example('crescent-moon'), views: ['svg'] });
    expect(moon.content[1]?.text).toContain('<path d="M ');
  });

  it('describes an arc and an erase layer in the report', async () => {
    const moon = jsonOf(
      await call('gridsmith_render', { spec: example('crescent-moon'), views: ['svg'] }),
    ) as { geometry: Record<string, unknown>[] };
    expect(moon.geometry.find((g) => g.id === 'outer_edge')).toMatchObject({
      type: 'arc',
      cx: 0,
      cy: 0,
      r: 4,
      from: 60,
      to: 300,
    });
    const sigil = jsonOf(
      await call('gridsmith_render', { spec: example('sigil-medallions'), views: ['svg'] }),
    ) as { stats: Record<string, number>[]; violations: unknown[] };
    expect(sigil.violations).toEqual([]);
    expect(sigil.stats.map((s) => Object.keys(s).sort().join())).toEqual([
      'paint,strokes',
      'erases,paint',
      'paint,strokes',
      'paint,strokes',
    ]);
    expect(sigil.stats[1]?.erases).toBe(8);
  });
});

describe('gridsmith_export', () => {
  const MARK_FILES = [
    'logo-16.png',
    'logo-32.png',
    'logo-512.png',
    'logo-64.png',
    'logo-guides.svg',
    'logo-sheet.svg',
    'logo.spec.json',
    'logo.svg',
  ];
  const FIGURE_FILES = [
    'circle-1024.png',
    'circle-guides.svg',
    'circle-sheet.svg',
    'circle.spec.json',
    'circle.svg',
  ];

  it('refuses a spec with violations and writes nothing', async () => {
    const dir = join(workDir, 'out');
    const result = await call('gridsmith_export', { spec: offGridFigure, dir, name: 'bad' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^gridsmith_export: /);
    expect(textOf(result)).toContain('off_grid');
    await expect(stat(dir)).rejects.toThrow();

    await mkdir(dir);
    const again = await call('gridsmith_export', { spec: offGridFigure, dir, name: 'bad' });
    expect(again.isError).toBe(true);
    expect(await listing(dir)).toEqual([]);
  });

  it('writes the documented files of a mark, creating the directory', async () => {
    const dir = join(workDir, 'nested', 'out');
    const result = await call('gridsmith_export', { spec: example('crescent'), dir, name: 'logo' });
    expect(result.isError).toBeFalsy();
    expect(await listing(dir)).toEqual(MARK_FILES);

    const report = jsonOf(result) as { summary: string; files: { path: string; bytes: number }[] };
    expect(report.files.map((f) => f.path).sort()).toEqual(MARK_FILES.map((f) => join(dir, f)));
    for (const file of report.files) {
      expect((await stat(file.path)).size).toBe(file.bytes);
    }

    expect(JSON.parse(await readFile(join(dir, 'logo.spec.json'), 'utf8'))).toEqual(
      example('crescent'),
    );
    expect(await readFile(join(dir, 'logo.svg'), 'utf8')).toMatch(/^<svg /);
    expect(await readFile(join(dir, 'logo-sheet.svg'), 'utf8')).toMatch(/^<svg /);
    const sizes = [16, 32, 64, 512];
    for (const size of sizes) {
      const png = readPng(await readFile(join(dir, `logo-${size}.png`)));
      expect([png.width, png.height]).toEqual([size, size]);
      expect(png.rgba.some((_, i) => i % 4 === 3 && png.rgba[i] === 0)).toBe(true);
    }
  });

  it('writes the documented files of a figure', async () => {
    const result = await call('gridsmith_export', {
      spec: example('hexagram-circle'),
      dir: workDir,
      name: 'circle',
    });
    expect(result.isError).toBeFalsy();
    expect(await listing(workDir)).toEqual(FIGURE_FILES);
    const png = readPng(await readFile(join(workDir, 'circle-1024.png')));
    expect([png.width, png.height]).toEqual([1024, 1024]);
  });

  it('refuses to replace existing files and leaves them unchanged', async () => {
    const args = { spec: example('crescent'), dir: workDir, name: 'logo' };
    expect((await call('gridsmith_export', args)).isError).toBeFalsy();
    const before = new Map<string, Buffer>();
    for (const file of MARK_FILES) {
      before.set(file, await readFile(join(workDir, file)));
    }

    const second = await call('gridsmith_export', args);
    expect(second.isError).toBe(true);
    expect(textOf(second)).toMatch(/^gridsmith_export: overwrite: /);
    expect(await listing(workDir)).toEqual(MARK_FILES);
    for (const file of MARK_FILES) {
      expect((await readFile(join(workDir, file))).equals(before.get(file) as Buffer)).toBe(true);
    }
  });

  it('replaces existing files when overwrite is true', async () => {
    const args = { spec: example('crescent'), dir: workDir, name: 'logo' };
    await call('gridsmith_export', args);
    const original = await readFile(join(workDir, 'logo.svg'));
    await writeFile(join(workDir, 'logo.svg'), 'stale');
    await writeFile(join(workDir, 'logo-16.png'), 'stale');

    const result = await call('gridsmith_export', { ...args, overwrite: true });
    expect(result.isError).toBeFalsy();
    expect((await readFile(join(workDir, 'logo.svg'))).equals(original)).toBe(true);
    expect(readPng(await readFile(join(workDir, 'logo-16.png'))).width).toBe(16);
    expect(await listing(workDir)).toEqual(MARK_FILES);
  });

  it('exports the same files from a spec path as from an object', async () => {
    const path = join(workDir, 'input.json');
    await writeFile(path, JSON.stringify(example('crescent')));
    const byObject = join(workDir, 'a');
    const byPath = join(workDir, 'b');
    await call('gridsmith_export', { spec: example('crescent'), dir: byObject, name: 'logo' });
    const result = await call('gridsmith_export', { spec: path, dir: byPath, name: 'logo' });
    expect(result.isError).toBeFalsy();
    for (const file of MARK_FILES) {
      const a = await readFile(join(byObject, file));
      const b = await readFile(join(byPath, file));
      expect(b.equals(a)).toBe(true);
    }
  });

  it('accepts the spec file that is itself <dir>/<name>.spec.json and leaves it untouched', async () => {
    const path = join(workDir, 'logo.spec.json');
    const original = JSON.stringify(example('crescent'));
    await writeFile(path, original);
    const before = await stat(path);

    const result = await call('gridsmith_export', { spec: path, dir: workDir, name: 'logo' });
    expect(result.isError).toBeFalsy();
    expect(await listing(workDir)).toEqual(MARK_FILES);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    const report = jsonOf(result) as { files: { path: string }[] };
    expect(report.files.map((f) => f.path)).not.toContain(path);
    expect(report.files).toHaveLength(MARK_FILES.length - 1);
  });

  it('writes the guides svg next to the others and includes it in the overwrite check', async () => {
    const args = { spec: example('crescent-moon'), dir: workDir, name: 'moon' };
    const result = await call('gridsmith_export', args);
    expect(result.isError, textOf(result)).toBeFalsy();
    const guides = await readFile(join(workDir, 'moon-guides.svg'), 'utf8');
    expect(guides).toMatch(/^<svg /);
    expect(guides).toContain('data-id="outer_edge"');
    await rm(join(workDir, 'moon.svg'));
    await rm(join(workDir, 'moon-1024.png'));
    await rm(join(workDir, 'moon-sheet.svg'));
    await rm(join(workDir, 'moon.spec.json'));
    const again = await call('gridsmith_export', args);
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain('moon-guides.svg');
    expect(await listing(workDir)).toEqual(['moon-guides.svg']);
  });

  it('leaves no temporary files behind', async () => {
    await call('gridsmith_export', { spec: example('crescent'), dir: workDir, name: 'logo' });
    await call('gridsmith_export', { spec: example('crescent'), dir: workDir, name: 'logo' });
    expect((await listing(workDir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
