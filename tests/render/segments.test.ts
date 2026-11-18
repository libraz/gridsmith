import { describe, expect, it } from 'vitest';
import type { FillResult } from '../../src/geom/arrangement.js';
import { arrange } from '../../src/geom/arrangement.js';
import type { SegmentSet, StrokeSegment } from '../../src/render/segments.js';
import { renderSegments, segmentPaths } from '../../src/render/segments.js';
import type { ResolvedModel } from '../../src/resolve/resolve.js';
import { resolveSpec } from '../../src/resolve/resolve.js';
import type { SpecInput } from '../../src/spec/schema.js';
import { specSchema } from '../../src/spec/schema.js';

const build = (input: unknown): { model: ResolvedModel; fills: FillResult[] } => {
  const spec = specSchema.parse(input as SpecInput);
  const res = resolveSpec(spec);
  if (!res.ok) {
    throw new Error(`resolve failed: ${JSON.stringify(res.errors)}`);
  }
  return { model: res.model, fills: res.model.fills.map((f) => arrange(f.region)) };
};

const icon = (shapes: unknown[], paint: unknown[]): unknown => ({
  version: 1,
  mode: 'icon',
  grid: { divisions: 12 },
  shapes,
  paint,
});

const segmentsOf = (input: unknown): SegmentSet => {
  const { model, fills } = build(input);
  return renderSegments(model, fills);
};

