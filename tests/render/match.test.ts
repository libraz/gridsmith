import { describe, expect, it } from 'vitest';
import {
  type Binary,
  binarize,
  compareMasks,
  diffShare,
  type Mask,
  MatchError,
  placeReference,
  type RgbaImage,
} from '../../src/render/match.js';

const HALF = 9;
const SIZE = 256;

/** Disc mask on the canvas grid; row 0 is the top. */
function disc(cx: number, cy: number, r: number, half = HALF): Mask {
  const data = new Uint8Array(SIZE * SIZE);
  const cell = (2 * half) / SIZE;
  for (let j = 0; j < SIZE; j++) {
    for (let i = 0; i < SIZE; i++) {
      const x = -half + (i + 0.5) * cell;
      const y = half - (j + 0.5) * cell;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
        data[j * SIZE + i] = 1;
      }
    }
  }
  return { size: SIZE, data };
}

/** Black disc on white, opaque RGBA. */
function discImage(side: number, r: number): Uint8Array {
  const rgba = new Uint8Array(side * side * 4).fill(255);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      if ((x + 0.5 - side / 2) ** 2 + (y + 0.5 - side / 2) ** 2 <= r * r) {
        rgba.set([0, 0, 0, 255], (y * side + x) * 4);
      }
    }
  }
  return rgba;
}

function rect(mask: Mask, c0: number, c1: number, r0: number, r1: number): Mask {
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      mask.data[r * mask.size + c] = 1;
    }
  }
  return mask;
}

const empty = (): Mask => ({ size: SIZE, data: new Uint8Array(SIZE * SIZE) });

function reference(r: number, box: [number, number, number, number]): Mask {
  const bin = binarize(discImage(200, 100 * (r / 6)), 200, 200, {});
  return placeReference(bin, box, HALF).mask;
}

