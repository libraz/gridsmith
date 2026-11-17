import { crc32, deflateSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';

/** Views that are rasterized to PNG. */
export type View = 'sheet' | 'final' | 'sizes' | 'guides';

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

/** Encodes 8-bit RGB pixels (row-major, 3 bytes each) as a non-interlaced colour-type-2 PNG. */
export function encodeRgbPng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const stride = width * 3;
  if (rgb.length !== stride * height) {
    throw new Error(`encodeRgbPng: expected ${stride * height} bytes, got ${rgb.length}`);
  }
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return new Uint8Array(
    Buffer.concat([
      SIGNATURE,
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', new Uint8Array(0)),
    ]),
  );
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
