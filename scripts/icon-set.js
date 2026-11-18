/**
 * Batch tools for icon specs, run from `dist/`.
 *
 *   import <segments.json> <outDir>                  segment sets -> snapped specs + report.json
 *   check <dir | spec.json ...> [--widths a,b] [--colors #x,#y]
 *                                                    evaluate specs; write segments when all pass
 *   show <spec.json> <outPrefix>                     sheet and pixel-preview PNGs, violations as JSON
 *   compare <segments.json> <out.png> <dir | spec.json ...>
 *                                                    original beside redrawn, one row per spec
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = 'gridsmith_import';
const SIDE = 192;
const TOLERANCE = 32;
const FAITHFUL_MAX = 0.01;
const CELL = 96;
const ROW = 112;
const GAP = 16;
const MARGIN = 8;
const USAGE = [
  'usage:',
  '  icon-set.js import <segments.json> <outDir>',
  '  icon-set.js check <dir | spec.json ...> [--widths a,b,...] [--colors #rrggbb,...]',
  '  icon-set.js show <spec.json> <outPrefix>',
  '  icon-set.js compare <segments.json> <out.png> <dir | spec.json ...>',
];

function fail(lines) {
  for (const line of Array.isArray(lines) ? lines : [lines]) {
    console.error(line);
  }
  process.exit(1);
}

if (!existsSync(join(root, 'dist', 'tools', 'shared.js'))) {
  fail('icon-set: dist/ is missing or incomplete; run `yarn build` first.');
}

const { segmentsToSvg } = await import('../dist/import/segments.js');
const { ovalDeviation } = await import('../dist/geom/shapes.js');
const { diffShare } = await import('../dist/render/match.js');
const { encodeRgbPng, rasterRgba, renderPreviewPng } = await import('../dist/render/png.js');
const { renderGuidesSvg, renderSheetSvg } = await import('../dist/render/sheet.js');
const { renderSegments } = await import('../dist/render/segments.js');
const { renderFinalSvg } = await import('../dist/render/svg.js');
const { importIcon } = await import('../dist/tools/import.js');
const { evaluate } = await import('../dist/tools/shared.js');

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const bump = (table, key, by = 1) => {
  table[key] = (table[key] ?? 0) + by;
};
const message = (error) => (error.lines ? error.lines.join('; ') : error.message);

/** Evaluates a raw spec; failures come back as `error` instead of throwing. */
function tryEvaluate(raw) {
  try {
    return { ev: evaluate(TOOL, raw) };
  } catch (error) {
    return { error: message(error) };
  }
}

const countBy = (violations) => {
  const table = {};
  for (const v of violations) {
    bump(table, v.rule);
  }
  return table;
};

async function listSpecs(dir) {
  const names = await readdir(dir);
  return names
    .filter((n) => n.endsWith('.json') && n !== 'report.json' && !n.endsWith('.segments.json'))
    .sort()
    .map((n) => n.slice(0, -'.json'.length));
}

/** Specs named by one directory or a list of .json files, as `{ name, file }`. */
async function specTargets(command, args) {
  const isFile = (a) => a.endsWith('.json');
  if (args.length === 0 || (args.length > 1 && !args.every(isFile))) {
    fail(USAGE);
  }
  if (args.every(isFile)) {
    return args.map((file) => ({ name: basename(file, '.json'), file }));
  }
  const names = await listSpecs(args[0]);
  if (names.length === 0) {
    fail(`${command}: no specs in ${args[0]}`);
  }
  return names.map((name) => ({ name, file: join(args[0], `${name}.json`) }));
}

