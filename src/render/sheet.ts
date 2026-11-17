import type { FillResult } from '../geom/arrangement.js';
import type { Circle, Line, Vec } from '../geom/primitives.js';
import { pointOnCircle } from '../geom/primitives.js';
import type { RepeatElement, ResolvedElement, ResolvedModel } from '../resolve/resolve.js';
import type { Spec } from '../spec/schema.js';
import { arcParts, finalMarkup, num } from './svg.js';

const SHEET_WIDTH = 1000;
const DRAWING_SIZE = 1000;
const FONT_SIZE = 16;
const LINE_ADVANCE = 22;
const PANEL_PAD = 20;
const PANEL_MIN_HEIGHT = 360;
const TICK_FONT_SIZE = 12;
const TAG_FONT_SIZE = 12;

const TEXT_LEFT = 40;
const TEXT_WIDTH = 580;
const BOX_SIZE = 300;
const BOX_LEFT = SHEET_WIDTH - 40 - BOX_SIZE;

const CONCEPT_MAX_LINES = 3;
const LEGEND_MAX_ROWS = 10;
const VIOLATION_MAX_ROWS = 4;
const ASCII_EM = 0.5;
const WIDE_EM = 1;
const ELLIPSIS = '…';

const FONT_FAMILY = 'sans-serif';
const PAPER = '#f7f2e6';
const PANEL_BG = '#ffffff';
const GRID_COLOR = '#d9d2bf';
const GRID_BOLD_COLOR = '#b9b09a';
const TICK_COLOR = '#7a7260';
const TEXT_COLOR = '#222222';
const HEADING_COLOR = '#555555';
const WARN_COLOR = '#b3261e';
const HELPER_COLOR = '#2a6fb0';
const HELPER_WIDTH = 0.8;
/** Construction lines over the finished drawing are thicker so they show at 512 px. */
const GUIDE_WIDTH = 1.8;
const ARC_WIDTH_FACTOR = 2.5;
const COPY_OPACITY = 0.4;
const MARK_FILL_OPACITY = 0.15;
const FIGURE_TINT_OPACITY = 0.25;
const TAG_BEARING_START = 45;
const TAG_BEARING_STEP = 47;
const POINT_RADIUS = 3;
const CENTER_RADIUS = 2;
const BOX_STROKE = '#444444';

export type SheetViolation = { rule: string; target: string; message: string };
export type SheetException = { rule: string; target: string; reason: string };

export type SheetInput = {
  spec: Spec;
  model: ResolvedModel;
  fills: readonly FillResult[];
  violations: readonly SheetViolation[];
  exceptionsApplied: readonly SheetException[];
};

export type SheetOutput = { svg: string; width: number; height: number };

const escapeXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const glyphWidth = (ch: string): number =>
  FONT_SIZE * ((ch.codePointAt(0) ?? 0) < 128 ? ASCII_EM : WIDE_EM);

const textWidth = (s: string): number => [...s].reduce((w, ch) => w + glyphWidth(ch), 0);

/** Cuts a single line to the width, ending in an ellipsis when something was removed. */
function truncate(s: string, maxWidth: number): string {
  if (textWidth(s) <= maxWidth) {
    return s;
  }
  const chars = [...s];
  while (chars.length > 0 && textWidth(chars.join('')) + glyphWidth(ELLIPSIS) > maxWidth) {
    chars.pop();
  }
  return chars.join('').trimEnd() + ELLIPSIS;
}

/** Greedy wrap by the width estimate, preferring spaces; at most `maxLines`, the last cut with an ellipsis. */
function wrap(s: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let rest = [...s];
  while (rest.length > 0 && lines.length < maxLines) {
    let w = 0;
    let end = 0;
    let lastSpace = -1;
    while (end < rest.length && w + glyphWidth(rest[end] ?? '') <= maxWidth) {
      w += glyphWidth(rest[end] ?? '');
      if (rest[end] === ' ') {
        lastSpace = end;
      }
      end++;
    }
    if (end < rest.length && lastSpace > 0) {
      end = lastSpace + 1;
    }
    lines.push(rest.slice(0, end).join('').trimEnd());
    rest = rest.slice(end);
    while (rest[0] === ' ') {
      rest.shift();
    }
  }
  if (rest.length > 0) {
    lines.push(truncate(`${lines.pop() ?? ''}${ELLIPSIS}`, maxWidth));
  }
  return lines;
}

