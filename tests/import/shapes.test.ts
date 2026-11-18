import { describe, expect, it } from 'vitest';
import { type Matrix, parsePath } from '../../src/import/path.js';
import { buildPieces } from '../../src/import/shapes.js';

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** A flat run of n cubics; each lies on its chord, so each fits as exactly one line piece. */
const flatRun = (n: number): string => `M2 12${'c0.25 0 0.5 0 0.75 0'.repeat(n)}`;

const build = (d: string) => {
  const sub = parsePath(d, 0)[0];
  if (sub === undefined) {
    throw new Error('no subpath');
  }
  return buildPieces(sub, IDENTITY);
};

describe('buildPieces', () => {
  it('builds a subpath whose curves give 17 fitted pieces', () => {
    const built = build(flatRun(17));
    expect(built?.curves).toBe(17);
    expect(built?.fitted).toBe(17);
    expect(built?.pieces).toHaveLength(17);
  });

  it('builds a subpath whose curves give exactly 64 fitted pieces', () => {
    expect(build(flatRun(64))?.fitted).toBe(64);
  });

  it('returns null when the fitted pieces exceed 64', () => {
    expect(build(flatRun(65))).toBeNull();
  });
});
