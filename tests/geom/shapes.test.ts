import { describe, expect, it } from 'vitest';
import { arrange } from '../../src/geom/arrangement.js';
import type { Chain, ChainPiece } from '../../src/geom/chain.js';
import { intersectCircleLine } from '../../src/geom/intersect.js';
import type { Vec } from '../../src/geom/primitives.js';
import { centerOf, distance } from '../../src/geom/primitives.js';
import type { RegionNode } from '../../src/geom/region.js';
import { ovalArc, ovalChain, ovalDeviation, ovalRadii, rectChain } from '../../src/geom/shapes.js';

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

describe('arc on an oval', () => {
  // rx 3, ry 2: chord length d = sqrt(13), joints at ((d + 1) / 2, +-(d - 1) / 2).
  const d = Math.sqrt(13);
  const endR = (d * (d - 1)) / 6;
  const sideR = (d * (d + 1)) / 4;
  const jx = (d + 1) / 2;
  const jy = (d - 1) / 2;
  const O = v(0, 0);
  const near = (p: Vec, q: Vec, tol = 1e-9): void => {
    expect(distance(p, q)).toBeLessThanOrEqual(tol);
  };
  const radiusOf = (p: ChainPiece | undefined): number =>
    p?.kind === 'arc' ? p.circle.r : Number.NaN;
  const dirOf = (c: Vec, p: Vec): Vec => {
    const len = distance(c, p);
    return v((p.x - c.x) / len, (p.y - c.y) / len);
  };
  const full = (a: ChainPiece): number => (a.kind === 'arc' ? a.sweep : 0);

  /** Points where the ray leaves the oval, found per piece by circle-line intersection. */
  const rayHits = (center: Vec, rx: number, ry: number, rotate: number, angle: number): Vec[] => {
    const dir = v(Math.cos(angle), Math.sin(angle));
    const out: Vec[] = [];
    for (const piece of ovalChain(center, rx, ry, rotate).pieces) {
      if (piece.kind !== 'arc') {
        continue;
      }
      const res = intersectCircleLine(piece.circle, { p: center, d: dir });
      const pts = res.kind === 'two' ? res.points : res.kind === 'tangent' ? [res.point] : [];
      for (const q of pts) {
        const along = (q.x - center.x) * dir.x + (q.y - center.y) * dir.y;
        const raw = Math.atan2(q.y - piece.circle.cy, q.x - piece.circle.cx) - piece.from;
        const o = ((raw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const inside = o <= piece.sweep + 1e-9 || o >= 2 * Math.PI - 1e-9;
        if (along > 1e-9 && inside && !out.some((u) => distance(u, q) < 1e-7)) {
          out.push(q);
        }
      }
    }
    return out;
  };

  it('0 to 180 degrees on a 3 by 2 oval is the upper half in three pieces', () => {
    const pieces = ovalArc(O, 3, 2, 0, 0, Math.PI);
    expect(pieces).toHaveLength(3);
    near(pieces[0]?.start ?? O, v(3, 0));
    near(pieces[0]?.end ?? O, v(jx, jy));
    near(pieces[1]?.start ?? O, v(jx, jy));
    near(pieces[1]?.end ?? O, v(-jx, jy));
    near(pieces[2]?.start ?? O, v(-jx, jy));
    near(pieces[2]?.end ?? O, v(-3, 0));
    expect(pieces.map(radiusOf).map((r, k) => Math.abs(r - (k === 1 ? sideR : endR)))).toEqual([
      expect.closeTo(0, 9),
      expect.closeTo(0, 9),
      expect.closeTo(0, 9),
    ]);
    // Half of an end arc spans alpha, the side arc pi - 2 alpha, with tan alpha = (side - 2) / (3 - end).
    const alpha = Math.atan2(sideR - 2, 3 - endR);
    expect(full(pieces[0] as ChainPiece)).toBeCloseTo(alpha, 9);
    expect(full(pieces[1] as ChainPiece)).toBeCloseTo(Math.PI - 2 * alpha, 9);
    expect(full(pieces[2] as ChainPiece)).toBeCloseTo(alpha, 9);
  });

  it('10 to 350 degrees starts and ends on the same end arc in five pieces', () => {
    const pieces = ovalArc(O, 3, 2, 0, (10 * Math.PI) / 180, (350 * Math.PI) / 180);
    expect(pieces).toHaveLength(5);
    const radii = pieces.map(radiusOf);
    [endR, sideR, endR, sideR, endR].forEach((r, k) => {
      expect(radii[k]).toBeCloseTo(r, 9);
    });
    const first = pieces[0];
    const last = pieces[4];
    near(dirOf(O, first?.start ?? O), v(Math.cos(Math.PI / 18), Math.sin(Math.PI / 18)));
    near(first?.end ?? O, v(jx, jy));
    near(last?.start ?? O, v(jx, -jy));
    near(dirOf(O, last?.end ?? O), v(Math.cos(Math.PI / 18), -Math.sin(Math.PI / 18)));
    for (let k = 0; k < 4; k++) {
      near((pieces[k] as ChainPiece).end, (pieces[k + 1] as ChainPiece).start, 1e-12);
    }
  });

  it('a direction through a joint starts on the next piece, ends on the previous one, and leaves no empty piece', () => {
    const toJoint = Math.atan2(jy, jx);
    const fromJoint = ovalArc(O, 3, 2, 0, toJoint, Math.PI);
    expect(fromJoint).toHaveLength(2);
    expect(radiusOf(fromJoint[0])).toBeCloseTo(sideR, 9);
    near(fromJoint[0]?.start ?? O, v(jx, jy));
    const intoJoint = ovalArc(O, 3, 2, 0, Math.PI / 18, toJoint);
    expect(intoJoint).toHaveLength(1);
    expect(radiusOf(intoJoint[0])).toBeCloseTo(endR, 9);
    near(intoJoint[0]?.end ?? O, v(jx, jy));
    for (const seam of [toJoint, Math.PI - toJoint, Math.PI + toJoint, -toJoint]) {
      for (const other of [seam + 0.3, seam + 2, seam + 4, seam + 6]) {
        const pieces = ovalArc(O, 3, 2, 0, seam, other);
        for (const p of pieces) {
          expect(distance(p.start, p.end)).toBeGreaterThan(1e-7);
        }
        const reverse = ovalArc(O, 3, 2, 0, other, seam);
        for (const p of reverse) {
          expect(distance(p.start, p.end)).toBeGreaterThan(1e-7);
        }
      }
    }
  });

  const shapes = [
    { rx: 3, ry: 2, rotate: 0 },
    { rx: 8, ry: 2, rotate: 0 },
    { rx: 2, ry: 3, rotate: Math.PI / 6 },
    { rx: 2.5, ry: 5, rotate: -2.2 },
  ];

  it.each(shapes)(
    'rx $rx, ry $ry: every one of 72 directions meets the oval once, on a piece circle',
    ({ rx, ry, rotate }) => {
      const center = v(1.5, -0.5);
      for (let k = 0; k < 72; k++) {
        const angle = (k * Math.PI) / 36;
        const hits = rayHits(center, rx, ry, rotate, angle);
        expect(hits).toHaveLength(1);
        const start = ovalArc(center, rx, ry, rotate, angle, angle + 1)[0]?.start ?? center;
        near(start, hits[0] ?? center);
      }
    },
  );

  it('with ry a quarter of rx the hit is the outer root and stays between ry and rx from the centre', () => {
    for (let k = 0; k < 72; k++) {
      const angle = (k * Math.PI) / 36;
      const start = ovalArc(O, 8, 2, 0, angle, angle + 1)[0]?.start ?? O;
      expect(distance(O, start)).toBeGreaterThanOrEqual(2 - 1e-9);
      expect(distance(O, start)).toBeLessThanOrEqual(8 + 1e-9);
      near(dirOf(O, start), v(Math.cos(angle), Math.sin(angle)));
    }
  });

  it('with rx below ry and a 30 degree turn, the ends lie on the requested directions', () => {
    const center = v(-1, 2);
    const turn = Math.PI / 6;
    const from = (40 * Math.PI) / 180;
    const to = (200 * Math.PI) / 180;
    const pieces = ovalArc(center, 2, 3, turn, from, to);
    const first = pieces[0]?.start ?? center;
    const last = pieces[pieces.length - 1]?.end ?? center;
    near(dirOf(center, first), v(Math.cos(from), Math.sin(from)));
    near(dirOf(center, last), v(Math.cos(to), Math.sin(to)));
    // The long semi-axis points 90 degrees past the turn, the short one along it.
    const major =
      ovalArc(center, 2, 3, turn, turn + Math.PI / 2, turn + Math.PI)[0]?.start ?? center;
    near(
      major,
      v(center.x + 3 * Math.cos(turn + Math.PI / 2), center.y + 3 * Math.sin(turn + Math.PI / 2)),
    );
    const minor = ovalArc(center, 2, 3, turn, turn, turn + 1)[0]?.start ?? center;
    near(minor, v(center.x + 2 * Math.cos(turn), center.y + 2 * Math.sin(turn)));
  });
});
