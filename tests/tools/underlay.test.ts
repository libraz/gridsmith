import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeRgbaPng, encodeRgbPng } from '../../src/render/png.js';
import { ToolFailure } from '../../src/tools/shared.js';
import {
  buildUnderlay,
  checkUnderlayFile,
  UNDERLAY_MAX_BYTES,
  type UnderlayArgs,
  underlaySchema,
} from '../../src/tools/underlay.js';

// Baseline 16x16 JPEG: black disc on white.
const DISC_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/wAALCAAQABABAREA/8QAFwAAAwEAAAAAAAAAAAAAAAAAAAUGB//EACMQAAIBAwQDAAMAAAAAAAAAAAECAwQFEQYHEiEIEzEiMkH/2gAIAQEAAD8A0zfzeSPbKChpKKhS4XmuVpESR+McMY65vjs5PQAxnDdjABS7Cb8vuDensN/t1PQ3b0tNBLTMfVPx/ZeLElWA7HbZAb5gZPJfZy47gyW686benN2o4TTywTPw98WSy8W+Bgxbo4B5fRjuf8b9jL3pLVC6n1etPTVFPC6UlHHIJHV3BVndl/EAKWAAJzy/mO//2Q==',
  'base64',
);

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gridsmith-underlay-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (name: string, bytes: Uint8Array): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
};

/** Message lines of the ToolFailure thrown by `run`. */
async function failure(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolFailure);
    return (error as ToolFailure).lines.join('\n');
  }
  throw new Error('expected a ToolFailure');
}

/** RGB image, white with a black disc covering about a third of the side. */
function discPng(side: number): Uint8Array {
  const rgb = new Uint8Array(side * side * 3).fill(255);
  const c = (side - 1) / 2;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      if ((x - c) ** 2 + (y - c) ** 2 <= (side / 3) ** 2) {
        rgb.fill(0, (y * side + x) * 3, (y * side + x) * 3 + 3);
      }
    }
  }
  return encodeRgbPng(side, side, rgb);
}

