import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { compareMasks } from '../render/match.js';
import { inkMask, renderMatchPng, renderPreviewPng, underlayHref } from '../render/png.js';
import { renderGuidesSvg, renderSheetSvg } from '../render/sheet.js';
import { renderFinalSvg } from '../render/svg.js';
import type { ResolvedElement, ResolvedModel } from '../resolve/resolve.js';
import type { Spec } from '../spec/schema.js';
import type { Evaluation } from './shared.js';
import {
  complain,
  evaluate,
  guarded,
  jsonText,
  loadSpec,
  parseArgs,
  pngImage,
  RESPONSE_MAX_CHARS,
  rasterize,
  round4,
  specArgSchema,
  ToolFailure,
} from './shared.js';
import { buildUnderlay, checkUnderlayFile, type UnderlayFile, underlaySchema } from './underlay.js';

const TOOL = 'gridsmith_render';
const VIEWS = [
  'sheet',
  'final',
  'sizes',
  'svg',
  'sheet_svg',
  'guides',
  'guides_svg',
  'match',
] as const;
const VIEW_LIST = VIEWS.map((v) => `"${v}"`).join(', ');
const VIEWS_ALLOWED = `an array of 1 to ${VIEWS.length} distinct values from ${VIEW_LIST}`;
const MAX_VIOLATIONS = 50;
/** An SVG view longer than this is not returned. */
const SVG_TEXT_MAX_CHARS = 60000;

type SvgView = 'svg' | 'sheet_svg' | 'guides_svg';
type RenderView = (typeof VIEWS)[number];
const isSvgView = (view: RenderView): view is SvgView =>
  view === 'svg' || view === 'sheet_svg' || view === 'guides_svg';

const viewsSchema = z
  .array(z.enum(VIEWS, { error: complain('view', `one of ${VIEW_LIST}`) }), {
    error: complain('views', VIEWS_ALLOWED),
  })
  .min(1, { error: complain('views', VIEWS_ALLOWED) })
  .max(VIEWS.length, { error: complain('views', VIEWS_ALLOWED) })
  .superRefine((views, ctx) => {
    views.forEach((view, i) => {
      if (views.indexOf(view) !== i) {
        ctx.addIssue({
          code: 'custom',
          path: [i],
          message: `duplicate view (received: "${view}"; allowed: each view at most once)`,
        });
      }
    });
  });

const argsSchema = z.strictObject({
  spec: specArgSchema,
  views: viewsSchema.optional(),
  underlay: underlaySchema.optional(),
});

const inputSchema = z.looseObject({
  spec: z
    .unknown()
    .optional()
    .describe(
      'Required. The drawing spec as an object, or the absolute path of a JSON file (at most 256 KB) holding it. Prefer a file: edit it and pass the same path again.',
    ),
  views: z
    .unknown()
    .optional()
    .describe(
      'Array of 1 to 8 distinct views, returned in this order after the JSON. PNG images: "sheet" (construction sheet), "final" (finished drawing, 512 px), "sizes" (mark only: 64, 32 and 16 px side by side), "guides" (finished drawing with every construction element over it, 512 px), "match" (needs underlay: overlap of the reference and the drawing, 512 px; both dark, reference only orange, drawing only blue). SVG markup as text: "svg" (finished drawing), "sheet_svg" (construction sheet), "guides_svg" (guides, transparent). An SVG over 60000 characters is not returned; use gridsmith_export. Default: ["sheet", "sizes"] for a mark, ["sheet", "final"] for a figure.',
    ),
  underlay: z
    .unknown()
    .optional()
    .describe(
      'Optional reference image to match: { path, box?, threshold?, invert? }. path: absolute path of a PNG or JPEG file (at most 4 MB, 8192 px a side). box: [x0, y0, x1, y1] in modules, where the shape in the image is placed (default [-R, -R, R, R]). threshold: integer 1 to 254 (default: automatic). invert: true when the shape is the lighter part. Adds "match" to the report (iou, missing, excess, offset, grid, blobs, underlay) and draws the reference on the sheet.',
    ),
});

const DESCRIPTION =
  'Draws a spec and returns a JSON report (resolved geometry, rule violations, near-tangent hints, statistics) plus the requested views: PNG previews (sheet, final, sizes, guides) and SVG markup (svg, sheet_svg, guides_svg). ' +
  'Reports violations without refusing to draw, so use it to iterate. Writes nothing. ' +
  'Read gridsmith_guide first for the spec format.';

const DEFAULT_VIEWS: Record<Spec['mode'], RenderView[]> = {
  mark: ['sheet', 'sizes'],
  figure: ['sheet', 'final'],
};