type PanelLine = { text: string; kind: 'heading' | 'body' | 'warn' };

function legendRow(el: ResolvedElement): string {
  switch (el.type) {
    case 'circle':
    case 'tangent_circle': {
      const value = String(Number(el.circle.r.toFixed(4)));
      const radius = el.label === value ? value : `${el.label} = ${value}`;
      return `${el.id}  ${el.type}  r = ${radius}`;
    }
    case 'repeat':
      return `${el.id}  repeat  ${el.copyCount} placements`;
    default:
      return `${el.id}  ${el.type}`;
  }
}

function panelLines(input: SheetInput): PanelLine[] {
  const lines: PanelLine[] = [];
  const body = (text: string, kind: PanelLine['kind'] = 'body'): void => {
    lines.push({ text: truncate(text, TEXT_WIDTH), kind });
  };
  const more = (n: number): void => body(`+${n} more`);

  const concept = input.spec.concept;
  if (concept !== undefined) {
    lines.push({ text: 'CONCEPT', kind: 'heading' });
    for (const l of wrap(concept, TEXT_WIDTH, CONCEPT_MAX_LINES)) {
      lines.push({ text: l, kind: 'body' });
    }
  }

  const rows = input.model.elements.map(legendRow);
  lines.push({ text: 'LEGEND', kind: 'heading' });
  rows.slice(0, LEGEND_MAX_ROWS).forEach((r) => {
    body(r);
  });
  if (rows.length > LEGEND_MAX_ROWS) {
    more(rows.length - LEGEND_MAX_ROWS);
  }

  if (input.exceptionsApplied.length > 0) {
    lines.push({ text: 'EXCEPTIONS', kind: 'heading' });
    for (const e of input.exceptionsApplied) {
      body(`${e.rule}  ${e.target}  ${e.reason}`);
    }
  }

  if (input.violations.length > 0) {
    lines.push({ text: 'VIOLATIONS', kind: 'heading' });
    for (const v of input.violations.slice(0, VIOLATION_MAX_ROWS)) {
      body(`${v.rule}  ${v.target}  ${v.message}`, 'warn');
    }
    if (input.violations.length > VIOLATION_MAX_ROWS) {
      more(input.violations.length - VIOLATION_MAX_ROWS);
    }
  }
  return lines;
}

type Frame = { half: number; scale: number; line: number };

const sx = (f: Frame, x: number): number => DRAWING_SIZE / 2 + x * f.scale;
const sy = (f: Frame, y: number): number => DRAWING_SIZE / 2 - y * f.scale;

function gridMarkup(model: ResolvedModel, f: Frame): string[] {
  const out: string[] = [
    `<rect x="0" y="0" width="${DRAWING_SIZE}" height="${DRAWING_SIZE}" fill="${PAPER}"/>`,
  ];
  const max = Math.floor(f.half);
  for (let m = -max; m <= max; m++) {
    const bold = m % model.divisions === 0;
    const color = bold ? GRID_BOLD_COLOR : GRID_COLOR;
    const width = bold ? 1.2 : 0.6;
    out.push(
      `<line x1="${num(sx(f, m))}" y1="0" x2="${num(sx(f, m))}" y2="${DRAWING_SIZE}" stroke="${color}" stroke-width="${width}"/>`,
      `<line x1="0" y1="${num(sy(f, m))}" x2="${DRAWING_SIZE}" y2="${num(sy(f, m))}" stroke="${color}" stroke-width="${width}"/>`,
    );
  }
  return out;
}