/** A valid PNG whose IHDR claims another size; the body no longer matches. */
function pngWithSize(width: number, height: number): Uint8Array {
  const bytes = Uint8Array.from(encodeRgbPng(2, 2, new Uint8Array(12)));
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const u16 = (n: number): number[] => [n >> 8, n & 0xff];

/** SOF0 segment with the given size and three components. */
const sof = (width: number, height: number): number[] => [
  0xff,
  0xc0,
  ...u16(17),
  8,
  ...u16(height),
  ...u16(width),
  3,
  1,
  0x11,
  0,
  2,
  0x11,
  0,
  3,
  0x11,
  0,
];

/** SOI plus a SOF segment only: enough for the header check. */
const jpegWithSize = (width: number, height: number): Uint8Array =>
  Uint8Array.from([0xff, 0xd8, ...sof(width, height)]);

const argsOf = (raw: Record<string, unknown>): UnderlayArgs => underlaySchema.parse(raw);

describe('checkUnderlayFile', () => {
  it('rejects a relative path', async () => {
    const text = await failure(() => checkUnderlayFile('ref.png'));
    expect(text).toMatch(/^gridsmith_render: underlay\.path: path must be absolute/);
    expect(text).toContain('"ref.png"');
  });

  it('rejects a missing file and a directory', async () => {
    const missing = await failure(() => checkUnderlayFile(join(dir, 'nope.png')));
    expect(missing).toContain('underlay.path: file cannot be read');
    expect(missing).toContain('ENOENT');
    await mkdir(join(dir, 'folder'));
    const folder = await failure(() => checkUnderlayFile(join(dir, 'folder')));
    expect(folder).toContain('underlay.path: path is not a regular file');
  });

  it('follows a symlink to a regular file', async () => {
    const target = await write('target.png', discPng(8));
    const link = join(dir, 'link.png');
    await symlink(target, link);
    expect(await checkUnderlayFile(link)).toMatchObject({ mime: 'image/png', width: 8 });
  });

  it('reads PNG dimensions from the header', async () => {
    const file = await checkUnderlayFile(await write('a.png', discPng(20)));
    expect(file).toMatchObject({ mime: 'image/png', width: 20, height: 20 });
    expect(file.bytes.length).toBeGreaterThan(33);
  });

  it('accepts exactly the size cap and rejects one byte more', async () => {
    const header = pngWithSize(100, 100);
    const pad = (n: number): Uint8Array => {
      const bytes = new Uint8Array(n);
      bytes.set(header.subarray(0, 33));
      return bytes;
    };
    const ok = await checkUnderlayFile(await write('cap.png', pad(UNDERLAY_MAX_BYTES)));
    expect(ok).toMatchObject({ width: 100, height: 100 });
    const big = await failure(async () =>
      checkUnderlayFile(await write('cap1.png', pad(UNDERLAY_MAX_BYTES + 1))),
    );
    expect(big).toContain('underlay.path: image file is too large');
    expect(big).toContain('4194305 bytes');
    expect(big).toContain('4194304');
  });

  it.each([
    ['WebP', Buffer.from('RIFF\x24\0\0\0WEBPVP8 ', 'latin1')],
    ['GIF', Buffer.from('GIF89a\x01\0\x01\0\0\0\0', 'latin1')],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>')],
    ['text', Buffer.from('just some text')],
    ['empty', Buffer.alloc(0)],
  ])('rejects %s and names the supported formats', async (name, bytes) => {
    const text = await failure(async () =>
      checkUnderlayFile(await write(`other-${name}.png`, bytes)),
    );
    expect(text).toContain('underlay.path: file is not a supported image');
    expect(text).toContain('PNG');
    expect(text).toContain('JPEG');
    expect(text).not.toContain('just some text');
  });

  it('decides by content, not by extension', async () => {
    const file = await checkUnderlayFile(await write('really-jpeg.png', DISC_JPEG));
    expect(file).toMatchObject({ mime: 'image/jpeg', width: 16, height: 16 });
  });

  describe('header', () => {
    it('rejects a PNG shorter than IHDR', async () => {
      const png = pngWithSize(4, 4);
      for (const cut of [8, 16, 24, 28]) {
        const text = await failure(async () =>
          checkUnderlayFile(await write(`short-${cut}.png`, png.subarray(0, cut))),
        );
        expect(text).toContain('underlay.path: image dimensions cannot be read');
      }
    });

    it('rejects a PNG whose first chunk is not a 13-byte IHDR', async () => {
      const png = pngWithSize(4, 4);
      const badLength = Uint8Array.from(png);
      badLength[11] = 12;
      const badType = Uint8Array.from(png);
      badType[12] = 0x58;
      for (const [name, bytes] of [
        ['len', badLength],
        ['type', badType],
      ] as const) {
        const text = await failure(async () =>
          checkUnderlayFile(await write(`ihdr-${name}.png`, bytes)),
        );
        expect(text).toContain('image dimensions cannot be read');
      }
    });

    it('rejects 0x0 in a PNG and in a JPEG', async () => {
      const png = await failure(async () =>
        checkUnderlayFile(await write('zero.png', pngWithSize(0, 0))),
      );
      expect(png).toContain('image dimensions cannot be read');
      const jpeg = await failure(async () =>
        checkUnderlayFile(await write('zero.jpg', jpegWithSize(0, 0))),
      );
      expect(jpeg).toContain('image dimensions cannot be read');
    });

    it('rejects a JPEG without SOF', async () => {
      const app0 = [0xff, 0xe0, ...u16(4), 0, 0];
      const cases: Record<string, number[]> = {
        'only-soi': [0xff, 0xd8],
        'app0-eoi': [0xff, 0xd8, ...app0, 0xff, 0xd9],
        'sos-first': [0xff, 0xd8, ...app0, 0xff, 0xda, ...u16(4), 0, 0, 1, 2, 3, ...sof(4, 4)],
        truncated: [0xff, 0xd8, 0xff, 0xe0, ...u16(40), 0, 0],
        'cut-sof': [0xff, 0xd8, 0xff, 0xc0, ...u16(17), 8, 0],
        'no-marker': [0xff, 0xd8, 0x12, 0x34],
      };
      for (const [name, bytes] of Object.entries(cases)) {
        const text = await failure(async () =>
          checkUnderlayFile(await write(`nosof-${name}.jpg`, Uint8Array.from(bytes))),
        );
        expect(text, name).toContain('underlay.path: image dimensions cannot be read');
      }
    });

    it('skips fill bytes and standalone markers before the SOF', async () => {
      const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xff, 0xff, 0x01, 0xff, 0xd3, ...sof(9, 7)]);
      expect(await checkUnderlayFile(await write('fill.jpg', bytes))).toMatchObject({
        width: 9,
        height: 7,
      });
    });

    it('reads the main image size when an APP1 segment carries a thumbnail SOF', async () => {
      const thumb = [...Buffer.from('Exif\0\0', 'latin1'), ...sof(5, 7)];
      const app1 = [0xff, 0xe1, ...u16(thumb.length + 2), ...thumb];
      const bytes = Uint8Array.from([0xff, 0xd8, ...app1, ...DISC_JPEG.subarray(2)]);
      const file = await checkUnderlayFile(await write('thumb.jpg', bytes));
      expect(file).toMatchObject({ mime: 'image/jpeg', width: 16, height: 16 });
    });
  });

  describe('dimension limits', () => {
    it.each([
      ['PNG 8192x1', pngWithSize(8192, 1), 8192, 1],
      ['PNG 4000x4000', pngWithSize(4000, 4000), 4000, 4000],
      ['JPEG 8192x1', jpegWithSize(8192, 1), 8192, 1],
      ['JPEG 4000x4000', jpegWithSize(4000, 4000), 4000, 4000],
    ])('accepts %s', async (name, bytes, width, height) => {
      const file = await checkUnderlayFile(await write(`ok-${name}.bin`, bytes));
      expect(file).toMatchObject({ width, height });
    });

    it.each([
      ['PNG 8193x1', pngWithSize(8193, 1), '8193x1'],
      ['PNG 4001x4000', pngWithSize(4001, 4000), '4001x4000'],
      ['JPEG 8193x1', jpegWithSize(8193, 1), '8193x1'],
      ['JPEG 4001x4000', jpegWithSize(4001, 4000), '4001x4000'],
    ])('rejects %s and names the dimensions', async (name, bytes, dims) => {
      const text = await failure(async () =>
        checkUnderlayFile(await write(`big-${name}.bin`, bytes)),
      );
      expect(text).toContain('underlay.path: image is too large');
      expect(text).toContain(dims);
    });

    it('rejects a PNG header claiming 30000x30000 without decoding it', async () => {
      const text = await failure(async () =>
        checkUnderlayFile(await write('huge.png', pngWithSize(30000, 30000))),
      );
      expect(text).toContain('30000x30000');
    });
  });
});

