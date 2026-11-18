import { describe, expect, it } from 'vitest';
import { arrange } from '../../src/geom/arrangement.js';
import type { Chain } from '../../src/geom/chain.js';
import type { Vec } from '../../src/geom/primitives.js';
import { centerOf, distance } from '../../src/geom/primitives.js';
import type { RegionNode } from '../../src/geom/region.js';
import { ovalChain, ovalDeviation, ovalRadii, rectChain } from '../../src/geom/shapes.js';

const v = (x: number, y: number): Vec => ({ x, y });
const source = { id: 's', copy: 0 };
const leaf = (chain: Chain): RegionNode => ({ kind: 'chain', pieces: chain.pieces, source });
const DISC_R = 11;
const disc: RegionNode = { kind: 'disc', circle: { cx: 0.3, cy: -0.2, r: DISC_R }, source };

const expectRelative = (actual: number, expected: number, rel: number): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(rel * Math.abs(expected));
};

/** w * h less the four corner remainders of radius r. */
const rectArea = (w: number, h: number, r: number): number => w * h - (4 - Math.PI) * r * r;

/**
 * Four sectors (two of radius `end` over 2 alpha, two of radius `side` over pi - 2 alpha) less
 * the rhombus of the four centres, counted twice by the side sectors:
 * 2 end^2 alpha + side^2 (pi - 2 alpha) - 2 (a - end)(side - b), alpha = atan((side - b) / (a - end)).
 */
const ovalArea = (rx: number, ry: number): number => {
  const a = Math.max(rx, ry);
  const b = Math.min(rx, ry);
  const { end, side } = ovalRadii(rx, ry);
  const alpha = Math.atan((side - b) / (a - end));
  return 2 * end * end * alpha + side * side * (Math.PI - 2 * alpha) - 2 * (a - end) * (side - b);
};

const expectClosedCcw = (chain: Chain): void => {
  const n = chain.pieces.length;
  chain.pieces.forEach((p, k) => {
    const next = chain.pieces[(k + 1) % n];
    expect(next).toBeDefined();
    expect(distance(p.end, next?.start ?? v(Number.NaN, 0))).toBe(0);
    expect(chain.joints[k]?.at).toBe(p.end);
  });
  expect(chain.area).toBeGreaterThan(0);
};

const kinds = (chain: Chain): string[] => chain.pieces.map((p) => p.kind);

const rects = [
  { name: 'sharp', min: v(-5, -2), max: v(6, 3), r: 0, pieces: 4 },
  { name: 'rounded', min: v(-5, -2), max: v(6, 3), r: 1.5, pieces: 8 },
  { name: 'horizontal pill', min: v(-5, -2), max: v(6, 3), r: 2.5, pieces: 4 },
  { name: 'vertical pill', min: v(-1, -4), max: v(2, 5), r: 1.5, pieces: 4 },
];

describe('rectChain', () => {
  it('a sharp rectangle is four lines from the bottom-left corner with +90 degree corners', () => {
    const chain = rectChain(v(-5, -2), v(6, 3), 0);
    expectClosedCcw(chain);
    expect(kinds(chain)).toEqual(['line', 'line', 'line', 'line']);
    expect(chain.pieces[0]?.start).toEqual(v(-5, -2));
    expect(chain.pieces[0]?.end).toEqual(v(6, -2));
    for (const j of chain.joints) {
      expect(j.kind).toBe('corner');
      expect(j.turn).toBeCloseTo(90, 12);
    }
  });

  it('a rounded rectangle alternates four lines and four quarter arcs, all tangent', () => {
    const chain = rectChain(v(-5, -2), v(6, 3), 1.5);
    expectClosedCcw(chain);
    expect(kinds(chain)).toEqual(['line', 'arc', 'line', 'arc', 'line', 'arc', 'line', 'arc']);
    expect(chain.pieces[0]?.start).toEqual(v(-3.5, -2));
    expect(chain.pieces[0]?.end).toEqual(v(4.5, -2));
    for (const p of chain.pieces) {
      if (p.kind === 'arc') {
        expect(p.ccw).toBe(true);
        expect(p.sweep).toBe(Math.PI / 2);
        expect(p.circle.r).toBe(1.5);
      }
    }
    for (const j of chain.joints) {
      expect(j.kind).toBe('tangent');
      expect(Math.abs(j.turn)).toBeLessThan(1e-9);
    }
  });

  it('a pill is two lines and two semicircles on distinct circles', () => {
    const wide = rectChain(v(-5, -2), v(6, 3), 2.5);
    expectClosedCcw(wide);
    expect(kinds(wide)).toEqual(['line', 'arc', 'line', 'arc']);
    expect(wide.pieces[0]?.start).toEqual(v(-2.5, -2));
    const tall = rectChain(v(-1, -4), v(2, 5), 1.5);
    expectClosedCcw(tall);
    expect(kinds(tall)).toEqual(['arc', 'line', 'arc', 'line']);
    expect(tall.pieces[0]?.start).toEqual(v(-1, -2.5));
    for (const chain of [wide, tall]) {
      const arcs = chain.pieces.filter((p) => p.kind === 'arc');
      expect(arcs.map((p) => p.sweep)).toEqual([Math.PI, Math.PI]);
      const [c0, c1] = arcs.map((p) => (p.kind === 'arc' ? centerOf(p.circle) : v(0, 0)));
      expect(distance(c0 ?? v(0, 0), c1 ?? v(0, 0))).toBeGreaterThan(1);
      for (const j of chain.joints) {
        expect(j.kind).toBe('tangent');
        expect(Math.abs(j.turn)).toBeLessThan(1e-9);
      }
    }
  });

  it('a square with half-side radius is a circle and throws', () => {
    expect(() => rectChain(v(-2, -2), v(2, 2), 2)).toThrow(/circle/);
  });

  for (const c of rects) {
    const w = c.max.x - c.min.x;
    const h = c.max.y - c.min.y;
    const expected = rectArea(w, h, c.r);

    it(`${c.name}: ${c.pieces} pieces with area w * h - (4 - pi) r^2`, () => {
      const chain = rectChain(c.min, c.max, c.r);
      expect(chain.pieces).toHaveLength(c.pieces);
      expectRelative(chain.area, expected, 1e-9);
    });

    it(`${c.name}: arrange keeps the area alone and subtracted from a disc`, () => {
      const chain = rectChain(c.min, c.max, c.r);
      expectRelative(arrange(leaf(chain)).area, expected, 1e-9);
      const holed = arrange({ kind: 'subtract', children: [disc, leaf(chain)] });
      expectRelative(holed.area, Math.PI * DISC_R * DISC_R - expected, 1e-9);
    });
  }
});

