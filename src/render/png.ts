import { crc32, deflateSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';
import { MASK_SIZE, type Mask } from './match.js';

/** Views that are rasterized to PNG. */
export type View = 'sheet' | 'final' | 'sizes' | 'guides' | 'match';

export type PreviewSvgs = {
  final: string;
  guides: string;
  sheet: { svg: string; width: number; height: number };
};

export type PreviewPng = {
  png: Uint8Array;
  width: number;
  height: number;
  overBudget: boolean;
};

const SHEET_LONG_SIDE = 1024;
const FINAL_SIDE = 512;
const SIZES_TILE = 128;
const SIZES_SOURCES = [64, 32, 16] as const;
const BACKGROUND = '#ffffff';
const MAX_BYTES = 300 * 1024;
const SHRINK = 0.75;
const MAX_SHRINKS = 3;
const DECODE_LONG_SIDE = 512;
const MATCH_SIDE = 512;
const UNDERLAY_RGB = [0xd9, 0x48, 0x0f] as const;
const UNDERLAY_ALPHA = Math.round(255 * 0.3);
const MATCH_BOTH = [0x22, 0x22, 0x22] as const;
const MATCH_REFERENCE = [0xd9, 0x48, 0x0f] as const;
const MATCH_INK = [0x1c, 0x7e, 0xd6] as const;
const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

type Raster = { width: number; height: number; rgb: Uint8Array };

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(
  name: string,
  width: number,
  height: number,
  channels: 3 | 4,
  pixels: Uint8Array,
): Uint8Array {
  const stride = width * channels;
  if (pixels.length !== stride * height) {
    throw new Error(`${name}: expected ${stride * height} bytes, got ${pixels.length}`);
  }
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  return new Uint8Array(
    Buffer.concat([
      SIGNATURE,
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', new Uint8Array(0)),
    ]),
  );
}

/** Encodes 8-bit RGB pixels (row-major, 3 bytes each) as a non-interlaced colour-type-2 PNG. */
export function encodeRgbPng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  return encodePng('encodeRgbPng', width, height, 3, rgb);
}

/** Encodes straight (non-premultiplied) 8-bit RGBA pixels as a non-interlaced colour-type-6 PNG. */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  return encodePng('encodeRgbaPng', width, height, 4, rgba);
}

/** Renders on an opaque background, so the premultiplied RGBA from resvg equals straight RGBA. */
function rasterize(
  svg: string,
  fit: { mode: 'width' | 'height'; value: number },
  systemFonts: boolean,
): Raster {
  const image = new Resvg(svg, {
    background: BACKGROUND,
    fitTo: fit,
    font: { loadSystemFonts: systemFonts },
  }).render();
  const rgba = image.pixels;
  const rgb = new Uint8Array(image.width * image.height * 3);
  for (let i = 0; i < image.width * image.height; i++) {
    rgb[i * 3] = rgba[i * 4] ?? 0;
    rgb[i * 3 + 1] = rgba[i * 4 + 1] ?? 0;
    rgb[i * 3 + 2] = rgba[i * 4 + 2] ?? 0;
  }
  return { width: image.width, height: image.height, rgb };
}

/** Three marks rendered directly at 64/32/16 px, then nearest-neighbour scaled to equal tiles. */
function rasterizeSizes(finalSvg: string, tile: number): Raster {
  const rgb = new Uint8Array(tile * SIZES_SOURCES.length * tile * 3).fill(255);
  const width = tile * SIZES_SOURCES.length;
  SIZES_SOURCES.forEach((source, t) => {
    const small = rasterize(finalSvg, { mode: 'width', value: source }, false);
    for (let y = 0; y < tile; y++) {
      const sy = Math.min(small.height - 1, Math.floor((y * source) / tile));
      for (let x = 0; x < tile; x++) {
        const sxp = Math.min(small.width - 1, Math.floor((x * source) / tile));
        const from = (sy * small.width + sxp) * 3;
        const to = (y * width + t * tile + x) * 3;
        rgb.set(small.rgb.subarray(from, from + 3), to);
      }
    }
  });
  return { width, height: tile, rgb };
}