describe('underlaySchema', () => {
  const issuePaths = (raw: unknown): PropertyKey[][] => {
    const result = underlaySchema.safeParse(raw);
    return result.success ? [] : result.error.issues.map((i) => [...i.path]);
  };

  it('accepts a path alone and every optional field', () => {
    expect(underlaySchema.safeParse({ path: '/a.png' }).success).toBe(true);
    const all = { path: '/a.png', box: [-8, -8, 8, 8], threshold: 128, invert: false };
    expect(underlaySchema.safeParse(all).success).toBe(true);
  });

  it.each([['text'], [[]], [null], [5]])('rejects a non-object (%j)', (raw) => {
    const result = underlaySchema.safeParse(raw);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('underlay is invalid');
  });

  it('rejects an unknown key and a missing path', () => {
    const unknown = underlaySchema.safeParse({ path: '/a.png', colour: 'red' });
    expect(unknown.error?.issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: ['colour'] });
    expect(issuePaths({})).toEqual([['path']]);
  });

  it.each([[0], [255], [1.5], ['128'], [null]])('rejects threshold %j', (threshold) => {
    expect(issuePaths({ path: '/a.png', threshold })).toEqual([['threshold']]);
  });

  it.each([[1], [254]])('accepts threshold %j', (threshold) => {
    expect(underlaySchema.safeParse({ path: '/a.png', threshold }).success).toBe(true);
  });

  it.each([[1], ['true'], [null]])('rejects invert %j', (invert) => {
    expect(issuePaths({ path: '/a.png', invert })).toEqual([['invert']]);
  });

  it.each([
    ['three values', [0, 0, 4]],
    ['five values', [0, 0, 4, 4, 4]],
    ['x0 = x1', [1, 0, 1, 4]],
    ['x0 > x1', [4, 0, 1, 4]],
    ['y0 >= y1', [0, 4, 4, 4]],
  ])('rejects box with %s', (_name, box) => {
    expect(issuePaths({ path: '/a.png', box })).toEqual([['box']]);
  });

  it.each([
    ['NaN', [0, 0, Number.NaN, 4]],
    ['Infinity', [0, 0, 4, Number.POSITIVE_INFINITY]],
    ['strings', ['0', '0', '4', '4']],
  ])('rejects box with %s', (_name, box) => {
    const paths = issuePaths({ path: '/a.png', box });
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p[0] === 'box')).toBe(true);
  });
});

