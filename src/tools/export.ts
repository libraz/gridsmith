import { lstat, mkdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { renderExportPng } from '../render/png.js';
import { renderSegments } from '../render/segments.js';
import { renderGuidesSvg, renderSheetSvg } from '../render/sheet.js';
import { renderFinalSvg } from '../render/svg.js';
import {
  complain,
  errorCode,
  evaluate,
  guarded,
  jsonText,
  loadSpec,
  parseArgs,
  rasterize,
  specArgSchema,
  ToolFailure,
} from './shared.js';

const TOOL = 'gridsmith_export';
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NAME_ALLOWED = 'a string matching ^[a-z0-9][a-z0-9_-]{0,63}$';
const MAX_LISTED_VIOLATIONS = 20;

const argsSchema = z.strictObject({
  spec: specArgSchema,
  dir: z
    .string({ error: complain('dir', 'an absolute directory path') })
    .refine(isAbsolute, { error: complain('dir', 'an absolute directory path') }),
  name: z
    .string({ error: complain('name', NAME_ALLOWED) })
    .regex(NAME_PATTERN, { error: complain('name', NAME_ALLOWED) }),
  overwrite: z.boolean({ error: complain('overwrite', 'true or false') }).optional(),
});

const inputSchema = z.looseObject({
  spec: z
    .unknown()
    .optional()
    .describe(
      'Required. The drawing spec as an object, or the absolute path of a JSON file (at most 256 KB) holding it.',
    ),
  dir: z
    .unknown()
    .optional()
    .describe('Required. Absolute path of the output directory; created if missing.'),
  name: z
    .unknown()
    .optional()
    .describe('Required. Base name of the output files, matching ^[a-z0-9][a-z0-9_-]{0,63}$.'),
  overwrite: z
    .unknown()
    .optional()
    .describe(
      'Boolean, default false. When false, the call is refused if any output file already exists; when true, existing files are replaced.',
    ),
});

const DESCRIPTION =
  'Writes a finished drawing to disk: <name>.svg, <name>-sheet.svg, <name>-guides.svg, <name>.spec.json, plus PNGs (a mark: -512, -64, -32, -16; a figure: -1024; an icon: -512, -48, -24, -16, and <name>.segments.json with its path segments). ' +
  'Refuses a spec that still has violations, and refuses to replace existing files unless overwrite is true. ' +
  'Render the spec with gridsmith_render and clear its violations first.';

const PNG_SIZES = {
  mark: [512, 64, 32, 16],
  figure: [1024],
  icon: [512, 48, 24, 16],
} as const;

type Output = { file: string; data: string | Uint8Array };

let counter = 0;

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

const sameFile = async (a: string, b: string): Promise<boolean> => {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
};

const removeAll = async (paths: readonly string[]): Promise<void> => {
  await Promise.all(paths.map((p) => unlink(p).catch(() => undefined)));
};

async function ensureDirectory(dir: string): Promise<void> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      throw new ToolFailure([
        `${TOOL}: dir: directory is not usable (received: ${JSON.stringify(dir)}, which is not a directory; allowed: a directory path or a path that does not exist yet)`,
      ]);
    }
    return;
  } catch (error) {
    if (error instanceof ToolFailure) {
      throw error;
    }
  }
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    throw new ToolFailure([
      `${TOOL}: dir: directory cannot be created (received: ${JSON.stringify(dir)}, ${errorCode(error)}; allowed: a path whose parent is writable)`,
    ]);
  }
}