async function importCommand(file, outDir) {
  const input = await readJson(file);
  await mkdir(outDir, { recursive: true });
  const report = {
    icons: 0,
    converted: 0,
    evaluated: 0,
    faithful: 0,
    status: { clean: 0, violations: 0, partial: 0, failed: 0 },
    skipped: {},
    unconverted: [],
    notes: {},
    fit: { curves: 0, arcs: 0 },
    elements: {},
    violations: {},
    ovals: [],
    perIcon: {},
  };
  for (const name of Object.keys(input).sort()) {
    report.icons += 1;
    const entry = {
      status: 'failed',
      converted: false,
      evaluated: false,
      diffShare: null,
      diff: null,
      moved: 0,
      gap: 0,
      kept: [],
      violations: {},
      skipped: [],
    };
    report.perIcon[name] = entry;
    let result;
    try {
      result = importIcon(TOOL, input[name], { snap: true });
    } catch (error) {
      if (error.name === 'ToolFailure') {
        throw error;
      }
      entry.skipped.push({ reason: 'invalid input' });
      bump(report.skipped, 'invalid input');
      bump(report.status, 'failed');
      report.unconverted.push({ name, reasons: ['invalid input'] });
      continue;
    }
    entry.status = result.status;
    bump(report.status, result.status);
    for (const s of result.skipped) {
      entry.skipped.push({
        reason: s.reason,
        ...(s.detail === undefined ? {} : { detail: s.detail }),
        ...(s.pieces ? { pieces: s.pieces } : {}),
      });
      bump(report.skipped, s.reason);
    }
    for (const n of result.notes) {
      bump(report.notes, n.note);
      if (n.note === 'curve fit') {
        report.fit.curves += n.curves ?? 0;
        report.fit.arcs += n.arcs ?? 0;
      }
    }
    entry.converted = result.spec !== null && result.skipped.length === 0;
    if (entry.converted) {
      report.converted += 1;
    } else {
      const reasons = [...new Set(result.skipped.map((s) => s.reason))].sort();
      report.unconverted.push({ name, reasons });
    }
    if (result.spec === null) {
      continue;
    }
    await writeJson(join(outDir, `${name}.json`), result.spec);
    for (const shape of result.spec.shapes ?? []) {
      bump(report.elements, shape.type);
    }
    entry.diffShare = result.faithful;
    entry.moved = result.snap?.moved ?? 0;
    entry.gap = result.snap?.gap ?? 0;
    entry.kept = result.snap?.kept ?? [];
    const { ev } = tryEvaluate(result.spec);
    if (!ev) {
      continue;
    }
    entry.evaluated = true;
    entry.diff = result.diff;
    report.evaluated += 1;
    entry.violations = countBy(result.violations);
    for (const v of result.violations) {
      bump(report.violations, v.rule);
    }
    for (const el of ev.model.elements) {
      if (el.type === 'oval') {
        const deviation = Math.round(ovalDeviation(el.rx, el.ry) * 1e4) / 1e4;
        report.ovals.push({ name, id: el.id, rx: el.rx, ry: el.ry, deviation });
      }
    }
    if (entry.converted && entry.diffShare !== null && entry.diffShare <= FAITHFUL_MAX) {
      report.faithful += 1;
    }
  }
  await writeJson(join(outDir, 'report.json'), report);
  const { clean, violations, partial, failed } = report.status;
  process.stdout.write(
    `icons ${report.icons}, clean ${clean}, violations ${violations}, partial ${partial}, failed ${failed}, faithful ${report.faithful}\n`,
  );
}

const sameNumber = (a, b) => Math.abs(a - b) <= 1e-9;

async function checkCommand(args) {
  const flagAt = args.findIndex((a) => a.startsWith('--'));
  const paths = flagAt < 0 ? args : args.slice(0, flagAt);
  const flags = flagAt < 0 ? [] : args.slice(flagAt);
  const list = (flag) => {
    const at = flags.indexOf(flag);
    if (at < 0) {
      return null;
    }
    const value = flags[at + 1];
    if (value === undefined) {
      fail(`check: ${flag} needs a comma-separated list`);
    }
    return value.split(',').filter((x) => x !== '');
  };
  const widths = list('--widths')?.map(Number) ?? null;
  const colors = list('--colors')?.map((c) => c.toLowerCase()) ?? null;
  if (widths?.some(Number.isNaN)) {
    fail('check: --widths must be numbers');
  }
  const targets = await specTargets('check', paths);
  const pending = [];
  let bad = 0;
  for (const { name, file } of targets) {
    const problems = [];
    const raw = await readJson(file);
    const { ev, error } = tryEvaluate(raw);
    if (!ev) {
      problems.push(`error: ${error}`);
    } else {
      if (ev.violations.length > 0) {
        const by = Object.entries(countBy(ev.violations))
          .map(([rule, n]) => `${rule}=${n}`)
          .join(' ');
        problems.push(`${ev.violations.length} violation(s) ${by}`);
      }
      if (Array.isArray(raw.exceptions) && raw.exceptions.length > 0) {
        problems.push(`${raw.exceptions.length} exception(s)`);
      }
      if (widths) {
        const off = ev.model.strokes.filter((s) => !widths.some((w) => sameNumber(w, s.width)));
        for (const s of off) {
          problems.push(`width ${s.width} not allowed`);
        }
      }
      if (colors) {
        const layers = [...ev.model.fills, ...ev.model.strokes];
        for (const l of layers) {
          if (!colors.includes(l.color.toLowerCase())) {
            problems.push(`colour ${l.color} not allowed`);
          }
        }
      }
      pending.push({ file, name, ev });
    }
    process.stdout.write(`${name} ${ev ? ev.violations.length : 'error'} ${problems.join('; ')}\n`);
    if (problems.length > 0) {
      bad += 1;
    }
  }
  if (bad > 0) {
    fail(`check: ${bad} of ${targets.length} spec(s) failed`);
  }
  for (const { file, name, ev } of pending) {
    await writeJson(
      join(dirname(file), `${name}.segments.json`),
      renderSegments(ev.model, ev.fills),
    );
  }
}

