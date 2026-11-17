import { inflateSync } from 'node:zlib';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type DecodedPng = {
  width: number;
  height: number;
  rgba: Uint8Array;
};

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG into RGBA bytes. */
export function readPng(buf: Uint8Array): DecodedPng {
  if (buf.length < 8 || SIGNATURE.some((byte, i) => buf[i] !== byte)) {
    throw new Error('readPng: not a PNG (bad signature)');
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let width = 0;
  let height = 0;
  let colorType = -1;
  let sawHeader = false;
  const idat: Uint8Array[] = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...buf.subarray(pos + 4, pos + 8));
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (data.length < length) {
      throw new Error('readPng: truncated chunk');
    }
    if (type === 'IHDR') {
      const bitDepth = data[8];
      const interlace = data[12];
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      colorType = data[9] ?? -1;
      if (bitDepth !== 8) {
        throw new Error(`readPng: unsupported bit depth ${bitDepth}`);
      }
      if (colorType !== 2 && colorType !== 6) {
        throw new Error(`readPng: unsupported colour type ${colorType}`);
      }
      if (interlace !== 0) {
        throw new Error('readPng: interlaced PNG is not supported');
      }
      sawHeader = true;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  if (!sawHeader) {
    throw new Error('readPng: missing IHDR');
  }
  if (idat.length === 0) {
    throw new Error('readPng: missing IDAT');
  }

  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) {
    throw new Error('readPng: decompressed size does not match dimensions');
  }

  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[src + x] ?? 0;
      const left = x >= bpp ? (pixels[row + x - bpp] ?? 0) : 0;
      const up = y > 0 ? (pixels[row - stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= bpp ? (pixels[row - stride + x - bpp] ?? 0) : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = cur;
          break;
        case 1:
          value = cur + left;
          break;
        case 2:
          value = cur + up;
          break;
        case 3:
          value = cur + ((left + up) >> 1);
          break;
        case 4:
          value = cur + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`readPng: unknown filter type ${filter}`);
      }
      pixels[row + x] = value & 0xff;
    }
  }

  if (colorType === 6) {
    return { width, height, rgba: pixels };
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = pixels[i * 3] ?? 0;
    rgba[i * 4 + 1] = pixels[i * 3 + 1] ?? 0;
    rgba[i * 4 + 2] = pixels[i * 3 + 2] ?? 0;
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}
