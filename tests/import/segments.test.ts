import { describe, expect, it } from 'vitest';
import { type ImportSegment, importSegments, segmentsToSvg } from '../../src/import/segments.js';
import { specSchema } from '../../src/spec/schema.js';

const BLACK = '#1f1f1f';

/** Imports and checks that a non-null spec passes the schema. */
const convert = (segments: ImportSegment[]) => {
  const result = importSegments(segments);
  if (result.spec !== null) {
    expect(() => specSchema.parse(result.spec)).not.toThrow();
  }
  return result;
};

const stroked = (d: string, extra: Partial<ImportSegment> = {}): ImportSegment => ({
  d,
  fill: 'none',
  stroke: BLACK,
  strokeWidth: '1',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  ...extra,
});

const filled = (d: string, extra: Partial<ImportSegment> = {}): ImportSegment => ({
  d,
  fill: BLACK,
  ...extra,
});

const shapesOf = (segments: ImportSegment[]) => convert(segments).spec?.shapes;
const paintOf = (segments: ImportSegment[]) => convert(segments).spec?.paint;
const skipsOf = (segments: ImportSegment[]) => convert(segments).skipped.map((s) => s.reason);

const roundStroke = { width: 1, color: BLACK, cap: 'round', join: 'round' };

describe('importSegments conversion table', () => {
  it('wraps the elements in an icon spec', () => {
    expect(convert([stroked('M2 2H8')])).toEqual({
      spec: {
        version: 1,
        mode: 'icon',
        grid: { divisions: 12 },
        shapes: [{ id: 's0_0', type: 'line', from: [-10, 10], to: [-4, 10] }],
        paint: [{ stroke: ['s0_0'], ...roundStroke }],
      },
      skipped: [],
      notes: [],
      subpaths: 1,
    });
  });

  it('bakes translate and uniform scale into points, width and dash', () => {
    const segment = stroked('M2 2H6', {
      strokeDasharray: '1 0.5',
      transform: 'translate(1 1) scale(2)',
    });
    expect(convert([segment]).spec).toMatchObject({
      shapes: [{ id: 's0_0', type: 'line', from: [-7, 7], to: [1, 7] }],
      paint: [{ stroke: ['s0_0'], width: 2, dash: [2, 1] }],
    });
  });

  it('bakes rotate about a centre into points', () => {
    expect(shapesOf([stroked('M12 2V6', { transform: 'rotate(90 12 12)' })])).toEqual([
      { id: 's0_0', type: 'line', from: [10, 0], to: [6, 0] },
    ]);
  });

  it('skips the whole segment for a non-uniform scale or another transform function', () => {
    expect(skipsOf([stroked('M2 2H6M2 4H6', { transform: 'scale(1 2)' })])).toEqual([
      'non-uniform scale',
      'non-uniform scale',
    ]);
    expect(skipsOf([stroked('M2 2H6', { transform: 'matrix(1 0 0 1 0 0)' })])).toEqual([
      'transform',
    ]);
    expect(skipsOf([stroked('M2 2H6', { transform: 'skewX(10)' })])).toEqual(['transform']);
  });

  it('drops repeated vertices and an L back to the start before Z', () => {
    expect(shapesOf([filled('M2 2L10 2L10 2.00005L10 10L2 2Z')])).toEqual([
      {
        id: 's0_0',
        type: 'points',
        through: [
          [-10, 10],
          [-2, 10],
          [-2, 2],
        ],
      },
    ]);
  });

  it('paints a zero-length round-capped subpath as a dot right after its stroke layer', () => {
    const result = convert([stroked('M2 2H8M5 5v0M6 6L6 6', { strokeWidth: '1.2' })]);
    expect(result.spec).toEqual({
      version: 1,
      mode: 'icon',
      grid: { divisions: 12 },
      shapes: [
        { id: 's0_0', type: 'line', from: [-10, 10], to: [-4, 10] },
        { id: 's0_1d', type: 'circle', center: [-7, 7], r: 0.6 },
        { id: 's0_2d', type: 'circle', center: [-6, 6], r: 0.6 },
      ],
      paint: [
        { stroke: ['s0_0'], ...roundStroke, width: 1.2 },
        { fill: { union: ['s0_1d', 's0_2d'] }, color: BLACK },
      ],
    });
  });

  it('ignores a butt-capped dot and skips a square-capped one', () => {
    expect(convert([stroked('M2 2H8M5 5v0', { strokeLinecap: 'butt' })]).skipped).toEqual([]);
    expect(convert([stroked('M2 2H8M5 5v0', { strokeLinecap: 'square' })]).skipped).toEqual([
      { segment: 0, subpath: 1, reason: 'dot' },
    ]);
  });

  it('turns an open two-point subpath into a line', () => {
    expect(shapesOf([stroked('M1 23L23 1')])).toEqual([
      { id: 's0_0', type: 'line', from: [-11, -11], to: [11, 11] },
    ]);
  });

  it('turns an open subpath of 3 to 32 points into a polyline', () => {
    expect(shapesOf([stroked('M2.8 18.6l4.6-5 4.2 3.2 5.4-6.4')])).toEqual([
      {
        id: 's0_0',
        type: 'polyline',
        through: [
          [-9.2, -6.6],
          [-4.6, -1.6],
          [-0.4, -4.8],
          [5, 1.6],
        ],
      },
    ]);
  });

  it('turns a closed axis-parallel 4-point subpath into a rect', () => {
    expect(shapesOf([filled('M2 5h20v14H2z')])).toEqual([
      {
        id: 's0_0',
        type: 'rect',
        corners: [
          [-10, -7],
          [10, 7],
        ],
      },
    ]);
  });

  it('keeps a dashed closed axis-parallel 4-point subpath as points in path order', () => {
    // The dash pattern starts at the first vertex and runs along the path, top-left clockwise.
    const d = 'M2.6 2.6h18.8v18.8h-18.8z';
    const through = [
      [-9.4, 9.4],
      [9.4, 9.4],
      [9.4, -9.4],
      [-9.4, -9.4],
    ];
    const dashed = { strokeDasharray: '1 1.35', strokeLinecap: 'butt' };
    expect(convert([stroked(d, dashed)])).toMatchObject({
      spec: {
        shapes: [{ id: 's0_0', type: 'points', through }],
        paint: [{ stroke: ['s0_0'], dash: [1, 1.35] }],
      },
      notes: [],
    });
    expect(convert([stroked(d, { ...dashed, fill: '#ffffff' })]).spec).toMatchObject({
      shapes: [{ id: 's0_0', type: 'points', through }],
      paint: [{ fill: 's0_0' }, { stroke: ['s0_0'], dash: [1, 1.35] }],
    });
  });

  it('converts a dashed circle, oval and rounded rect as they are, with a note dash phase', () => {
    const dashed = { strokeDasharray: '1 1' };
    const cases: [string, string][] = [
      ['M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0z', 'circle'],
      ['M6 12a6 4 0 1 0 12 0a6 4 0 1 0 -12 0z', 'oval'],
      ['M6 9h12a3 3 0 0 1 0 6h-12a3 3 0 0 1 0 -6z', 'rect'],
    ];
    for (const [d, type] of cases) {
      const result = convert([stroked(d, dashed)]);
      expect(result.spec?.shapes).toMatchObject([{ id: 's0_0', type }]);
      expect(result.notes).toEqual([{ segment: 0, subpath: 0, note: 'dash phase' }]);
      expect(convert([stroked(d)]).notes).toEqual([]);
    }
  });

  it('turns any other closed line subpath into points', () => {
    expect(shapesOf([filled('M3.6 6.2L6.5 4.13L6.5 8.27z')])).toEqual([
      {
        id: 's0_0',
        type: 'points',
        through: [
          [-8.4, 5.8],
          [-5.5, 7.87],
          [-5.5, 3.73],
        ],
      },
    ]);
  });

  it('skips a line subpath of 33 points or more', () => {
    const d = `M0 0${'h0.5v0.5'.repeat(16)}`;
    expect(convert([stroked(d)]).skipped).toEqual([
      { segment: 0, subpath: 0, reason: 'too many points' },
    ]);
  });

  it('turns two equal-radius arcs into a circle', () => {
    expect(convert([filled('M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0z')])).toMatchObject({
      spec: { shapes: [{ id: 's0_0', type: 'circle', center: [0, 0], r: 4 }] },
      notes: [],
    });
  });

  it('accepts an arc pair whose chord misses the diameter by up to 0.02, with a note', () => {
    // Chord 7.99 under r 4: each large arc's centre sits sqrt(16 - 3.995^2) off the chord on
    // the arc's own side, so the pair reaches 4 along the chord and further across it.
    const result = convert([filled('M8 12a4 4 0 1 0 7.99 0a4 4 0 1 0 -7.99 0z')]);
    expect(result).toMatchObject({
      spec: { shapes: [{ id: 's0_0', type: 'oval', center: [-0.005, 0], rx: 4, rotate: 0 }] },
      notes: [{ segment: 0, subpath: 0, note: 'rounded arc pair' }],
    });
    const [oval] = result.spec?.shapes ?? [];
    expect(oval?.type === 'oval' ? oval.ry : undefined).toBeCloseTo(
      4 + Math.sqrt(16 - 3.995 ** 2),
      4,
    );
    // A chord 0.1 off the diameter is no pair, but the two arcs still bound an outline.
    const loose = convert([filled('M8 12a4 4 0 1 0 7.9 0a4 4 0 1 0 -7.9 0z')]);
    expect(loose.skipped).toEqual([]);
    expect(loose.spec?.shapes.some((s) => s.type === 'outline')).toBe(true);
  });

  it('reads an arc pair whose chord exceeds the diameter as one circle of the scaled radius', () => {
    // Chord 8.01 over r 4: SVG scales the radius to half the chord and centres it on the chord.
    expect(convert([filled('M8 12a4 4 0 1 0 8.01 0a4 4 0 1 0 -8.01 0z')])).toMatchObject({
      spec: { shapes: [{ id: 's0_0', type: 'circle', center: [0.005, 0], r: 4.005 }] },
      notes: [{ segment: 0, subpath: 0, note: 'rounded arc pair' }],
    });
  });

  it('stretches an elliptical arc pair across a chord short of the diameter, filled or stroked', () => {
    // Chord 4.09 along rx 2.05: each centre sits 3.3 * sqrt(1 - (2.045 / 2.05)^2) off the chord.
    const d = 'M8.82 7.4a2.05 3.3 0 1 0 4.09 0a2.05 3.3 0 1 0 -4.09 0z';
    const fill = convert([filled(d)]);
    expect(fill).toMatchObject({
      spec: { shapes: [{ id: 's0_0', type: 'oval', center: [-1.135, 4.6], rx: 2.05, rotate: 0 }] },
      notes: [{ segment: 0, subpath: 0, note: 'rounded arc pair' }],
    });
    const [oval] = fill.spec?.shapes ?? [];
    expect(oval?.type === 'oval' ? oval.ry : undefined).toBeCloseTo(
      3.3 + 3.3 * Math.sqrt(1 - (2.045 / 2.05) ** 2),
      4,
    );
    expect(shapesOf([stroked(d)])).toEqual(fill.spec?.shapes);
  });

  it('turns two elliptical arcs into an oval, taking the rotation from the transform', () => {
    expect(shapesOf([stroked('M6 12a6 4 0 1 0 12 0a6 4 0 1 0 -12 0z')])).toEqual([
      { id: 's0_0', type: 'oval', center: [0, 0], rx: 6, ry: 4, rotate: 0 },
    ]);
    expect(
      shapesOf([
        stroked('M6 12a6 4 0 1 0 12 0a6 4 0 1 0 -12 0z', { transform: 'rotate(-30 12 12)' }),
      ]),
    ).toEqual([{ id: 's0_0', type: 'oval', center: [0, 0], rx: 6, ry: 4, rotate: 30 }]);
  });

  it('turns four lines and four equal quarter arcs into a rect with r', () => {
    const d =
      'M5.2 4h13.6a1.2 1.2 0 0 1 1.2 1.2v15.6a1.2 1.2 0 0 1 -1.2 1.2h-13.6a1.2 1.2 0 0 1 -1.2 -1.2v-15.6a1.2 1.2 0 0 1 1.2 -1.2z';
    expect(convert([filled(d)])).toMatchObject({
      spec: {
        shapes: [
          {
            id: 's0_0',
            type: 'rect',
            corners: [
              [-8, -10],
              [8, 8],
            ],
            r: 1.2,
          },
        ],
      },
      notes: [],
    });
  });

  it('turns two lines and two half arcs into a pill rect', () => {
    expect(shapesOf([filled('M6 9h12a3 3 0 0 1 0 6h-12a3 3 0 0 1 0 -6z')])).toEqual([
      {
        id: 's0_0',
        type: 'rect',
        corners: [
          [-9, -3],
          [9, 3],
        ],
        r: 3,
      },
    ]);
  });

  it('turns four quarter arcs joined by zero-length lines into a pill rect', () => {
    const d =
      'M11.1 1h1.8a1.2 1.2 0 0 1 1.2 1.2v0a1.2 1.2 0 0 1 -1.2 1.2h-1.8a1.2 1.2 0 0 1 -1.2 -1.2v0a1.2 1.2 0 0 1 1.2 -1.2z';
    expect(convert([filled(d)])).toMatchObject({
      spec: {
        shapes: [
          {
            id: 's0_0',
            type: 'rect',
            corners: [
              [-2.1, 8.6],
              [2.1, 11],
            ],
            r: 1.2,
          },
        ],
      },
      notes: [],
    });
  });

  it('turns four quarter arcs joined by zero-length lines on all sides into a circle', () => {
    const d = 'M6.2 15h0a3 3 0 0 1 3 3v0a3 3 0 0 1 -3 3h0a3 3 0 0 1 -3 -3v0a3 3 0 0 1 3 -3z';
    expect(convert([filled(d)])).toMatchObject({
      spec: { shapes: [{ id: 's0_0', type: 'circle', center: [-5.8, -6], r: 3 }] },
      skipped: [],
    });
  });

  it('rounds r up to half the short side within 0.02, with a note', () => {
    const d =
      'M3 2h4a1.995 1.995 0 0 1 1.995 1.995v.01a1.995 1.995 0 0 1 -1.995 1.995h-4a1.995 1.995 0 0 1 -1.995 -1.995v-.01a1.995 1.995 0 0 1 1.995 -1.995z';
    expect(convert([filled(d)])).toMatchObject({
      spec: {
        shapes: [
          {
            id: 's0_0',
            type: 'rect',
            corners: [
              [-10.995, 6],
              [-3.005, 10],
            ],
            r: 2,
          },
        ],
      },
      notes: [{ segment: 0, subpath: 0, note: 'near pill' }],
    });
  });

  it('turns a single open circular arc into a helper circle and an arc', () => {
    expect(shapesOf([stroked('M12 4a8 8 0 0 1 8 8')])).toEqual([
      { id: 's0_0c', type: 'circle', center: [0, 0], r: 8 },
      { id: 's0_0', type: 'arc', on: 's0_0c', from: 0, to: 90 },
    ]);
    expect(shapesOf([stroked('M12 4a8 8 0 0 0 -8 8')])).toEqual([
      { id: 's0_0c', type: 'circle', center: [0, 0], r: 8 },
      { id: 's0_0', type: 'arc', on: 's0_0c', from: 90, to: 180 },
    ]);
  });

  it('splits an open round line/arc mix into parts on one stroke layer', () => {
    const result = convert([
      stroked('M3.6 6.2h9.8a6.2 6.2 0 0 1 0 12.4H7.6', { strokeWidth: '1.15' }),
    ]);
    expect(result.spec).toEqual({
      version: 1,
      mode: 'icon',
      grid: { divisions: 12 },
      shapes: [
        { id: 's0_0a', type: 'line', from: [-8.4, 5.8], to: [1.4, 5.8] },
        { id: 's0_0bc', type: 'circle', center: [1.4, -0.4], r: 6.2 },
        { id: 's0_0b', type: 'arc', on: 's0_0bc', from: 270, to: 90 },
        { id: 's0_0c', type: 'line', from: [1.4, -6.6], to: [-4.4, -6.6] },
      ],
      paint: [{ stroke: ['s0_0a', 's0_0b', 's0_0c'], ...roundStroke, width: 1.15 }],
    });
  });

  it('splits an open round chain made only of arcs', () => {
    expect(shapesOf([stroked('M4 12a4 4 0 0 1 8 0a4 4 0 0 0 8 0')])).toEqual([
      { id: 's0_0ac', type: 'circle', center: [-4, 0], r: 4 },
      { id: 's0_0a', type: 'arc', on: 's0_0ac', from: 0, to: 180 },
      { id: 's0_0bc', type: 'circle', center: [4, 0], r: 4 },
      { id: 's0_0b', type: 'arc', on: 's0_0bc', from: 180, to: 0 },
    ]);
  });

  it('splits a closed round unfilled line/arc ring, closing edge included', () => {
    expect(convert([stroked('M6 8H14A4 4 0 0 1 14 16H6Z')]).spec).toMatchObject({
      shapes: [
        { id: 's0_0a', type: 'line', from: [-6, 4], to: [2, 4] },
        { id: 's0_0bc', type: 'circle', center: [2, 0], r: 4 },
        { id: 's0_0b', type: 'arc', on: 's0_0bc', from: 270, to: 90 },
        {
          id: 's0_0c',
          type: 'polyline',
          through: [
            [2, -4],
            [-6, -4],
            [-6, 4],
          ],
        },
      ],
      paint: [{ stroke: ['s0_0a', 's0_0b', 's0_0c'], ...roundStroke }],
    });
  });

  it('splits a closed round unfilled chain of two arcs that is no circle', () => {
    // Chord 8 under radius 6: the centres sit sqrt(20) below and above it.
    expect(shapesOf([stroked('M8 12A6 6 0 0 1 16 12A6 6 0 0 1 8 12Z')])).toEqual([
      { id: 's0_0ac', type: 'circle', center: [0, -4.4721], r: 6 },
      { id: 's0_0a', type: 'arc', on: 's0_0ac', from: 48.1897, to: 131.8103 },
      { id: 's0_0bc', type: 'circle', center: [0, 4.4721], r: 6 },
      { id: 's0_0b', type: 'arc', on: 's0_0bc', from: 228.1897, to: 311.8103 },
    ]);
  });

  it('skips the other arc subpaths as mixed path', () => {
    // Part of a narrow ellipse with butt caps.
    const part = 'M7.3 19.07A1 5 0 1 1 7.3 15.33';
    expect(skipsOf([stroked(part, { strokeLinecap: 'butt' })])).toEqual(['mixed path']);
    // A closed ring with butt caps.
    const ring = 'M6 8H14A4 4 0 0 1 14 16H6Z';
    expect(skipsOf([stroked(ring, { strokeLinecap: 'butt' })])).toEqual(['mixed path']);
    // A mix with butt caps, with a dash, or with a fill.
    const mix = 'M2 12h4a2 2 0 0 1 4 0';
    expect(skipsOf([stroked(mix, { strokeLinecap: 'butt' })])).toEqual(['mixed path']);
    expect(skipsOf([stroked(mix, { strokeDasharray: '1 1' })])).toEqual(['mixed path']);
    expect(skipsOf([stroked(mix, { fill: '#ffffff' })])).toEqual(['mixed path']);
  });

  it('fits an elliptical arc joined to a line with circular arcs', () => {
    const result = convert([stroked('M2 12h4A3 2.4 0 0 1 10 8')]);
    expect(result.skipped).toEqual([]);
    const shapes = result.spec?.shapes ?? [];
    expect(shapes.some((s) => s.type === 'oval')).toBe(false);
    expect(shapes[0]).toMatchObject({ type: 'line', from: [-10, 0], to: [-6, 0] });
    const note = result.notes.find((n) => n.note === 'curve fit');
    expect(note).toBeDefined();
    expect(note?.deviation).toBeLessThanOrEqual(0.1);
    // The arcs run counter-clockwise, against the path: its end begins the last arc.
    const arcs = shapes.filter((s) => s.type === 'arc');
    const last = arcs[arcs.length - 1];
    const circle = shapes.find((s) => s.id === last?.on);
    if (last === undefined || circle?.type !== 'circle') {
      throw new Error('missing arc');
    }
    const a = ((last.from as number) * Math.PI) / 180;
    const [cx, cy] = circle.center as [number, number];
    const r = circle.r as number;
    expect(Math.hypot(cx + r * Math.cos(a) + 2, cy + r * Math.sin(a) - 4)).toBeLessThan(0.01);
  });

  it('keeps a filled ellipse outline as a draft', () => {
    const result = convert([filled('M2 12A6 4 0 0 1 14 12z')]);
    expect(result.skipped.map((s) => s.reason)).toEqual(['mixed path']);
    expect(result.skipped[0]?.pieces?.some((p) => 'ellipse' in p)).toBe(true);
  });

  it('lists the parts of a mixed path in path order, arcs counter-clockwise', () => {
    // A pie slice on an ellipse: the filled ring, closing edge included.
    const [slice] = convert([filled('M12 12L12 3.2A8.8 6 0 0 1 20.8 12z')]).skipped;
    expect(slice).toMatchObject({
      segment: 0,
      subpath: 0,
      reason: 'mixed path',
      detail: 'ellipse',
    });
    expect(slice?.pieces?.map((p) => Object.keys(p)[0])).toEqual(['line', 'ellipse', 'line']);
    // A stroked mix lists only what is drawn.
    expect(
      convert([stroked('M2 12h4a2 2 0 0 1 4 0', { strokeLinecap: 'butt' })]).skipped[0]?.pieces,
    ).toEqual([
      {
        line: [
          [-10, 0],
          [-6, 0],
        ],
      },
      { arc: { center: [-4, 0], r: 2, from: 0, to: 180 } },
    ]);
    // The same mix filled lists its ring.
    expect(
      convert([stroked('M2 12h4a2 2 0 0 1 4 0', { fill: '#ffffff' })]).skipped[0]?.pieces,
    ).toEqual([
      {
        line: [
          [-10, 0],
          [-6, 0],
        ],
      },
      { arc: { center: [-4, 0], r: 2, from: 0, to: 180 } },
      {
        line: [
          [-2, 0],
          [-10, 0],
        ],
      },
    ]);
    // A quarter of a 6 x 4 ellipse, run clockwise from the left end to the top, then a line
    // turning down at a corner.
    expect(
      convert([stroked('M6 12A6 4 0 0 1 12 8v2', { strokeLinecap: 'butt' })]).skipped[0]?.pieces,
    ).toEqual([
      { ellipse: { center: [0, 0], rx: 6, ry: 4, rotate: 0, from: 90, to: 180 } },
      {
        line: [
          [0, 4],
          [0, 2],
        ],
      },
    ]);
  });

  it('subtracts nested evenodd subpaths from the outside in', () => {
    const d = 'M2 2h20v20H2zM6 6h12v12H6zM10 10h4v4h-4z';
    expect(paintOf([filled(d, { fillRule: 'evenodd' })])).toEqual([
      { fill: { subtract: ['s0_0', { subtract: ['s0_1', 's0_2'] }] }, color: BLACK },
    ]);
  });

  it('unions disjoint evenodd subpaths and nonzero roots', () => {
    const d = 'M2 2h4v4H2zM10 2h4v4h-4zM11 3h2v2h-2z';
    expect(paintOf([filled(d, { fillRule: 'evenodd' })])).toEqual([
      { fill: { union: ['s0_0', { subtract: ['s0_1', 's0_2'] }] }, color: BLACK },
    ]);
    // All three run the same way, so the inner square adds nothing to the second.
    expect(paintOf([filled(d)])).toEqual([{ fill: { union: ['s0_0', 's0_1'] }, color: BLACK }]);
  });

  // On screen (y down) `h` then `v` then `H` runs clockwise; `v` first then `h` runs counter-clockwise.
  it('subtracts a nonzero hole wound against its outer subpath', () => {
    const d = 'M2 2v20h20V2zM6 6h12v12H6z';
    expect(paintOf([filled(d)])).toEqual([{ fill: { subtract: ['s0_0', 's0_1'] }, color: BLACK }]);
  });

  it('treats a partly overlapping nonzero circle and triangle as two roots', () => {
    const d = 'M17.6 12.8a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0zM19.2 8.6L17.6 12.8L20.8 12.8z';
    expect(paintOf([filled(d)])).toEqual([{ fill: { union: ['s0_0', 's0_1'] }, color: BLACK }]);
  });

  it('fills a nonzero circle and rect wound opposite ways as their symmetric difference', () => {
    // The circle runs counter-clockwise on screen and the rect clockwise: the overlap winds to 0.
    const d = 'M10.1 15.2a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0 -3.8 0zM11.2 15.2h1.6v3.8h-1.6z';
    const result = convert([filled(d)]);
    expect(result.spec?.paint).toEqual([
      {
        fill: { subtract: [{ union: ['s0_0', 's0_1'] }, { intersect: ['s0_0', 's0_1'] }] },
        color: BLACK,
      },
    ]);
    expect(result.notes).toEqual([]);
  });

  it('fills two partly overlapping evenodd squares as their symmetric difference', () => {
    // Both run clockwise on screen; under evenodd the overlap counts twice and stays empty.
    expect(paintOf([filled('M2 2h6v6H2zM5 5h6v6H5z', { fillRule: 'evenodd' })])).toEqual([
      {
        fill: { subtract: [{ union: ['s0_0', 's0_1'] }, { intersect: ['s0_0', 's0_1'] }] },
        color: BLACK,
      },
    ]);
  });

  it('keeps the union of three nonzero roots that do not match, with a note fill differs', () => {
    // The first two squares overlap wound opposite ways; the third lies apart from both.
    const result = convert([filled('M2 2h6v6H2zM5 5v6h6V5zM16 16h4v4h-4z')]);
    expect(result.spec?.paint).toEqual([
      { fill: { union: ['s0_0', 's0_1', 's0_2'] }, color: BLACK },
    ]);
    expect(result.notes).toEqual([{ segment: 0, subpath: -1, note: 'fill differs' }]);
  });

  it('still nests a hole that shares a vertex with its outer subpath, despite the overlap test', () => {
    // The inner square touches the outer at (2, 2) and otherwise lies inside it.
    const d = 'M2 2v20h20V2zM2 2v10h10V2z';
    expect(paintOf([filled(d, { fillRule: 'evenodd' })])).toEqual([
      { fill: { subtract: ['s0_0', 's0_1'] }, color: BLACK },
    ]);
  });

  it('keeps only the outer subpath for nonzero nested squares of one direction', () => {
    const d = 'M2 2h20v20H2zM6 6h12v12H6z';
    expect(paintOf([filled(d)])).toEqual([{ fill: 's0_0', color: BLACK }]);
  });

  it('unions a nonzero island inside a hole with the subtracted outer', () => {
    const d = 'M2 2v20h20V2zM6 6h12v12H6zM10 10v4h4v-4z';
    expect(paintOf([filled(d)])).toEqual([
      { fill: { union: [{ subtract: ['s0_0', 's0_1'] }, 's0_2'] }, color: BLACK },
    ]);
  });

  it('decides nesting inside an arc outline', () => {
    const d = 'M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0zM18.9 12.2h0.5v0.5h-0.5z';
    expect(paintOf([filled(d, { fillRule: 'evenodd' })])).toEqual([
      { fill: { subtract: ['s0_0', 's0_1'] }, color: BLACK },
    ]);
  });

  it('fills an open polyline as closed points', () => {
    expect(shapesOf([filled('M2 20L8 10L14 16')])).toEqual([
      {
        id: 's0_0',
        type: 'points',
        through: [
          [-10, -8],
          [-4, 2],
          [2, -4],
        ],
      },
    ]);
  });

  it('reads stroke defaults as width 1, butt caps and miter joins', () => {
    expect(paintOf([{ d: 'M2 2H8', fill: 'none', stroke: BLACK }])).toEqual([
      { stroke: ['s0_0'], width: 1, color: BLACK, cap: 'butt', join: 'miter' },
    ]);
  });

  it('skips the segment for arcs or miter-clip joins and for dash patterns other than 2 values', () => {
    expect(skipsOf([stroked('M2 2H8', { strokeLinejoin: 'arcs' })])).toEqual(['stroke join']);
    expect(skipsOf([stroked('M2 2H8', { strokeLinejoin: 'miter-clip' })])).toEqual(['stroke join']);
    expect(skipsOf([stroked('M2 2H8', { strokeDasharray: '1 2 3' })])).toEqual(['dash pattern']);
    expect(skipsOf([stroked('M2 2H8', { strokeDasharray: '2' })])).toEqual(['dash pattern']);
  });

  it('paints a segment with fill and stroke as a fill layer, then a stroke layer', () => {
    expect(
      convert([filled('M2 5h20v14H2z', { fill: '#FFFFFF', stroke: BLACK, strokeWidth: 0.8 })]).spec,
    ).toMatchObject({
      shapes: [{ id: 's0_0', type: 'rect' }],
      paint: [
        { fill: 's0_0', color: '#ffffff' },
        { stroke: ['s0_0'], width: 0.8, color: BLACK },
      ],
    });
  });

  it('normalises colours and reads a missing fill as none', () => {
    expect(paintOf([filled('M2 5h20v14H2z', { fill: '#AbC' })])).toEqual([
      { fill: 's0_0', color: '#aabbcc' },
    ]);
    expect(importSegments([{ d: 'M2 5h20v14H2z' }]).spec).toBeNull();
    expect(paintOf([{ d: 'M2 5h20v14H2z', stroke: '#107C41' }])).toEqual([
      { stroke: ['s0_0'], width: 1, color: '#107c41', cap: 'butt', join: 'miter' },
    ]);
    expect(convert([{ d: 'M2 5h20v14H2z', fill: 'none' }])).toEqual({
      spec: null,
      skipped: [],
      notes: [],
      subpaths: 1,
    });
    expect(skipsOf([filled('M2 5h20v14H2z', { fill: 'currentColor' })])).toEqual(['colour']);
  });

  it('returns no spec when there are more than 256 elements or 16 layers', () => {
    const many = Array.from({ length: 257 }, (_, k) => `M1 ${k * 0.1}h1`).join('');
    expect(convert([stroked(many)])).toMatchObject({
      spec: null,
      skipped: [{ segment: -1, subpath: -1, reason: 'too many shapes' }],
    });
    const layers = Array.from({ length: 17 }, (_, k) => stroked(`M1 ${k}h1`));
    expect(convert(layers)).toMatchObject({
      spec: null,
      skipped: [{ segment: -1, subpath: -1, reason: 'too many layers' }],
    });
    expect(convert(layers.slice(0, 16)).spec?.paint).toHaveLength(16);
  });
});