describe('compareMasks', () => {
  it('matches a concentric disc of the same radius', () => {
    const m = compareMasks(reference(6, [-6, -6, 6, 6]), disc(0, 0, 6), HALF);
    expect(m.iou).toBeGreaterThanOrEqual(0.98);
    expect(m.missing).toBeLessThanOrEqual(0.02);
    expect(m.excess).toBeLessThanOrEqual(0.02);
    expect(m.grid).toEqual(Array(12).fill('.'.repeat(12)));
  });

  it('reports a smaller disc as missing area', () => {
    const m = compareMasks(reference(4, [-4, -4, 4, 4]), disc(0, 0, 3), HALF);
    expect(Math.abs(m.iou - 9 / 16)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(m.missing - 7 / 16)).toBeLessThanOrEqual(0.02);
    expect(m.excess).toBeLessThanOrEqual(0.01);
  });

  it('locates a disc shifted right through offset and blobs', () => {
    const m = compareMasks(reference(4, [-4, -4, 4, 4]), disc(2, 0, 4), HALF);
    expect(m.offset).not.toBeNull();
    expect(Math.abs((m.offset?.[0] ?? 0) - 2)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(m.offset?.[1] ?? 1)).toBeLessThanOrEqual(0.1);
    const missing = m.blobs.find((b) => b.kind === 'missing');
    const excess = m.blobs.find((b) => b.kind === 'excess');
    expect(missing?.center[0]).toBeLessThan(0);
    expect(excess?.center[0]).toBeGreaterThan(2);
  });

  it('puts missing marks in the upper rows and excess marks in the lower rows for a disc shifted down', () => {
    const m = compareMasks(reference(4, [-4, -4, 4, 4]), disc(0, -2, 4), HALF);
    expect(Math.abs((m.offset?.[1] ?? 0) + 2)).toBeLessThanOrEqual(0.1);
    // The two crescents meet at y = -1, inside row 6 (y from -1.5 to 0).
    m.grid.forEach((line, row) => {
      if (row >= 7) {
        expect(line).not.toContain('-');
      }
      if (row <= 5) {
        expect(line).not.toContain('+');
      }
    });
    expect(m.grid.slice(0, 6).join('')).toContain('-');
    expect(m.grid.slice(6).join('')).toContain('+');
  });

  it('returns a null offset and zero excess for an empty drawing', () => {
    const m = compareMasks(disc(0, 0, 4), empty(), HALF);
    expect(m.offset).toBeNull();
    expect(m.excess).toBe(0);
    expect(m.iou).toBe(0);
    expect(m.missing).toBe(1);
  });

  it('assigns pixel (i, j) to grid cell floor(i * 12 / 256)', () => {
    const anchor = (m: Mask) => rect(m, 240, 255, 240, 255);
    // Columns 0..21 belong to cell 0, column 22 starts cell 1.
    let ref = anchor(rect(empty(), 0, 21, 0, 21));
    let m = compareMasks(ref, anchor(empty()), HALF);
    expect(m.grid[0]).toBe(`-${'.'.repeat(11)}`);
    expect(m.grid.slice(1).join('')).toBe('.'.repeat(11 * 12));
    // 3 of 21 columns of cell 1 is 14%, over the 10% mark.
    ref = anchor(rect(empty(), 22, 24, 0, 21));
    m = compareMasks(ref, anchor(empty()), HALF);
    expect(m.grid[0]).toBe(`.-${'.'.repeat(10)}`);
    // A single column of cell 0 stays below the mark.
    ref = anchor(rect(empty(), 21, 21, 0, 21));
    m = compareMasks(ref, anchor(empty()), HALF);
    expect(m.grid[0]).toBe('.'.repeat(12));
    // Ink only marks '+'.
    m = compareMasks(anchor(empty()), anchor(rect(empty(), 0, 21, 0, 21)), HALF);
    expect(m.grid[0]).toBe(`+${'.'.repeat(11)}`);
  });

  it('breaks the grid tie toward missing', () => {
    // Cell (0, 0): half of it missing, half of it excess.
    const ref = rect(empty(), 0, 10, 0, 21);
    const ink = rect(empty(), 11, 21, 0, 21);
    const m = compareMasks(ref, ink, 128);
    expect(m.grid[0]?.[0]).toBe('-');
  });
});

describe('blobs', () => {
  it('orders by area, then missing before excess, then centre x; keeps three', () => {
    const half = 128;
    const ref = rect(rect(rect(empty(), 10, 29, 10, 29), 100, 109, 10, 19), 150, 154, 10, 14);
    const ink = rect(empty(), 50, 59, 10, 19);
    const m = compareMasks(ref, ink, half);
    expect(m.blobs.map((b) => b.kind)).toEqual(['missing', 'missing', 'excess']);
    expect(m.blobs[0]?.share).toBeCloseTo(400 / 525, 3);
    expect(m.blobs[1]?.center[0]).toBeCloseTo(-128 + 105, 1);
    expect(m.blobs[2]?.center[0]).toBeCloseTo(-128 + 55, 1);
    expect(m.blobs[2]?.share).toBeCloseTo(100 / 525, 3);
  });

  it('orders equal missing blobs by centre x', () => {
    const ref = rect(rect(empty(), 100, 109, 10, 19), 60, 69, 10, 19);
    const m = compareMasks(ref, empty(), 128);
    expect(m.blobs.map((b) => b.center[0])).toEqual([-128 + 65, -128 + 105]);
  });

  it('drops components under 0.5% of the reference and joins diagonal neighbours', () => {
    const ref = rect(empty(), 10, 29, 10, 29);
    rect(ref, 200, 200, 200, 200);
    expect(compareMasks(ref, rect(empty(), 10, 29, 10, 29), 128).blobs).toEqual([]);
    const diagonal = rect(rect(empty(), 0, 9, 0, 9), 10, 19, 10, 19);
    expect(compareMasks(diagonal, empty(), 128).blobs).toHaveLength(1);
  });

  it('reports the bounding box and centre in modules with y up', () => {
    const ref = rect(empty(), 10, 29, 10, 19);
    const m = compareMasks(ref, empty(), 128);
    expect(m.blobs[0]).toEqual({
      kind: 'missing',
      share: 1,
      center: [-128 + 20, 128 - 15],
      bbox: [-128 + 10, 128 - 20, -128 + 30, 128 - 10],
    });
  });
});

