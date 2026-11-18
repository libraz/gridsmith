import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importSegments } from '../../src/import/segments.js';
import { snapSpec } from '../../src/rules/snap.js';
import { createServer } from '../../src/server.js';
import { importIcon } from '../../src/tools/import.js';

vi.mock('../../src/rules/snap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rules/snap.js')>();
  return { ...actual, snapSpec: vi.fn(actual.snapSpec) };
});
vi.mock('../../src/import/segments.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/import/segments.js')>();
  return { ...actual, importSegments: vi.fn(actual.importSegments) };
});

type Block = { type: string; text?: string };
type ToolResult = { isError?: boolean; content: Block[] };
type Obj = Record<string, unknown>;

const TOOL = 'gridsmith_import';

const plate = { d: 'M3 5h18v14H3z', fill: '#f3f2f1' };
const trend = (d: string) => ({
  d,
  fill: 'none',
  stroke: '#107c41',
  strokeWidth: 1,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
});
const evenTrend = trend('M5 16l4-4 4 3 4-6 4 2');
const unevenTrend = trend('M3.3 17l3.1-4.6 4.2 3.2 2.5-5.4 7.3-1.3');
// A filled shape bounded by lines and an elliptical arc has no outline of lines and circles.
const bulge = { d: 'M12 12L12 3.2A8.8 6 0 0 1 20.8 12z', fill: '#0f6cbd' };
const fan = { d: 'M12 12L12 3.2A8.8 8.8 0 0 1 20.8 12z', fill: '#0f6cbd' };

const rules = (report: { violations: { rule: string }[] }): string[] =>
  report.violations.map((v) => v.rule);

