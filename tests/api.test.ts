import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXAMPLES,
  exportSpec,
  GridsmithError,
  guide,
  importIcon,
  render,
  type SpecInput,
} from '../src/index.js';
import { readPng } from './helpers/png.js';

const example = (name: string): SpecInput => {
  const found = EXAMPLES.find((e) => e.name === name);
  if (found === undefined) {
    throw new Error(`no example ${name}`);
  }
  return found.spec;
};

const offGridFigure: SpecInput = {
  version: 1,
  mode: 'figure',
  grid: { divisions: 4 },
  shapes: [{ id: 'outer', type: 'circle', r: 3.3 }],
  paint: [{ stroke: ['outer'], width: 0.125 }],
};

/** The lines of the GridsmithError `fn` throws. */
async function failure(fn: () => unknown): Promise<readonly string[]> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GridsmithError);
    return (error as GridsmithError).lines;
  }
  throw new Error('expected a GridsmithError');
}

describe('render', () => {
  it('draws a mark with its sheet and guides', () => {
    const drawing = render(example('crescent'));
    expect(drawing.exportable).toBe(true);
    expect(drawing.violations).toEqual([]);
    expect(drawing.spec.mode).toBe('mark');
    for (const svg of [drawing.svg, drawing.sheetSvg, drawing.guidesSvg]) {
      expect(svg).toMatch(/^<svg /);
    }
    expect(drawing.segments).toBeNull();
  });

  it('returns the segments of an icon', () => {
    const drawing = render(example('line-chart'));
    expect(drawing.segments?.canvas).toBe(24);
    expect(drawing.segments?.segments.length).toBe(drawing.spec.paint.length);
  });

  it('reports violations without throwing', () => {
    const drawing = render(offGridFigure);
    expect(drawing.exportable).toBe(false);
    expect(drawing.violations.map((v) => v.rule)).toContain('off_grid');
  });

  it('rasterizes the drawing at the requested width', () => {
    const png = readPng(render(example('crescent')).png(64));
    expect(png.width).toBe(64);
  });

  it.each([0, 1.5, 4097])('refuses a PNG size of %s', async (size) => {
    const lines = await failure(() => render(example('crescent')).png(size));
    expect(lines[0]).toMatch(/^gridsmith: size: size is invalid/);
  });

  it('throws a GridsmithError prefixed with gridsmith for a malformed spec', async () => {
    const lines = await failure(() => render({ ...offGridFigure, mode: 'poster' } as never));
    expect(lines[0]).toMatch(/^gridsmith: spec\.mode/);
  });
});

describe('exportSpec', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gridsmith-api-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the files of the mode and returns them', async () => {
    const files = await exportSpec(example('crescent'), { dir, name: 'crescent' });
    const names = (await readdir(dir)).sort();
    expect(files.map((f) => f.path.slice(dir.length + 1)).sort()).toEqual(names);
    expect(names).toContain('crescent-64.png');
    const spec = JSON.parse(await readFile(join(dir, 'crescent.spec.json'), 'utf8'));
    expect(spec).toEqual(example('crescent'));
  });

  it('refuses existing files unless overwrite is set', async () => {
    await exportSpec(example('crescent'), { dir, name: 'mark' });
    const lines = await failure(() => exportSpec(example('crescent'), { dir, name: 'mark' }));
    expect(lines[0]).toMatch(/^gridsmith: overwrite: files already exist/);
    await expect(
      exportSpec(example('crescent'), { dir, name: 'mark', overwrite: true }),
    ).resolves.toHaveLength(8);
  });

  it('refuses a spec with violations and an invalid name', async () => {
    const violations = await failure(() => exportSpec(offGridFigure, { dir, name: 'ring' }));
    expect(violations[0]).toMatch(/^gridsmith: spec has 1 violation/);
    const name = await failure(() => exportSpec(example('crescent'), { dir, name: 'Bad Name' }));
    expect(name[0]).toMatch(/^gridsmith: name: name is invalid/);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('importIcon', () => {
  it('turns the segments of a drawn icon back into a clean spec', () => {
    const segments = render(example('line-chart')).segments?.segments ?? [];
    const report = importIcon(segments);
    expect(report.status).toBe('clean');
    expect(report.spec?.mode).toBe('icon');
  });

  it('throws a GridsmithError for malformed path data', async () => {
    const lines = await failure(() => importIcon([{ d: 'M1e400 0', fill: '#000000' }]));
    expect(lines[0]).toMatch(/^gridsmith: segments: /);
  });
});

describe('guide', () => {
  it('returns the overview by default and the rule table on request', () => {
    expect(guide().topic).toBe('overview');
    expect(guide('rules').rules).toBeInstanceOf(Array);
  });

  it('refuses an unknown topic', async () => {
    const lines = await failure(() => guide('colors' as never));
    expect(lines[0]).toMatch(/^gridsmith: topic: topic is invalid/);
  });
});
