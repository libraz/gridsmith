import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const galleryDir = join(root, 'docs', 'gallery');
const check = process.argv.includes('--check');
const TOOL = 'gridsmith_render';

function fail(lines) {
  for (const line of lines) {
    console.error(line);
  }
  process.exit(1);
}

if (!existsSync(join(distDir, 'tools', 'shared.js'))) {
  fail(['gallery: dist/ is missing or incomplete; run `yarn build` first.']);
}

const { EXAMPLES } = await import('../dist/guide/examples.js');
const { renderPreviewPng } = await import('../dist/render/png.js');
const { renderGuidesSvg, renderSheetSvg } = await import('../dist/render/sheet.js');
const { renderFinalSvg } = await import('../dist/render/svg.js');
const { evaluate, GridsmithError } = await import('../dist/tools/shared.js');

const isIcon = (example) => example.spec.mode === 'icon';

const specJson = (example) => `${JSON.stringify(example.spec, null, 2)}\n`;

/** Expected file name -> content for one example. */
function render(example) {
  let ev;
  try {
    ev = evaluate(TOOL, example.spec);
  } catch (error) {
    if (error instanceof GridsmithError) {
      throw new Error(error.lines.join('\n'));
    }
    throw error;
  }
  if (ev.violations.length > 0) {
    const listed = ev.violations.map((v) => `  ${v.rule} on ${v.target}: ${v.message}`);
    throw new Error(`${ev.violations.length} rule violation(s)\n${listed.join('\n')}`);
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
  };
  const png = (view, extra = {}) => renderPreviewPng(view, { ...svgs, ...extra }).png;
  const { name } = example;
  const files = new Map([
    [`${name}.png`, png('final')],
    [`${name}-sheet.png`, png('sheet')],
    [`${name}-guides.png`, png('guides')],
    [`${name}.svg`, svgs.final],
    [`${name}.json`, specJson(example)],
  ]);
  if (isIcon(example)) {
    files.set(`${name}-sizes.png`, png('sizes', { sizes: 'pixels' }));
  }
  return files;
}

async function listGallery() {
  try {
    return await readdir(galleryDir);
  } catch {
    return [];
  }
}

const expectedNames = new Set(
  EXAMPLES.flatMap((e) => [
    `${e.name}.png`,
    `${e.name}-sheet.png`,
    `${e.name}-guides.png`,
    `${e.name}.svg`,
    `${e.name}.json`,
    ...(isIcon(e) ? [`${e.name}-sizes.png`] : []),
  ]),
);

if (check) {
  const present = new Set(await listGallery());
  const problems = [];
  for (const name of expectedNames) {
    if (!present.has(name)) {
      problems.push(`missing: docs/gallery/${name}`);
    }
  }
  for (const name of present) {
    if (!expectedNames.has(name)) {
      problems.push(`stray: docs/gallery/${name}`);
    }
  }
  for (const example of EXAMPLES) {
    const json = `${example.name}.json`;
    if (
      present.has(json) &&
      (await readFile(join(galleryDir, json), 'utf8')) !== specJson(example)
    ) {
      problems.push(`stale: docs/gallery/${json} differs from the example spec`);
    }
    const svg = `${example.name}.svg`;
    if (present.has(svg)) {
      try {
        const expected = render(example).get(svg);
        if ((await readFile(join(galleryDir, svg), 'utf8')) !== expected) {
          problems.push(`stale: docs/gallery/${svg} differs from the rendered example`);
        }
      } catch (error) {
        problems.push(`example "${example.name}": ${error.message}`);
      }
    }
  }
  if (problems.length > 0) {
    fail([...problems, 'gallery: out of date; run `yarn gallery`.']);
  }
  process.stdout.write(`gallery: ${EXAMPLES.length} examples up to date\n`);
} else {
  const errors = [];
  const outputs = new Map();
  for (const example of EXAMPLES) {
    try {
      outputs.set(example.name, render(example));
    } catch (error) {
      errors.push(`gallery: example "${example.name}": ${error.message}`);
    }
  }
  if (errors.length > 0) {
    fail(errors);
  }
  await mkdir(galleryDir, { recursive: true });
  for (const name of await listGallery()) {
    if (!expectedNames.has(name)) {
      await rm(join(galleryDir, name), { recursive: true, force: true });
    }
  }
  for (const [name, files] of outputs) {
    for (const [file, data] of files) {
      await writeFile(join(galleryDir, file), data);
    }
    process.stdout.write(`${name}: ${files.size} files\n`);
  }
}