describe('importSegments edge values', () => {
  it('rejects a non-array and an entry whose d is not a string, with its position', () => {
    expect(() => importSegments({ d: 'M0 0' })).toThrow(/array/);
    expect(() => importSegments([{ d: 'M0 0' }, { d: 3 }])).toThrow(/segments\[1\]\.d/);
    expect(() => importSegments([null])).toThrow(/segments\[0\]\.d/);
  });

  it('rejects characters outside the grammar and missing numbers, with both positions', () => {
    expect(() => importSegments([stroked('M2 2H8'), stroked('M2 2 X8')])).toThrow(
      'segment 1: unexpected character "X" at character 5 of d',
    );
    expect(() => importSegments([stroked('M2 2L8')])).toThrow(
      'segment 0: missing number at character 6 of d',
    );
    expect(() => importSegments([stroked('M2 2L8Z')])).toThrow(
      'segment 0: missing number at character 6 of d',
    );
    expect(() => importSegments([stroked('L2 2')])).toThrow(/unexpected character "L"/);
    expect(() => importSegments([stroked('M2 2a1 1 0 2 0 3 3')])).toThrow(
      /unexpected character "2" at character 11/,
    );
  });

  it('ignores an empty d and a lone moveto', () => {
    expect(convert([stroked(''), stroked('M5 5'), stroked('M5 5m1 1')])).toEqual({
      spec: null,
      skipped: [],
      notes: [],
      subpaths: 0,
    });
  });

  it('reads exponents', () => {
    expect(shapesOf([stroked('M1e1 2E0L1.5e+1 2.0e-0')])).toEqual([
      { id: 's0_0', type: 'line', from: [-2, 10], to: [3, 10] },
    ]);
  });

  it('rejects a stroke width that is not a positive number', () => {
    expect(() => importSegments([stroked('M2 2H8', { strokeWidth: 'thin' })])).toThrow(
      /segments\[0\]\.strokeWidth/,
    );
    expect(() =>
      importSegments([stroked('M2 2H8'), stroked('M2 2H8', { strokeWidth: 0 })]),
    ).toThrow(/segments\[1\]\.strokeWidth/);
  });

  it('rejects a number that is not finite, with both positions', () => {
    expect(() => importSegments([stroked('M2 2H8'), stroked('M1e400 0H8')])).toThrow(
      'segment 1: number out of range at character 1 of d',
    );
    expect(() => importSegments([stroked('M2 2L8 -1e999')])).toThrow(
      'segment 0: number out of range at character 7 of d',
    );
  });

  it('rejects a d longer than 4096 characters', () => {
    const at = (n: number) => `M0 0${' '.repeat(n - 6)}H8`;
    expect(at(4096)).toHaveLength(4096);
    expect(convert([stroked(at(4096))]).skipped).toEqual([]);
    expect(() => importSegments([stroked('M2 2H8'), stroked(at(4097))])).toThrow(
      /segments\[1\]\.d must be at most 4096 characters/,
    );
  });

  it('counts the subpaths that draw, skipped ones included', () => {
    const result = convert([
      stroked('M2 2H8M5 5M6 6zM7 7v1'),
      filled('M2 5h20v14H2z', { fill: 'currentColor' }),
    ]);
    expect(result.subpaths).toBe(4);
    expect(result.skipped).toHaveLength(1);
  });

  it('returns no spec and no skips for an empty array', () => {
    expect(importSegments([])).toEqual({ spec: null, skipped: [], notes: [], subpaths: 0 });
  });
});

