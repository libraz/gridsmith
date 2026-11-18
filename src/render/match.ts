/** Pure pixel math for the reference underlay: binarizing, placing and scoring. No decoding, no I/O. */

/** Square foreground mask; 1 = foreground, row 0 is the top (largest y). */
export type Mask = { size: number; data: Uint8Array };

export type Binary = {
  width: number;
  height: number;
  data: Uint8Array;
  threshold: number | null;
  inverted: boolean;
  source: 'alpha' | 'luminance';
};

/** `[x0, y0, x1, y1]` in modules, y up. */
export type Box = [number, number, number, number];

export type MatchBlob = {
  kind: 'missing' | 'excess';
  share: number;
  center: [number, number];
  bbox: Box;
};

export type MatchNumbers = {
  iou: number;
  missing: number;
  excess: number;
  offset: [number, number] | null;
  grid: string[];
  blobs: MatchBlob[];
};

export type MatchErrorCode = 'no_silhouette' | 'empty_reference';

export class MatchError extends Error {
  readonly code: MatchErrorCode;

  constructor(code: MatchErrorCode) {
    super(code === 'no_silhouette' ? 'no silhouette found' : 'reference is empty after placement');
    this.name = 'MatchError';
    this.code = code;
  }
}

/** Side of the canvas grid every mask is sampled on. */
export const MASK_SIZE = 256;

const ALPHA_FOREGROUND = 128;
const ALPHA_SHARE = 0.01;
const MIN_FOREGROUND = 0.005;
const MAX_FOREGROUND = 0.995;
const GRID_CELLS = 12;
const GRID_MARK = 0.1;
const BLOB_MIN_SHARE = 0.005;
const MAX_BLOBS = 3;

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f + 0;
}

function otsu(luma: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  let sum = 0;
  for (const y of luma) {
    hist[y] = (hist[y] ?? 0) + 1;
    sum += y;
  }
  const total = luma.length;
  let best = 1;
  let bestVariance = -1;
  let weightDark = 0;
  let sumDark = 0;
  // Dark class is Y < t, so t = 1 holds only Y = 0.
  for (let t = 1; t <= 255; t++) {
    const count = hist[t - 1] ?? 0;
    weightDark += count;
    sumDark += (t - 1) * count;
    const weightLight = total - weightDark;
    if (weightDark === 0 || weightLight === 0) {
      continue;
    }
    const diff = sumDark / weightDark - (sum - sumDark) / weightLight;
    const variance = weightDark * weightLight * diff * diff;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = t;
    }
  }
  return best;
}

/** Foreground mask of premultiplied RGBA pixels (row 0 = top). Throws `MatchError` when no silhouette is found. */
export function binarize(
  rgba: Uint8Array,
  width: number,
  height: number,
  opts: { threshold?: number; invert?: boolean },
): Binary {
  const n = width * height;
  const invert = opts.invert === true;
  let transparent = 0;
  for (let i = 0; i < n; i++) {
    if ((rgba[i * 4 + 3] ?? 0) < ALPHA_FOREGROUND) {
      transparent++;
    }
  }
  const data = new Uint8Array(n);
  let threshold: number | null = null;
  let source: Binary['source'];
  if (transparent >= n * ALPHA_SHARE) {
    source = 'alpha';
    for (let i = 0; i < n; i++) {
      data[i] = (rgba[i * 4 + 3] ?? 0) >= ALPHA_FOREGROUND ? 1 : 0;
    }
  } else {
    source = 'luminance';
    const luma = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const rest = 255 - (rgba[i * 4 + 3] ?? 0);
      const r = Math.min(255, (rgba[i * 4] ?? 0) + rest);
      const g = Math.min(255, (rgba[i * 4 + 1] ?? 0) + rest);
      const b = Math.min(255, (rgba[i * 4 + 2] ?? 0) + rest);
      luma[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
    threshold = opts.threshold ?? otsu(luma);
    let ringDark = 0;
    let ringLight = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dark = (luma[y * width + x] ?? 0) < threshold;
        data[y * width + x] = dark ? 1 : 0;
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
          if (dark) {
            ringDark++;
          } else {
            ringLight++;
          }
        }
      }
    }
    // A dark majority on the ring is the background; a tie counts as a light background.
    if (ringDark > ringLight) {
      for (let i = 0; i < n; i++) {
        data[i] = data[i] === 1 ? 0 : 1;
      }
    }
  }
  if (invert) {
    for (let i = 0; i < n; i++) {
      data[i] = data[i] === 1 ? 0 : 1;
    }
  }
  let count = 0;
  for (let i = 0; i < n; i++) {
    count += data[i] ?? 0;
  }
  if (count < n * MIN_FOREGROUND || count > n * MAX_FOREGROUND) {
    throw new MatchError('no_silhouette');
  }
  return { width, height, data, threshold, inverted: invert, source };
}

