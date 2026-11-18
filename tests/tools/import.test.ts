import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapSpec } from '../../src/rules/snap.js';
import { createServer } from '../../src/server.js';
import { importIcon } from '../../src/tools/import.js';

vi.mock('../../src/rules/snap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rules/snap.js')>();
  return { ...actual, snapSpec: vi.fn(actual.snapSpec) };
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
// A filled shape bounded by a line and a bulging curve is neither a circle nor a rounded rect.
const bulge = { d: 'M4 4H20V12Q12 20 4 12Z', fill: '#0f6cbd' };

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

  it('snaps an uneven polyline into a clean one', () => {
    const rounded = importIcon(TOOL, [unevenTrend], { snap: true });
    expect(rounded.status).toBe('clean');
    expect(rounded.snap?.applied).toBe(true);
    expect(rounded.snap?.moved).toBeGreaterThan(0);
    expect(rounded.snap?.error).toBeUndefined();
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
    expect(Array.isArray(skip?.pieces)).toBe(true);
    expect(skip?.pieces?.some((p) => 'line' in p)).toBe(true);
    expect(skip?.pieces?.some((p) => 'arc' in p)).toBe(true);
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
    vi.mocked(snapSpec).mockReturnValueOnce({
      spec: broken as never,
      moved: 9,
      gap: 9,
      kept: [],
    });
    const report = importIcon(TOOL, [plate, evenTrend], { snap: true });
    expect(report.snap?.applied).toBe(false);
    expect(report.snap?.moved).toBe(0);
    expect(report.snap?.gap).toBe(0);
    expect(report.snap?.kept).toEqual([]);
    expect(report.snap?.error?.startsWith(`${TOOL}: `)).toBe(true);
    expect(report.snap?.error).not.toContain('\n');
    expect(report.spec).toEqual(original.spec);
    expect(report.status).toBe('clean');
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