describe('importSegments path reader', () => {
  it('reads relative commands after a closed subpath from its start', () => {
    expect(shapesOf([stroked('M2 2h4v4zl-1 -1')])).toEqual([
      {
        id: 's0_0',
        type: 'points',
        through: [
          [-10, 10],
          [-6, 10],
          [-6, 6],
        ],
      },
      { id: 's0_1', type: 'line', from: [-10, 10], to: [-11, 11] },
    ]);
  });

  it('repeats commands implicitly, a moveto continuing as lineto', () => {
    expect(shapesOf([stroked('m2 2 1 0 0 1M10 10 11 10 11 11')])).toEqual([
      {
        id: 's0_0',
        type: 'polyline',
        through: [
          [-10, 10],
          [-9, 10],
          [-9, 9],
        ],
      },
      {
        id: 's0_1',
        type: 'polyline',
        through: [
          [-2, 2],
          [-1, 2],
          [-1, 1],
        ],
      },
    ]);
  });

  it('reads compact numbers and concatenated arc flags', () => {
    expect(shapesOf([stroked('M12 4a6 6 0 010 12')])).toEqual([
      { id: 's0_0c', type: 'circle', center: [0, 2], r: 6 },
      { id: 's0_0', type: 'arc', on: 's0_0c', from: 270, to: 90 },
    ]);
    expect(shapesOf([stroked('M1.5.5.5-.5-1.5.5')])).toEqual([
      {
        id: 's0_0',
        type: 'polyline',
        through: [
          [-10.5, 11.5],
          [-11.5, 12.5],
          [-13.5, 11.5],
        ],
      },
    ]);
  });

  it('reads a real line and arc outline', () => {
    expect(shapesOf([stroked('M3.6 6.2h9.8a6.2 6.2 0 0 1 0 12.4H7.6')])?.map((s) => s.id)).toEqual([
      's0_0a',
      's0_0bc',
      's0_0b',
      's0_0c',
    ]);
  });
});

