import { resolve } from 'node:path';
import type { ImportSegment } from './import/segments.js';
import { renderExportPng } from './render/png.js';
import { renderSegments, type SegmentSet } from './render/segments.js';
import { renderGuidesSvg, renderSheetSvg } from './render/sheet.js';
import { renderFinalSvg } from './render/svg.js';
import type { AppliedException, Hint, Violation } from './rules/lint.js';
import type { Spec, SpecInput } from './spec/schema.js';
import { type ExportedFile, exportArgsSchema, writeExport } from './tools/export.js';
import { type GuideTopic, guideArgsSchema, guideDocument } from './tools/guide.js';
import { type ImportReport, runImport } from './tools/import.js';
import { evaluate, GridsmithError, parseArgs, rasterize } from './tools/shared.js';

const CALLER = 'gridsmith';
const PNG_SIZE_MAX = 4096;

/** A spec solved, linted and drawn. */
export type Drawing = {
  /** The parsed spec, defaults filled in. */
  spec: Spec;
  violations: Violation[];
  exceptionsApplied: AppliedException[];
  hints: Hint[];
  /** True when no violation remains, so {@link exportSpec} accepts the spec. */
  exportable: boolean;
  /** The finished drawing. */
  svg: string;
  /** The construction sheet: grid, construction elements, legend, violations. */
  sheetSvg: string;
  /** The finished drawing with every construction element over it, on a transparent ground. */
  guidesSvg: string;
  /** An icon's path data, one segment per paint layer; null for a mark or a figure. */
  segments: SegmentSet | null;
  /** Rasterizes {@link svg} to a transparent PNG `size` px wide (1 to 4096). */
  png(size: number): Uint8Array;
};

/**
 * Solves, lints and draws a spec. Rule violations are reported in the result, not thrown.
 *
 * @throws GridsmithError when the spec is malformed or an element cannot be resolved.
 */
export function render(spec: SpecInput): Drawing {
  const ev = evaluate(CALLER, spec);
  const svg = renderFinalSvg(ev.model, ev.fills);
  return {
    spec: ev.spec,
    violations: ev.violations,
    exceptionsApplied: ev.exceptionsApplied,
    hints: ev.hints,
    exportable: ev.exportable,
    svg,
    sheetSvg: renderSheetSvg({
      spec: ev.spec,
      model: ev.model,
      fills: ev.fills,
      violations: ev.violations,
      exceptionsApplied: ev.exceptionsApplied,
    }).svg,
    guidesSvg: renderGuidesSvg(ev.model, ev.fills),
    segments: ev.model.mode === 'icon' ? renderSegments(ev.model, ev.fills) : null,
    png(size) {
      if (!Number.isInteger(size) || size < 1 || size > PNG_SIZE_MAX) {
        throw new GridsmithError([
          `${CALLER}: size: size is invalid (received: ${String(size)}; allowed: an integer from 1 to ${PNG_SIZE_MAX})`,
        ]);
      }
      return rasterize(CALLER, `the ${size} px PNG`, () => renderExportPng(svg, size));
    },
  };
}

export type ExportSpecOptions = {
  /** Output directory, created if missing; a relative path resolves against the working directory. */
  dir: string;
  /** Base name of the output files, matching `^[a-z0-9][a-z0-9_-]{0,63}$`. */
  name: string;
  /** Replace existing files instead of refusing. Default false. */
  overwrite?: boolean;
};

/**
 * Writes the same files as the gridsmith_export tool: the SVGs, the spec, PNGs at the sizes of
 * the mode and, for an icon, `<name>.segments.json`. Writes nothing unless every file can be written.
 *
 * @throws GridsmithError for a malformed spec, remaining violations, existing files without
 *   `overwrite`, or an unwritable directory.
 */
export async function exportSpec(
  spec: SpecInput,
  options: ExportSpecOptions,
): Promise<ExportedFile[]> {
  const parsed = parseArgs(
    CALLER,
    { ...options, spec, dir: resolve(options.dir) },
    exportArgsSchema,
  );
  const { files } = await writeExport(CALLER, { raw: spec }, parsed);
  return files;
}

export type ImportIconOptions = {
  /** Round the converted spec to a grid step. Default true. */
  snap?: boolean;
  /** The grid step to round to; omitted, the step closest to the original is chosen. */
  step?: 0.5 | 0.25 | 0.1;
};

/**
 * Converts a 24-unit icon given as SVG path segments (y down) into an icon spec.
 *
 * @throws GridsmithError for malformed segments or path data.
 */
export function importIcon(
  segments: readonly ImportSegment[],
  options: ImportIconOptions = {},
): ImportReport {
  return runImport(CALLER, { ...options, segments });
}

/**
 * The reference document of one topic: `overview` (default), `spec` (JSON Schema), `rules`,
 * `examples` or `icon`. The same text the gridsmith_guide tool returns.
 */
export function guide(topic: GuideTopic = 'overview'): Record<string, unknown> {
  parseArgs(CALLER, { topic }, guideArgsSchema);
  return guideDocument(topic);
}