/**
 * Scales the placed extent to the largest size that keeps its aspect ratio inside `box`, centres it
 * there and samples it onto the canvas grid. The extent is the foreground bounding box (measured on
 * pixel edges) for `fit` "shape", or the whole image for "image".
 */
export function placeReference(
  bin: Binary,
  box: Box,
  canvasHalf: number,
  fit: 'shape' | 'image' = 'shape',
): { mask: Mask; placed: Box } {
  const { width, height, data } = bin;
  let minC = width;
  let maxC = -1;
  let minR = height;
  let maxR = -1;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (data[r * width + c] === 1) {
        minC = Math.min(minC, c);
        maxC = Math.max(maxC, c);
        minR = Math.min(minR, r);
        maxR = Math.max(maxR, r);
      }
    }
  }
  if (fit === 'image') {
    minC = 0;
    maxC = width - 1;
    minR = 0;
    maxR = height - 1;
  }
  const mask: Mask = { size: MASK_SIZE, data: new Uint8Array(MASK_SIZE * MASK_SIZE) };
  if (maxC < 0) {
    throw new MatchError('empty_reference');
  }
  const bw = maxC - minC + 1;
  const bh = maxR - minR + 1;
  const [bx0, by0, bx1, by1] = box;
  const scale = Math.min((bx1 - bx0) / bw, (by1 - by0) / bh);
  const pw = bw * scale;
  const ph = bh * scale;
  const px0 = (bx0 + bx1) / 2 - pw / 2;
  const py1 = (by0 + by1) / 2 + ph / 2;
  const placed: Box = [px0, py1 - ph, px0 + pw, py1];
  const cell = (2 * canvasHalf) / MASK_SIZE;
  let any = false;
  for (let j = 0; j < MASK_SIZE; j++) {
    const y = canvasHalf - (j + 0.5) * cell;
    const fr = (py1 - y) / scale + minR;
    if (fr < minR || fr >= maxR + 1) {
      continue;
    }
    const row = Math.floor(fr);
    for (let i = 0; i < MASK_SIZE; i++) {
      const x = -canvasHalf + (i + 0.5) * cell;
      const fc = (x - px0) / scale + minC;
      if (fc < minC || fc >= maxC + 1) {
        continue;
      }
      if (data[row * width + Math.floor(fc)] === 1) {
        mask.data[j * MASK_SIZE + i] = 1;
        any = true;
      }
    }
  }
  if (!any) {
    throw new MatchError('empty_reference');
  }
  return { mask, placed };
}

/** Straight RGBA pixels, row 0 is the top. */
export type RgbaImage = { width: number; height: number; data: Uint8Array };