describe('importSegments curves', () => {
  /** A clockwise quarter circle of radius 8 around the canvas centre, top to right. */
  const QUARTER = 'M12 4C16.41828 4 20 7.58172 20 12';
  const quarterShapes = [
    { id: 's0_0c', type: 'circle', center: [0, 0], r: 8 },
    { id: 's0_0', type: 'arc', on: 's0_0c', from: 0, to: 90 },
  ];

  it('fits C, absolute or relative, and notes the fit', () => {
    const result = convert([stroked(QUARTER)]);
    expect(result.spec?.shapes).toEqual(quarterShapes);
    expect(result.notes).toEqual([
      {
        segment: 0,
        subpath: 0,
        note: 'curve fit',
        deviation: expect.any(Number),
        curves: 1,
        arcs: 1,
      },
    ]);
    expect(result.notes[0]?.deviation).toBeLessThanOrEqual(0.1);
    expect(shapesOf([stroked('M12 4c4.41828 0 8 3.58172 8 8')])).toEqual(quarterShapes);
  });

  it('reads S as C with the previous second control point mirrored', () => {
    const halfCircle = 'M4 12C4 7.58172 7.58172 4 12 4C16.41828 4 20 7.58172 20 12';
    const expected = [
      { id: 's0_0ac', type: 'circle', center: [0, 0], r: 8 },
      { id: 's0_0a', type: 'arc', on: 's0_0ac', from: 90, to: 180 },
      { id: 's0_0bc', type: 'circle', center: [0, 0], r: 8 },
      { id: 's0_0b', type: 'arc', on: 's0_0bc', from: 0, to: 90 },
    ];
    expect(shapesOf([stroked(halfCircle)])).toEqual(expected);
    expect(shapesOf([stroked('M4 12C4 7.58172 7.58172 4 12 4S20 7.58172 20 12')])).toEqual(
      expected,
    );
    expect(shapesOf([stroked('m4 12c0-4.41828 3.58172-8 8-8s8 3.58172 8 8')])).toEqual(expected);
  });

  it('reads Q and T as the same cubic, T mirroring the previous control point', () => {
    const explicit = convert([stroked('M4 12Q8 8 12 12Q16 16 20 12')]);
    expect(explicit.skipped).toEqual([]);
    expect(explicit.notes[0]).toMatchObject({ note: 'curve fit', curves: 2 });
    expect(shapesOf([stroked('M4 12Q8 8 12 12T20 12')])).toEqual(explicit.spec?.shapes);
    expect(shapesOf([stroked('m4 12q4-4 8 0t8 0')])).toEqual(explicit.spec?.shapes);
  });

  it('reads S and T with no curve before them from the current point', () => {
    const line = [{ id: 's0_0', type: 'line', from: [-8, 0], to: [8, 0] }];
    expect(shapesOf([stroked('M4 12S20 12 20 12')])).toEqual(line);
    expect(shapesOf([stroked('M4 12T20 12')])).toEqual(line);
    expect(shapesOf([stroked('M4 12L4 12S20 12 20 12')])).toEqual(line);
  });

  it('turns four fitted quarter arcs of one circle into a circle', () => {
    const d =
      'M12 4C16.41828 4 20 7.58172 20 12C20 16.41828 16.41828 20 12 20' +
      'C7.58172 20 4 16.41828 4 12C4 7.58172 7.58172 4 12 4Z';
    const result = convert([filled(d)]);
    expect(result.spec?.shapes).toEqual([{ id: 's0_0', type: 'circle', center: [0, 0], r: 8 }]);
    expect(result.notes).toMatchObject([{ note: 'curve fit', curves: 4, arcs: 4 }]);
  });

  it('never recognises fitted arcs as a rect, nor arcs of differing radii as a circle', () => {
    const rounded =
      'M6 4H18C19.10457 4 20 4.89543 20 6V18C20 19.10457 19.10457 20 18 20H6' +
      'C4.89543 20 4 19.10457 4 18V6C4 4.89543 4.89543 4 6 4Z';
    const roundedResult = convert([filled(rounded)]);
    expect(roundedResult.skipped).toEqual([]);
    expect(roundedResult.spec?.shapes.map((s) => s.type)).not.toContain('rect');
    expect(roundedResult.spec?.shapes.at(-1)?.type).toBe('outline');
    const oval =
      'M12 7C15.31371 7 18 9.23858 18 12C18 14.76142 15.31371 17 12 17' +
      'C8.68629 17 6 14.76142 6 12C6 9.23858 8.68629 7 12 7Z';
    const ovalResult = convert([filled(oval)]);
    expect(ovalResult.skipped).toEqual([]);
    expect(ovalResult.spec?.shapes.at(-1)?.type).toBe('outline');
  });

  it('fits a curve bulging 0.06 over a chord of 6 as two lines by default, one at fitTolerance 0.1', () => {
    // The arc through it has radius about 75, so at 0.025 it is halved at (-7, 0.06) and each
    // half bulges 0.015.
    const d = 'M2 12C4 11.92 6 11.92 8 12';
    const fine = convert([stroked(d)]);
    expect(fine.spec?.shapes).toEqual([
      {
        id: 's0_0',
        type: 'polyline',
        through: [
          [-10, 0],
          [-7, 0.06],
          [-4, 0],
        ],
      },
    ]);
    expect(fine.notes).toMatchObject([{ note: 'curve fit', curves: 1, arcs: 2 }]);
    const coarse = importSegments([stroked(d)], { fitTolerance: 0.1 });
    expect(coarse.spec?.shapes).toEqual([
      { id: 's0_0', type: 'line', from: [-10, 0], to: [-4, 0] },
    ]);
    expect(coarse.notes).toMatchObject([{ note: 'curve fit', curves: 1, arcs: 1 }]);
  });

  it('refits elliptical arcs within fitTolerance', () => {
    const d = 'M2 12h4A3 2.4 0 0 1 10 8';
    const arcsAt = (fitTolerance: number) => {
      const note = importSegments([stroked(d)], { fitTolerance }).notes[0];
      expect(note?.deviation).toBeLessThanOrEqual(fitTolerance);
      return note?.arcs ?? 0;
    };
    expect(arcsAt(0.005)).toBeGreaterThan(arcsAt(0.1));
  });

  it('rejects a fitTolerance that is not a positive number', () => {
    for (const fitTolerance of [0, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => importSegments([stroked('M2 2H8')], { fitTolerance })).toThrow(/fitTolerance/);
    }
  });

  it('skips a curve that cannot be fitted as bezier and keeps reading the later subpaths', () => {
    const result = convert([stroked('M0 0C100 0 100 100 0 100M8 8H9')]);
    expect(result.skipped).toEqual([{ segment: 0, subpath: 0, reason: 'bezier' }]);
    expect(result.spec?.shapes).toEqual([{ id: 's0_1', type: 'line', from: [-4, 4], to: [-3, 4] }]);
  });

  it('skips a subpath whose curves fit to more than 64 pieces as bezier', () => {
    /** A regular n-gon of radius 10 whose edges bulge out as quarter circles, one cubic each. */
    const scallops = (n: number) => {
      const f = (v: number) => v.toFixed(6);
      const half = Math.sin(Math.PI / n) * 10;
      const r = half * Math.SQRT2;
      const k = (4 / 3) * Math.tan(Math.PI / 8);
      const cubics = Array.from({ length: n }, (_, i) => {
        const mid = ((2 * i + 1) * Math.PI) / n;
        const off = Math.cos(Math.PI / n) * 10 - half;
        const [cx, cy] = [12 + off * Math.cos(mid), 12 + off * Math.sin(mid)];
        const [a0, a1] = [mid - Math.PI / 4, mid + Math.PI / 4];
        const end = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
        const c1 = [
          cx + r * (Math.cos(a0) - k * Math.sin(a0)),
          cy + r * (Math.sin(a0) + k * Math.cos(a0)),
        ];
        const c2 = [
          cx + r * (Math.cos(a1) + k * Math.sin(a1)),
          cy + r * (Math.sin(a1) - k * Math.cos(a1)),
        ];
        return `C${[...c1, ...c2, ...end].map(f).join(' ')}`;
      });
      return `M22 12${cubics.join('')}Z`;
    };
    const sixtyFour = convert([filled(scallops(64))]);
    expect(sixtyFour.skipped).toEqual([]);
    expect(sixtyFour.spec?.shapes.at(-1)?.type).toBe('outline');
    expect(sixtyFour.notes).toMatchObject([{ curves: 64, arcs: 64 }]);
    expect(skipsOf([filled(scallops(65))])).toEqual(['bezier']);
  });
});

