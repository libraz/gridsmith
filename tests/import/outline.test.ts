import { describe, expect, it } from 'vitest';
import { buildChain, type ChainInput, type ChainSupport } from '../../src/geom/chain.js';
import { lineThrough, type Vec } from '../../src/geom/primitives.js';
import { outlineOf, outlinesOf } from '../../src/import/outline.js';
import type { polygonOf, ShapeInput } from '../../src/import/shapes.js';

type Piece = Parameters<typeof polygonOf>[0][number];

const line = (a: [number, number], b: [number, number]): Piece => ({
  kind: 'line',
  a: { x: a[0], y: a[1] },
  b: { x: b[0], y: b[1] },
});

/** Circular arc about `c` from angle `t1` turning by `dt` radians (positive counter-clockwise). */
const arc = (
  c: [number, number],
  r: number,
  t1: number,
  dt: number,
  a: [number, number],
  b: [number, number],
): Piece => ({
  kind: 'arc',
  a: { x: a[0], y: a[1] },
  b: { x: b[0], y: b[1] },
  c: { x: c[0], y: c[1] },
  rx: r,
  ry: r,
  givenRx: r,
  givenRy: r,
  phi: 0,
  t1,
  dt,
  circular: true,
});

/** Chain inputs rebuilt from the emitted shapes the way resolve builds them. */
function rebuilt(shapes: ShapeInput[]): ChainInput[] {
  const curves = new Map<string, ChainSupport>();
  for (const s of shapes) {
    if (s.type === 'circle') {
      const [cx, cy] = s.center as [number, number];
      curves.set(s.id, { kind: 'circle', circle: { cx, cy, r: s.r as number } });
    } else if (s.type === 'line') {
      const [ax, ay] = s.from as [number, number];
      const [bx, by] = s.to as [number, number];
      curves.set(s.id, { kind: 'line', line: lineThrough({ x: ax, y: ay }, { x: bx, y: by }) });
    }
  }
  const outline = shapes.find((s) => s.type === 'outline');
  if (outline?.type !== 'outline') {
    throw new Error('no outline');
  }
  return outline.through.map((p) => {
    const piece = typeof p === 'string' ? { on: p } : p;
    const corner = piece.corner as [number, number] | undefined;
    const at: Vec | undefined = corner === undefined ? undefined : { x: corner[0], y: corner[1] };
    return {
      support: curves.get(piece.on) as ChainSupport,
      concave: piece.concave ?? false,
      ...(at === undefined ? {} : { corner: at }),
    };
  });
}

function accepted(ring: Piece[], id: string, area: number): ShapeInput[] {
  const result = outlineOf(ring, id);
  if (!('shapes' in result)) {
    throw new Error(`rejected: ${result.detail}`);
  }
  expect(buildChain(rebuilt(result.shapes)).area).toBeCloseTo(area, 6);
  return result.shapes;
}

const Q = Math.PI / 2;

// Quarter disc of radius 8.8 about the origin, counter-clockwise from the origin along +x.
const fanShapes: ShapeInput[] = [
  { id: 'fp0', type: 'line', from: [0, 0], to: [8.8, 0] },
  { id: 'fp1', type: 'circle', center: [0, 0], r: 8.8 },
  { id: 'fp2', type: 'line', from: [0, 8.8], to: [0, 0] },
  {
    id: 'f',
    type: 'outline',
    through: [{ on: 'fp0', corner: [8.8, 0] }, { on: 'fp1', corner: [0, 8.8] }, { on: 'fp2' }],
  },
];