const xy = (p: { x: number; y: number }): [number, number] => [round4(p.x), round4(p.y)];

function describeElement(el: ResolvedElement): Record<string, unknown> {
  switch (el.type) {
    case 'point':
      return { id: el.id, type: el.type, x: round4(el.x), y: round4(el.y) };
    case 'circle':
      return {
        id: el.id,
        type: el.type,
        cx: round4(el.circle.cx),
        cy: round4(el.circle.cy),
        r: round4(el.circle.r),
        label: el.label,
      };
    case 'tangent_circle':
      return {
        id: el.id,
        type: el.type,
        cx: round4(el.circle.cx),
        cy: round4(el.circle.cy),
        r: round4(el.circle.r),
        label: el.label,
        contacts: el.contacts.map((c) => ({
          to: c.to,
          kind: c.kind,
          x: round4(c.x),
          y: round4(c.y),
        })),
      };
    case 'arc':
      return {
        id: el.id,
        type: el.type,
        cx: round4(el.circle.cx),
        cy: round4(el.circle.cy),
        r: round4(el.circle.r),
        from: round4(el.from),
        to: round4(el.to),
        x1: round4(el.start.x),
        y1: round4(el.start.y),
        x2: round4(el.end.x),
        y2: round4(el.end.y),
      };
    case 'line':
      return {
        id: el.id,
        type: el.type,
        x1: round4(el.from.x),
        y1: round4(el.from.y),
        x2: round4(el.to.x),
        y2: round4(el.to.y),
      };
    case 'polygon':
    case 'points':
      return { id: el.id, type: el.type, vertices: el.vertices.map(xy) };
    case 'repeat':
      return { id: el.id, type: el.type, of: el.of, copies: el.copyCount };
    case 'outline':
      return {
        id: el.id,
        type: el.type,
        pieces: el.pieces.length,
        corners: el.joints
          .filter((j) => j.kind === 'corner')
          .map((j) => [round4(j.at.x), round4(j.at.y), round4(j.turn)]),
        area: round4(el.area),
      };
  }
}

const geometryOf = (model: ResolvedModel): Record<string, unknown>[] =>
  model.elements.map(describeElement);

function statsOf(ev: Evaluation): Record<string, unknown>[] {
  const { model, fills } = ev;
  if (model.mode === 'figure') {
    return [
      ...model.strokes.map((s) => ({ paint: s.index, strokes: s.items.length })),
      ...model.erases.map((e) => ({ paint: e.index, erases: e.shapes.length })),
    ].sort((a, b) => a.paint - b.paint);
  }
  return model.fills.map((layer, i) => {
    const fill = fills[i];
    const edges = fill?.loops.flat() ?? [];
    const bbox = fill?.bbox ?? null;
    return {
      paint: layer.index,
      loops: fill?.loops.length ?? 0,
      arcs: edges.filter((e) => e.kind === 'arc').length,
      segments: edges.filter((e) => e.kind === 'segment').length,
      area: round4(fill?.area ?? 0),
      bbox:
        bbox === null
          ? null
          : {
              minX: round4(bbox.minX),
              minY: round4(bbox.minY),
              maxX: round4(bbox.maxX),
              maxY: round4(bbox.maxY),
            },
    };
  });
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function summaryOf(ev: Evaluation): string {
  const { spec, violations, exceptionsApplied, exportable } = ev;
  return (
    `${spec.mode === 'mark' ? 'Mark' : 'Figure'} with ${plural(spec.shapes.length, 'shape')} and ` +
    `${plural(spec.paint.length, 'paint layer')}: ${plural(violations.length, 'violation')}, ` +
    `${plural(exceptionsApplied.length, 'exception')} applied; ` +
    `${exportable ? 'exportable' : 'not exportable until the violations are fixed or excepted'}.`
  );
}

type Report = {
  summary: string;
  geometry: Record<string, unknown>[];
  violations: unknown[];
  exceptions_applied: unknown[];
  hints: unknown[];
  stats: Record<string, unknown>[];
  exportable: boolean;
  truncated: string[];
  match?: Record<string, unknown>;
};

// Drops geometry from the tail, then hints, then violations beyond the first 50; match stays.
function fitReport(report: Report): Report {
  const size = (r: Report): number => JSON.stringify(r).length;
  if (size(report) <= RESPONSE_MAX_CHARS) {
    return report;
  }
  const full = report.geometry;
  const withGeometry = (n: number): Report => ({
    ...report,
    geometry: full.slice(0, n),
    truncated: [...report.truncated, 'geometry'],
  });
  if (size(withGeometry(0)) <= RESPONSE_MAX_CHARS) {
    let lo = 0;
    let hi = full.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size(withGeometry(mid)) <= RESPONSE_MAX_CHARS) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return withGeometry(lo);
  }
  const noHints: Report = {
    ...withGeometry(0),
    hints: [],
    truncated: [...report.truncated, 'geometry', 'hints'],
  };
  if (size(noHints) <= RESPONSE_MAX_CHARS) {
    return noHints;
  }
  return {
    ...noHints,
    violations: report.violations.slice(0, MAX_VIOLATIONS),
    truncated: [...noHints.truncated, 'violations'],
  };
}

