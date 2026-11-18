import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hasEntry,
  PACKAGE_SPEC,
  parseTargetChoice,
  removeFromClaudeConfig,
  removeFromCodexConfig,
  writeClaudeConfig,
  writeCodexConfig,
} from '../src/install.js';

const ENTRY = { command: 'npx', args: ['-y', PACKAGE_SPEC] };
const CODEX_BLOCK = `[mcp_servers.gridsmith]\ncommand = "npx"\nargs = ["-y", "${PACKAGE_SPEC}"]\n`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gridsmith-install-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

describe('Claude Code config', () => {
  it('creates the file and its parent directory', async () => {
    const path = join(dir, 'nested', '.mcp.json');
    await writeClaudeConfig(path);
    expect(await readJson(path)).toEqual({ mcpServers: { gridsmith: ENTRY } });
    expect(await hasEntry(path)).toBe(true);
  });

  it('keeps other keys and servers, and replaces only its own entry', async () => {
    const path = join(dir, '.claude.json');
    const other = { command: 'other' };
    await writeFile(
      path,
      JSON.stringify({ theme: 'dark', mcpServers: { other, gridsmith: { command: 'old' } } }),
    );
    await writeClaudeConfig(path);
    expect(await readJson(path)).toEqual({
      theme: 'dark',
      mcpServers: { other, gridsmith: ENTRY },
    });
  });

  it('keeps the file mode', async () => {
    const path = join(dir, '.claude.json');
    await writeFile(path, '{}');
    await chmod(path, 0o600);
    await writeClaudeConfig(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('refuses a file that is not JSON and leaves it untouched', async () => {
    const path = join(dir, '.claude.json');
    await writeFile(path, '{ broken');
    await expect(writeClaudeConfig(path)).rejects.toThrow(/Failed to parse existing JSON/);
    expect(await readFile(path, 'utf8')).toBe('{ broken');
  });

  it('removes only its own entry', async () => {
    const path = join(dir, '.claude.json');
    await writeFile(path, JSON.stringify({ mcpServers: { other: {}, gridsmith: ENTRY } }));
    expect(await removeFromClaudeConfig(path)).toBe('removed');
    expect(await readJson(path)).toEqual({ mcpServers: { other: {} } });
    expect(await removeFromClaudeConfig(path)).toBe('absent');
    expect(await removeFromClaudeConfig(join(dir, 'missing.json'))).toBe('no-file');
  });
});

describe('Codex CLI config', () => {
  it('appends its block after the other sections', async () => {
    const path = join(dir, 'config.toml');
    await writeFile(path, 'model = "o4"\n\n[mcp_servers.other]\ncommand = "x"\n');
    await writeCodexConfig(path);
    expect(await readFile(path, 'utf8')).toBe(
      `model = "o4"\n\n[mcp_servers.other]\ncommand = "x"\n\n${CODEX_BLOCK}`,
    );
    expect(await hasEntry(path)).toBe(true);
  });

  it('replaces an existing block together with its sub-tables', async () => {
    const path = join(dir, 'config.toml');
    await writeFile(
      path,
      '[mcp_servers.gridsmith]\ncommand = "old"\n\n[mcp_servers.gridsmith.env]\nA = "1"\n\n[other]\nk = 1\n',
    );
    await writeCodexConfig(path);
    expect(await readFile(path, 'utf8')).toBe(`[other]\nk = 1\n\n${CODEX_BLOCK}`);
  });

  it('removes its block and keeps the rest', async () => {
    const path = join(dir, 'config.toml');
    await writeFile(path, `[other]\nk = 1\n\n${CODEX_BLOCK}`);
    expect(await removeFromCodexConfig(path)).toBe('removed');
    expect(await readFile(path, 'utf8')).toBe('[other]\nk = 1\n');
    expect(await hasEntry(path)).toBe(false);
    expect(await removeFromCodexConfig(path)).toBe('absent');
    expect(await removeFromCodexConfig(join(dir, 'missing.toml'))).toBe('no-file');
  });
});

describe('parseTargetChoice', () => {
  it('takes the default for a blank answer and drops duplicates', () => {
    expect(parseTargetChoice('  ', '1,3')).toEqual(['claude-user', 'codex']);
    expect(parseTargetChoice('2, 2,1', '1')).toEqual(['claude-project', 'claude-user']);
  });

  it('refuses an unknown choice', () => {
    expect(() => parseTargetChoice('4', '1')).toThrow('Invalid choice: 4');
    expect(() => parseTargetChoice(',', '1')).toThrow('No targets selected.');
  });
});