describe('filled outlines', () => {
  it('reverses a clockwise fan; line-circle joints carry corners, the line-line joint none', () => {
    const ring = [
      line([0, 0], [0, 8.8]),
      arc([0, 0], 8.8, Q, -Q, [0, 8.8], [8.8, 0]),
      line([8.8, 0], [0, 0]),
    ];
    expect(accepted(ring, 'f', (Math.PI * 8.8 * 8.8) / 4)).toEqual(fanShapes);
  });

  it('gives the same outline for the fan drawn counter-clockwise', () => {
    const ring = [
      line([0, 0], [8.8, 0]),
      arc([0, 0], 8.8, 0, Q, [8.8, 0], [0, 8.8]),
      line([0, 8.8], [0, 0]),
    ];
    expect(accepted(ring, 'f', (Math.PI * 8.8 * 8.8) / 4)).toEqual(fanShapes);
  });

  it('joins lines tangent to a half circle without corners', () => {
    // Clockwise D: top edge, right half circle about (-2, 2), bottom edge, left edge.
    const ring = [
      line([-8, 8], [-2, 8]),
      arc([-2, 2], 6, Q, -Math.PI, [-2, 8], [-2, -4]),
      line([-2, -4], [-8, -4]),
      line([-8, -4], [-8, 8]),
    ];
    expect(accepted(ring, 'd', 72 + 18 * Math.PI)).toEqual([
      { id: 'dp0', type: 'line', from: [-8, 8], to: [-8, -4] },
      { id: 'dp1', type: 'line', from: [-8, -4], to: [-2, -4] },
      { id: 'dp2', type: 'circle', center: [-2, 2], r: 6 },
      { id: 'dp3', type: 'line', from: [-2, 8], to: [-8, 8] },
      {
        id: 'd',
        type: 'outline',
        through: [{ on: 'dp0' }, { on: 'dp1' }, { on: 'dp2' }, { on: 'dp3' }],
      },
    ]);
  });

  it('marks an inward half circle concave', () => {
    // Square of side 12 whose top side is carved by a half circle of radius 3 about (0, 6).
    const ring = [
      line([-6, -6], [6, -6]),
      line([6, -6], [6, 6]),
      line([6, 6], [3, 6]),
      arc([0, 6], 3, 0, -Math.PI, [3, 6], [-3, 6]),
      line([-3, 6], [-6, 6]),
      line([-6, 6], [-6, -6]),
    ];
    const shapes = accepted(ring, 'n', 144 - (9 * Math.PI) / 2);
    expect(shapes.at(-1)).toEqual({
      id: 'n',
      type: 'outline',
      through: [
        { on: 'np0' },
        { on: 'np1' },
        { on: 'np2', corner: [3, 6] },
        { on: 'np3', concave: true, corner: [-3, 6] },
        { on: 'np4' },
        { on: 'np5' },
      ],
    });
    expect(shapes[3]).toEqual({ id: 'np3', type: 'circle', center: [0, 6], r: 3 });
  });

  const halfDisc: ShapeInput[] = [
    { id: 'hp0', type: 'line', from: [-5, 0], to: [5, 0] },
    { id: 'hp1', type: 'circle', center: [0, 0], r: 5 },
    {
      id: 'h',
      type: 'outline',
      through: [
        { on: 'hp0', corner: [5, 0] },
        { on: 'hp1', corner: [-5, 0] },
      ],
    },
  ];

  it('merges consecutive arcs on one circle and consecutive collinear lines', () => {
    const ring = [
      line([-5, 0], [0, 0]),
      line([0, 0], [5, 0]),
      arc([0, 0], 5, 0, Q, [5, 0], [0, 5]),
      arc([0, 0], 5, Q, Q, [0, 5], [-5, 0]),
    ];
    expect(accepted(ring, 'h', (25 * Math.PI) / 2)).toEqual(halfDisc);
  });

  it('merges across the end of the ring', () => {
    const ring = [
      arc([0, 0], 5, Q, Q, [0, 5], [-5, 0]),
      line([-5, 0], [0, 0]),
      line([0, 0], [5, 0]),
      arc([0, 0], 5, 0, Q, [5, 0], [0, 5]),
    ];
    expect(accepted(ring, 'h', (25 * Math.PI) / 2)).toEqual(halfDisc);
  });

  it('rejects a figure eight as self-intersecting', () => {
    // The edge from (0, 0) to (6, 6) crosses the edge from (6, 0) to (0, 2) at (1.5, 1.5).
    const ring = [
      line([0, 0], [6, 6]),
      line([6, 6], [6, 0]),
      line([6, 0], [0, 2]),
      line([0, 2], [0, 0]),
    ];
    expect(outlineOf(ring, 'e')).toEqual({ detail: 'self_intersection' });
  });

  it('rejects more than 64 pieces', () => {
    const corners = Array.from({ length: 65 }, (_, k): [number, number] => {
      const t = (2 * Math.PI * k) / 65;
      return [10 * Math.cos(t), 10 * Math.sin(t)];
    });
    const ring = corners.map((p, k) => line(p, corners[(k + 1) % 65] as [number, number]));
    expect(outlineOf(ring, 'g')).toEqual({ detail: 'too many pieces' });
  });

  it('rejects a ring without area', () => {
    expect(outlineOf([line([0, 0], [5, 0]), line([5, 0], [0, 0])], 'z')).toEqual({
      detail: 'degenerate',
    });
  });

  it('rejects a circle drawn as three arcs, which merges into one piece', () => {
    const t = (2 * Math.PI) / 3;
    const at = (k: number): [number, number] => [4 * Math.cos(k * t), 4 * Math.sin(k * t)];
    const ring = [0, 1, 2].map((k) => arc([0, 0], 4, k * t, t, at(k), at(k + 1)));
    expect(outlineOf(ring, 'o')).toEqual({ detail: 'degenerate' });
  });

  it('leaves rings with an elliptical arc alone', () => {
    const ring = [
      line([-5, 0], [5, 0]),
      { ...arc([0, 0], 5, 0, Math.PI, [5, 0], [-5, 0]), ry: 3, givenRy: 3, circular: false },
    ];
    expect(outlineOf(ring, 'l')).toEqual({ detail: 'ellipse' });
  });

  /** Every outline of a tidied ring; the chains rebuilt from the shapes add up to `area`. */
  function tidied(ring: Piece[], id: string, area: number) {
    const result = outlinesOf(ring, id);
    if (!('shapes' in result)) {
      throw new Error(`rejected: ${result.detail}`);
    }
    const total = result.outlines.reduce((sum, o) => {
      const own = result.shapes.filter((s) => s.id === o.id || s.id.startsWith(`${o.id}p`));
      return sum + buildChain(rebuilt(own)).area;
    }, 0);
    expect(total).toBeCloseTo(area, 6);
    return result;
  }

  it('tidies away a tiny line that overshoots the start', () => {
    // The last line ends 0.01 past the first one's start, so they would run back on each other.
    const ring = [
      line([7.75, 10], [-2, 10]),
      arc([-2, 5], 5, Q, Math.PI, [-2, 10], [-2, 0]),
      line([-2, 0], [8, 0]),
      line([8, 0], [7.74, 10]),
      line([7.74, 10], [7.75, 10]),
    ];
    expect(outlineOf(ring, 't')).toEqual({ detail: 'degenerate' });
    const result = tidied(ring, 't', 98.7 + (25 * Math.PI) / 2);
    expect(result.outlines.map((o) => o.id)).toEqual(['t']);
    expect(result.shapes).toEqual([
      { id: 'tp0', type: 'line', from: [7.75, 10], to: [-2, 10] },
      { id: 'tp1', type: 'circle', center: [-2, 5], r: 5 },
      { id: 'tp2', type: 'line', from: [-2, 0], to: [8, 0] },
      { id: 'tp3', type: 'line', from: [8, 0], to: [7.74, 10] },
      {
        id: 't',
        type: 'outline',
        through: [{ on: 'tp0' }, { on: 'tp1' }, { on: 'tp2' }, { on: 'tp3' }],
      },
    ]);
  });

  it('tidies away a retraced line and converts the rest', () => {
    // The fan, then its first edge once more and back.
    const ring = [
      line([0, 0], [8.8, 0]),
      arc([0, 0], 8.8, 0, Q, [8.8, 0], [0, 8.8]),
      line([0, 8.8], [0, 0]),
      line([0, 0], [8.8, 0]),
      line([8.8, 0], [0, 0]),
    ];
    expect(outlineOf(ring, 'r')).toEqual({ detail: 'degenerate' });
    expect(tidied(ring, 'r', (Math.PI * 8.8 * 8.8) / 4).shapes).toEqual([
      { id: 'rp0', type: 'circle', center: [0, 0], r: 8.8 },
      { id: 'rp1', type: 'line', from: [0, 8.8], to: [0, 0] },
      { id: 'rp2', type: 'line', from: [0, 0], to: [8.8, 0] },
      {
        id: 'r',
        type: 'outline',
        through: [{ on: 'rp0', corner: [0, 8.8] }, { on: 'rp1' }, { on: 'rp2', corner: [8.8, 0] }],
      },
    ]);
  });

  it('tidies away a retrace whose return misses by 0.01', () => {
    // The return ends at (0, 0.01); dropping the 0.01 closing line leaves a sliver from (8.8, 0)
    // with area 8.8 * 0.01 / 2 = 0.044 and perimeter about 17.6, mean width 0.005 <= 0.02.
    const ring = [
      line([0, 0], [8.8, 0]),
      arc([0, 0], 8.8, 0, Q, [8.8, 0], [0, 8.8]),
      line([0, 8.8], [0, 0]),
      line([0, 0], [8.8, 0]),
      line([8.8, 0], [0, 0.01]),
      line([0, 0.01], [0, 0]),
    ];
    expect('detail' in outlineOf(ring, 'm')).toBe(true);
    const result = tidied(ring, 'm', (Math.PI * 8.8 * 8.8) / 4);
    expect(result.outlines.map((o) => o.id)).toEqual(['m']);
    expect(result.shapes.at(-1)).toEqual({
      id: 'm',
      type: 'outline',
      through: [{ on: 'mp0', corner: [0, 8.8] }, { on: 'mp1' }, { on: 'mp2', corner: [8.8, 0] }],
    });
  });

  it('tidies a ring through one point twice into two outlines', () => {
    // Two quarter discs of radius 4 meeting at the origin, drawn as one ring.
    const ring = [
      line([0, 0], [4, 0]),
      arc([0, 0], 4, 0, Q, [4, 0], [0, 4]),
      line([0, 4], [0, 0]),
      line([0, 0], [-4, 0]),
      arc([0, 0], 4, Math.PI, Q, [-4, 0], [0, -4]),
      line([0, -4], [0, 0]),
    ];
    expect('detail' in outlineOf(ring, 'w')).toBe(true);
    const result = tidied(ring, 'w', 8 * Math.PI);
    expect(result.outlines.map((o) => o.id)).toEqual(['w', 'wb']);
    expect(result.shapes).toEqual([
      { id: 'wp0', type: 'line', from: [0, 0], to: [-4, 0] },
      { id: 'wp1', type: 'circle', center: [0, 0], r: 4 },
      { id: 'wp2', type: 'line', from: [0, -4], to: [0, 0] },
      {
        id: 'w',
        type: 'outline',
        through: [{ on: 'wp0', corner: [-4, 0] }, { on: 'wp1', corner: [0, -4] }, { on: 'wp2' }],
      },
      { id: 'wbp0', type: 'line', from: [0, 0], to: [4, 0] },
      { id: 'wbp1', type: 'circle', center: [0, 0], r: 4 },
      { id: 'wbp2', type: 'line', from: [0, 4], to: [0, 0] },
      {
        id: 'wb',
        type: 'outline',
        through: [{ on: 'wbp0', corner: [4, 0] }, { on: 'wbp1', corner: [0, 4] }, { on: 'wbp2' }],
      },
    ]);
  });

  it('tidies neighbouring arcs on circles 0.001 apart into one piece', () => {
    // Equal circles offset along y cross at y = 0.0005, both points equally far from the joint.
    const ring = [
      line([-5, 0], [5, 0]),
      arc([0, 0], 5, 0, Q, [5, 0], [0, 5]),
      arc([0, 0.001], 5, Q, Q, [0, 5], [-5, 0.001]),
    ];
    expect(outlineOf(ring, 'a')).toEqual({ detail: 'corner_tie' });
    expect(tidied(ring, 'a', (25 * Math.PI) / 2).shapes).toEqual([
      { id: 'ap0', type: 'line', from: [-5, 0], to: [5, 0] },
      { id: 'ap1', type: 'circle', center: [0, 0], r: 5 },
      {
        id: 'a',
        type: 'outline',
        through: [
          { on: 'ap0', corner: [5, 0] },
          { on: 'ap1', corner: [-5, 0.001] },
        ],
      },
    ]);
  });

  // A chevron pointing right whose arms cross a bar: the arms' outer edges run from (-6, 4) and
  // (-6, -4) to the tip (0, 0), and the bar y -1..1 runs from x -4 to 2, so the edges cross the
  // bar's edges at (-1.5, 1) and (-1.5, -1). Clockwise as drawn.
  const chevron = [
    line([-6, 4], [0, 0]),
    line([0, 0], [-6, -4]),
    line([-6, -4], [-6, -2]),
    line([-6, -2], [-4, -2]),
    line([-4, -2], [-4, -1]),
    line([-4, -1], [2, -1]),
    line([2, -1], [2, 1]),
    line([2, 1], [-4, 1]),
    line([-4, 1], [-4, 2]),
    line([-4, 2], [-6, 2]),
    line([-6, 2], [-6, 4]),
  ];

  it('cuts a ring whose lines cross into three loops, marked checked', () => {
    expect('detail' in outlineOf(chevron, 'v')).toBe(true);
    const result = outlinesOf(chevron, 'v');
    if (!('shapes' in result)) {
      throw new Error(`rejected: ${result.detail}`);
    }
    expect(result.checked).toBe(true);
    expect(result.outlines.map((o) => o.id)).toEqual(['v', 'vb', 'vc']);
    expect(result.outlines.every((o) => o.minus === undefined)).toBe(true);
    // Upper arm (-6,4) (-1.5,1) (-4,1) (-4,2) (-6,2): 4.75; lower arm the same; the wedge, the
    // bar from x -1.5 to 2 less the tip triangle (-1.5,1) (0,0) (-1.5,-1): 7 - 1.5 = 5.5.
    const areas = result.outlines.map((o) => {
      const own = result.shapes.filter((s) => s.id === o.id || s.id.startsWith(`${o.id}p`));
      return buildChain(rebuilt(own)).area;
    });
    expect(areas.map((a) => Math.round(a * 1e6) / 1e6).sort()).toEqual([4.75, 4.75, 5.5]);
  });

  it('leaves the crossings alone without untangle', () => {
    expect(outlinesOf(chevron, 'v', false)).toEqual({ detail: 'self_intersection' });
  });

  it('still fails when the lines cross within 0.02 of an end', () => {
    // The edge from (0, 0) to (6, 6) crosses the edge from (6, 0) to (0.01, 0.02) at about
    // (0.02, 0.02), 0.01 from the latter's end.
    const ring = [
      line([0, 0], [6, 6]),
      line([6, 6], [6, 0]),
      line([6, 0], [0.01, 0.02]),
      line([0.01, 0.02], [0, 0]),
    ];
    expect(outlinesOf(ring, 'e')).toEqual(outlinesOf(ring, 'e', false));
    expect('detail' in outlinesOf(ring, 'e')).toBe(true);
  });

  it('writes a cusp half circle as its chord ring less the circle', () => {
    // Rect x -6..0, y -1..1 whose right side is carved by the half circle about the origin of
    // radius 1; the bar edges meet the half circle with reversed tangents.
    const ring = [
      line([-6, -1], [0, -1]),
      arc([0, 0], 1, -Q, -Math.PI, [0, -1], [0, 1]),
      line([0, 1], [-6, 1]),
      line([-6, 1], [-6, -1]),
    ];
    expect(outlineOf(ring, 'k')).toEqual({ detail: 'direction_mismatch' });
    const result = outlinesOf(ring, 'k');
    if (!('shapes' in result)) {
      throw new Error(`rejected: ${result.detail}`);
    }
    expect(result.checked).toBe(true);
    expect(result.outlines).toHaveLength(1);
    expect(result.outlines[0]?.minus).toEqual({ id: 'kcap', center: [0, 0], r: 1 });
    expect(result.shapes.at(-1)).toEqual({ id: 'kcap', type: 'circle', center: [0, 0], r: 1 });
    const own = result.shapes.filter((s) => s.id === 'k' || s.id.startsWith('kp'));
    expect(buildChain(rebuilt(own)).area).toBeCloseTo(12, 6);
    expect(outlinesOf(ring, 'k', false)).toEqual({ detail: 'direction_mismatch' });
  });

  it('tidies near-same arcs and the chord between them into one piece', () => {
    // The base overshoots by 0.01 and turns back; the arc is two quarters joined by a 0.1 chord.
    const e = 0.01;
    const top: [number, number] = [5 * Math.sin(e), 5 * Math.cos(e)];
    const back: [number, number] = [0.001 - 5 * Math.sin(e), 5 * Math.cos(e)];
    const ring = [
      line([-5, 0], [5.01, 0]),
      line([5.01, 0], [5, 0]),
      arc([0, 0], 5, 0, Q - e, [5, 0], top),
      line(top, back),
      arc([0.001, 0], 5, Q + e, Q - e, back, [-4.999, 0]),
    ];
    expect(outlineOf(ring, 'c')).toEqual({ detail: 'degenerate' });
    expect(tidied(ring, 'c', (25 * Math.PI) / 2).shapes).toEqual([
      { id: 'cp0', type: 'line', from: [-5, 0], to: [5.01, 0] },
      { id: 'cp1', type: 'circle', center: [0, 0], r: 5 },
      {
        id: 'c',
        type: 'outline',
        through: [
          { on: 'cp0', corner: [5.01, 0] },
          { on: 'cp1', corner: [-4.999, 0] },
        ],
      },
    ]);
  });
});
