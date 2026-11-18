import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it } from 'vitest';
import { arrange } from '../../src/geom/arrangement.js';
import type { Mask } from '../../src/render/match.js';
import {
  decodeImage,
  encodeRgbaPng,
  encodeRgbPng,
  inkMask,
  rasterRgba,
  renderExportPng,
  renderMatchPng,
  renderPreviewPng,
  underlayHref,
} from '../../src/render/png.js';
import { renderGuidesSvg, renderSheetSvg } from '../../src/render/sheet.js';
import { renderFinalSvg } from '../../src/render/svg.js';
import { resolveSpec } from '../../src/resolve/resolve.js';
import type { SpecInput } from '../../src/spec/schema.js';
import { specSchema } from '../../src/spec/schema.js';
import { readPng } from '../helpers/png.js';

const markInput = {
  version: 1,
  mode: 'mark',
  grid: { divisions: 4 },
  concept: 'A crescent cut from one disc by a second.',
  shapes: [
    { id: 'body', type: 'circle', r: 'R' },
    { id: 'bite', type: 'circle', center: [1, 1], r: 3 },
  ],
  paint: [{ fill: { subtract: ['body', 'bite'] } }],
};

const figureInput = {
  version: 1,
  mode: 'figure',
  grid: { divisions: 4 },
  shapes: [
    { id: 'outer', type: 'circle', r: 'R' },
    { id: 'inner', type: 'circle', r: 3 },
    { id: 'star', type: 'polygon', in: 'inner', n: 6, step: 2, rotate: 90 },
  ],
  paint: [{ stroke: ['outer', 'star'], width: 0.125 }],
};

const svgsOf = (input: unknown) => {
  const spec = specSchema.parse(input as SpecInput);
  const res = resolveSpec(spec);
  if (!res.ok) {
    throw new Error(`resolve failed: ${JSON.stringify(res.errors)}`);
  }
  const fills = res.model.fills.map((f) => arrange(f.region));
  return {
    final: renderFinalSvg(res.model, fills),
    guides: renderGuidesSvg(res.model, fills),
    sheet: renderSheetSvg({
      spec,
      model: res.model,
      fills,
      violations: [],
      exceptionsApplied: [],
    }),
  };
};

const WHITE = [255, 255, 255];

const stats = (rgba: Uint8Array) => {
  let opaque = 0;
  let nonWhite = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 255) {
      opaque++;
    }
    if (rgba[i] !== WHITE[0] || rgba[i + 1] !== WHITE[1] || rgba[i + 2] !== WHITE[2]) {
      nonWhite++;
    }
  }
  return { opaque, nonWhite, pixels: rgba.length / 4 };
};