describe('buildUnderlay', () => {
  const fileOf = async (name: string, bytes: Uint8Array) =>
    checkUnderlayFile(await write(name, bytes));

  it('places a luminance image on the default box and reports the settings used', async () => {
    const file = await fileOf('disc.png', discPng(64));
    const { reference, report } = buildUnderlay(file, argsOf({ path: 'x' }), 9, 6);
    expect(reference.size).toBe(256);
    expect(reference.data.some((v) => v === 1)).toBe(true);
    expect(report.box).toEqual([-6, -6, 6, 6]);
    expect(report.placed).toEqual([-6, -6, 6, 6]);
    expect(report.source).toBe('luminance');
    expect(report.inverted).toBe(false);
    expect(Number.isInteger(report.threshold)).toBe(true);
  });

  it('rounds placed to 2 decimals and echoes the given box, threshold and invert', async () => {
    const file = await fileOf('disc2.png', discPng(64));
    const args = argsOf({ path: 'x', box: [-3, -2, 5, 1], threshold: 100, invert: true });
    const { report } = buildUnderlay(file, args, 9, 9);
    expect(report).toMatchObject({ box: [-3, -2, 5, 1], threshold: 100, inverted: true });
    for (const v of report.placed) {
      expect(Math.round(v * 100) / 100).toBe(v);
    }
  });

  it('reads a JPEG through the same path', async () => {
    const file = await fileOf('disc.jpg', DISC_JPEG);
    const { report } = buildUnderlay(file, argsOf({ path: 'x' }), 9, 9);
    expect(report.source).toBe('luminance');
  });

  it('reports alpha as the source and ignores a given threshold', async () => {
    const side = 32;
    const rgba = new Uint8Array(side * side * 4);
    for (let y = 8; y < 24; y++) {
      for (let x = 8; x < 24; x++) {
        rgba.set([20, 20, 20, 255], (y * side + x) * 4);
      }
    }
    const file = await fileOf('alpha.png', encodeRgbaPng(side, side, rgba));
    const { report } = buildUnderlay(file, argsOf({ path: 'x', threshold: 77 }), 9, 9);
    expect(report.source).toBe('alpha');
    expect(report.threshold).toBeNull();
  });

  it.each([
    ['x range below 1', [0, 0, 0.5, 5]],
    ['y range below 1', [0, 0, 5, 0.5]],
    ['x past canvasHalf', [-10, -8, 8, 8]],
    ['y past canvasHalf', [-8, -8, 8, 9.5]],
  ])('rejects a box with %s', async (_name, box) => {
    const file = await fileOf('box.png', discPng(32));
    const text = await failure(() => buildUnderlay(file, argsOf({ path: 'x', box }), 9, 9));
    expect(text).toMatch(/^gridsmith_render: underlay\.box: box is out of range/);
  });

  it('accepts a box exactly at canvasHalf and of size 1', async () => {
    const file = await fileOf('box-edge.png', discPng(32));
    expect(() =>
      buildUnderlay(file, argsOf({ path: 'x', box: [-9, -9, -8, -8] }), 9, 9),
    ).not.toThrow();
  });

  it('rejects a 1x1 image, a single colour and a corrupt body as "no silhouette"', async () => {
    const corrupt = Uint8Array.from([
      ...pngWithSize(32, 32).subarray(0, 33),
      ...Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff),
    ]);
    const cases: [string, Uint8Array][] = [
      ['one.png', encodeRgbPng(1, 1, Uint8Array.from([0, 0, 0]))],
      ['grey.png', encodeRgbPng(16, 16, new Uint8Array(16 * 16 * 3).fill(128))],
      ['corrupt.png', corrupt],
    ];
    for (const [name, bytes] of cases) {
      const file = await fileOf(name, bytes);
      const text = await failure(() => buildUnderlay(file, argsOf({ path: 'x' }), 9, 9));
      expect(text, name).toMatch(/^gridsmith_render: underlay: no silhouette found/);
      expect(text, name).toContain('PNG');
      expect(text, name).toContain('JPEG');
      expect(text, name).toContain('CMYK');
      expect(text, name).toContain('threshold');
      expect(text, name).toContain('invert');
    }
  });

  it('rejects a hairline reference that is empty after placement', async () => {
    const side = 64;
    const rgb = new Uint8Array(side * side * 3).fill(255);
    for (let y = 0; y < side; y++) {
      rgb.fill(0, (y * side + 32) * 3, (y * side + 32) * 3 + 3);
    }
    const file = await fileOf('hairline.png', encodeRgbPng(side, side, rgb));
    const box = [0, 0, 1, 1];
    const text = await failure(() => buildUnderlay(file, argsOf({ path: 'x', box }), 9, 9));
    expect(text).toMatch(/^gridsmith_render: underlay\.box: the reference is empty after placement/);
  });
});
