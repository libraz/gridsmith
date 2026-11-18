import { describe, expect, it } from 'vitest';
import {
  elevate,
  FIT_RADIUS_MAX,
  FIT_TOLERANCE,
  type Fit,
  type FitPiece,
  fitCubic,
  type Vec,
} from '../../src/import/fit.js';

const v = (x: number, y: number): Vec => ({ x, y });
/** Control-point offset of the cubic that draws a quarter circle of radius 1. */
const KAPPA = 0.5522847;

const fitted = (...p: [Vec, Vec, Vec, Vec]): Fit => {
  const result = fitCubic(...p);
  if (result === null) {
    throw new Error('no fit');
  }
  return result;
};

/** Checks that the pieces run from p0 to p3 without gaps and stay within the tolerance. */
const expectChain = (result: Fit, p0: Vec, p3: Vec): void => {
  const pieces = result.pieces;
  expect(pieces[0]?.a).toEqual(p0);
  expect(pieces[pieces.length - 1]?.b).toEqual(p3);
  pieces.slice(1).forEach((p, k) => {
    expect(p.a).toEqual(pieces[k]?.b);
  });
  expect(result.deviation).toBeLessThanOrEqual(FIT_TOLERANCE);
};

const arcs = (pieces: FitPiece[]) => pieces.flatMap((p) => (p.kind === 'arc' ? [p] : []));

describe('fitCubic', () => {
  it('fits a quarter circle with one arc within 1e-3 of its radius', () => {
    const result = fitted(v(4, 0), v(4, 4 * KAPPA), v(4 * KAPPA, 4), v(0, 4));
    expect(result.pieces).toHaveLength(1);
    const [arc] = arcs(result.pieces);
    expect(arc?.ccw).toBe(true);
    expect(Math.abs((arc?.r ?? 0) - 4)).toBeLessThanOrEqual(1e-3);
    expect(Math.hypot(arc?.c.x ?? 1, arc?.c.y ?? 1)).toBeLessThanOrEqual(1e-3);
    expectChain(result, v(4, 0), v(0, 4));
  });

  it('turns a clockwise quarter into a clockwise arc', () => {
    const result = fitted(v(0, 4), v(4 * KAPPA, 4), v(4, 4 * KAPPA), v(4, 0));
    expect(arcs(result.pieces).map((a) => a.ccw)).toEqual([false]);
  });

  it('fits a straight curve with its chord', () => {
    expect(fitted(v(0, 0), v(1, 0), v(3, 0), v(4, 0))).toEqual({
      pieces: [{ kind: 'line', a: v(0, 0), b: v(4, 0) }],
      deviation: 0,
    });
  });

  it('fits a nearly straight curve, bulging 0.05 over a chord of 8, with its chord', () => {
    const h = 0.05 / 0.75;
    const result = fitted(v(0, 0), v(8 / 3, h), v(16 / 3, h), v(8, 0));
    expect(result.pieces).toEqual([{ kind: 'line', a: v(0, 0), b: v(8, 0) }]);
    expect(result.deviation).toBeCloseTo(0.05, 6);
  });

  it('returns no pieces for a curve collapsed to a point', () => {
    expect(fitCubic(v(1, 1), v(1, 1), v(1, 1), v(1, 1))).toEqual({ pieces: [], deviation: 0 });
  });

  it('splits an S curve at its inflection into sections turning opposite ways', () => {
    const result = fitted(v(0, 0), v(2, 2), v(2, -2), v(4, 0));
    expectChain(result, v(0, 0), v(4, 0));
    const at = result.pieces.findIndex((p) => Math.hypot(p.b.x - 2, p.b.y) < 1e-12);
    expect(at).toBeGreaterThanOrEqual(0);
    const before = arcs(result.pieces.slice(0, at + 1));
    const after = arcs(result.pieces.slice(at + 1));
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    // Rising first, the curve turns right (clockwise in y-up), then left.
    expect(before.every((a) => !a.ccw)).toBe(true);
    expect(after.every((a) => a.ccw)).toBe(true);
  });

  it('adds pieces when one arc misses the curve by more than the tolerance', () => {
    // A quarter of an ellipse 6 x 3: its curvature changes fourfold along the curve.
    const result = fitted(v(6, 0), v(6, 3 * KAPPA), v(6 * KAPPA, 3), v(0, 3));
    expect(result.pieces.length).toBeGreaterThan(1);
    expectChain(result, v(6, 0), v(0, 3));
  });

  it('splits at a cusp and fits both sides', () => {
    const result = fitted(v(-4, 0), v(4, 4), v(-4, 4), v(4, 0));
    expectChain(result, v(-4, 0), v(4, 0));
    expect(result.pieces.some((p) => Math.hypot(p.b.x, p.b.y - 3) < 1e-12)).toBe(true);
  });

  it('fits a drop whose start and end coincide', () => {
    const result = fitted(v(0, 0), v(6, 6), v(-6, 6), v(0, 0));
    expect(result.pieces.length).toBeGreaterThan(1);
    expectChain(result, v(0, 0), v(0, 0));
  });

  it('gives up on a curve too large for the tolerance at the depth limit', () => {
    expect(fitCubic(v(0, 0), v(100, 0), v(100, 100), v(0, 100))).toBeNull();
  });

  it('cuts a shallow arc of radius over 32 into lines instead of one arc', () => {
    // Bulges 0.45 over a chord of 12: the arc through it has radius about 40.
    const result = fitted(v(-6, 0), v(-2, 0.6), v(2, 0.6), v(6, 0));
    expect((36 + 0.45 ** 2) / (2 * 0.45)).toBeGreaterThan(FIT_RADIUS_MAX);
    expect(result.pieces.length).toBeGreaterThan(1);
    expect(result.pieces.every((p) => p.kind === 'line')).toBe(true);
    expectChain(result, v(-6, 0), v(6, 0));
  });
});

describe('elevate', () => {
  it('places the inner control points at (q0 + 2 q1) / 3 and (2 q1 + q2) / 3', () => {
    expect(elevate(v(0, 0), v(3, 6), v(6, 0))).toEqual([v(0, 0), v(2, 4), v(4, 4), v(6, 0)]);
  });

  it('keeps the curve: the cubic passes through the quadratic midpoint', () => {
    const [p0, p1, p2, p3] = elevate(v(0, 0), v(3, 6), v(6, 0));
    const mid = (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8;
    expect(mid).toBeCloseTo((0 + 2 * 6 + 0) / 4, 12);
  });
});