describe('segmentsToSvg', () => {
  it('writes one path per segment with only the attributes present', () => {
    const svg = segmentsToSvg([
      { d: 'M2 5h20v14H2z', fill: '#ffffff', fillRule: 'evenodd' },
      {
        d: 'M4 15L8 11',
        stroke: '#107c41',
        strokeWidth: '1.3',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        strokeDasharray: '2 1',
        transform: 'translate(1 1)',
      },
      { d: 'M1 1h2' },
    ]);
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
        '<path d="M2 5h20v14H2z" fill="#ffffff" fill-rule="evenodd"/>' +
        '<path d="M4 15L8 11" fill="none" stroke="#107c41" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="2 1" transform="translate(1 1)"/>' +
        '<path d="M1 1h2" fill="none"/>' +
        '</svg>',
    );
  });
});

describe('arc on an oval', () => {
  const part = 'M7.3 19.07A2.24 2.8 0 1 1 7.3 15.33';

  it('turns a lone elliptical arc into an oval and an arc on it', () => {
    const result = convert([stroked(part)]);
    expect(result.skipped).toEqual([]);
    expect(result.spec?.shapes).toEqual([
      { id: 's0_0c', type: 'oval', center: [-6.3672, -5.2], rx: 2.24, ry: 2.8, rotate: 0 },
      { id: 's0_0', type: 'arc', on: 's0_0c', from: 48.2812, to: 311.7188 },
    ]);
    expect(result.spec?.paint).toEqual([{ stroke: ['s0_0'], ...roundStroke }]);
  });

  it('measures the ends from the centre, not from the parameter', () => {
    // The ends sit at x = -4.7, 1.6672 right of the centre and 1.87 above or below it.
    const shapes = shapesOf([stroked(part)]) ?? [];
    const arc = shapes.find((s) => s.type === 'arc');
    expect(arc?.from).toBeCloseTo((Math.atan2(1.87, 1.6672) * 180) / Math.PI, 3);
    expect(arc?.to).toBeCloseTo(360 - (arc?.from as number), 3);
  });

  it('takes the arc from the end to the start when the path runs counter-clockwise', () => {
    const shapes = shapesOf([stroked('M7.3 15.33A2.24 2.8 0 1 0 7.3 19.07')]) ?? [];
    expect(shapes[1]).toMatchObject({ type: 'arc', from: 48.2812, to: 311.7188 });
  });

  it('folds a rotated ellipse into (-90, 90]', () => {
    const shapes = shapesOf([stroked('M4 12A4 2 120 0 1 12 12')]) ?? [];
    expect(shapes[0]).toMatchObject({ type: 'oval', rotate: 60 });
  });

  it('keeps nearly round and elongated arcs on the circular fit', () => {
    for (const d of ['M7.3 19.07A2.8 2.77 0 1 1 7.3 15.33', 'M7.3 19.07A1 5 0 1 1 7.3 15.33']) {
      const result = convert([stroked(d)]);
      const shapes = result.spec?.shapes ?? [];
      expect(shapes.some((s) => s.type === 'oval')).toBe(false);
      expect(shapes.some((s) => s.type === 'arc')).toBe(true);
      expect(result.notes.some((n) => n.note === 'curve fit')).toBe(true);
    }
  });
});

