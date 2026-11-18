import { open, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Box, Mask } from '../render/match.js';
import { binarize, MatchError, placeReference } from '../render/match.js';
import { decodeImage } from '../render/png.js';
import type { ToolName } from './shared.js';
import { complain, errorCode, rasterize, show, ToolFailure } from './shared.js';

const TOOL: ToolName = 'gridsmith_render';

export const UNDERLAY_MAX_BYTES = 4 * 1024 * 1024;
export const UNDERLAY_MAX_SIDE = 8192;
export const UNDERLAY_MAX_PIXELS = 16_000_000;

const FORMATS = 'a PNG or a JPEG file (baseline or progressive, not CMYK)';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_END = 8 + 8 + 13;

export type UnderlayFile = {
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
};

const failure = (where: string, what: string, detail: string): ToolFailure =>
  new ToolFailure([`${TOOL}: ${where}: ${what} (${detail})`]);

const unreadable = (): ToolFailure =>
  failure(
    'underlay.path',
    'image dimensions cannot be read from the file header',
    `allowed: ${FORMATS} with a valid header`,
  );

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);

function pngSize(bytes: Uint8Array): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < IHDR_END || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) {
    throw unreadable();
  }
  return [view.getUint32(16), view.getUint32(20)];
}

/** Walks the segments from SOI by their length fields; never searches for marker bytes. */
function jpegSize(bytes: Uint8Array): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) {
      throw unreadable();
    }
    while (bytes[at] === 0xff) {
      at++;
    }
    const marker = bytes[at++];
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || marker === 0xd9) {
      throw unreadable();
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (marker === 0xda || at + 2 > bytes.length) {
      throw unreadable();
    }
    const length = view.getUint16(at);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (length < 2 || at + length > bytes.length || (isSof && length < 8)) {
      throw unreadable();
    }
    if (isSof) {
      return [view.getUint16(at + 5), view.getUint16(at + 3)];
    }
    at += length;
  }
  throw unreadable();
}

async function readBounded(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(UNDERLAY_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
    }
    if (total > UNDERLAY_MAX_BYTES) {
      throw failure(
        'underlay.path',
        'image file is too large',
        `allowed: at most ${UNDERLAY_MAX_BYTES} bytes`,
      );
    }
    return new Uint8Array(buffer.buffer, buffer.byteOffset, total);
  } finally {
    await handle.close();
  }
}

/**
 * Validates the underlay file and reads its dimensions from the header, without decoding.
 *
 * @throws ToolFailure (path `underlay.path`) for anything that is not a readable PNG or JPEG within the limits.
 */
export async function checkUnderlayFile(path: string): Promise<UnderlayFile> {
  if (!isAbsolute(path)) {
    throw failure(
      'underlay.path',
      `path must be absolute (received: ${show(path)})`,
      'allowed: an absolute path such as /tmp/work/ref.png',
    );
  }
  const unreadablePath = (error: unknown): ToolFailure =>
    failure(
      'underlay.path',
      `file cannot be read (received: ${show(path)}, ${errorCode(error)})`,
      'allowed: an existing readable image file',
    );
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      throw failure(
        'underlay.path',
        `path is not a regular file (received: ${show(path)})`,
        'allowed: an image file',
      );
    }
    size = info.size;
  } catch (error) {
    throw error instanceof ToolFailure ? error : unreadablePath(error);
  }
  if (size > UNDERLAY_MAX_BYTES) {
    throw failure(
      'underlay.path',
      `image file is too large (received: ${size} bytes)`,
      `allowed: at most ${UNDERLAY_MAX_BYTES} bytes`,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBounded(path);
  } catch (error) {
    throw error instanceof ToolFailure ? error : unreadablePath(error);
  }
  let mime: UnderlayFile['mime'];
  let dims: [number, number];
  if (startsWith(bytes, PNG_SIGNATURE)) {
    mime = 'image/png';
    dims = pngSize(bytes);
  } else if (startsWith(bytes, [0xff, 0xd8])) {
    mime = 'image/jpeg';
    dims = jpegSize(bytes);
  } else {
    throw failure('underlay.path', 'file is not a supported image', `allowed: ${FORMATS}`);
  }
  const [width, height] = dims;
  if (width < 1 || height < 1) {
    throw unreadable();
  }
  if (
    width > UNDERLAY_MAX_SIDE ||
    height > UNDERLAY_MAX_SIDE ||
    width * height > UNDERLAY_MAX_PIXELS
  ) {
    throw failure(
      'underlay.path',
      `image is too large (received: ${width}x${height} px)`,
      `allowed: each side at most ${UNDERLAY_MAX_SIDE} px and at most ${UNDERLAY_MAX_PIXELS} pixels in total`,
    );
  }
  return { bytes, mime, width, height };
}

