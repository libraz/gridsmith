import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it } from 'vitest';
import { type ImportSegment, importSegments, segmentsToSvg } from '../../src/import/segments.js';
import { diffShare, type RgbaImage } from '../../src/render/match.js';
import { renderFinalSvg } from '../../src/render/svg.js';
import { evaluate } from '../../src/tools/shared.js';

const SIDE = 192;
const TOLERANCE = 32;

const raster = (svg: string): RgbaImage => {
  const image = new Resvg(svg, {
    background: '#ffffff',
    fitTo: { mode: 'width', value: SIDE },
    font: { loadSystemFonts: false },
  }).render();
  return { width: image.width, height: image.height, data: new Uint8Array(image.pixels) };
};

const stroke = (d: string, color: string, width: number): ImportSegment => ({
  d,
  fill: 'none',
  stroke: color,
  strokeWidth: width,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
});

/** Lines, circles, rects and a single arc, layered so that every layer overlaps another. */
const BASIC: ImportSegment[] = [
  { d: 'M3 3H21V21H3Z', fill: '#cfe8ff' },
  { d: 'M12 6A6 6 0 0 1 12 18A6 6 0 0 1 12 6Z', fill: '#ff8800' },
  stroke('M4 12H20', '#107c41', 1.5),
  stroke('M6 6H18V18H6Z', '#aa0000', 1),
  stroke('M6 12A6 6 0 0 1 18 12', '#0000cc', 1.2),
  { d: 'M9 9H15V15H9Z', fill: '#7030a0' },
];

/** An ellipse of 6 x 4 over a plate, filled and outlined. */
const WITH_OVAL: ImportSegment[] = [
  { d: 'M3 5H21V19H3Z', fill: '#e8f0e0' },
  {
    d: 'M6 12A6 4 0 0 1 18 12A6 4 0 0 1 6 12Z',
    fill: '#ffd966',
    stroke: '#7f6000',
    strokeWidth: 1,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  },
  stroke('M5 12H19', '#107c41', 1),
];

/** A cylinder rim and a quarter circle drawn with cubic curves. */
const WITH_CURVES: ImportSegment[] = [
  stroke('M4 12c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8', '#1f1f1f', 1.3),
  stroke('M4 12c0-4.4 3.6-8 8-8', '#1f1f1f', 1.3),
];

/** Final SVG of the imported spec, optionally without one paint layer. */
const importedSvg = (segments: ImportSegment[], drop?: number): string => {
  const { spec } = importSegments(segments);
  if (spec === null) {
    throw new Error('nothing was imported');
  }
  const kept =
    drop === undefined ? spec : { ...spec, paint: spec.paint.filter((_, i) => i !== drop) };
  const ev = evaluate('gridsmith_render', kept);
  return renderFinalSvg(ev.model, ev.fills);
};

const share = (segments: ImportSegment[], drop?: number): number =>
  diffShare(raster(importedSvg(segments, drop)), raster(segmentsToSvg(segments)), TOLERANCE);

describe('import round trip', () => {
  it('redraws lines, circles, rects and an arc as the original', () => {
    expect(share(BASIC)).toBeLessThanOrEqual(0.005);
  });

  it('sees a dropped layer', () => {
    expect(share(BASIC, 1)).toBeGreaterThan(0.005);
    expect(share(BASIC, 5)).toBeGreaterThan(0.005);
  });

  it('keeps an ellipse within the egg approximation', () => {
    expect(share(WITH_OVAL)).toBeLessThanOrEqual(0.02);
  });

  it('redraws cubic curves through their fitted lines and arcs', () => {
    expect(importSegments(WITH_CURVES).skipped).toEqual([]);
    expect(share(WITH_CURVES)).toBeLessThanOrEqual(0.02);
  });
});

describe('arc on an oval', () => {
  it('redraws a lone elliptical arc as the original', () => {
    const arc = [stroke('M7.3 19.07A2.24 2.8 0 1 1 7.3 15.33', '#1f1f1f', 1)];
    expect(importSegments(arc).spec?.shapes.map((s) => s.type)).toEqual(['oval', 'arc']);
    expect(share(arc)).toBeLessThanOrEqual(0.02);
  });
});