describe('filled outlines', () => {
  const fan = 'M12 12L12 3.2A8.8 8.8 0 0 1 20.8 12z';

  it('turns a filled fan into supports and an outline, skipping nothing', () => {
    const result = convert([filled(fan)]);
    expect(result.skipped).toEqual([]);
    expect(result.spec?.shapes).toEqual([
      { id: 's0_0p0', type: 'line', from: [0, 0], to: [8.8, 0] },
      { id: 's0_0p1', type: 'circle', center: [0, 0], r: 8.8 },
      { id: 's0_0p2', type: 'line', from: [0, 8.8], to: [0, 0] },
      {
        id: 's0_0',
        type: 'outline',
        through: [
          { on: 's0_0p0', corner: [8.8, 0] },
          { on: 's0_0p1', corner: [0, 8.8] },
          { on: 's0_0p2' },
        ],
      },
    ]);
    expect(result.spec?.paint).toEqual([{ fill: 's0_0', color: BLACK }]);
  });

  it('keeps a ring the outline cannot be built from as a skip with its detail', () => {
    const [skip] = convert([filled('M12 12L12 3.2A8.8 6 0 0 1 20.8 12z')]).skipped;
    expect(skip).toMatchObject({ reason: 'mixed path', detail: 'ellipse' });
    expect(skip?.pieces).toHaveLength(3);
    expect(convert([filled('M12 12L12 3.2A8.8 6 0 0 1 20.8 12z')]).spec).toBeNull();
  });

  it('subtracts a nonzero hole that is itself an outline', () => {
    const outer = 'M12 12L20.8 12A8.8 8.8 0 0 0 12 3.2z';
    const hole = 'M13 11L13 6A5 5 0 0 1 18 11z';
    const result = convert([filled(`${outer}${hole}`)]);
    expect(result.skipped).toEqual([]);
    expect(result.spec?.shapes.filter((s) => s.type === 'outline').map((s) => s.id)).toEqual([
      's0_0',
      's0_1',
    ]);
    expect(result.spec?.paint).toEqual([{ fill: { subtract: ['s0_0', 's0_1'] }, color: BLACK }]);
  });

  it('splits an unfilled fan ring into lines and an arc as before', () => {
    const result = convert([stroked(fan)]);
    expect(result.skipped).toEqual([]);
    expect(result.spec?.shapes.map((s) => s.type)).not.toContain('outline');
    expect(result.spec?.shapes.map((s) => s.type)).toContain('arc');
  });

  it('strokes the outline of a filled and stroked fan', () => {
    const result = convert([filled(fan, { stroke: '#ff0000', strokeWidth: '1' })]);
    expect(result.skipped).toEqual([]);
    expect(result.spec?.shapes.filter((s) => s.type === 'outline')).toHaveLength(1);
    expect(result.spec?.paint).toMatchObject([
      { fill: 's0_0' },
      { stroke: ['s0_0'], color: '#ff0000' },
    ]);
  });

  // Two quarter discs of radius 4 meeting at the centre, drawn as one subpath.
  const lobes = 'M12 12L16 12A4 4 0 0 0 12 8L12 12L8 12A4 4 0 0 0 12 16z';

  it('tidies a subpath through one point twice into one fill leaf per outline', () => {
    const result = convert([filled(lobes)]);
    expect(result.skipped).toEqual([]);
    expect(result.spec?.shapes.filter((s) => s.type === 'outline').map((s) => s.id)).toEqual([
      's0_0',
      's0_0b',
    ]);
    expect(result.spec?.paint).toEqual([{ fill: { union: ['s0_0', 's0_0b'] }, color: BLACK }]);
  });

  it('tidies a filled and stroked subpath into outlines stroked together', () => {
    const result = convert([filled(lobes, { stroke: '#ff0000', strokeWidth: '1' })]);
    expect(result.spec?.paint).toMatchObject([
      { fill: { union: ['s0_0', 's0_0b'] } },
      { stroke: ['s0_0', 's0_0b'], color: '#ff0000' },
    ]);
  });

  it('tidies nothing when one part of the subpath cannot become an outline', () => {
    // The second part crosses itself where its edge to (-6, -6) meets its arc to (0, -2); a
    // line crossing an arc is not cut.
    const result = convert([
      filled('M12 12L16 12A4 4 0 0 0 12 8L12 12L6 18L6 12A20 20 0 0 1 12 14z'),
    ]);
    expect(result.spec).toBeNull();
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ reason: 'mixed path', detail: 'self_intersection' });
    expect(result.skipped[0]?.pieces).toHaveLength(7);
  });
});