describe('preview png', () => {
  for (const [name, input] of [
    ['mark', markInput],
    ['figure', figureInput],
  ] as const) {
    const svgs = svgsOf(input);

    it(`renders the sheet with a 1024 long side: ${name}`, () => {
      const out = renderPreviewPng('sheet', svgs);
      const img = readPng(out.png);
      expect(img.width).toBe(out.width);
      expect(img.height).toBe(out.height);
      expect(Math.max(img.width, img.height)).toBe(1024);
      const s = stats(img.rgba);
      expect(s.opaque).toBe(s.pixels);
      expect(s.nonWhite).toBeGreaterThan(0);
      expect(out.png.length).toBeLessThanOrEqual(300 * 1024);
      expect(out.overBudget).toBe(false);
    });

    it(`renders the guides as a 512 square on white: ${name}`, () => {
      const out = renderPreviewPng('guides', svgs);
      const img = readPng(out.png);
      expect([img.width, img.height]).toEqual([512, 512]);
      const s = stats(img.rgba);
      expect(s.opaque).toBe(s.pixels);
      expect(s.nonWhite).toBeGreaterThan(0);
      expect(img.rgba.slice(0, 4)).toEqual(Uint8Array.of(255, 255, 255, 255));
    });

    it(`renders a 512 square final on white: ${name}`, () => {
      const out = renderPreviewPng('final', svgs);
      const img = readPng(out.png);
      expect([img.width, img.height]).toEqual([512, 512]);
      const s = stats(img.rgba);
      expect(s.opaque).toBe(s.pixels);
      expect(s.nonWhite).toBeGreaterThan(0);
      expect(img.rgba.slice(0, 4)).toEqual(Uint8Array.of(255, 255, 255, 255));
    });
  }

  it('renders the sizes strip as 384 by 128, opaque, with a mark in every tile', () => {
    const out = renderPreviewPng('sizes', svgsOf(markInput));
    const img = readPng(out.png);
    expect([img.width, img.height]).toEqual([384, 128]);
    expect([out.width, out.height]).toEqual([384, 128]);
    const s = stats(img.rgba);
    expect(s.opaque).toBe(s.pixels);
    for (let tile = 0; tile < 3; tile++) {
      let dark = 0;
      for (let y = 0; y < 128; y++) {
        for (let x = 0; x < 128; x++) {
          if (img.rgba[(y * 384 + tile * 128 + x) * 4] !== 255) {
            dark++;
          }
        }
      }
      expect(dark).toBeGreaterThan(0);
    }
  });

  it('upscales the 16 px tile with nearest neighbour: 8 by 8 blocks of one colour', () => {
    const img = readPng(renderPreviewPng('sizes', svgsOf(markInput)).png);
    const at = (x: number, y: number) =>
      [...img.rgba.slice((y * 384 + 256 + x) * 4, (y * 384 + 256 + x) * 4 + 3)].join(',');
    for (let by = 0; by < 16; by++) {
      for (let bx = 0; bx < 16; bx++) {
        const first = at(bx * 8, by * 8);
        expect(at(bx * 8 + 7, by * 8 + 7)).toBe(first);
      }
    }
  });

  it('shrinks three times and flags over budget when the image cannot fit', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000">' +
      '<filter id="n" x="0" y="0" width="1" height="1"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" seed="3"/></filter>' +
      '<rect width="1000" height="1000" filter="url(#n)"/></svg>';
    const out = renderPreviewPng('sheet', {
      final: svg,
      guides: svg,
      sheet: { svg, width: 1000, height: 1000 },
    });
    expect(out.overBudget).toBe(true);
    expect(out.width).toBe(Math.round(1024 * 0.75 ** 3));
    expect(out.png.length).toBeGreaterThan(300 * 1024);
  });
});

describe('export png', () => {
  it('is transparent at 16 px', () => {
    const img = readPng(renderExportPng(svgsOf(markInput).final, 16));
    expect([img.width, img.height]).toEqual([16, 16]);
    const s = stats(img.rgba);
    expect(s.opaque).toBeLessThan(s.pixels);
    let clear = 0;
    for (let i = 3; i < img.rgba.length; i += 4) {
      if (img.rgba[i] === 0) {
        clear++;
      }
    }
    expect(clear).toBeGreaterThan(0);
  });
});

describe('encodeRgbPng', () => {
  it('round-trips a small known image', () => {
    const rgb = Uint8Array.of(
      255,
      0,
      0,
      0,
      255,
      0,
      0,
      0,
      255,
      10,
      20,
      30,
      40,
      50,
      60,
      255,
      255,
      255,
    );
    const img = readPng(encodeRgbPng(3, 2, rgb));
    expect([img.width, img.height]).toEqual([3, 2]);
    const expected = [
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 255, 40, 50, 60, 255, 255, 255,
      255, 255,
    ];
    expect([...img.rgba]).toEqual(expected);
  });

  it('rejects a buffer of the wrong length', () => {
    expect(() => encodeRgbPng(2, 2, new Uint8Array(5))).toThrow();
  });
});