const BOX_ALLOWED = 'four finite numbers [x0, y0, x1, y1] with x0 < x1 and y0 < y1';

const boxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()], {
    error: complain('underlay.box', BOX_ALLOWED),
  })
  .superRefine((box, ctx) => {
    const [x0, y0, x1, y1] = box;
    if (x0 >= x1 || y0 >= y1) {
      ctx.addIssue({
        code: 'custom',
        message: `underlay.box is invalid (received: ${show(box)}; allowed: ${BOX_ALLOWED})`,
      });
    }
  });

/** Strict shape of the `underlay` argument; the render tool nests it in its own argument schema. */
export const underlaySchema = z.strictObject(
  {
    path: z.string({ error: complain('underlay.path', 'an absolute path of a PNG or JPEG file') }),
    box: boxSchema.optional(),
    threshold: z
      .number({ error: complain('underlay.threshold', 'an integer from 1 to 254') })
      .int({ error: complain('underlay.threshold', 'an integer from 1 to 254') })
      .min(1, { error: complain('underlay.threshold', 'an integer from 1 to 254') })
      .max(254, { error: complain('underlay.threshold', 'an integer from 1 to 254') })
      .optional(),
    invert: z.boolean({ error: complain('underlay.invert', 'true or false') }).optional(),
    fit: z
      .enum(['shape', 'image'], { error: complain('underlay.fit', '"shape" or "image"') })
      .default('shape'),
  },
  {
    error: complain(
      'underlay',
      'an object with "path" and optional "box", "threshold", "invert", "fit"',
    ),
  },
);

export type UnderlayArgs = z.output<typeof underlaySchema>;

/** The `underlay` item of the `match` report. */
export type UnderlayReport = {
  box: Box;
  placed: Box;
  threshold: number | null;
  inverted: boolean;
  source: 'alpha' | 'luminance';
};

const round2 = (x: number): number => Math.round(x * 100) / 100 + 0;

const NO_SILHOUETTE =
  `underlay: no silhouette found in the image (allowed: ${FORMATS}; ` +
  'the foreground must cover between 0.5% and 99.5% of the pixels; ' +
  'set "threshold" (1 to 254) or "invert" to change what counts as foreground)';

/**
 * Validates `box` against the canvas, decodes and binarizes the image and places it as the reference mask.
 *
 * @throws ToolFailure for a box out of range, an image without a silhouette or an empty placed reference.
 */
export function buildUnderlay(
  file: UnderlayFile,
  args: UnderlayArgs,
  canvasHalf: number,
  R: number,
): { reference: Mask; report: UnderlayReport } {
  const box: Box = args.box ?? [-R, -R, R, R];
  const [x0, y0, x1, y1] = box;
  if (
    x1 - x0 < 1 ||
    y1 - y0 < 1 ||
    box.some((v) => !Number.isFinite(v) || Math.abs(v) > canvasHalf)
  ) {
    throw failure(
      'underlay.box',
      `box is out of range (received: ${show(box)})`,
      `allowed: x1 - x0 >= 1, y1 - y0 >= 1 and every value from -${canvasHalf} to ${canvasHalf}`,
    );
  }
  const image = rasterize(TOOL, 'the underlay image', () =>
    decodeImage(file.bytes, file.mime, file.width, file.height),
  );
  try {
    const bin = binarize(image.rgba, image.width, image.height, {
      threshold: args.threshold,
      invert: args.invert,
    });
    const { mask, placed } = placeReference(bin, box, canvasHalf, args.fit);
    return {
      reference: mask,
      report: {
        box,
        placed: placed.map(round2) as Box,
        threshold: bin.threshold,
        inverted: bin.inverted,
        source: bin.source,
      },
    };
  } catch (error) {
    if (!(error instanceof MatchError)) {
      throw error;
    }
    if (error.code === 'no_silhouette') {
      throw new ToolFailure([`${TOOL}: ${NO_SILHOUETTE}`]);
    }
    throw failure(
      'underlay.box',
      'the reference is empty after placement',
      'allowed: a larger box, or an image whose foreground is not a hairline',
    );
  }
}
