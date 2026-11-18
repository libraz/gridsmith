import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ImportNote, ImportSegment, ImportSkip } from '../import/segments.js';
import { importSegments, segmentsToSvg } from '../import/segments.js';
import { diffShare } from '../render/match.js';
import { rasterRgba } from '../render/png.js';
import { renderFinalSvg } from '../render/svg.js';
import type { Violation } from '../rules/lint.js';
import type { SnapKept } from '../rules/snap.js';
import { snapSpec } from '../rules/snap.js';
import type { SpecInput } from '../spec/schema.js';
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
const SEGMENTS_ALLOWED = `an array of 1 to ${MAX_SEGMENTS} segment objects { d, fill?, stroke?, strokeWidth?, strokeLinecap?, strokeLinejoin?, strokeDasharray?, fillRule?, transform? }`;

export type ImportStatus = 'clean' | 'violations' | 'partial' | 'failed';

export type ImportReport = {
  spec: SpecInput | null;
  status: ImportStatus;
  skipped: ImportSkip[];
  notes: ImportNote[];
  subpaths: number;
  snap?: { applied: boolean; moved: number; gap: number; kept: SnapKept[]; error?: string };
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

/**
 * Converts one icon's segments to a spec, snaps it to the grid, evaluates it and measures how far
 * it is from the original.
 *
 * @param options.snap Whether to round the converted spec; `faithful` is always measured before.
 * @throws Error when the segments or their path data are malformed.
 * @throws ToolFailure when the native rasterizer is unavailable.
 */
export function importIcon(
  tool: ToolName,
  segments: unknown,
  options: { snap: boolean },
): ImportReport {
  const imported = importSegments(segments);
  const { skipped, notes, subpaths } = imported;
  if (imported.spec === null) {
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

  const before = tryEvaluate(tool, imported.spec);
  const faithful = 'ev' in before ? measure(before.ev) : null;
  let spec: SpecInput = imported.spec;
  let adopted = 'ev' in before ? before.ev : null;
  let diff = faithful;
  let snap: ImportReport['snap'];
  if (options.snap) {
    const snapped = snapSpec(imported.spec);
    const after = tryEvaluate(tool, snapped.spec);
    if ('ev' in after) {
      spec = snapped.spec;
      adopted = after.ev;
      diff = measure(after.ev);
      snap = { applied: true, moved: snapped.moved, gap: snapped.gap, kept: snapped.kept };
    } else {
      snap = { applied: false, moved: 0, gap: 0, kept: [], error: after.error };
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
      'Optional boolean, default true: round the converted spec to the 0.5 grid and to equal polyline steps. false returns the spec as converted.',
    ),
});

const DESCRIPTION =
  'Converts a 24-unit icon given as SVG path segments into an icon spec, rounds it to the grid, and returns the spec with its status (clean, violations, partial, failed), the rule violations and the pixel difference from the original. ' +
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
          report = importIcon(TOOL, parsed.segments, { snap: parsed.snap ?? true });
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