describe('erase layers in rasters', () => {
  // Canvas half side 5: 51.2 px per module in the 512 px final, centred at (256, 256).
  const erased = {
    version: 1,
    mode: 'figure',
    grid: { divisions: 4 },
    shapes: [
      { id: 'ring', type: 'circle', r: 3 },
      { id: 'disc', type: 'circle', center: [3, 0], r: 1 },
      { id: 'dot', type: 'circle', center: [3, 0], r: 0.5 },
    ],
    paint: [
      { stroke: ['ring'], width: 0.25 },
      { erase: ['disc'] },
      { stroke: ['dot'], width: 0.25 },
    ],
  };

  const inkAt = (img: ReturnType<typeof readPng>, x: number, y: number): boolean => {
    const i = (Math.round(y) * img.width + Math.round(x)) * 4;
    const darkest = Math.max(img.rgba[i] ?? 255, img.rgba[i + 1] ?? 255, img.rgba[i + 2] ?? 255);
    return darkest < 100 && (img.rgba[i + 3] ?? 0) > 200;
  };
  const module = (x: number, y: number): [number, number] => [256 + x * 51.2, 256 - y * 51.2];

  it('hides an earlier stroke inside the erased disc and keeps it outside', () => {
    const svgs = svgsOf(erased);
    const img = readPng(renderPreviewPng('final', svgs).png);
    expect(inkAt(img, ...module(0, 3))).toBe(true);
    expect(inkAt(img, ...module(3 * Math.cos(Math.PI / 6), 3 * Math.sin(Math.PI / 6)))).toBe(true);
    expect(inkAt(img, ...module(3, 0))).toBe(false);
    expect(inkAt(img, ...module(2.6, 0.75))).toBe(false);
  });

  it('keeps a later layer inked inside the erased disc', () => {
    const img = readPng(renderPreviewPng('final', svgsOf(erased)).png);
    expect(inkAt(img, ...module(3.5, 0))).toBe(true);
    expect(inkAt(img, ...module(3, 0.5))).toBe(true);
  });

  it('leaves the erased area transparent in the exported raster', () => {
    const img = readPng(renderExportPng(svgsOf(erased).final, 512));
    const alphaAt = (x: number, y: number) =>
      img.rgba[(Math.round(y) * 512 + Math.round(x)) * 4 + 3];
    expect(alphaAt(...module(3, 0))).toBe(0);
    expect(alphaAt(...module(3.9, 0.4))).toBe(0);
    expect(alphaAt(...module(0, 3))).toBe(255);
    expect(alphaAt(...module(3.5, 0))).toBe(255);
  });

  it('nests several erase layers: each one hides what came before it only', () => {
    const svgs = svgsOf({
      ...erased,
      shapes: [...erased.shapes, { id: 'far', type: 'circle', center: [-3, 0], r: 1 }],
      paint: [...erased.paint, { stroke: ['ring'], width: 0.25 }, { erase: ['far'] }],
    });
    const img = readPng(renderPreviewPng('final', svgs).png);
    // The second stroke of the ring redraws the part the first erase hid.
    expect(inkAt(img, ...module(3, 0))).toBe(true);
    expect(inkAt(img, ...module(-3, 0))).toBe(false);
    expect(inkAt(img, ...module(0, -3))).toBe(true);
  });

  it('masks the boxed final of the sheet the same way', () => {
    const svgs = svgsOf(erased);
    const img = readPng(renderPreviewPng('sheet', svgs).png);
    const k = img.width / 1000;
    const box = (x: number, y: number): [number, number] => [
      (810 + x * 30) * k,
      (1170 - y * 30) * k,
    ];
    expect(inkAt(img, ...box(0, 3))).toBe(true);
    expect(inkAt(img, ...box(3, 0))).toBe(false);
    expect(inkAt(img, ...box(3.5, 0))).toBe(true);
  });

  it('draws the guides view with the same masking', () => {
    const img = readPng(renderPreviewPng('guides', svgsOf(erased)).png);
    expect(inkAt(img, ...module(0, 3.08))).toBe(true);
    expect(inkAt(img, ...module(2.7, 0.7))).toBe(false);
  });
});

