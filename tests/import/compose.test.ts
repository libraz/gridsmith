import { describe, expect, it } from 'vitest';
import { composeRing, fillMatches, strokeParts } from '../../src/import/compose.js';
import { type Matrix, parsePath } from '../../src/import/path.js';
import { buildPieces, type Piece } from '../../src/import/shapes.js';

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Pieces and fill ring of the first subpath of `d`, y up. */
const built = (d: string): { pieces: Piece[]; ring: Piece[]; closed: boolean } => {
  const [sub] = parsePath(d, 0);
  const result = sub === undefined ? null : buildPieces(sub, IDENTITY);
  if (result === null) {
    throw new Error(`cannot build ${d}`);
  }
  return result;
};

describe('composeRing', () => {
  it('unites a rect with the ellipse of a D whose arc bulges out', () => {
    // Clockwise in y-up, and so is the arc: it turns with the chord ring, so it adds.
    const composed = composeRing(built('M4 4h6a6 4 0 0 1 0 8h-6z').ring, 'd');
    expect(composed?.shapes).toEqual([
      {
        id: 'd',
        type: 'rect',
        corners: [
          [-8, 0],
          [-2, 8],
        ],
      },
      { id: 'de0', type: 'oval', center: [-2, 4], rx: 6, ry: 4, rotate: 0 },
    ]);
    expect(composed?.region).toEqual({ union: ['d', 'de0'] });
  });

  it('subtracts the ellipse of an arc that carves into the ring', () => {
    // The ring runs clockwise in y-up, the arc counter-clockwise: against the ring, so it carves.
    const composed = composeRing(built('M4 4H16V7A4 3 0 0 0 16 13V16H4Z').ring, 'c');
    expect(composed?.shapes).toEqual([
      {
        id: 'c',
        type: 'points',
        through: [
          [-8, 8],
          [4, 8],
          [4, 5],
          [4, -1],
          [4, -4],
          [-8, -4],
        ],
      },
      { id: 'ce0', type: 'oval', center: [4, 2], rx: 4, ry: 3, rotate: 0 },
    ]);
    expect(composed?.region).toEqual({ subtract: ['c', 'ce0'] });
  });

  it('refuses a ring of one chord and one ellipse arc, which has no chord area', () => {
    expect(composeRing(built('M2 12A6 4 0 0 1 14 12z').ring, 'h')).toBeNull();
  });
});

describe('fillMatches', () => {
  it('rejects an ellipse whose other half lies outside a narrow chord ring', () => {
    // The chord ring spans x -2..0; the left half of the oval reaches x = -6.
    const { ring } = built('M10 4h2a6 4 0 0 1 0 8h-2z');
    const composed = composeRing(ring, 'n');
    if (composed === null) {
      throw new Error('not composed');
    }
    expect(fillMatches([ring], false, composed.region, composed.tests)).toBe(false);
    const wide = built('M4 4h6a6 4 0 0 1 0 8h-6z').ring;
    const fits = composeRing(wide, 'd');
    if (fits === null) {
      throw new Error('not composed');
    }
    expect(fillMatches([wide], false, fits.region, fits.tests)).toBe(true);
  });
});

describe('strokeParts', () => {
  it('splits lines and an ellipse arc meeting smoothly, and refuses corners unless round', () => {
    // The lower half of a 6 x 3 ellipse leaves and meets vertical lines: smooth seams.
    const smooth = built('M4 4V12A6 3 0 0 0 16 12V4');
    expect(strokeParts(smooth.pieces, 'p', false, false)?.shapes).toEqual([
      { id: 'pe0', type: 'oval', center: [-2, 0], rx: 6, ry: 3, rotate: 0 },
      { id: 'pa', type: 'line', from: [-8, 8], to: [-8, 0] },
      { id: 'pb', type: 'arc', on: 'pe0', from: 180, to: 0 },
      { id: 'pc', type: 'line', from: [4, 0], to: [4, 8] },
    ]);
    // Slanted lines meet the arc at a corner of about 14 degrees.
    const cornered = built('M2 4L4 12A6 3 0 0 0 16 12L18 4');
    expect(strokeParts(cornered.pieces, 'q', false, false)).toBeNull();
    expect(strokeParts(cornered.pieces, 'q', false, true)?.ids).toEqual(['qa', 'qb', 'qc']);
  });
});
