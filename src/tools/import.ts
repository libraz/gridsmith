import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { FIT_TOLERANCE } from '../import/fit.js';
import type { ImportNote, ImportResult, ImportSegment, ImportSkip } from '../import/segments.js';
import { importSegments, segmentsToSvg } from '../import/segments.js';
import { diffShare } from '../render/match.js';
import { rasterRgba } from '../render/png.js';
import { renderFinalSvg } from '../render/svg.js';
import type { Violation } from '../rules/lint.js';
import type { SnapKept } from '../rules/snap.js';
import { snapSpec } from '../rules/snap.js';
import type { SpecInput } from '../spec/schema.js';
import { ICON_GRID_STEPS } from '../spec/schema.js';
import type { Evaluation, ToolName } from './shared.js';
import {
  complain,
  evaluate,
  guarded,
  jsonText,
  parseArgs,
  RESPONSE_MAX_CHARS,
  rasterize,
  round4,
  ToolFailure,
} from './shared.js';

const TOOL = 'gridsmith_import';
const MAX_SEGMENTS = 64;
/** Side of the images compared with the original, in px. */
const COMPARE_SIDE = 192;
/** Per-channel difference above which a pixel counts as different. */
const PIXEL_TOLERANCE = 32;
/** How much worse than the unsnapped drawing a snapped one may be and still count as faithful. */
const DIFF_MARGIN = 0.005;
/** Curve-fit tolerances tried in order until the unsnapped spec keeps within the circle limit. */
const FIT_TOLERANCES = [FIT_TOLERANCE, 0.05, 0.1] as const;
/** Most exceptions a spec may carry. */
const EXCEPTIONS_MAX = 16;
type GridStep = (typeof ICON_GRID_STEPS)[number];
const STEP_ALLOWED = ICON_GRID_STEPS.join(', ');
const SEGMENTS_ALLOWED = `an array of 1 to ${MAX_SEGMENTS} segment objects { d, fill?, stroke?, strokeWidth?, strokeLinecap?, strokeLinejoin?, strokeDasharray?, fillRule?, transform? }`;

export type ImportStatus = 'clean' | 'violations' | 'partial' | 'failed';

export type ImportReport = {
  spec: SpecInput | null;
  status: ImportStatus;
  skipped: ImportSkip[];
  notes: ImportNote[];
  subpaths: number;
  snap?: {
    applied: boolean;
    /** The grid step adopted; absent when no step could be evaluated. */
    step?: number;
    moved: number;
    gap: number;
    kept: SnapKept[];
    error?: string;
  };
  violations: Violation[];
  /** Share of pixels that differ between the adopted spec and the original. */
  diff: number | null;
  /** The same share measured before snapping. */
  faithful: number | null;
};

const firstLine = (text: string): string => (text.split('\n')[0] ?? '').slice(0, 200);

/** Evaluates a spec; an unresolvable one comes back as the first line of its error. */
function tryEvaluate(tool: ToolName, raw: unknown): { ev: Evaluation } | { error: string } {
  try {
    return { ev: evaluate(tool, raw) };
  } catch (error) {
    if (error instanceof ToolFailure) {
      return { error: firstLine(error.lines[0] ?? error.message) };
    }
    throw error;
  }
}

/** A conversion and the evaluation of its unsnapped spec, null when there is no spec. */
type Conversion = { imported: ImportResult; before: { ev: Evaluation } | { error: string } | null };

/**
 * Converts the segments at the finest fit tolerance whose unsnapped spec has no `circle_count`
 * violation, or at the finest one when every tolerance has it; with the evaluation of that spec.
 */
function convertFitted(tool: ToolName, segments: unknown): Conversion {
  let first: Conversion | undefined;
  for (const fitTolerance of FIT_TOLERANCES) {
    const imported = importSegments(segments, { fitTolerance });
    const before = imported.spec === null ? null : tryEvaluate(tool, imported.spec);
    first ??= { imported, before };
    if (
      before === null ||
      !('ev' in before) ||
      !before.ev.violations.some((v) => v.rule === 'circle_count')
    ) {
      return { imported, before };
    }
  }
  return first as Conversion;
}

/**
 * Snaps the converted spec at one grid step and evaluates it. A polyline rounded plainly because its
 * source steps were uneven gets an `uneven_steps` exception when it would otherwise be flagged.
 */