export function registerExport(server: McpServer): void {
  server.registerTool(
    TOOL,
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) =>
      guarded(TOOL, async () => {
        const parsed = parseArgs(TOOL, args, argsSchema);
        const loaded = await loadSpec(TOOL, parsed.spec);
        const ev = evaluate(TOOL, loaded.raw);
        if (!ev.exportable) {
          const listed = ev.violations
            .slice(0, MAX_LISTED_VIOLATIONS)
            .map((v) => `- ${v.rule} on ${v.target}: ${v.message}`);
          const more = ev.violations.length - listed.length;
          throw new ToolFailure([
            `${TOOL}: spec has ${ev.violations.length} violation(s) (received: ${ev.violations.length} violation(s); allowed: none). Nothing was written. Fix them, or add an exceptions entry { rule, target, reason } for each one that is intended.`,
            ...listed,
            ...(more > 0 ? [`… and ${more} more`] : []),
          ]);
        }

        const dir = resolve(parsed.dir);
        const { name } = parsed;
        const finalSvg = renderFinalSvg(ev.model, ev.fills);
        const sheet = renderSheetSvg({
          spec: ev.spec,
          model: ev.model,
          fills: ev.fills,
          violations: ev.violations,
          exceptionsApplied: ev.exceptionsApplied,
        });
        const sizes = PNG_SIZES[ev.spec.mode];
        const outputs: Output[] = [
          { file: `${name}.svg`, data: finalSvg },
          { file: `${name}-sheet.svg`, data: sheet.svg },
          { file: `${name}-guides.svg`, data: renderGuidesSvg(ev.model, ev.fills) },
          { file: `${name}.spec.json`, data: `${JSON.stringify(loaded.raw, null, 2)}\n` },
          ...(ev.spec.mode === 'icon'
            ? [
                {
                  file: `${name}.segments.json`,
                  data: `${JSON.stringify(renderSegments(ev.model, ev.fills), null, 2)}\n`,
                },
              ]
            : []),
          ...sizes.map((size) => ({
            file: `${name}-${size}.png`,
            data: rasterize(TOOL, `the ${size} px PNG`, () => renderExportPng(finalSvg, size)),
          })),
        ];

        await ensureDirectory(dir);

        // A spec read from <dir>/<name>.spec.json is already in place.
        const specTarget = join(dir, `${name}.spec.json`);
        const keepSpec = loaded.path !== undefined && (await sameFile(loaded.path, specTarget));
        const planned = outputs
          .filter((o) => !(keepSpec && o.file === `${name}.spec.json`))
          .map((o) => {
            counter += 1;
            return {
              ...o,
              path: join(dir, o.file),
              temp: join(dir, `.${name}.${process.pid}.${counter}.tmp`),
            };
          });

        const temps = planned.map((p) => p.temp);
        try {
          for (const p of planned) {
            await writeFile(p.temp, p.data, { flag: 'wx' });
          }
        } catch (error) {
          await removeAll(temps);
          throw new ToolFailure([
            `${TOOL}: dir: files cannot be written (received: ${JSON.stringify(dir)}, ${errorCode(error)}; allowed: a writable directory). Nothing was changed.`,
          ]);
        }

        if (parsed.overwrite !== true) {
          const present = (
            await Promise.all(planned.map(async (p) => ((await exists(p.path)) ? p.file : null)))
          ).filter((f): f is string => f !== null);
          if (present.length > 0) {
            await removeAll(temps);
            throw new ToolFailure([
              `${TOOL}: overwrite: files already exist (received: ${present.join(', ')} in ${dir}; allowed: new names, or overwrite: true to replace them). Nothing was changed.`,
            ]);
          }
        }

        const replaced: string[] = [];
        for (const [i, p] of planned.entries()) {
          try {
            await rename(p.temp, p.path);
            replaced.push(p.file);
          } catch (error) {
            await removeAll(temps.slice(i));
            const done = replaced.length > 0 ? replaced.join(', ') : 'none';
            throw new ToolFailure([
              `${TOOL}: dir: replacing ${p.file} failed (${errorCode(error)}). Files already replaced and not restorable: ${done}. Remaining temporary files were removed.`,
            ]);
          }
        }

        const files = planned.map((p) => ({
          path: p.path,
          bytes: typeof p.data === 'string' ? Buffer.byteLength(p.data) : p.data.byteLength,
        }));
        return {
          content: [
            jsonText({
              summary: `Wrote ${files.length} file${files.length === 1 ? '' : 's'} to ${dir}.`,
              files,
            }),
          ],
        };
      }),
  );
}