export function registerRender(server: McpServer): void {
  server.registerTool(
    TOOL,
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      guarded(TOOL, async () => {
        const parsed = parseArgs(TOOL, args, argsSchema);
        const underlayFile: UnderlayFile | undefined =
          parsed.underlay === undefined ? undefined : await checkUnderlayFile(parsed.underlay.path);
        const loaded = await loadSpec(TOOL, parsed.spec);
        let views: RenderView[] = [];
        const ev = evaluate(TOOL, loaded.raw, (spec) => {
          views = parsed.views ?? DEFAULT_VIEWS[spec.mode];
          const at = views.indexOf('sizes');
          if (spec.mode === 'figure' && at >= 0) {
            throw new ToolFailure([
              `${TOOL}: views[${at}]: view is not available for a figure (received: "sizes"; allowed: "sheet" or "final" when mode is "figure")`,
            ]);
          }
          const matchAt = views.indexOf('match');
          if (matchAt >= 0 && parsed.underlay === undefined) {
            throw new ToolFailure([
              `${TOOL}: views[${matchAt}]: view needs an underlay (received: "match" without underlay; allowed: "match" only together with the underlay argument)`,
            ]);
          }
        });
        const overlay =
          parsed.underlay === undefined || underlayFile === undefined
            ? undefined
            : buildUnderlay(underlayFile, parsed.underlay, ev.model.canvasHalf, ev.model.R);

        const svgs = {
          final: renderFinalSvg(ev.model, ev.fills),
          guides: renderGuidesSvg(ev.model, ev.fills),
          sheet: renderSheetSvg({
            spec: ev.spec,
            model: ev.model,
            fills: ev.fills,
            violations: ev.violations,
            exceptionsApplied: ev.exceptionsApplied,
            ...(overlay === undefined
              ? {}
              : { underlay: { href: underlayHref(overlay.reference) } }),
          }),
        };
        const ink =
          overlay === undefined
            ? undefined
            : rasterize(TOOL, 'the drawing mask', () => inkMask(svgs.final));
        const svgText: Record<SvgView, string> = {
          svg: svgs.final,
          sheet_svg: svgs.sheet.svg,
          guides_svg: svgs.guides,
        };
        const truncated: string[] = [];
        const blocks: (ReturnType<typeof pngImage> | ReturnType<typeof jsonText>)[] = [];
        for (const view of views) {
          if (isSvgView(view)) {
            const text = svgText[view];
            if (text.length > SVG_TEXT_MAX_CHARS) {
              truncated.push(`${view}: too large, use gridsmith_export`);
            } else {
              blocks.push({ type: 'text', text });
            }
            continue;
          }
          if (view === 'match' && overlay !== undefined && ink !== undefined) {
            const png = rasterize(TOOL, 'the match view', () =>
              renderMatchPng(overlay.reference, ink),
            );
            blocks.push(pngImage(png));
            continue;
          }
          const preview = rasterize(TOOL, `the ${view} view`, () => renderPreviewPng(view, svgs));
          if (preview.overBudget) {
            truncated.push(`${view}: over budget`);
          }
          blocks.push(pngImage(preview.png));
        }

        const report = fitReport({
          summary: summaryOf(ev),
          geometry: geometryOf(ev.model),
          violations: ev.violations,
          exceptions_applied: ev.exceptionsApplied,
          hints: ev.hints.map((h) => ({ ...h, gap: Number(h.gap.toPrecision(4)) })),
          stats: statsOf(ev),
          exportable: ev.exportable,
          truncated,
          ...(overlay === undefined || ink === undefined
            ? {}
            : {
                match: {
                  ...compareMasks(overlay.reference, ink, ev.model.canvasHalf),
                  underlay: overlay.report,
                },
              }),
        });
        return { content: [jsonText(report), ...blocks] };
      }),
  );
}