/*
 * Binarization cases (each checks the foreground side and the reported source, threshold, inverted):
 *
 * | # | alpha | threshold | invert | border |
 * |---|-------|-----------|--------|--------|
 * | 1 | no    | omitted   | false  | light  |
 * | 2 | no    | given     | true   | light  |
 * | 3 | no    | omitted   | true   | dark   |
 * | 4 | no    | given     | false  | dark   |
 * | 5 | yes   | omitted   | false  | -      |
 * | 6 | yes   | given     | true   | -      |
 */
describe('binarize', () => {
  const N = 20;
  const inSquare = (x: number, y: number) => x >= 6 && x < 14 && y >= 6 && y < 14;
  /** Opaque square of `inner` grey on `outer` grey. */
  function grey(outer: number, inner: number): Uint8Array {
    const rgba = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const v = inSquare(x, y) ? inner : outer;
        rgba.set([v, v, v, 255], (y * N + x) * 4);
      }
    }
    return rgba;
  }
  /** Opaque black square on a fully transparent background. */
  function cutout(): Uint8Array {
    const rgba = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (inSquare(x, y)) {
          rgba.set([0, 0, 0, 255], (y * N + x) * 4);
        }
      }
    }
    return rgba;
  }
  const foreground = (b: Binary) => {
    const out: boolean[] = [];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        out.push(b.data[y * N + x] === 1);
      }
    }
    return out;
  };
  const squareOnly = () => {
    const out: boolean[] = [];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        out.push(inSquare(x, y));
      }
    }
    return out;
  };

  it('1: dark square on light border, Otsu', () => {
    const b = binarize(grey(255, 0), N, N, {});
    expect(foreground(b)).toEqual(squareOnly());
    expect([b.source, b.threshold, b.inverted]).toEqual(['luminance', 1, false]);
  });

  it('2: given threshold with invert on a light border selects the border', () => {
    const b = binarize(grey(255, 0), N, N, { threshold: 128, invert: true });
    expect(foreground(b)).toEqual(squareOnly().map((v) => !v));
    expect([b.source, b.threshold, b.inverted]).toEqual(['luminance', 128, true]);
  });

  it('3: invert on a dark border selects the border', () => {
    const b = binarize(grey(0, 255), N, N, { invert: true });
    expect(foreground(b)).toEqual(squareOnly().map((v) => !v));
    expect([b.source, b.threshold, b.inverted]).toEqual(['luminance', 1, true]);
  });

  it('4: light square on a dark border with a given threshold', () => {
    const b = binarize(grey(0, 200), N, N, { threshold: 100 });
    expect(foreground(b)).toEqual(squareOnly());
    expect([b.source, b.threshold, b.inverted]).toEqual(['luminance', 100, false]);
  });

  it('5: transparent background gives an alpha foreground with a null threshold', () => {
    const b = binarize(cutout(), N, N, {});
    expect(foreground(b)).toEqual(squareOnly());
    expect([b.source, b.threshold, b.inverted]).toEqual(['alpha', null, false]);
  });

  it('6: alpha ignores the given threshold and inverts last', () => {
    const b = binarize(cutout(), N, N, { threshold: 50, invert: true });
    expect(foreground(b)).toEqual(squareOnly().map((v) => !v));
    expect([b.source, b.threshold, b.inverted]).toEqual(['alpha', null, true]);
  });

  it('treats a light/dark tie on the border as a light background', () => {
    // 2x1 image: one dark and one light pixel, both on the border.
    const rgba = Uint8Array.of(0, 0, 0, 255, 255, 255, 255, 255);
    const b = binarize(rgba, 2, 1, { threshold: 128 });
    expect(Array.from(b.data)).toEqual([1, 0]);
  });

  it('composites translucent pixels onto white before taking luminance', () => {
    // Premultiplied 50% black: [0, 0, 0, 128] becomes (127, 127, 127), dark at t = 128.
    const rgba = new Uint8Array(N * N * 4).fill(255);
    for (let y = 6; y < 14; y++) {
      for (let x = 6; x < 14; x++) {
        rgba.set([0, 0, 0, 128], (y * N + x) * 4);
      }
    }
    expect(foreground(binarize(rgba, N, N, { threshold: 128 }))).toEqual(squareOnly());
    // At t = 127 nothing is dark.
    expect(() => binarize(rgba, N, N, { threshold: 127 })).toThrow(MatchError);
  });

  it('rejects an image with no silhouette', () => {
    const flat = new Uint8Array(N * N * 4).fill(255);
    expect(() => binarize(flat, N, N, {})).toThrow(MatchError);
    try {
      binarize(flat, N, N, {});
    } catch (e) {
      expect((e as MatchError).code).toBe('no_silhouette');
    }
  });

  it('rejects a speck under 0.5% and its complement over 99.5%', () => {
    const speck = new Uint8Array(N * N * 4).fill(255);
    speck.set([0, 0, 0, 255], 0);
    expect(() => binarize(speck, N, N, {})).toThrow(MatchError);
    expect(() => binarize(speck, N, N, { invert: true })).toThrow(MatchError);
  });
});

