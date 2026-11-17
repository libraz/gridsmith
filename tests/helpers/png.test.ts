import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readPng } from './png.js';

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function buildPng(
  width: number,
  height: number,
  colorType: number,
  scanlines: number[][],
  overrides: { bitDepth?: number; interlace?: number } = {},
): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = overrides.bitDepth ?? 8;
  ihdr[9] = colorType;
  ihdr[12] = overrides.interlace ?? 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(scanlines.flat()))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('readPng', () => {
  it('decodes a 2x2 RGBA image with None and Sub filters', () => {
    const png = buildPng(2, 2, 6, [
      [0, 255, 0, 0, 255, 0, 255, 0, 128],
      [1, 0, 0, 255, 255, 10, 20, 30, 0],
    ]);
    const { width, height, rgba } = readPng(png);
    expect([width, height]).toEqual([2, 2]);
    expect(Array.from(rgba)).toEqual([
      255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 10, 20, 29, 255,
    ]);
  });

  it('decodes a 2x2 RGB image with Up, Average and Paeth filters and fills alpha', () => {
    const rows = [
      [0, 10, 20, 30, 40, 50, 60],
      [2, 1, 2, 3, 4, 5, 6],
    ];
    const { rgba } = readPng(buildPng(2, 2, 2, rows));
    expect(Array.from(rgba)).toEqual([
      10, 20, 30, 255, 40, 50, 60, 255, 11, 22, 33, 255, 44, 55, 66, 255,
    ]);

    const avg = readPng(buildPng(2, 2, 2, [rows[0] ?? [], [3, 2, 2, 2, 2, 2, 2]]));
    // first pixel: 2 + floor((0 + up) / 2); second red: 2 + floor((left 7 + up 40) / 2)
    expect(Array.from(avg.rgba.subarray(8, 12))).toEqual([2 + 5, 2 + 10, 2 + 15, 255]);
    expect(avg.rgba[12]).toBe(2 + ((7 + 40) >> 1));

    const paeth = readPng(buildPng(2, 2, 2, [rows[0] ?? [], [4, 1, 1, 1, 1, 1, 1]]));
    // first pixel: left = 0, upLeft = 0, so Paeth picks up (10); second: left 11, up 40, upLeft 10
    expect(Array.from(paeth.rgba.subarray(8, 12))).toEqual([11, 21, 31, 255]);
    expect(paeth.rgba[12]).toBe(1 + 40);
  });

  it('rejects unsupported formats', () => {
    expect(() => readPng(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/);
    expect(() => buildAndRead(0, 8, 0)).toThrow(/colour type 0/);
    expect(() => buildAndRead(2, 16, 0)).toThrow(/bit depth 16/);
    expect(() => buildAndRead(2, 8, 1)).toThrow(/interlaced/);
  });
});

function buildAndRead(colorType: number, bitDepth: number, interlace: number): unknown {
  return readPng(buildPng(1, 1, colorType, [[0, 0, 0, 0]], { bitDepth, interlace }));
}