async function showCommand(file, prefix) {
  const raw = await readJson(file);
  const { ev, error } = tryEvaluate(raw);
  if (!ev) {
    process.stdout.write(`${JSON.stringify({ violations: [], error }, null, 2)}\n`);
    return;
  }
  const svgs = {
    final: renderFinalSvg(ev.model, ev.fills),
    guides: renderGuidesSvg(ev.model, ev.fills),
    sheet: renderSheetSvg({
      spec: ev.spec,
      model: ev.model,
      fills: ev.fills,
      violations: ev.violations,
      exceptionsApplied: ev.exceptionsApplied,
    }),
    sizes: 'pixels',
  };
  await writeFile(`${prefix}-sheet.png`, renderPreviewPng('sheet', svgs).png);
  await writeFile(`${prefix}-sizes.png`, renderPreviewPng('sizes', svgs).png);
  const violations = ev.violations.map((v) => ({
    rule: v.rule,
    target: v.target,
    message: v.message,
  }));
  process.stdout.write(`${JSON.stringify({ violations }, null, 2)}\n`);
}

async function compareCommand(file, out, paths) {
  const input = await readJson(file);
  const targets = await specTargets('compare', paths);
  const width = MARGIN * 2 + CELL * 2 + GAP;
  const height = MARGIN * 2 + ROW * targets.length;
  const rgb = new Uint8Array(width * height * 3).fill(255);
  const blit = (image, x0, y0) => {
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const from = (y * image.width + x) * 4;
        const to = ((y0 + y) * width + x0 + x) * 3;
        rgb.set(image.data.subarray(from, from + 3), to);
      }
    }
  };
  for (const [row, { name, file: specFile }] of targets.entries()) {
    const segments = input[name];
    if (!segments) {
      fail(`compare: "${name}" is not in ${file}`);
    }
    const { ev, error } = tryEvaluate(await readJson(specFile));
    if (!ev) {
      fail(`compare: "${name}": ${error}`);
    }
    const original = segmentsToSvg(segments);
    const redrawn = renderFinalSvg(ev.model, ev.fills);
    const y = MARGIN + row * ROW;
    blit(rasterRgba(original, CELL), MARGIN, y);
    blit(rasterRgba(redrawn, CELL), MARGIN + CELL + GAP, y);
    const share = diffShare(rasterRgba(redrawn, SIDE), rasterRgba(original, SIDE), TOLERANCE);
    process.stdout.write(`${row + 1} ${name} ${share}\n`);
  }
  await writeFile(out, encodeRgbPng(width, height, rgb));
}

const [command, ...rest] = process.argv.slice(2);
const need = (n) => {
  if (rest.length < n) {
    fail(USAGE);
  }
};
try {
  switch (command) {
    case 'import':
      need(2);
      await importCommand(rest[0], rest[1]);
      break;
    case 'check':
      need(1);
      await checkCommand(rest);
      break;
    case 'show':
      need(2);
      await showCommand(rest[0], rest[1]);
      break;
    case 'compare':
      need(3);
      await compareCommand(rest[0], rest[1], rest.slice(2));
      break;
    default:
      fail(USAGE);
  }
} catch (error) {
  fail(`icon-set ${command}: ${error.message}`);
}