function tickMarkup(model: ResolvedModel, f: Frame): string[] {
  const step = model.divisions / 2;
  const out: string[] = [];
  const attrs = `font-size="${TICK_FONT_SIZE}" fill="${TICK_COLOR}"`;
  for (let v = -Math.floor(f.half / step) * step; v <= f.half; v += step) {
    const label = num(v);
    out.push(
      `<text x="3" y="${num(sy(f, v) - 2)}" ${attrs}>${label}</text>`,
      `<text x="${num(sx(f, v) + 2)}" y="${DRAWING_SIZE - 4}" ${attrs}>${label}</text>`,
    );
  }
  return out;
}

/** A line guide reaches this fraction of the segment's length past each endpoint. */
const LINE_GUIDE_OVERSHOOT = 0.5;

/** Parameter range of a line inside the canvas square, as two points; `tMin`/`tMax` bound the parameter. */
function clipLine(
  line: Line,
  half: number,
  tMin = Number.NEGATIVE_INFINITY,
  tMax = Number.POSITIVE_INFINITY,
): [Vec, Vec] | null {
  let lo = tMin;
  let hi = tMax;
  for (const [p, d] of [
    [line.p.x, line.d.x],
    [line.p.y, line.d.y],
  ] as const) {
    if (Math.abs(d) < 1e-12) {
      if (Math.abs(p) > half) {
        return null;
      }
      continue;
    }
    const t0 = (-half - p) / d;
    const t1 = (half - p) / d;
    lo = Math.max(lo, Math.min(t0, t1));
    hi = Math.min(hi, Math.max(t0, t1));
  }
  if (!(lo < hi)) {
    return null;
  }
  const at = (t: number): Vec => ({ x: line.p.x + line.d.x * t, y: line.p.y + line.d.y * t });
  return [at(lo), at(hi)];
}

/** The segment extended past both ends by `LINE_GUIDE_OVERSHOOT` of its length, clipped to the canvas square. */
function clipSegment(from: Vec, to: Vec, half: number): [Vec, Vec] | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    return null;
  }
  const k = LINE_GUIDE_OVERSHOOT;
  const p = { x: from.x - dx * k, y: from.y - dy * k };
  return clipLine({ p, d: { x: dx, y: dy } }, half, 0, 1 + 2 * k);
}

function helperMarkup(
  el: RepeatElement | Extract<ResolvedElement, { type: 'tangent_circle' }>,
  f: Frame,
  centre: boolean,
  extra: string,
): string[] {
  const stroke = `fill="none" stroke="${HELPER_COLOR}" stroke-width="${f.line}"${extra}`;
  switch (el.type) {
    case 'circle':
    case 'tangent_circle': {
      const c: Circle = el.circle;
      const out = [
        `<circle cx="${num(sx(f, c.cx))}" cy="${num(sy(f, c.cy))}" r="${num(c.r * f.scale)}" ${stroke}/>`,
      ];
      if (centre) {
        out.push(
          `<circle cx="${num(sx(f, c.cx))}" cy="${num(sy(f, c.cy))}" r="${CENTER_RADIUS}" fill="${HELPER_COLOR}"${extra}/>`,
        );
      }
      return out;
    }
    case 'arc': {
      const c = el.circle;
      const p = (v: Vec): string => `${num(sx(f, v.x))} ${num(sy(f, v.y))}`;
      const radius = num(c.r * f.scale);
      const parts = arcParts({ cx: c.cx, cy: c.cy, r: c.r, from: el.start, to: el.end, ccw: true });
      const d = [
        `M ${p(el.start)}`,
        ...parts.map((end) => `A ${radius} ${radius} 0 0 0 ${p(end)}`),
      ];
      return [
        `<circle cx="${num(sx(f, c.cx))}" cy="${num(sy(f, c.cy))}" r="${radius}" ${stroke}/>`,
        `<path d="${d.join(' ')}" fill="none" stroke="${HELPER_COLOR}" stroke-width="${num(f.line * ARC_WIDTH_FACTOR)}" stroke-linecap="round"${extra}/>`,
      ];
    }
    case 'line': {
      const seg = clipSegment(el.from, el.to, f.half);
      if (seg === null) {
        return [];
      }
      return [
        `<line x1="${num(sx(f, seg[0].x))}" y1="${num(sy(f, seg[0].y))}" x2="${num(sx(f, seg[1].x))}" y2="${num(sy(f, seg[1].y))}" ${stroke}/>`,
      ];
    }
    case 'polygon':
    case 'points':
      return el.loops.map(
        (loop) =>
          `<polygon points="${loop.map((p) => `${num(sx(f, p.x))} ${num(sy(f, p.y))}`).join(' ')}" ${stroke}/>`,
      );
  }
}