describe('importIcon', () => {
  it('reports clean when everything converted and no rule is broken', () => {
    const report = importIcon(TOOL, [plate, evenTrend], { snap: true });
    expect(report.status).toBe('clean');
    expect(report.spec).not.toBeNull();
    expect(report.skipped).toEqual([]);
    expect(report.violations).toEqual([]);
    expect(report.subpaths).toBe(2);
    expect(report.snap?.applied).toBe(true);
    expect(report.diff).toBeLessThanOrEqual(0.05);
    expect(report.faithful).toBeLessThanOrEqual(0.05);
  });

  it('rounds an unevenly stepped polyline plainly and excepts its uneven_steps', () => {
    const rounded = importIcon(TOOL, [unevenTrend], { snap: true, step: 0.5 });
    expect(rounded.status).toBe('clean');
    expect(rounded.violations).toEqual([]);
    expect(rounded.snap?.applied).toBe(true);
    expect(rounded.snap?.moved).toBeGreaterThan(0);
    expect(rounded.snap?.error).toBeUndefined();
    const line = rounded.spec?.shapes.find((s) => s.type === 'polyline');
    expect(rounded.snap?.kept).toEqual([{ id: line?.id, reason: 'uneven steps' }]);
    expect(rounded.spec?.exceptions).toEqual([
      { rule: 'uneven_steps', target: line?.id, reason: 'steps as drawn in the source' },
    ]);
    // The source steps are 3.1, 4.2, 2.5, 7.3 along x; they stay uneven.
    const xs = (line as unknown as { through: number[][] }).through.map((v) => v[0] as number);
    const deltas = xs.slice(1).map((x, k) => x - (xs[k] as number));
    expect(Math.max(...deltas) - Math.min(...deltas)).toBeGreaterThan(1);
  });

  it('adds no exception for an evenly stepped polyline or without snapping', () => {
    expect(importIcon(TOOL, [plate, evenTrend], { snap: true }).spec?.exceptions).toBeUndefined();
    expect(importIcon(TOOL, [unevenTrend], { snap: false }).spec?.exceptions).toBeUndefined();
  });

  it('adds at most 16 exceptions and leaves the rest as violations', () => {
    // One layer holds 17 copies of the uneven trend, each a quarter module higher than the last.
    const many = trend(
      Array.from(
        { length: 17 },
        (_, k) => `M3.3 ${17 - k * 0.25}l3.1-4.6 4.2 3.2 2.5-5.4 7.3-1.3`,
      ).join(''),
    );
    const report = importIcon(TOOL, [many], { snap: true, step: 0.5 });
    expect(report.spec?.exceptions).toHaveLength(16);
    expect(rules(report)).toEqual(['uneven_steps']);
  });

  it('returns the spec as converted with snap false, and no snap field', () => {
    const report = importIcon(TOOL, [unevenTrend], { snap: false });
    expect(report.status).toBe('violations');
    expect(rules(report)).toContain('uneven_steps');
    expect(report.snap).toBeUndefined();
    expect(report.diff).toBe(report.faithful);
  });

  it('reports partial with the pieces of a mixed path', () => {
    const report = importIcon(TOOL, [plate, bulge], { snap: true });
    expect(report.status).toBe('partial');
    expect(report.spec).not.toBeNull();
    expect(report.skipped).toHaveLength(1);
    const [skip] = report.skipped;
    expect(skip?.reason).toBe('mixed path');
    expect(skip?.detail).toBe('ellipse');
    expect(Array.isArray(skip?.pieces)).toBe(true);
    expect(skip?.pieces?.some((p) => 'line' in p)).toBe(true);
    expect(skip?.pieces?.some((p) => 'ellipse' in p)).toBe(true);
    expect(report.subpaths).toBe(2);
  });

  it('reports partial before violations when both hold', () => {
    const report = importIcon(TOOL, [unevenTrend, bulge], { snap: false });
    expect(rules(report)).toContain('uneven_steps');
    expect(report.status).toBe('partial');
  });

  it('fails with the spec kept when a spec cannot be resolved', () => {
    const report = importIcon(TOOL, [{ d: 'M100 100h5v5z', fill: '#000000' }], { snap: true });
    expect(report.status).toBe('failed');
    expect(report.spec).not.toBeNull();
    expect(report.violations).toEqual([]);
    expect(report.diff).toBeNull();
    expect(report.snap?.applied).toBe(false);
    expect(typeof report.snap?.error).toBe('string');
  });

  it('fails without a spec when nothing converted', () => {
    const report = importIcon(TOOL, [{ d: 'M5 5', fill: '#000000' }], { snap: true });
    expect(report.status).toBe('failed');
    expect(report.spec).toBeNull();
    expect(report.snap).toBeUndefined();
    expect(report.diff).toBeNull();
    expect(report.faithful).toBeNull();
  });

  it('keeps the original spec when the snapped one does not resolve', () => {
    const original = importIcon(TOOL, [plate, evenTrend], { snap: false });
    const broken = { ...(original.spec as Obj), shapes: [{ id: 'x', type: 'circle', r: 0 }] };
    vi.mocked(snapSpec).mockClear();
    const brokenResult = { spec: broken as never, moved: 9, gap: 9, kept: [] };
    vi.mocked(snapSpec)
      .mockReturnValueOnce(brokenResult)
      .mockReturnValueOnce(brokenResult)
      .mockReturnValueOnce(brokenResult);
    const report = importIcon(TOOL, [plate, evenTrend], { snap: true });
    expect(vi.mocked(snapSpec)).toHaveBeenCalledTimes(3);
    expect(report.snap?.applied).toBe(false);
    expect(report.snap).not.toHaveProperty('step');
    expect(report.snap?.moved).toBe(0);
    expect(report.snap?.gap).toBe(0);
    expect(report.snap?.kept).toEqual([]);
    expect(report.snap?.error?.startsWith(`${TOOL}: `)).toBe(true);
    expect(report.snap?.error).not.toContain('\n');
    expect(report.spec).toEqual(original.spec);
    expect(report.status).toBe('clean');
  });

  describe('choice of the grid step', () => {
    const bar = { d: 'M4 12h16', fill: 'none', stroke: '#107c41', strokeWidth: 1 };
    const converted = importIcon(TOOL, [bar], { snap: false });
    const base = converted.spec as Obj;
    // The bar drawn at height y, on the grid step the spec of the call names.
    const variant = (y: number) => (input: { grid: Obj }) => {
      const spec = structuredClone(base) as { shapes: { from: number[]; to: number[] }[] } & Obj;
      for (const shape of spec.shapes) {
        shape.from = [shape.from[0] as number, y];
        shape.to = [shape.to[0] as number, y];
      }
      return { spec: { ...spec, grid: input.grid } as never, moved: 0, gap: 0, kept: [] };
    };
    // One snapSpec outcome per step, in the order 0.5, 0.25, 0.1.
    const script = (ys: [number, number, number]): void => {
      vi.mocked(snapSpec).mockReset();
      for (const y of ys) {
        vi.mocked(snapSpec).mockImplementationOnce(variant(y) as never);
      }
    };

    afterEach(async () => {
      const actual =
        await vi.importActual<typeof import('../../src/rules/snap.js')>('../../src/rules/snap.js');
      vi.mocked(snapSpec).mockReset().mockImplementation(actual.snapSpec);
    });

    it('takes the coarsest step when every step gives the same drawing', () => {
      script([0, 0, 0]);
      const report = importIcon(TOOL, [bar], { snap: true });
      expect(report.snap).toMatchObject({ applied: true, step: 0.5 });
      expect((report.spec as { grid: Obj }).grid).not.toHaveProperty('step', 0.25);
    });

    it('skips steps whose drawing is more than 0.005 worse than the unsnapped one', () => {
      script([0.5, 0, 0]);
      const report = importIcon(TOOL, [bar], { snap: true });
      expect(report.snap?.step).toBe(0.25);
      expect(report.diff).toBeLessThanOrEqual((report.faithful as number) + 0.005);
    });

    it('takes the closest drawing when no step is within the margin', () => {
      // Every bar sits on its grid, so violations tie and the smallest offset wins.
      script([1, 0.5, 0.7]);
      const report = importIcon(TOOL, [bar], { snap: true });
      expect(report.snap?.step).toBe(0.25);
    });

    it('prefers a violation-free step to a closer one with violations outside the margin', () => {
      // The bar at 0.55 is closest but off the 0.1 grid; 0.75 is the closer of the clean ones.
      script([1, 0.75, 0.55]);
      const report = importIcon(TOOL, [bar], { snap: true });
      expect(report.snap?.step).toBe(0.25);
      expect(report.violations).toEqual([]);
    });

    it('takes the closest drawing outside the margin when every step has violations', () => {
      // Bars at y 4 and -4; per step their heights, every step leaving a bar off its grid. The
      // 0.1 drawing moves one bar 0.35 and the other 0.01, the others one bar 0.6 and 0.8, but
      // it leaves both bars off its grid.
      const pair = [
        { ...bar, d: 'M4 8h16' },
        { ...bar, d: 'M4 16h16' },
      ];
      const two = importIcon(TOOL, pair, { snap: false }).spec as Obj;
      vi.mocked(snapSpec).mockReset();
      for (const ys of [
        [4.6, -4],
        [4.8, -4],
        [4.35, -4.01],
      ]) {
        vi.mocked(snapSpec).mockImplementationOnce(((input: { grid: Obj }) => {
          const spec = structuredClone(two) as { shapes: { from: number[]; to: number[] }[] } & Obj;
          spec.shapes.forEach((shape, k) => {
            shape.from = [shape.from[0] as number, ys[k] as number];
            shape.to = [shape.to[0] as number, ys[k] as number];
          });
          return { spec: { ...spec, grid: input.grid }, moved: 0, gap: 0, kept: [] };
        }) as never);
      }
      const report = importIcon(TOOL, pair, { snap: true });
      expect(report.snap?.step).toBe(0.1);
      expect(rules(report)).toEqual(['off_grid', 'off_grid']);
    });

    it('prefers fewer violations among the steps within the margin', () => {
      // A bar at 0.01 sits on none of the grids; only the last drawing is on its grid.
      script([0.01, 0.01, 0]);
      const report = importIcon(TOOL, [bar], { snap: true });
      expect(report.snap?.step).toBe(0.1);
      expect(report.violations).toEqual([]);
    });

    it('does not fall back to another step when the one given cannot be evaluated', () => {
      vi.mocked(snapSpec).mockReset();
      vi.mocked(snapSpec).mockImplementationOnce(((input: { grid: Obj }) => ({
        spec: { ...base, grid: input.grid, shapes: [{ id: 'x', type: 'circle', r: 0 }] },
        moved: 0,
        gap: 0,
        kept: [],
      })) as never);
      const report = importIcon(TOOL, [bar], { snap: true, step: 0.1 });
      expect(vi.mocked(snapSpec)).toHaveBeenCalledTimes(1);
      expect(report.snap?.applied).toBe(false);
      expect(report.status).toBe('clean');
    });

    it('writes grid.step into the spec snapped at a finer step, and nothing at 0.5', () => {
      const at = (step: 0.5 | 0.25 | 0.1) => importIcon(TOOL, [bar], { snap: true, step });
      expect((at(0.1).spec as { grid: Obj }).grid).toMatchObject({ step: 0.1 });
      expect(at(0.1).snap?.step).toBe(0.1);
      expect((at(0.5).spec as { grid: Obj }).grid).not.toHaveProperty('step');
    });

    it('ignores step when snap is false', () => {
      const report = importIcon(TOOL, [bar], { snap: false, step: 0.1 });
      expect(report.snap).toBeUndefined();
      expect(report.spec).toEqual(converted.spec);
    });
  });

  describe('choice of the fit tolerance', () => {
    // A conversion of n stroked circles of radius 0.5, ten to a row, 2 apart.
    const circles = (n: number): ReturnType<typeof importSegments> => {
      const ids = Array.from({ length: n }, (_, k) => `c${k}`);
      const layer = (part: string[]) => ({ stroke: part, width: 0.5, color: '#000000' });
      return {
        spec: {
          version: 1,
          mode: 'icon',
          grid: { divisions: 12 },
          shapes: ids.map((id, k) => ({
            id,
            type: 'circle' as const,
            center: [-10 + 2 * (k % 10), -10 + 2 * Math.floor(k / 10)] as [number, number],
            r: 0.5,
          })),
          paint: [layer(ids.slice(0, 32)), layer(ids.slice(32))].filter((l) => l.stroke.length),
        },
        skipped: [],
        notes: [],
        subpaths: n,
      };
    };
    // Circles per conversion at fit tolerance 0.025, 0.05 and 0.1.
    const script = (counts: [number, number, number]): void => {
      const at = new Map([0.025, 0.05, 0.1].map((t, k) => [t, counts[k] as number]));
      vi.mocked(importSegments)
        .mockReset()
        .mockImplementation((_s, options) => circles(at.get(options?.fitTolerance ?? 0) ?? 0));
    };
    const tolerances = (): (number | undefined)[] =>
      vi.mocked(importSegments).mock.calls.map((call) => call[1]?.fitTolerance);

    afterEach(async () => {
      const actual = await vi.importActual<typeof import('../../src/import/segments.js')>(
        '../../src/import/segments.js',
      );
      vi.mocked(importSegments).mockReset().mockImplementation(actual.importSegments);
    });

    it('stops at 0.025 when its spec keeps within 40 circles', () => {
      script([40, 40, 40]);
      const report = importIcon(TOOL, [plate], { snap: false });
      expect(tolerances()).toEqual([0.025]);
      expect(report.violations).toEqual([]);
    });

    it('falls to a coarser tolerance when the finer one exceeds 40 circles', () => {
      script([41, 40, 40]);
      const report = importIcon(TOOL, [plate], { snap: false });
      expect(tolerances()).toEqual([0.025, 0.05]);
      expect(report.spec?.shapes).toHaveLength(40);
      expect(report.violations).toEqual([]);
    });

    it('keeps 0.025 when every tolerance exceeds 40 circles', () => {
      script([43, 42, 41]);
      const report = importIcon(TOOL, [plate], { snap: false });
      expect(tolerances()).toEqual([0.025, 0.05, 0.1]);
      expect(report.spec?.shapes).toHaveLength(43);
      expect(rules(report)).toEqual(['circle_count']);
    });
  });

  it('throws on malformed segments', () => {
    expect(() => importIcon(TOOL, [null], { snap: true })).toThrow();
    expect(() => importIcon(TOOL, [{ d: 'M1e400 0' }], { snap: true })).toThrow(
      /number out of range/,
    );
  });
});