function snapAtStep(tool: ToolName, converted: SpecInput, step: GridStep) {
  const input: SpecInput =
    step === ICON_GRID_STEPS[0] ? converted : { ...converted, grid: { ...converted.grid, step } };
  const snapped = snapSpec(input);
  let after = tryEvaluate(tool, snapped.spec);
  if ('ev' in after) {
    const uneven = new Set(
      snapped.kept.filter((k) => k.reason === 'uneven steps').map((k) => k.id),
    );
    const room = EXCEPTIONS_MAX - (snapped.spec.exceptions?.length ?? 0);
    const targets = [
      ...new Set(
        after.ev.violations
          .filter((v) => v.rule === 'uneven_steps' && uneven.has(v.target))
          .map((v) => v.target),
      ),
    ].slice(0, Math.max(0, room));
    if (targets.length > 0) {
      snapped.spec.exceptions = [
        ...(snapped.spec.exceptions ?? []),
        ...targets.map((target) => ({
          rule: 'uneven_steps' as const,
          target,
          reason: 'steps as drawn in the source',
        })),
      ];
      after = tryEvaluate(tool, snapped.spec);
    }
  }
  return {
    step,
    spec: snapped.spec,
    moved: snapped.moved,
    gap: snapped.gap,
    kept: snapped.kept,
    after,
  };
}

/**
 * Converts one icon's segments to a spec, snaps it to the grid, evaluates it and measures how far
 * it is from the original.
 *
 * Curves are fitted within 0.025, or 0.05 or 0.1 when the finer fit breaks the circle limit.
 * Without `options.step` every grid step is tried and the one chosen is the first of: evaluable;
 * within `faithful + 0.005`; fewest violations; coarsest step. When no step is within the margin,
 * it is the smallest diff among the violation-free steps, or among all when none is free of
 * violations, then the coarsest step. Polylines
 * that were not evenly stepped in the source get an `uneven_steps` exception.
 *
 * @param options.snap Whether to round the converted spec; `faithful` is always measured before.
 * @param options.step The grid step to round to; ignored when `snap` is false.
 * @throws Error when the segments or their path data are malformed.
 * @throws ToolFailure when the native rasterizer is unavailable.
 */
export function importIcon(
  tool: ToolName,
  segments: unknown,
  options: { snap: boolean; step?: GridStep },
): ImportReport {
  const { imported, before } = convertFitted(tool, segments);
  const { skipped, notes, subpaths } = imported;
  if (imported.spec === null || before === null) {
    return {
      spec: null,
      status: 'failed',
      skipped,
      notes,
      subpaths,
      violations: [],
      diff: null,
      faithful: null,
    };
  }
  const original = segmentsToSvg(segments as ImportSegment[]);
  const measure = (ev: Evaluation): number =>
    rasterize(tool, 'the drawing', () =>
      diffShare(
        rasterRgba(renderFinalSvg(ev.model, ev.fills), COMPARE_SIDE),
        rasterRgba(original, COMPARE_SIDE),
        PIXEL_TOLERANCE,
      ),
    );

  const faithful = 'ev' in before ? measure(before.ev) : null;
  let spec: SpecInput = imported.spec;
  let adopted = 'ev' in before ? before.ev : null;
  let diff = faithful;
  let snap: ImportReport['snap'];
  if (options.snap) {
    const steps = options.step === undefined ? ICON_GRID_STEPS : [options.step];
    const tried = steps.map((step) => snapAtStep(tool, imported.spec as SpecInput, step));
    const evaluable = tried.flatMap((t) => ('ev' in t.after ? [{ ...t, ev: t.after.ev }] : []));
    const scored = evaluable.map((t) => ({ ...t, diff: measure(t.ev) }));
    const faithfulEnough =
      faithful === null ? [] : scored.filter((t) => t.diff <= faithful + DIFF_MARGIN);
    // Without a measurable unsnapped drawing there is no yardstick: every evaluable step competes.
    const missed = faithful !== null && faithfulEnough.length === 0;
    // With no step within the margin, what counts is whether the spec can be exported at all.
    const exportable = scored.filter((t) => t.ev.violations.length === 0);
    const pool =
      faithful === null
        ? scored
        : !missed
          ? faithfulEnough
          : exportable.length > 0
            ? exportable
            : scored;
    const better = (t: (typeof scored)[number], best: (typeof scored)[number]): boolean =>
      missed ? t.diff < best.diff : t.ev.violations.length < best.ev.violations.length;
    const chosen = pool.reduce<(typeof scored)[number] | undefined>(
      (best, t) => (best === undefined || better(t, best) ? t : best),
      undefined,
    );
    if (chosen !== undefined) {
      spec = chosen.spec;
      adopted = chosen.ev;
      diff = chosen.diff;
      snap = {
        applied: true,
        step: chosen.step,
        moved: chosen.moved,
        gap: chosen.gap,
        kept: chosen.kept,
      };
    } else {
      const [first] = tried;
      const error = first !== undefined && 'error' in first.after ? first.after.error : '';
      snap = { applied: false, moved: 0, gap: 0, kept: [], error };
    }
  }
  if (adopted === null) {
    return {
      spec,
      status: 'failed',
      skipped,
      notes,
      subpaths,
      ...(snap === undefined ? {} : { snap }),
      violations: [],
      diff: null,
      faithful,
    };
  }
  const violations = adopted.violations;
  const status: ImportStatus =
    skipped.length > 0 ? 'partial' : violations.length > 0 ? 'violations' : 'clean';
  return {
    spec,
    status,
    skipped,
    notes,
    subpaths,
    ...(snap === undefined ? {} : { snap }),
    violations,
    diff,
    faithful,
  };
}