/** Where an element's id tag goes, in module coordinates; `bearing` places a circle's tag on its circumference. */
function anchorOf(el: ResolvedElement | RepeatElement, f: Frame, bearing: number): Vec | null {
  switch (el.type) {
    case 'point':
      return { x: el.x, y: el.y };
    case 'circle':
    case 'tangent_circle':
      return pointOnCircle(el.circle, bearing);
    case 'arc':
      return pointOnCircle(el.circle, el.from + el.sweep / 2);
    case 'line': {
      const seg = clipSegment(el.from, el.to, f.half);
      return seg === null ? null : seg[1];
    }
    case 'polygon':
    case 'points':
      return el.vertices[0] ?? null;
    case 'repeat': {
      const first = el.copies[0];
      return first === undefined ? null : anchorOf(first.element, f, bearing);
    }
  }
}

/** Moves a tag vertically until it starts at least one font size from every tag placed before. */
function nudgeTag(x: number, y: number, placed: readonly Vec[]): Vec {
  const low = TAG_FONT_SIZE;
  const high = DRAWING_SIZE - TAG_FONT_SIZE;
  const step = y + TAG_FONT_SIZE > high ? -TAG_FONT_SIZE : TAG_FONT_SIZE;
  let ny = y;
  for (let tries = 0; tries <= 2 * placed.length; tries++) {
    if (!placed.some((p) => Math.hypot(p.x - x, p.y - ny) < TAG_FONT_SIZE)) {
      break;
    }
    ny = Math.min(Math.max(ny + step, low), high);
  }
  return { x, y: ny };
}

/** Construction lines of every element, in the sheet frame, with each element's id tag. */
function constructionMarkup(model: ResolvedModel, f: Frame): { helpers: string[]; tags: string[] } {
  const helpers: string[] = [];
  const tags: string[] = [];
  const placed: Vec[] = [];
  model.elements.forEach((el, index) => {
    const id = escapeXml(el.id);
    const inner: string[] = [];
    if (el.type === 'point') {
      inner.push(
        `<circle cx="${num(sx(f, el.x))}" cy="${num(sy(f, el.y))}" r="${POINT_RADIUS}" fill="${HELPER_COLOR}"/>`,
      );
      helpers.push(`<g data-id="${id}">${inner.join('')}</g>`);
    } else if (el.type === 'repeat') {
      for (const c of el.copies) {
        inner.push(...helperMarkup(c.element, f, false, ` opacity="${COPY_OPACITY}"`));
      }
      helpers.push(`<g data-id="${id}" data-kind="repeat">${inner.join('')}</g>`);
    } else {
      inner.push(...helperMarkup(el, f, true, ''));
      helpers.push(`<g data-id="${id}">${inner.join('')}</g>`);
    }
    // A fixed bearing step per element keeps concentric circles' tags apart.
    const anchor = anchorOf(el, f, TAG_BEARING_START + TAG_BEARING_STEP * index);
    if (anchor !== null) {
      const x = Math.min(Math.max(sx(f, anchor.x) + 3, 2), DRAWING_SIZE - 2 - el.id.length * 7);
      const y = Math.min(
        Math.max(sy(f, anchor.y) - 3, TAG_FONT_SIZE),
        DRAWING_SIZE - TAG_FONT_SIZE,
      );
      const at = nudgeTag(x, y, placed);
      placed.push(at);
      tags.push(
        `<text x="${num(at.x)}" y="${num(at.y)}" font-size="${TAG_FONT_SIZE}" fill="${HELPER_COLOR}">${id}</text>`,
      );
    }
  });
  return { helpers, tags };
}