describe('decodeImage', () => {
  const solid = (w: number, h: number, px: number[]) => {
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba.set(px, i * 4);
    }
    return encodeRgbaPng(w, h, rgba);
  };

  it('returns premultiplied pixels that composite onto white at the straight-alpha luminance', () => {
    const img = decodeImage(solid(1, 1, [255, 0, 0, 128]), 'image/png', 1, 1);
    expect([img.width, img.height]).toEqual([1, 1]);
    const [r = 0, g = 0, b = 0, a = 0] = img.rgba;
    expect(Math.abs(r - 128)).toBeLessThanOrEqual(1);
    expect(g).toBe(0);
    expect(b).toBe(0);
    expect(a).toBe(128);
    const lum = ([x = 0, y = 0, z = 0]: number[]) => Math.round(0.299 * x + 0.587 * y + 0.114 * z);
    const composited = [r, g, b].map((c) => Math.min(255, c + (255 - a)));
    // Straight red at 128/255 over white: (255, 127, 127).
    const expected = lum([255, 255 - 128, 255 - 128]);
    expect(Math.abs(lum(composited) - expected)).toBeLessThanOrEqual(1);
  });

  it('scales a non-square image down to a 512 px long side with integer sizes', () => {
    const img = decodeImage(solid(1000, 500, [255, 0, 0, 255]), 'image/png', 1000, 500);
    expect([img.width, img.height]).toEqual([512, 256]);
    expect(img.rgba).toHaveLength(512 * 256 * 4);
    const mid = (128 * 512 + 256) * 4;
    expect([...img.rgba.subarray(mid, mid + 4)]).toEqual([255, 0, 0, 255]);
  });

  it('rounds the short side and never goes below 1 px', () => {
    const tall = decodeImage(solid(3, 1001, [0, 0, 0, 255]), 'image/png', 3, 1001);
    expect([tall.width, tall.height]).toEqual([2, 512]);
    const thin = decodeImage(solid(1, 4000, [0, 0, 0, 255]), 'image/png', 1, 4000);
    expect([thin.width, thin.height]).toEqual([1, 512]);
  });

  it('never upscales a small image', () => {
    const img = decodeImage(solid(10, 4, [0, 0, 255, 255]), 'image/png', 10, 4);
    expect([img.width, img.height]).toEqual([10, 4]);
  });

  it('builds an ink mask from alpha, ignoring colour', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-9 -9 18 18">' +
      '<circle cx="0" cy="-5" r="3" fill="#ffffff"/></svg>';
    const mask = inkMask(svg);
    expect(mask.size).toBe(256);
    const at = (x: number, y: number) =>
      mask.data[Math.round(((9 - y) / 18) * 256) * 256 + Math.round(((x + 9) / 18) * 256)];
    // SVG y is down: cy = -5 is the upper part of the image.
    expect(at(0, 5)).toBe(1);
    expect(at(0, -5)).toBe(0);
    expect(at(8, 8)).toBe(0);
  });

  it('returns a PNG data URI for the underlay, tinted where the reference is', () => {
    const data = new Uint8Array(256 * 256);
    data[10 * 256 + 20] = 1;
    const href = underlayHref({ size: 256, data });
    expect(href.startsWith('data:image/png;base64,')).toBe(true);
    const img = readPng(Buffer.from(href.slice('data:image/png;base64,'.length), 'base64'));
    expect([img.width, img.height]).toEqual([256, 256]);
    const px = (x: number, y: number) => [
      ...img.rgba.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4),
    ];
    expect(px(20, 10)).toEqual([0xd9, 0x48, 0x0f, 77]);
    expect(px(21, 10)[3]).toBe(0);
  });

  it('draws the match view with one colour per overlap class on white', () => {
    const mk = (cells: number[]): Mask => {
      const data = new Uint8Array(256 * 256);
      for (const c of cells) {
        data[c] = 1;
      }
      return { size: 256, data };
    };
    const at = (i: number, j: number) => j * 256 + i;
    const ref = mk([at(10, 10), at(11, 10)]);
    const ink = mk([at(11, 10), at(12, 10)]);
    const img = readPng(renderMatchPng(ref, ink));
    expect([img.width, img.height]).toEqual([512, 512]);
    const px = (i: number, j: number) => [
      ...img.rgba.subarray((2 * j * 512 + 2 * i) * 4, (2 * j * 512 + 2 * i) * 4 + 4),
    ];
    expect(px(10, 10)).toEqual([0xd9, 0x48, 0x0f, 255]);
    expect(px(11, 10)).toEqual([0x22, 0x22, 0x22, 255]);
    expect(px(12, 10)).toEqual([0x1c, 0x7e, 0xd6, 255]);
    expect(px(13, 10)).toEqual([255, 255, 255, 255]);
  });
});