describe('gridsmith_import', () => {
  let client: Client;
  let closeAll: () => Promise<void>;

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
  });

  afterEach(async () => {
    await closeAll();
  });

  const call = async (args: Obj): Promise<ToolResult> =>
    (await client.callTool({ name: TOOL, arguments: args })) as ToolResult;
  const textOf = (result: ToolResult): string => result.content[0]?.text ?? '';
  const rejected = async (args: Obj, ...fragments: string[]): Promise<string> => {
    const result = await call(args);
    const text = textOf(result);
    expect(result.isError, text).toBe(true);
    expect(text.startsWith(`${TOOL}: `)).toBe(true);
    for (const fragment of fragments) {
      expect(text).toContain(fragment);
    }
    return text;
  };

  it('returns a summary with the report', async () => {
    const result = await call({ segments: [plate, unevenTrend] });
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const body = JSON.parse(textOf(result));
    expect(body.status).toBe('clean');
    expect(body.summary).toMatch(/^Imported 2 of 2 subpaths; status clean; 0 violations; diff /);
    expect(body.snap.applied).toBe(true);
    expect(body.spec.mode).toBe('icon');
    expect(body.trimmed).toBeUndefined();
  });

  it('returns the step it chose, or the one asked for', async () => {
    const auto = JSON.parse(textOf(await call({ segments: [plate, evenTrend] })));
    expect([0.5, 0.25, 0.1]).toContain(auto.snap.step);
    const asked = JSON.parse(textOf(await call({ segments: [plate, evenTrend], step: 0.1 })));
    expect(asked.snap.step).toBe(0.1);
    expect(asked.spec.grid.step).toBe(0.1);
  });

  it('does not snap when snap is false', async () => {
    const body = JSON.parse(textOf(await call({ segments: [unevenTrend], snap: false })));
    expect(body.snap).toBeUndefined();
    expect(body.status).toBe('violations');
    expect(body.summary).toContain('status violations;');
  });

  it('rejects arguments that do not fit the schema', async () => {
    await rejected({}, 'segments');
    await rejected({ segments: null }, 'segments');
    await rejected({ segments: 'M0 0' }, 'segments', 'received: "M0 0"');
    await rejected({ segments: {} }, 'segments');
    await rejected({ segments: [] }, 'segments', '1 to 64');
    await rejected({ segments: Array.from({ length: 65 }, () => plate) }, 'segments', '1 to 64');
    await rejected({ segments: [plate], snap: 0 }, 'snap', 'received: 0');
    await rejected({ segments: [plate], snap: 'true' }, 'snap', 'received: "true"');
    await rejected({ segments: [plate], snap: null }, 'snap');
    await rejected({ segments: [plate], step: 0.2 }, 'step', 'received: 0.2');
    await rejected({ segments: [plate], step: '0.1' }, 'step', 'received: "0.1"');
    await rejected({ segments: [plate], extra: 1 }, 'unknown key', 'extra');
  });

  it('turns malformed segments into tool failures', async () => {
    for (const bad of [undefined, null, 5, 'M0 0']) {
      await rejected({ segments: [bad] }, 'segments');
    }
    await rejected({ segments: [{ d: 'x' }] }, 'segments');
    await rejected({ segments: [{ d: 'M0 0L5' }] }, 'segments');
    await rejected({ segments: [{ d: 'M1e400 0' }] }, 'number out of range');
    await rejected({ segments: [{ d: `M0 0${'h1'.repeat(2100)}` }] }, 'segments');
  });

  it('drops pieces, and says so, when the result is too large', async () => {
    const wavy = `M2 12${'Q4 4 6 12T10 12'.repeat(1)}Z`;
    const many = Array.from({ length: 64 }, (_, i) => ({
      d: `${wavy}M${i % 8} 2h1v1h-1z`,
      fill: '#0f6cbd',
    }));
    const result = await call({ segments: many });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text.length).toBeLessThanOrEqual(20000);
    const body = JSON.parse(text);
    expect(body.trimmed?.[0]).toBe('pieces');
    expect(body.skipped.length).toBeGreaterThan(0);
    for (const skip of body.skipped) {
      expect(skip.pieces).toBeUndefined();
    }
  });
});

describe('filled outlines', () => {
  it('reports a filled fan without a skip and with a faithful spec', async () => {
    const report = importIcon(TOOL, [fan], { snap: false });
    expect(report.skipped).toEqual([]);
    expect(report.spec?.shapes.some((s) => s.type === 'outline')).toBe(true);
    expect(report.faithful).not.toBeNull();
    expect(report.status).not.toBe('partial');
    expect(report.status).not.toBe('failed');
  });

  it('passes the detail of a refused ring through the tool', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    const client = new Client({ name: 'gridsmith-test', version: '0.0.0' });
    await client.connect(clientTransport);
    const result = (await client.callTool({
      name: TOOL,
      arguments: { segments: [plate, bulge] },
    })) as ToolResult;
    const body = JSON.parse(result.content[0]?.text ?? '');
    expect(body.skipped[0]).toMatchObject({ reason: 'mixed path', detail: 'ellipse' });
    await client.close();
    await server.close();
  });
});