const frameOf = (model: ResolvedModel, line = HELPER_WIDTH): Frame => ({
  half: model.canvasHalf,
  scale: DRAWING_SIZE / (2 * model.canvasHalf),
  line,
});

const drawingGroup = (f: Frame, body: string): string =>
  `<g transform="translate(${DRAWING_SIZE / 2} ${DRAWING_SIZE / 2}) scale(${num(f.scale)})">\n${body}\n</g>`;

/**
 * The final drawing at full strength under every construction element, on a transparent
 * background: no grid, ticks, tags or description panel.
 */
export function renderGuidesSvg(model: ResolvedModel, fills: readonly FillResult[]): string {
  const f = frameOf(model, GUIDE_WIDTH);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DRAWING_SIZE} ${DRAWING_SIZE}">`,
    drawingGroup(f, finalMarkup(model, fills)),
    ...constructionMarkup(model, f).helpers,
    '</svg>',
  ].join('\n');
}

/** Builds the construction sheet: drawing area on top, description panel below. */
export function renderSheetSvg(input: SheetInput): SheetOutput {
  const { model, fills } = input;
  const f = frameOf(model);
  const lines = panelLines(input);
  const panelHeight = Math.max(PANEL_MIN_HEIGHT, lines.length * LINE_ADVANCE + 2 * PANEL_PAD);
  const height = DRAWING_SIZE + panelHeight;

  // The drawing area shows the final figure as a light tint under the construction lines.
  const tinted = finalMarkup(model, fills, {
    fillOpacity: MARK_FILL_OPACITY,
    idPrefix: 'area-',
  });
  const finalInSheet = drawingGroup(
    f,
    model.mode === 'mark' ? tinted : `<g opacity="${FIGURE_TINT_OPACITY}">\n${tinted}\n</g>`,
  );

  const boxScale = BOX_SIZE / (2 * model.canvasHalf);
  const boxTop = DRAWING_SIZE + PANEL_PAD;
  const boxMark = `<g transform="translate(${BOX_LEFT + BOX_SIZE / 2} ${boxTop + BOX_SIZE / 2}) scale(${num(boxScale)})">\n${finalMarkup(model, fills, { idPrefix: 'box-' })}\n</g>`;

  const { helpers, tags } = constructionMarkup(model, f);

  const text = lines.map((l, i) => {
    const y = DRAWING_SIZE + PANEL_PAD + i * LINE_ADVANCE + FONT_SIZE;
    const color =
      l.kind === 'heading' ? HEADING_COLOR : l.kind === 'warn' ? WARN_COLOR : TEXT_COLOR;
    const weight = l.kind === 'heading' ? ' font-weight="bold"' : '';
    return `<text class="line" x="${TEXT_LEFT}" y="${y}" font-size="${FONT_SIZE}" fill="${color}"${weight} xml:space="preserve">${escapeXml(l.text)}</text>`;
  });

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_WIDTH}" height="${height}" viewBox="0 0 ${SHEET_WIDTH} ${height}" font-family="${FONT_FAMILY}">`,
    `<rect x="0" y="${DRAWING_SIZE}" width="${SHEET_WIDTH}" height="${panelHeight}" fill="${PANEL_BG}"/>`,
    ...gridMarkup(model, f),
    ...tickMarkup(model, f),
    `<clipPath id="drawing-area"><rect x="0" y="0" width="${DRAWING_SIZE}" height="${DRAWING_SIZE}"/></clipPath>`,
    '<g clip-path="url(#drawing-area)">',
    finalInSheet,
    ...helpers,
    '</g>',
    ...tags,
    `<rect x="${BOX_LEFT}" y="${boxTop}" width="${BOX_SIZE}" height="${BOX_SIZE}" fill="#ffffff" stroke="${BOX_STROKE}" stroke-width="1"/>`,
    boxMark,
    ...text,
    '</svg>',
  ].join('\n');
  return { svg, width: SHEET_WIDTH, height };
}