function rasterizeView(view: View, svgs: PreviewSvgs, factor: number): Raster {
  switch (view) {
    case 'sheet': {
      const long = Math.max(1, Math.round(SHEET_LONG_SIDE * factor));
      const fit = svgs.sheet.height >= svgs.sheet.width ? 'height' : 'width';
      return rasterize(svgs.sheet.svg, { mode: fit, value: long }, true);
    }
    case 'final':
      return rasterize(
        svgs.final,
        { mode: 'width', value: Math.max(1, Math.round(FINAL_SIDE * factor)) },
        false,
      );
    case 'guides':
      return rasterize(
        svgs.guides,
        { mode: 'width', value: Math.max(1, Math.round(FINAL_SIDE * factor)) },
        false,
      );
    case 'sizes':
      return rasterizeSizes(svgs.final, Math.max(1, Math.round(SIZES_TILE * factor)));
    case 'match':
      throw new Error('renderPreviewPng: the match view is drawn by renderMatchPng');
  }
}

/** Opaque preview PNG of one view; shrinks up to three times when over 300 KB. */
export function renderPreviewPng(view: View, svgs: PreviewSvgs): PreviewPng {
  let factor = 1;
  for (let attempt = 0; ; attempt++) {
    const raster = rasterizeView(view, svgs, factor);
    const png = encodeRgbPng(raster.width, raster.height, raster.rgb);
    const over = png.length > MAX_BYTES;
    if (!over || attempt >= MAX_SHRINKS) {
      return { png, width: raster.width, height: raster.height, overBudget: over };
    }
    factor *= SHRINK;
  }
}

/** Transparent PNG of the final drawing, `size` px wide. */
export function renderExportPng(finalSvg: string, size: number): Uint8Array {
  const image = new Resvg(finalSvg, {
    fitTo: { mode: 'width', value: size },
    font: { loadSystemFonts: false },
  }).render();
  return new Uint8Array(image.asPng());
}

/**
 * Decodes a PNG or JPEG through resvg into premultiplied RGBA, scaled down (never up) so the
 * longer side is at most 512 px. `width` and `height` are the source dimensions.
 */
export function decodeImage(
  bytes: Uint8Array,
  mime: 'image/png' | 'image/jpeg',
  width: number,
  height: number,
): { rgba: Uint8Array; width: number; height: number } {
  const s = Math.min(1, DECODE_LONG_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * s));
  const h = Math.max(1, Math.round(height * s));
  const href = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<image width="${w}" height="${h}" preserveAspectRatio="none" xlink:href="${href}"/></svg>`;
  const image = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
  return { rgba: new Uint8Array(image.pixels), width: image.width, height: image.height };
}

/** Ink mask of the final drawing: pixels with alpha >= 128 on a 256 px grid, colour ignored. */
export function inkMask(finalSvg: string): Mask {
  const image = new Resvg(finalSvg, {
    fitTo: { mode: 'width', value: MASK_SIZE },
    font: { loadSystemFonts: false },
  }).render();
  const data = new Uint8Array(MASK_SIZE * MASK_SIZE);
  const pixels = image.pixels;
  for (let i = 0; i < data.length; i++) {
    data[i] = (pixels[i * 4 + 3] ?? 0) >= 128 ? 1 : 0;
  }
  return { size: MASK_SIZE, data };
}

/** PNG data URI of the reference mask as a translucent tint, for the construction sheet underlay. */
export function underlayHref(reference: Mask): string {
  const rgba = new Uint8Array(reference.size * reference.size * 4);
  for (let i = 0; i < reference.data.length; i++) {
    if (reference.data[i] === 1) {
      rgba.set([...UNDERLAY_RGB, UNDERLAY_ALPHA], i * 4);
    }
  }
  const png = encodeRgbaPng(reference.size, reference.size, rgba);
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

/** Overlap view: both = dark, reference only = orange, ink only = blue, on white, 512 px wide. */
export function renderMatchPng(reference: Mask, ink: Mask): Uint8Array {
  const size = reference.size;
  const scale = Math.max(1, Math.floor(MATCH_SIDE / size));
  const side = size * scale;
  const rgb = new Uint8Array(side * side * 3).fill(255);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const k = Math.floor(y / scale) * size + Math.floor(x / scale);
      const r = reference.data[k] === 1;
      const f = ink.data[k] === 1;
      if (r || f) {
        rgb.set(r && f ? MATCH_BOTH : r ? MATCH_REFERENCE : MATCH_INK, (y * side + x) * 3);
      }
    }
  }
  return encodeRgbPng(side, side, rgb);
}
