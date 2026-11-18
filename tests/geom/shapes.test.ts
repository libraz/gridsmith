import { describe, expect, it } from 'vitest';
import { arrange } from '../../src/geom/arrangement.js';
import type { Chain, ChainPiece } from '../../src/geom/chain.js';
import { intersectCircleCircle, intersectCircleLine } from '../../src/geom/intersect.js';
import type { Circle, Vec } from '../../src/geom/primitives.js';
import { add, centerOf, distance } from '../../src/geom/primitives.js';
import type { RegionNode } from '../../src/geom/region.js';
import { ovalArc, ovalChain, ovalDeviation, rectChain } from '../../src/geom/shapes.js';
import { OVAL_CURVES } from '../../src/spec/schema.js';

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

const near = (p: Vec, q: Vec, tol = 1e-9): void => {
  expect(distance(p, q)).toBeLessThanOrEqual(tol);
};

/** Point halfway along an arc piece. */
const arcMidpoint = (p: ChainPiece): Vec => {
  if (p.kind !== 'arc') {
    throw new Error('expected an arc');
  }
  const t = p.from + p.sweep / 2;
  return v(p.circle.cx + p.circle.r * Math.cos(t), p.circle.cy + p.circle.r * Math.sin(t));
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

const sameCircle = (p: Circle, q: Circle): boolean => p.cx === q.cx && p.cy === q.cy && p.r === q.r;

const circleOf = (p: ChainPiece | undefined): Circle => {
  if (p?.kind !== 'arc') {
    throw new Error('expected an arc');
  }
  return p.circle;
};

describe('ovalChain', () => {
  const ovals = [
    { rx: 6, ry: 4, rotate: 0 },
    { rx: 3, ry: 7.5, rotate: 0 },
    { rx: 8, ry: 2.7, rotate: 0.4 },
    { rx: 2.5, ry: 5, rotate: -2.2 },
    { rx: 11.5, ry: 11, rotate: 0 },
    { rx: 1, ry: 0.95, rotate: 1 },
  ];
  const origin = v(0.5, -1);

  /** Maps a point to (along the major axis, along the minor axis) from the oval's centre. */
  const frameOf = (rx: number, ry: number, rotate: number) => {
    const turn = rx >= ry ? rotate : rotate + Math.PI / 2;
    const major = v(Math.cos(turn), Math.sin(turn));
    const minor = v(-major.y, major.x);
    const local = (p: Vec): Vec => {
      const d = v(p.x - origin.x, p.y - origin.y);
      return v(d.x * major.x + d.y * major.y, d.x * minor.x + d.y * minor.y);
    };
    return { local };
  };

  it('has as many pieces as the schema counts for an oval', () => {
    expect(ovalChain(origin, 6, 4, 0).pieces).toHaveLength(OVAL_CURVES);
  });

  it('equal semi-axes have no biarc joint and throw', () => {
    expect(() => ovalChain(origin, 3, 3, 0)).toThrow();
  });

  it('starts at the lower end of the arc on the positive major-axis end', () => {
    const wide = ovalChain(v(1, 2), 6, 4, 0);
    const first = wide.pieces[0];
    expect(first?.kind).toBe('arc');
    if (first?.kind === 'arc') {
      expect(first.circle.cx).toBeGreaterThan(1);
      expect(first.circle.cy).toBeCloseTo(2, 14);
      expect(first.start.y).toBeLessThan(2);
      expect(first.end.y).toBeGreaterThan(2);
      near(arcMidpoint(first), v(7, 2), 1e-9);
    }
    const tall = ovalChain(v(0, 0), 3, 7.5, 0);
    const top = tall.pieces[0];
    if (top?.kind === 'arc') {
      expect(top.circle.cy).toBeGreaterThan(0);
      expect(top.start.x).toBeGreaterThan(0);
      expect(top.end.x).toBeLessThan(0);
      near(arcMidpoint(top), v(0, 7.5), 1e-9);
    }
  });

  for (const o of ovals) {
    const label = `rx ${o.rx}, ry ${o.ry}, rotate ${o.rotate}`;
    const a = Math.max(o.rx, o.ry);
    const b = Math.min(o.rx, o.ry);

    it(`${label}: counter-clockwise arcs, closed, tangent at every joint`, () => {
      const chain = ovalChain(origin, o.rx, o.ry, o.rotate);
      expectClosedCcw(chain);
      expect(kinds(chain).every((k) => k === 'arc')).toBe(true);
      chain.pieces.forEach((p, k) => {
        const next = chain.pieces[(k + 1) % chain.pieces.length];
        expect(p.kind === 'arc' && p.ccw).toBe(true);
        expect(p.kind === 'arc' && p.sweep > 0 && p.sweep < Math.PI).toBe(true);
        expect(chain.joints[k]?.kind).toBe('tangent');
        expect(intersectCircleCircle(circleOf(p), circleOf(next)).kind).toBe('tangent');
      });
    });

    it(`${label}: each axis end lies at its semi-axis and is the midpoint of one arc`, () => {
      const chain = ovalChain(origin, o.rx, o.ry, o.rotate);
      const ends = [
        add(origin, v(o.rx * Math.cos(o.rotate), o.rx * Math.sin(o.rotate))),
        add(origin, v(-o.rx * Math.cos(o.rotate), -o.rx * Math.sin(o.rotate))),
        add(origin, v(-o.ry * Math.sin(o.rotate), o.ry * Math.cos(o.rotate))),
        add(origin, v(o.ry * Math.sin(o.rotate), -o.ry * Math.cos(o.rotate))),
      ];
      for (const end of ends) {
        const owners = chain.pieces.filter(
          (p) => p.kind === 'arc' && distance(arcMidpoint(p), end) < 1e-9,
        );
        expect(owners).toHaveLength(1);
      }
    });

    it(`${label}: symmetric about both axes`, () => {
      const chain = ovalChain(origin, o.rx, o.ry, o.rotate);
      const { local } = frameOf(o.rx, o.ry, o.rotate);
      const circles = chain.pieces.map((p) => {
        const c = circleOf(p);
        return { at: local(v(c.cx, c.cy)), r: c.r };
      });
      for (const flip of [(p: Vec) => v(-p.x, p.y), (p: Vec) => v(p.x, -p.y)]) {
        for (const c of circles) {
          const image = flip(c.at);
          const match = circles.some(
            (d) => distance(d.at, image) < 1e-9 && Math.abs(d.r - c.r) < 1e-9,
          );
          expect(match).toBe(true);
        }
      }
    });

    it(`${label}: radii grow from the major-axis end to the minor-axis end`, () => {
      const pieces = ovalChain(origin, o.rx, o.ry, o.rotate).pieces;
      const radii = pieces.slice(0, 8).map((p) => circleOf(p).r);
      for (let k = 1; k < radii.length; k++) {
        expect(radii[k]).toBeGreaterThan(radii[k - 1] as number);
      }
      expect(radii[0]).toBeLessThan(b);
      expect(radii[7]).toBeGreaterThan(a);
    });

    it(`${label}: every piece stays on the true ellipse, and the area is pi rx ry within 0.1%`, () => {
      const chain = ovalChain(origin, o.rx, o.ry, o.rotate);
      const { local } = frameOf(o.rx, o.ry, o.rotate);
      for (const p of chain.pieces) {
        if (p.kind !== 'arc') {
          continue;
        }
        for (let s = 0; s <= 8; s++) {
          const t = p.from + (p.sweep * s) / 8;
          const q = local(
            v(p.circle.cx + p.circle.r * Math.cos(t), p.circle.cy + p.circle.r * Math.sin(t)),
          );
          const level = Math.sqrt((q.x / a) ** 2 + (q.y / b) ** 2);
          expect(Math.abs(level - 1)).toBeLessThanOrEqual((0.0006 * a) / b);
        }
      }
      const expected = Math.PI * o.rx * o.ry;
      expectRelative(chain.area, expected, 1e-3);
      expectRelative(arrange(leaf(chain)).area, chain.area, 1e-9);
      const wide: RegionNode = { kind: 'disc', circle: { cx: 0.3, cy: -0.2, r: 13 }, source };
      const holed = arrange({ kind: 'subtract', children: [wide, leaf(chain)] });
      expectRelative(holed.area, Math.PI * 13 * 13 - chain.area, 1e-9);
    });
  }
});

describe('ovalDeviation', () => {
  it.each([
    [10, 2.5],
    [8, 4],
    [6, 5],
    [3, 1],
    [1, 0.5],
    [11.5, 11],
    [2.5, 10],
  ])('(%f, %f) stays within 0.0006 of the longer semi-axis', (rx, ry) => {
    const dev = ovalDeviation(rx, ry);
    expect(dev).toBeLessThanOrEqual(0.0006 * Math.max(rx, ry));
    expect(ovalDeviation(ry, rx)).toBeCloseTo(dev, 14);
  });
});

describe('arc on an oval', () => {
  const O = v(0, 0);
  const base = ovalChain(O, 3, 2, 0).pieces;
  const at = (angle: number): Vec => v(Math.cos(angle), Math.sin(angle));
  const dirOf = (c: Vec, p: Vec): Vec => {
    const len = distance(c, p);
    return v((p.x - c.x) / len, (p.y - c.y) / len);
  };
  const full = (a: ChainPiece | undefined): number => (a?.kind === 'arc' ? a.sweep : Number.NaN);

  /** Points where the ray leaves the oval, found per piece by circle-line intersection. */
  const rayHits = (center: Vec, rx: number, ry: number, rotate: number, angle: number): Vec[] => {
    const dir = at(angle);
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

  it('0 to 180 degrees is the upper half in 15 pieces: two half end arcs around 13 whole ones', () => {
    const pieces = ovalArc(O, 3, 2, 0, 0, Math.PI);
    expect(pieces).toHaveLength(15);
    near(pieces[0]?.start ?? O, v(3, 0));
    near(pieces[14]?.end ?? O, v(-3, 0));
    pieces.forEach((p, k) => {
      const next = pieces[k + 1];
      if (next !== undefined) {
        near(p.end, next.start, 1e-12);
      }
      expect(p.start.y).toBeGreaterThanOrEqual(-1e-12);
      expect(p.end.y).toBeGreaterThanOrEqual(-1e-12);
    });
    for (let k = 1; k <= 13; k++) {
      expect(circleOf(pieces[k])).toEqual(circleOf(base[k]));
      expect(full(pieces[k])).toBeCloseTo(full(base[k]), 12);
    }
    for (const [k, whole] of [
      [0, 0],
      [14, 14],
    ] as const) {
      expect(circleOf(pieces[k])).toEqual(circleOf(base[whole]));
      expect(full(pieces[k])).toBeCloseTo(full(base[whole]) / 2, 12);
    }
  });

  it('10 to 350 degrees ends on the requested directions and starts and ends on partial pieces', () => {
    const pieces = ovalArc(O, 3, 2, 0, (10 * Math.PI) / 180, (350 * Math.PI) / 180);
    const first = pieces[0];
    const last = pieces[pieces.length - 1];
    near(dirOf(O, first?.start ?? O), at(Math.PI / 18));
    near(dirOf(O, last?.end ?? O), at(-Math.PI / 18));
    for (let k = 0; k + 1 < pieces.length; k++) {
      near((pieces[k] as ChainPiece).end, (pieces[k + 1] as ChainPiece).start, 1e-12);
    }
    for (const end of [first, last]) {
      const whole = base.find((p) => sameCircle(circleOf(p), circleOf(end)));
      expect(whole).toBeDefined();
      expect(full(end)).toBeLessThan(full(whole));
    }
    expect(pieces.some((p) => sameCircle(circleOf(p), circleOf(base[0])))).toBe(false);
  });

  it.each([0, 1, 7, 14])(
    'a direction through the end of piece %i starts on the next piece, ends on that piece, and leaves no empty piece',
    (k) => {
      const joint = (base[k] as ChainPiece).end;
      const next = base[(k + 1) % base.length] as ChainPiece;
      const seam = Math.atan2(joint.y, joint.x);
      const fromSeam = ovalArc(O, 3, 2, 0, seam, seam + 2);
      expect(circleOf(fromSeam[0])).toEqual(circleOf(next));
      near(fromSeam[0]?.start ?? O, joint, 1e-12);
      const intoSeam = ovalArc(O, 3, 2, 0, seam - 0.05, seam);
      const lastPiece = intoSeam[intoSeam.length - 1];
      expect(circleOf(lastPiece)).toEqual(circleOf(base[k]));
      near(lastPiece?.end ?? O, joint, 1e-12);
      for (const other of [seam + 0.3, seam + 2, seam + 4, seam + 6]) {
        for (const pieces of [ovalArc(O, 3, 2, 0, seam, other), ovalArc(O, 3, 2, 0, other, seam)]) {
          for (const p of pieces) {
            expect(distance(p.start, p.end)).toBeGreaterThan(1e-7);
          }
        }
      }
    },
  );

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
      near(dirOf(O, start), at(angle));
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
    near(dirOf(center, first), at(from));
    near(dirOf(center, last), at(to));
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