/** Share of pixels where at least one RGBA channel differs by more than `tolerance`. Throws when the sizes differ. */
export function diffShare(a: RgbaImage, b: RgbaImage, tolerance: number): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`image sizes differ: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const n = a.width * a.height;
  let differing = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 4; c++) {
      if (Math.abs((a.data[i * 4 + c] ?? 0) - (b.data[i * 4 + c] ?? 0)) > tolerance) {
        differing++;
        break;
      }
    }
  }
  return n === 0 ? 0 : differing / n;
}

type Component = {
  area: number;
  sumI: number;
  sumJ: number;
  minI: number;
  maxI: number;
  minJ: number;
  maxJ: number;
};

function components(flags: Uint8Array, size: number): Component[] {
  const seen = new Uint8Array(flags.length);
  const out: Component[] = [];
  const stack: number[] = [];
  for (let start = 0; start < flags.length; start++) {
    if (flags[start] !== 1 || seen[start] === 1) {
      continue;
    }
    const comp: Component = {
      area: 0,
      sumI: 0,
      sumJ: 0,
      minI: size,
      maxI: -1,
      minJ: size,
      maxJ: -1,
    };
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const at = stack.pop() as number;
      const i = at % size;
      const j = (at - i) / size;
      comp.area++;
      comp.sumI += i;
      comp.sumJ += j;
      comp.minI = Math.min(comp.minI, i);
      comp.maxI = Math.max(comp.maxI, i);
      comp.minJ = Math.min(comp.minJ, j);
      comp.maxJ = Math.max(comp.maxJ, j);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= size || nj >= size) {
            continue;
          }
          const next = nj * size + ni;
          if (flags[next] === 1 && seen[next] === 0) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    out.push(comp);
  }
  return out;
}

/** Scores the finished drawing against the placed reference; both masks share one grid over the canvas. */
export function compareMasks(reference: Mask, ink: Mask, canvasHalf: number): MatchNumbers {
  const size = reference.size;
  const cell = (2 * canvasHalf) / size;
  const n = size * size;
  const missingFlags = new Uint8Array(n);
  const excessFlags = new Uint8Array(n);
  let refCount = 0;
  let inkCount = 0;
  let both = 0;
  let refX = 0;
  let refY = 0;
  let inkX = 0;
  let inkY = 0;
  const cellTotal = new Array<number>(GRID_CELLS * GRID_CELLS).fill(0);
  const cellMissing = new Array<number>(GRID_CELLS * GRID_CELLS).fill(0);
  const cellExcess = new Array<number>(GRID_CELLS * GRID_CELLS).fill(0);
  for (let j = 0; j < size; j++) {
    const y = canvasHalf - (j + 0.5) * cell;
    const cj = Math.floor((j * GRID_CELLS) / size);
    for (let i = 0; i < size; i++) {
      const x = -canvasHalf + (i + 0.5) * cell;
      const k = j * size + i;
      const r = reference.data[k] === 1;
      const f = ink.data[k] === 1;
      const g = cj * GRID_CELLS + Math.floor((i * GRID_CELLS) / size);
      cellTotal[g] = (cellTotal[g] ?? 0) + 1;
      if (r) {
        refCount++;
        refX += x;
        refY += y;
      }
      if (f) {
        inkCount++;
        inkX += x;
        inkY += y;
      }
      if (r && f) {
        both++;
      } else if (r) {
        missingFlags[k] = 1;
        cellMissing[g] = (cellMissing[g] ?? 0) + 1;
      } else if (f) {
        excessFlags[k] = 1;
        cellExcess[g] = (cellExcess[g] ?? 0) + 1;
      }
    }
  }

  const grid: string[] = [];
  for (let cj = 0; cj < GRID_CELLS; cj++) {
    let line = '';
    for (let ci = 0; ci < GRID_CELLS; ci++) {
      const g = cj * GRID_CELLS + ci;
      const total = cellTotal[g] ?? 1;
      const m = (cellMissing[g] ?? 0) / total;
      const e = (cellExcess[g] ?? 0) / total;
      line += Math.max(m, e) < GRID_MARK ? '.' : m >= e ? '-' : '+';
    }
    grid.push(line);
  }

  const found: (MatchBlob & { sortX: number; sortY: number; area: number })[] = [];
  const collect = (flags: Uint8Array, kind: MatchBlob['kind']) => {
    for (const c of components(flags, size)) {
      if (c.area < refCount * BLOB_MIN_SHARE) {
        continue;
      }
      const cx = -canvasHalf + (c.sumI / c.area + 0.5) * cell;
      const cy = canvasHalf - (c.sumJ / c.area + 0.5) * cell;
      found.push({
        kind,
        share: round(c.area / refCount, 3),
        center: [round(cx, 1), round(cy, 1)],
        bbox: [
          round(-canvasHalf + c.minI * cell, 1),
          round(canvasHalf - (c.maxJ + 1) * cell, 1),
          round(-canvasHalf + (c.maxI + 1) * cell, 1),
          round(canvasHalf - c.minJ * cell, 1),
        ],
        sortX: cx,
        sortY: cy,
        area: c.area,
      });
    }
  };
  collect(missingFlags, 'missing');
  collect(excessFlags, 'excess');
  found.sort(
    (a, b) =>
      b.area - a.area ||
      (a.kind === b.kind ? 0 : a.kind === 'missing' ? -1 : 1) ||
      a.sortX - b.sortX ||
      a.sortY - b.sortY,
  );
  const blobs = found.slice(0, MAX_BLOBS).map(({ kind, share, center, bbox }) => ({
    kind,
    share,
    center,
    bbox,
  }));

  return {
    iou: round(both / (refCount + inkCount - both), 3),
    missing: round((refCount - both) / refCount, 3),
    excess: inkCount === 0 ? 0 : round((inkCount - both) / inkCount, 3),
    offset:
      inkCount === 0
        ? null
        : [
            round(inkX / inkCount - refX / refCount, 2),
            round(inkY / inkCount - refY / refCount, 2),
          ],
    grid,
    blobs,
  };
}
