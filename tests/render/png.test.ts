import { describe, expect, it } from 'vitest';
import { arrange } from '../../src/geom/arrangement.js';
import { encodeRgbPng, renderExportPng, renderPreviewPng } from '../../src/render/png.js';
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