const argsSchema = z.strictObject({
  segments: z
    .array(z.unknown(), { error: complain('segments', SEGMENTS_ALLOWED) })
    .min(1, { error: complain('segments', SEGMENTS_ALLOWED) })
    .max(MAX_SEGMENTS, { error: complain('segments', SEGMENTS_ALLOWED) }),
  snap: z.boolean({ error: complain('snap', 'true or false') }).optional(),
  step: z.literal([...ICON_GRID_STEPS], { error: complain('step', STEP_ALLOWED) }).optional(),
});

const inputSchema = z.looseObject({
  segments: z
    .unknown()
    .optional()
    .describe(
      "Required. The icon as an array of 1 to 64 path segments on a 24-unit canvas, y down: { d, fill?, stroke?, strokeWidth?, strokeLinecap?, strokeLinejoin?, strokeDasharray?, fillRule?, transform? }. Use the segments of gridsmith_export or an SVG icon's paths.",
    ),
  snap: z
    .unknown()
    .optional()
    .describe(
      'Optional boolean, default true: round the converted spec to a grid step and to equal polyline steps. false returns the spec as converted.',
    ),
  step: z
    .unknown()
    .optional()
    .describe(
      'Optional grid step: 0.5, 0.25 or 0.1. Omitted: every step is tried and the one whose drawing stays closest to the original is returned (snap.step). Ignored when snap is false.',
    ),
});

const DESCRIPTION =
  'Converts a 24-unit icon given as SVG path segments into an icon spec, rounds it to a grid step, and returns the spec with its status (clean, violations, partial, failed), the rule violations and the pixel difference from the original. ' +
  'Curves are fitted within 0.025 units, or 0.05 or 0.1 when a finer fit needs more than 40 circles. ' +
  'Subpaths that cannot be expressed are listed in skipped, with their lines and arcs when a path mixes them. Writes nothing. ' +
  'Read gridsmith_guide topic "icon" first.';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function summaryOf(report: ImportReport): string {
  const total = report.subpaths;
  const done = Math.max(0, total - report.skipped.length);
  const diff = report.diff === null ? 'n/a' : String(round4(report.diff));
  return `Imported ${done} of ${total} subpaths; status ${report.status}; ${plural(report.violations.length, 'violation')}; diff ${diff}.`;
}

type Body = { summary: string } & ImportReport & { trimmed?: string[] };

// Drops the pieces of skipped subpaths, then the notes, until the JSON fits.
function fitBody(report: ImportReport): Body {
  const body: Body = { summary: summaryOf(report), ...report };
  const fits = (b: Body): boolean => JSON.stringify(b).length <= RESPONSE_MAX_CHARS;
  if (fits(body)) {
    return body;
  }
  const noPieces: Body = {
    ...body,
    skipped: body.skipped.map(({ pieces: _omit, ...rest }) => rest),
    trimmed: ['pieces'],
  };
  if (fits(noPieces)) {
    return noPieces;
  }
  const noNotes: Body = { ...noPieces, notes: [], trimmed: ['pieces', 'notes'] };
  if (fits(noNotes)) {
    return noNotes;
  }
  throw new ToolFailure([
    `${TOOL}: segments: the result is too large to return (received: ${report.subpaths} subpaths; allowed: fewer segments per call)`,
  ]);
}

export function registerImport(server: McpServer): void {
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
        let report: ImportReport;
        try {
          report = importIcon(TOOL, parsed.segments, {
            snap: parsed.snap ?? true,
            ...(parsed.step === undefined ? {} : { step: parsed.step }),
          });
        } catch (error) {
          if (error instanceof ToolFailure || !(error instanceof Error)) {
            throw error;
          }
          throw new ToolFailure([`${TOOL}: segments: ${firstLine(error.message)}`]);
        }
        return { content: [jsonText(fitBody(report))] };
      }),
  );
}