describe('filled rings that cross or turn back', () => {
  // A chevron whose arms cross a bar capped by an inward half circle of radius 0.75.
  const indent =
    'M2.22 10.47a.75.75 0 0 1 1.06 0l2.5 2.5c.3.3.3.77 0 1.06l-2.5 2.5a.75.75 0 0 1-1.06-1.06l1.22-1.22H7.5a.75.75 0 0 1 0-1.5H3.44l-1.22-1.22a.75.75 0 0 1 0-1.06Z';

  it('fills two arms and the wedge between the crossings less the cap circle', () => {
    const result = convert([filled(indent)]);
    expect(result.skipped).toEqual([]);
    const ids = result.spec?.shapes.filter((s) => s.type === 'outline').map((s) => s.id);
    expect(ids).toHaveLength(3);
    const caps = result.spec?.shapes.filter((s) => s.id.endsWith('cap'));
    // The cap's circle: centre (7.5, 13.5) in the source, radius 0.75.
    expect(caps).toEqual([
      { id: expect.any(String), type: 'circle', center: [-4.5, -1.5], r: 0.75 },
    ]);
    const cap = caps?.[0]?.id as string;
    const wedge = cap.slice(0, -'cap'.length);
    const arms = (ids ?? []).filter((id) => id !== wedge);
    expect(arms).toHaveLength(2);
    const [fill] = result.spec?.paint ?? [];
    expect(fill).toMatchObject({ color: BLACK });
    const region = (fill as { fill: { union: unknown[] } }).fill;
    expect(region.union).toHaveLength(3);
    expect(region.union).toEqual(expect.arrayContaining([...arms, { subtract: [wedge, cap] }]));
  });

  it('skips the ring as before when it is stroked too', () => {
    const [skip] = convert([filled(indent, { stroke: '#ff0000', strokeWidth: '1' })]).skipped;
    expect(skip).toMatchObject({ reason: 'mixed path', detail: 'direction_mismatch' });
  });

  it('fills a bar carved by a cusp half circle as its rect less the circle', () => {
    // Rect x 2..8, y 11..13 (y down) whose right side is the half circle about (8, 12), radius 1,
    // bulging inward.
    const result = convert([filled('M2 13H8A1 1 0 0 1 8 11H2z')]);
    expect(result.skipped).toEqual([]);
    expect(result.spec?.shapes.at(-1)).toEqual({
      id: 's0_0cap',
      type: 'circle',
      center: [-4, 0],
      r: 1,
    });
    expect(result.spec?.paint).toEqual([{ fill: { subtract: ['s0_0', 's0_0cap'] }, color: BLACK }]);
  });
});