describe('ovalChain', () => {
  const ovals = [
    { rx: 6, ry: 4, rotate: 0 },
    { rx: 3, ry: 7.5, rotate: 0 },
    { rx: 8, ry: 2.7, rotate: 0.4 },
    { rx: 2.5, ry: 5, rotate: -2.2 },
  ];

  it('the radii follow the closed form of the chord construction', () => {
    const { end, side } = ovalRadii(4, 2);
    const d = Math.sqrt(20);
    expect(end).toBeCloseTo((d * (d - 2)) / 8, 14);
    expect(side).toBeCloseTo((d * (d + 2)) / 4, 14);
    expect(ovalRadii(2, 4)).toEqual(ovalRadii(4, 2));
  });

  it('starts at the lower joint of the arc on the positive major-axis end', () => {
    const wide = ovalChain(v(1, 2), 6, 4, 0);
    const first = wide.pieces[0];
    expect(first?.kind).toBe('arc');
    if (first?.kind === 'arc') {
      expect(first.circle.cx).toBeGreaterThan(1);
      expect(first.circle.cy).toBeCloseTo(2, 14);
      expect(first.start.y).toBeLessThan(2);
      expect(first.end.y).toBeGreaterThan(2);
    }
    const tall = ovalChain(v(0, 0), 3, 7.5, 0);
    const top = tall.pieces[0];
    if (top?.kind === 'arc') {
      expect(top.circle.cy).toBeGreaterThan(0);
      expect(top.start.x).toBeGreaterThan(0);
      expect(top.end.x).toBeLessThan(0);
    }
  });

  for (const o of ovals) {
    const label = `rx ${o.rx}, ry ${o.ry}, rotate ${o.rotate}`;

    it(`${label}: four counter-clockwise arcs, tangent-continuous at every joint`, () => {
      const chain = ovalChain(v(0.5, -1), o.rx, o.ry, o.rotate);
      expectClosedCcw(chain);
      expect(kinds(chain)).toEqual(['arc', 'arc', 'arc', 'arc']);
      chain.pieces.forEach((p, k) => {
        const next = chain.pieces[(k + 1) % 4];
        if (p.kind !== 'arc' || next?.kind !== 'arc') {
          throw new Error('expected arcs');
        }
        expect(p.ccw).toBe(true);
        expect(chain.joints[k]?.kind).toBe('tangent');
        const n0 = { x: p.end.x - p.circle.cx, y: p.end.y - p.circle.cy };
        const n1 = { x: p.end.x - next.circle.cx, y: p.end.y - next.circle.cy };
        const angle = Math.atan2(Math.abs(n0.x * n1.y - n0.y * n1.x), n0.x * n1.x + n0.y * n1.y);
        expect(angle).toBeLessThanOrEqual(1e-9);
      });
    });

    it(`${label}: area matches the sector closed form, alone and through arrange`, () => {
      const chain = ovalChain(v(0.5, -1), o.rx, o.ry, o.rotate);
      const expected = ovalArea(o.rx, o.ry);
      expectRelative(chain.area, expected, 1e-9);
      expectRelative(arrange(leaf(chain)).area, expected, 1e-9);
      const holed = arrange({ kind: 'subtract', children: [disc, leaf(chain)] });
      expectRelative(holed.area, Math.PI * DISC_R * DISC_R - expected, 1e-9);
    });
  }
});

describe('ovalDeviation', () => {
  it.each([
    [1.25, 0.007],
    [2, 0.037],
    [3, 0.077],
  ])('at a:b = %f stays within %f of b', (ratio, share) => {
    const b = 4;
    expect(ovalDeviation(ratio * b, b)).toBeLessThanOrEqual(share * b);
    expect(ovalDeviation(b, ratio * b)).toBeCloseTo(ovalDeviation(ratio * b, b), 14);
  });
});