describe('placeReference', () => {
  const expectBox = (got: number[], want: number[]) => {
    want.forEach((v, k) => {
      expect(got[k]).toBeCloseTo(v, 9);
    });
  };
  const full = (width: number, height: number): Binary => ({
    width,
    height,
    data: new Uint8Array(width * height).fill(1),
    threshold: 1,
    inverted: false,
    source: 'luminance',
  });

  it('keeps the aspect ratio and centres the bounding box in the box', () => {
    const { placed } = placeReference(full(200, 100), [-8, -8, 8, 8], HALF);
    expectBox(placed, [-8, -4, 8, 4]);
  });

  it('fits a tall reference by height', () => {
    const { placed } = placeReference(full(100, 200), [-8, -4, 8, 4], HALF);
    expectBox(placed, [-2, -4, 2, 4]);
  });

  it('measures the bounding box on pixel edges, ignoring the empty margin', () => {
    const bin = full(40, 40);
    bin.data.fill(0);
    for (let r = 10; r < 20; r++) {
      for (let c = 5; c < 25; c++) {
        bin.data[r * 40 + c] = 1;
      }
    }
    const { placed } = placeReference(bin, [-4, -4, 4, 4], HALF);
    expectBox(placed, [-4, -2, 4, 2]);
  });

  it('puts image row 0 at the top of the mask', () => {
    const bin = full(20, 20);
    bin.data.fill(0);
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        bin.data[r * 20 + c] = 1;
      }
    }
    bin.data[19 * 20 + 19] = 1;
    const { mask } = placeReference(bin, [-8, -8, 8, 8], HALF);
    const at = (x: number, y: number) =>
      mask.data[
        Math.floor((HALF - y) / ((2 * HALF) / SIZE)) * SIZE +
          Math.floor((x + HALF) / ((2 * HALF) / SIZE))
      ];
    expect(at(-4, 4)).toBe(1);
    expect(at(-4, -4)).toBe(0);
    expect(at(4, 4)).toBe(0);
  });

  it('samples the cell centre nearest pixel', () => {
    const { mask } = placeReference(full(10, 10), [-4.5, -4.5, 4.5, 4.5], HALF);
    const cell = (2 * HALF) / SIZE;
    const count = mask.data.reduce((a, b) => a + b, 0);
    expect(Math.abs(count * cell * cell - 81)).toBeLessThan(2);
  });

  it('rejects a reference that covers no grid cell centre', () => {
    const bin = full(4, 4);
    expect(() => placeReference(bin, [0, 0, 0.01, 0.01], HALF)).toThrow(MatchError);
    try {
      placeReference(bin, [0, 0, 0.01, 0.01], HALF);
    } catch (e) {
      expect((e as MatchError).code).toBe('empty_reference');
    }
  });
});

