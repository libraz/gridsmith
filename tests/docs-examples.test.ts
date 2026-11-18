import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = new URL('..', import.meta.url).pathname;
const ENTRY = join(ROOT, 'src/index.ts');

/** Blocks not run, by page and a substring of the block; each entry says why. */
const PENDING: { page: string; contains: string; reason: string }[] = [
  {
    page: 'docs/en/api-reference.md',
    contains: 'new StdioServerTransport()',
    reason: 'serves MCP on the test process stdio',
  },
];

const TS_BLOCK = /^```ts\n([\s\S]*?)^```$/gm;

async function pages(): Promise<string[]> {
  const docs = (await readdir(join(ROOT, 'docs/en'))).filter((f) => f.endsWith('.md'));
  return ['README.md', ...docs.map((f) => `docs/en/${f}`)];
}

type Block = { page: string; index: number; code: string };

async function blocks(): Promise<Block[]> {
  const found: Block[] = [];
  for (const page of await pages()) {
    const text = await readFile(join(ROOT, page), 'utf8');
    [...text.matchAll(TS_BLOCK)].forEach((m, index) => {
      found.push({ page, index, code: m[1] ?? '' });
    });
  }
  return found;
}

const all = await blocks();
const pending = (b: Block) => PENDING.some((p) => p.page === b.page && b.code.includes(p.contains));

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gridsmith-docs-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('docs examples', () => {
  it('finds examples and every pending entry still matches one', () => {
    expect(all.length).toBeGreaterThan(0);
    for (const p of PENDING) {
      expect(all.some((b) => b.page === p.page && b.code.includes(p.contains))).toBe(true);
    }
  });

  it.each(all.filter((b) => !pending(b)).map((b) => [`${b.page} #${b.index + 1}`, b] as const))(
    '%s runs',
    async (_, block) => {
      const code = block.code.replaceAll("from '@libraz/gridsmith'", `from '${ENTRY}'`);
      const file = join(dir, `${block.page.replaceAll('/', '_')}-${block.index}.ts`);
      await writeFile(file, `${code}\nexport {};\n`);
      await import(file);
    },
  );
});