describe('filled rings with ellipse arcs', () => {
  /** Rect x -8..-2, y 0..8 (y up) closed on the right by half a 6 x 4 ellipse. */
  const dee = 'M4 4h6a6 4 0 0 1 0 8h-6z';

  it('fills a D closed by an ellipse arc as its rect united with the oval', () => {
    // Clockwise in y-up with a clockwise arc: the arc turns with the ring and bulges out.
    const result = convert([filled(dee)]);
    expect(result.skipped).toEqual([]);
    expect(result.spec?.shapes).toEqual([
      {
        id: 's0_0',
        type: 'rect',
        corners: [
          [-8, 0],
          [-2, 8],
        ],
      },
      { id: 's0_0e0', type: 'oval', center: [-2, 4], rx: 6, ry: 4, rotate: 0 },
    ]);
    expect(result.spec?.paint).toEqual([{ fill: { union: ['s0_0', 's0_0e0'] }, color: BLACK }]);
  });

  it('subtracts an evenodd hole that is itself composed from an ellipse arc', () => {
    // Both rings run clockwise with clockwise arcs: each is its rect united with its oval.
    const hole = 'M6 6h4a3 2 0 0 1 0 4h-4z';
    const result = convert([filled(`${dee}${hole}`, { fillRule: 'evenodd' })]);
    expect(result.skipped).toEqual([]);
    expect(result.spec?.shapes.slice(2)).toEqual([
      {
        id: 's0_1',
        type: 'rect',
        corners: [
          [-6, 2],
          [-2, 6],
        ],
      },
      { id: 's0_1e0', type: 'oval', center: [-2, 4], rx: 3, ry: 2, rotate: 0 },
    ]);
    expect(result.spec?.paint).toEqual([
      {
        fill: { subtract: [{ union: ['s0_0', 's0_0e0'] }, { union: ['s0_1', 's0_1e0'] }] },
        color: BLACK,
      },
    ]);
  });

  it('skips an ellipse arc whose oval reaches outside a narrow ring, with detail ellipse', () => {
    // The chord ring spans x -2..0; the rest of the oval reaches x = -6, outside the fill.
    const result = convert([filled('M10 4h2a6 4 0 0 1 0 8h-2z')]);
    expect(result.spec).toBeNull();
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ reason: 'mixed path', detail: 'ellipse' });
    expect(result.skipped[0]?.pieces).toHaveLength(4);
  });

  it('fills an open line, ellipse arc and line and strokes it as a polyline, an arc and a line', () => {
    // Closed by its chord the ring runs counter-clockwise, as does the lower half ellipse: it adds.
    // The lines leave and meet the arc vertically, so butt caps leave no gap at the seams.
    const d = 'M2 2L4 4V12A6 3 0 0 0 16 12V4';
    const result = convert([
      filled(d, { fill: '#ffffff', stroke: BLACK, strokeWidth: '1', strokeLinejoin: 'round' }),
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.spec?.shapes).toEqual([
      {
        id: 's0_0',
        type: 'points',
        through: [
          [-10, 10],
          [-8, 8],
          [-8, 0],
          [4, 0],
          [4, 8],
        ],
      },
      { id: 's0_0e0', type: 'oval', center: [-2, 0], rx: 6, ry: 3, rotate: 0 },
      {
        id: 's0_0a',
        type: 'polyline',
        through: [
          [-10, 10],
          [-8, 8],
          [-8, 0],
        ],
      },
      { id: 's0_0b', type: 'arc', on: 's0_0e0', from: 180, to: 0 },
      { id: 's0_0c', type: 'line', from: [4, 0], to: [4, 8] },
    ]);
    expect(result.spec?.paint).toEqual([
      { fill: { union: ['s0_0', 's0_0e0'] }, color: '#ffffff' },
      { stroke: ['s0_0a', 's0_0b', 's0_0c'], width: 1, color: BLACK, cap: 'butt', join: 'round' },
    ]);
  });

  it('does not split a butt stroke whose lines meet the ellipse arc at a corner', () => {
    const d = 'M2 4L4 12A6 3 0 0 0 16 12L18 4';
    const butt = { strokeLinecap: 'butt' };
    expect(skipsOf([stroked(d, butt)])).toEqual(['mixed path']);
    expect(skipsOf([stroked(d, { ...butt, fill: '#ffffff' })])).toEqual(['mixed path']);
  });
});