describe('image fit', () => {
  /** 24 px white image whose only black pixels are the top-left 6x6. */
  const corner = (): Binary => {
    const side = 24;
    const rgba = new Uint8Array(side * side * 4).fill(255);
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 6; x++) {
        rgba.set([0, 0, 0, 255], (y * side + x) * 4);
      }
    }
    return binarize(rgba, side, side, {});
  };

  /** Centroid of the mask in canvas units (y up). */
  const centroid = (mask: Mask, half: number): [number, number] => {
    const cell = (2 * half) / mask.size;
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (let j = 0; j < mask.size; j++) {
      for (let i = 0; i < mask.size; i++) {
        if (mask.data[j * mask.size + i] === 1) {
          n++;
          sx += -half + (i + 0.5) * cell;
          sy += half - (j + 0.5) * cell;
        }
      }
    }
    return [sx / n, sy / n];
  };

  const BOX: [number, number, number, number] = [-12, -12, 12, 12];

  it('places the whole image in the box, keeping the corner where it was', () => {
    const { mask, placed } = placeReference(corner(), BOX, 12, 'image');
    const [cx, cy] = centroid(mask, 12);
    expect(Math.abs(cx + 9)).toBeLessThan(0.1);
    expect(Math.abs(cy - 9)).toBeLessThan(0.1);
    expect(placed).toEqual(BOX);
  });

  it('shape fit scales the foreground box to the box instead', () => {
    const { mask } = placeReference(corner(), BOX, 12, 'shape');
    const [cx, cy] = centroid(mask, 12);
    expect(Math.abs(cx)).toBeLessThan(0.1);
    expect(Math.abs(cy)).toBeLessThan(0.1);
  });

  it('defaults to shape', () => {
    const a = placeReference(corner(), BOX, 12);
    const b = placeReference(corner(), BOX, 12, 'shape');
    expect(a.placed).toEqual(b.placed);
    expect(a.mask.data).toEqual(b.mask.data);
  });

  it('keeps the aspect ratio and centres a wide image in a square box', () => {
    const rgba = new Uint8Array(20 * 10 * 4).fill(255);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 5; x++) {
        rgba.set([0, 0, 0, 255], (y * 20 + x) * 4);
      }
    }
    const bin = binarize(rgba, 20, 10, {});
    const { placed } = placeReference(bin, [-10, -10, 10, 10], 12, 'image');
    expect(placed).toEqual([-10, -5, 10, 5]);
  });
});

describe('pixel difference', () => {
  const solid = (side: number, v: number): RgbaImage => ({
    width: side,
    height: side,
    data: new Uint8Array(side * side * 4).fill(v),
  });

  it('gives 0 for identical images', () => {
    expect(diffShare(solid(10, 7), solid(10, 7), 0)).toBe(0);
  });

  it('counts a single differing pixel of a 10x10 pair as 0.01', () => {
    const a = solid(10, 255);
    const b = solid(10, 255);
    b.data[(3 * 10 + 4) * 4 + 1] = 0;
    expect(diffShare(a, b, 32)).toBe(0.01);
  });

  it('counts a difference above the tolerance only, in any channel', () => {
    const a = solid(10, 100);
    const b = solid(10, 100);
    b.data[3] = 132;
    expect(diffShare(a, b, 32)).toBe(0);
    b.data[3] = 133;
    expect(diffShare(a, b, 32)).toBe(0.01);
  });

  it('throws when the sizes differ', () => {
    expect(() => diffShare(solid(10, 0), solid(11, 0), 32)).toThrow(Error);
  });
});