describe('icon pixel preview', () => {
  const iconInput = {
    version: 1,
    mode: 'icon',
    grid: { divisions: 12 },
    shapes: [
      {
        id: 'plate',
        type: 'rect',
        corners: [
          [-10, -8],
          [10, 6],
        ],
        r: 2,
      },
      {
        id: 'trend',
        type: 'polyline',
        through: [
          [-8, -6],
          [-4, -2],
          [0, -4],
          [4, 2],
        ],
      },
    ],
    paint: [
      { fill: 'plate', color: '#f3f2f1' },
      { stroke: ['trend'], width: 1, color: '#107c41' },
    ],
  };
  const svgs = { ...svgsOf(iconInput), sizes: 'pixels' as const };
  const out = renderPreviewPng('sizes', svgs);
  const img = readPng(out.png);

  const direct = (side: number) => {
    const res = new Resvg(svgs.final, {
      background: '#ffffff',
      fitTo: { mode: 'width', value: side },
    }).render();
    return { width: res.width, pixels: res.pixels };
  };
  const at = (x: number, y: number): number[] => {
    const i = (y * img.width + x) * 4;
    return [...img.rgba.subarray(i, i + 4)];
  };

  it('is 336 x 192 and exempt from the size budget', () => {
    expect([out.width, out.height]).toEqual([336, 192]);
    expect([img.width, img.height]).toEqual([336, 192]);
    expect(out.overBudget).toBe(false);
  });

  it.each([
    [24, 0],
    [16, 208],
  ])('shows the %i px render as 8x8 blocks', (side, left) => {
    const ref = direct(side);
    expect(ref.width).toBe(side);
    for (let y = 0; y < side * 8; y++) {
      for (let x = 0; x < side * 8; x++) {
        const i = (Math.floor(y / 8) * side + Math.floor(x / 8)) * 4;
        expect(at(left + x, y)).toEqual([...ref.pixels.subarray(i, i + 4)]);
      }
    }
  });

  it('leaves the gap and the remainder white', () => {
    for (let y = 0; y < 192; y++) {
      for (let x = 192; x < 336; x++) {
        if (x < 208 || y >= 128) {
          expect(at(x, y)).toEqual([255, 255, 255, 255]);
        }
      }
    }
  });
});

describe('rasterRgba', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12"><rect x="0" y="0" width="12" height="12" fill="#ff0000"/></svg>';
  const image = rasterRgba(svg, 48);

  it('is as wide as asked and keeps the aspect ratio', () => {
    expect(image.width).toBe(48);
    expect(image.height).toBe(24);
    expect(image.data.length).toBe(48 * 24 * 4);
  });

  it('draws on opaque white', () => {
    const at = (x: number, y: number) => [
      ...image.data.subarray((y * 48 + x) * 4, (y * 48 + x) * 4 + 4),
    ];
    expect(at(40, 12)).toEqual([255, 255, 255, 255]);
    expect(at(8, 12)).toEqual([255, 0, 0, 255]);
  });
});