describe('icon drawing', () => {
  it('writes one segment per layer in paint order on a 24 canvas', () => {
    const set = segmentsOf(
      icon(
        [
          {
            id: 'plate',
            type: 'rect',
            corners: [
              [-10, -7],
              [10, 7],
            ],
          },
          {
            id: 'axis',
            type: 'polyline',
            through: [
              [-7, 5],
              [-7, -5],
              [7, -5],
            ],
          },
          { id: 'dot', type: 'circle', center: [4, 2], r: 1.5 },
        ],
        [
          { fill: 'plate', color: '#F3F2F1' },
          { stroke: ['axis'], width: 1.3, color: '#107C41' },
          { fill: 'dot', color: '#107c41' },
          { stroke: ['dot'], width: 0.5, cap: 'butt', join: 'miter', dash: [2, 1] },
        ],
      ),
    );
    expect(set).toEqual({
      canvas: 24,
      segments: [
        { d: 'M2 19L22 19L22 5L2 5Z', fill: '#f3f2f1', fillRule: 'evenodd' },
        {
          d: 'M5 7L5 17L19 17',
          stroke: '#107c41',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        expect.objectContaining({ fill: '#107c41', fillRule: 'evenodd' }),
        {
          d: 'M17.5 10A1.5 1.5 0 0 1 14.5 10A1.5 1.5 0 0 1 17.5 10Z',
          stroke: '#000000',
          strokeWidth: 0.5,
          strokeLinecap: 'butt',
          strokeLinejoin: 'miter',
          strokeDasharray: '2 1',
        },
      ],
    });
  });

  it('carries the stroke attributes always and the dash array only when dashed', () => {
    const set = segmentsOf(
      icon([{ id: 'l', type: 'line', from: [-5, 0], to: [5, 0] }], [{ stroke: ['l'], width: 1 }]),
    );
    const [only] = set.segments as StrokeSegment[];
    expect(Object.keys(only ?? {})).toEqual([
      'd',
      'stroke',
      'strokeWidth',
      'strokeLinecap',
      'strokeLinejoin',
    ]);
    expect(only?.d).toBe('M7 12L17 12');
    expect(typeof only?.strokeWidth).toBe('number');
  });

  it('starts every element with M and closes the closed ones', () => {
    const set = segmentsOf(
      icon(
        [
          { id: 'c', type: 'circle', r: 8 },
          { id: 'a', type: 'arc', on: 'c', from: 0, to: 90 },
          {
            id: 'p',
            type: 'points',
            through: [
              [-2, -2],
              [2, -2],
              [0, 2],
            ],
          },
          {
            id: 'q',
            type: 'rect',
            corners: [
              [-6, -4],
              [6, 4],
            ],
            r: 2,
          },
        ],
        [{ stroke: ['a', 'p', 'q'], width: 1 }],
      ),
    );
    const d = (set.segments[0] as StrokeSegment).d;
    expect(d.match(/M/g)).toHaveLength(3);
    // The arc runs counter-clockwise from 0 degrees: sweep-flag 0 after the flip.
    expect(d.startsWith('M20 12A8 8 0 0 0 12 4M10 14L14 14L12 10Z')).toBe(true);
    // A rect starts at the left end of its bottom edge.
    expect(d.slice(d.lastIndexOf('M'))).toMatch(/^M8 16L16 16A2 2 0 0 0 18 14/);
    expect(d.endsWith('Z')).toBe(true);
    expect(d).toMatch(/^[MLAZ0-9 .-]+$/);
  });

  it('rounds numbers to four decimals and drops trailing zeros', () => {
    const set = segmentsOf(
      icon(
        [{ id: 'l', type: 'line', from: [-5, 0], to: [1 / 3, 2.5] }],
        [{ stroke: ['l'], width: 1 }],
      ),
    );
    expect((set.segments[0] as StrokeSegment).d).toBe('M7 12L12.3333 9.5');
  });

  it('omits a fill without area', () => {
    const set = segmentsOf(
      icon(
        [
          { id: 'a', type: 'circle', center: [-5, 0], r: 2 },
          { id: 'b', type: 'circle', center: [5, 0], r: 2 },
        ],
        [
          { fill: { intersect: ['a', 'b'] }, color: '#ff0000' },
          { fill: 'a', color: '#00ff00' },
        ],
      ),
    );
    expect(set.segments).toHaveLength(1);
    expect(set.segments[0]).toMatchObject({ fill: '#00ff00' });
  });

  it('writes one path element per segment', () => {
    const paths = segmentPaths({
      canvas: 24,
      segments: [
        { d: 'M2 5L22 5L22 19Z', fill: '#ffffff', fillRule: 'evenodd' },
        {
          d: 'M4 15L8 11',
          stroke: '#107c41',
          strokeWidth: 1.3,
          strokeLinecap: 'butt',
          strokeLinejoin: 'bevel',
          strokeDasharray: '2 1',
        },
      ],
    });
    expect(paths).toBe(
      [
        '<path fill="#ffffff" fill-rule="evenodd" d="M2 5L22 5L22 19Z"/>',
        '<path fill="none" stroke="#107c41" stroke-width="1.3" stroke-linecap="butt" stroke-linejoin="bevel" stroke-dasharray="2 1" d="M4 15L8 11"/>',
      ].join('\n'),
    );
  });

  it('throws for a mark or a figure', () => {
    const { model, fills } = build({
      version: 1,
      mode: 'figure',
      grid: { divisions: 4 },
      shapes: [{ id: 'c', type: 'circle', r: 2 }],
      paint: [{ stroke: ['c'], width: 0.25 }],
    });
    expect(() => renderSegments(model, fills)).toThrow(Error);
  });
});

describe('arc on an oval', () => {
  // rx 3, ry 2: chord length d = sqrt(13); end radius d (d - 1) / 6, side radius d (d + 1) / 4.
  const d = Math.sqrt(13);
  const endR = (d * (d - 1)) / 6;
  const sideR = (d * (d + 1)) / 4;
  const jx = (d + 1) / 2;
  const jy = (d - 1) / 2;
  const f = (x: number): string => String(Number(x.toFixed(4)));
  const oval = { id: 'o', type: 'oval', center: [0, 0], rx: 3, ry: 2 };

  it('writes the upper half as an open path of three arcs', () => {
    const set = segmentsOf(
      icon(
        [oval, { id: 'a', type: 'arc', on: 'o', from: 0, to: 180 }],
        [{ stroke: ['a'], width: 1, color: '#107c41' }],
      ),
    );
    const expected = [
      'M15 12',
      `A${f(endR)} ${f(endR)} 0 0 0 ${f(12 + jx)} ${f(12 - jy)}`,
      `A${f(sideR)} ${f(sideR)} 0 0 0 ${f(12 - jx)} ${f(12 - jy)}`,
      `A${f(endR)} ${f(endR)} 0 0 0 9 12`,
    ].join('');
    expect(set.segments[0]).toMatchObject({ d: expected, stroke: '#107c41' });
  });

  it('closes the oval and leaves an arc on it open', () => {
    const set = segmentsOf(
      icon(
        [oval, { id: 'a', type: 'arc', on: 'o', from: 90, to: 270 }],
        [
          { stroke: ['o'], width: 1, color: '#107c41' },
          { stroke: ['a'], width: 1, color: '#107c41' },
        ],
      ),
    );
    const [closed, open] = set.segments.map((s) => ('d' in s ? s.d : ''));
    expect(closed?.endsWith('Z')).toBe(true);
    expect(open?.startsWith('M12 10')).toBe(true);
    expect(open?.endsWith('Z')).toBe(false);
    expect(open?.match(/A/g)).toHaveLength(3);
  });
});
