import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline/promises';

/** Server name under which the entry is written. */
const SERVER = 'gridsmith';

/** Package specifier written into the entry: the package installs straight from GitHub. */
export const PACKAGE_SPEC = 'github:libraz/gridsmith';

/** The `mcpServers.gridsmith` entry Claude Code reads. */
type McpServerEntry = { command: string; args: string[] };

const ENTRY: McpServerEntry = { command: 'npx', args: ['-y', PACKAGE_SPEC] };

/** Subset of a Claude Code JSON config this module touches; other keys are kept verbatim. */
type ClaudeConfig = { mcpServers?: Record<string, unknown>; [key: string]: unknown };

const fileMode = async (path: string): Promise<number | undefined> => {
  const stats = await stat(path).catch(() => null);
  return stats ? stats.mode & 0o777 : undefined;
};

/**
 * Writes through a sibling temp file and a rename, so a client reading the config (Claude Code
 * keeps `~/.claude.json` open) never sees a partial file. The existing mode is kept.
 */
const writeFileAtomic = async (path: string, data: string): Promise<void> => {
  const mode = await fileMode(path);
  const tmp = `${path}.${SERVER}.tmp`;
  try {
    await writeFile(tmp, data, mode !== undefined ? { mode } : {});
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
};

const readClaudeConfig = async (path: string, command: string): Promise<ClaudeConfig> => {
  if (!existsSync(path)) {
    return {};
  }
  const raw = await readFile(path, 'utf8');
  if (raw.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw) as ClaudeConfig;
  } catch {
    throw new Error(
      `Failed to parse existing JSON at ${path}. Fix or move it before re-running ${command}.`,
    );
  }
};

/** Merges the gridsmith entry into a Claude Code JSON config, creating the file when missing. */
export const writeClaudeConfig = async (path: string): Promise<void> => {
  const data = await readClaudeConfig(path, 'init');
  data.mcpServers = { ...data.mcpServers, [SERVER]: ENTRY };
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
};

/**
 * Matches `[mcp_servers.gridsmith]` and its sub-tables such as `[mcp_servers.gridsmith.env]`;
 * a sub-table left behind would orphan its keys under the next header.
 */
const CODEX_HEADER = /^[ \t]*\[mcp_servers\.gridsmith(?:\.[^\]]+)?\][ \t]*$/;
const CODEX_HEADER_ANYWHERE = new RegExp(CODEX_HEADER.source, 'm');

/** Removes the gridsmith block and its sub-tables from a TOML document; other lines are kept. */
const stripCodexSection = (content: string): string => {
  const out: string[] = [];
  let inside = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (CODEX_HEADER.test(trimmed)) {
      inside = true;
      continue;
    }
    if (inside) {
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        inside = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
};

/** Appends or replaces the `[mcp_servers.gridsmith]` block of a Codex CLI TOML config. */
export const writeCodexConfig = async (path: string): Promise<void> => {
  const existing = existsSync(path) ? await readFile(path, 'utf8') : '';
  const stripped = stripCodexSection(existing).replace(/\n*$/, '');
  const prefix = stripped.length > 0 ? `${stripped}\n\n` : '';
  const block = [
    `[mcp_servers.${SERVER}]`,
    `command = "${ENTRY.command}"`,
    `args = [${ENTRY.args.map((a) => `"${a}"`).join(', ')}]`,
  ].join('\n');
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${prefix}${block}\n`);
};

export type RemoveOutcome = 'removed' | 'absent' | 'no-file';

/** Removes the gridsmith entry from a Claude Code JSON config; other entries are kept. */
export const removeFromClaudeConfig = async (path: string): Promise<RemoveOutcome> => {
  if (!existsSync(path)) {
    return 'no-file';
  }
  const data = await readClaudeConfig(path, 'uninstall');
  if (data.mcpServers === undefined || !(SERVER in data.mcpServers)) {
    return 'absent';
  }
  delete data.mcpServers[SERVER];
  await writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
  return 'removed';
};

/** Removes the `[mcp_servers.gridsmith]` block from a Codex CLI TOML config. */
export const removeFromCodexConfig = async (path: string): Promise<RemoveOutcome> => {
  if (!existsSync(path)) {
    return 'no-file';
  }
  const existing = await readFile(path, 'utf8');
  if (!CODEX_HEADER_ANYWHERE.test(existing)) {
    return 'absent';
  }
  const stripped = stripCodexSection(existing).replace(/\n*$/, '');
  await writeFileAtomic(path, stripped.length > 0 ? `${stripped}\n` : '');
  return 'removed';
};

/** Whether a config file already holds the gridsmith entry; false for a missing or empty file. */
export const hasEntry = async (path: string): Promise<boolean> => {
  const raw = existsSync(path) ? await readFile(path, 'utf8').catch(() => '') : '';
  if (raw.trim().length === 0) {
    return false;
  }
  try {
    const data = JSON.parse(raw) as ClaudeConfig;
    return data.mcpServers !== undefined && SERVER in data.mcpServers;
  } catch {
    return CODEX_HEADER_ANYWHERE.test(raw);
  }
};

/** `~` in place of the home directory, for display only. */
export const displayPath = (path: string): string => {
  const home = homedir();
  if (path === home) {
    return '~';
  }
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
};

/**
 * - `claude-user`: `~/.claude.json`, every Claude Code session of the user.
 * - `claude-project`: `<cwd>/.mcp.json`, Claude Code opened in that directory.
 * - `codex`: `~/.codex/config.toml`.
 */
export type TargetKind = 'claude-user' | 'claude-project' | 'codex';

type TargetOption = { key: string; kind: TargetKind; label: string; path: () => string };

const TARGETS: readonly TargetOption[] = [
  {
    key: '1',
    kind: 'claude-user',
    label: 'Claude Code',
    path: () => join(homedir(), '.claude.json'),
  },
  {
    key: '2',
    kind: 'claude-project',
    label: 'Claude Code (project)',
    path: () => join(process.cwd(), '.mcp.json'),
  },
  {
    key: '3',
    kind: 'codex',
    label: 'Codex CLI',
    path: () => join(homedir(), '.codex', 'config.toml'),
  },
];

/**
 * Parses a comma-separated selection such as `"1,3"` into distinct targets; a blank answer takes
 * `defaultRaw`.
 *
 * @throws Error on an unknown choice or an empty selection.
 */
export const parseTargetChoice = (raw: string, defaultRaw: string): TargetKind[] => {
  const input = raw.trim() === '' ? defaultRaw : raw;
  const parts = input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error('No targets selected.');
  }
  const selected = new Set<TargetKind>();
  for (const part of parts) {
    const option = TARGETS.find((o) => o.key === part);
    if (option === undefined) {
      throw new Error(`Invalid choice: ${part}`);
    }
    selected.add(option.kind);
  }
  return [...selected];
};

const menu = (): string =>
  TARGETS.map((o) => `  ${o.key}) ${o.label.padEnd(24)} ${displayPath(o.path())}`).join('\n');

const promptYesNo = async (rl: ReadlineInterface, question: string): Promise<boolean> => {
  const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
  return answer === '' || answer === 'y' || answer === 'yes';
};

const chosen = (kinds: readonly TargetKind[]): { kind: TargetKind; path: string }[] =>
  TARGETS.filter((o) => kinds.includes(o.kind)).map((o) => ({ kind: o.kind, path: o.path() }));

/** Interactive setup: writes the gridsmith entry into the chosen MCP client configs. */
export const runInit = async (): Promise<void> => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write('gridsmith setup\n\nWhere to install? (pick one or more, comma-separated)\n');
    stdout.write(`${menu()}\n`);
    const targets = chosen(parseTargetChoice(await rl.question('Choice [1,3]: '), '1,3'));

    stdout.write('\nWill update:\n');
    for (const t of targets) {
      const impact = !existsSync(t.path)
        ? '(new)'
        : (await hasEntry(t.path))
          ? `(replace ${SERVER})`
          : '(merge)';
      stdout.write(`  - ${displayPath(t.path)} ${impact}\n`);
    }
    if (!(await promptYesNo(rl, '\nProceed?'))) {
      stdout.write('Aborted.\n');
      return;
    }
    for (const t of targets) {
      await (t.kind === 'codex' ? writeCodexConfig(t.path) : writeClaudeConfig(t.path));
      stdout.write(`Wrote ${displayPath(t.path)}\n`);
    }
    stdout.write('\nDone. Restart your MCP client to pick up the new server.\n');
  } finally {
    rl.close();
  }
};

/** Interactive removal of the gridsmith entry; other servers and sections are kept. */
export const runUninstall = async (): Promise<void> => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(
      'gridsmith uninstall\n\nWhere to remove from? (pick one or more, comma-separated)\n',
    );
    stdout.write(`${menu()}\n`);
    const targets = chosen(parseTargetChoice(await rl.question('Choice [1,2,3]: '), '1,2,3'));

    stdout.write('\nWill update:\n');
    for (const t of targets) {
      const impact = !existsSync(t.path)
        ? '(no file; skip)'
        : (await hasEntry(t.path))
          ? `(remove ${SERVER})`
          : `(no ${SERVER}; skip)`;
      stdout.write(`  - ${displayPath(t.path)} ${impact}\n`);
    }
    if (!(await promptYesNo(rl, '\nProceed?'))) {
      stdout.write('Aborted.\n');
      return;
    }
    for (const t of targets) {
      const outcome = await (t.kind === 'codex'
        ? removeFromCodexConfig(t.path)
        : removeFromClaudeConfig(t.path));
      const p = displayPath(t.path);
      stdout.write(
        outcome === 'removed'
          ? `Removed ${SERVER} from ${p}\n`
          : outcome === 'absent'
            ? `No ${SERVER} in ${p}; skipped.\n`
            : `${p} does not exist; skipped.\n`,
      );
    }
    stdout.write('\nDone. Restart your MCP client for the change to take effect.\n');
  } finally {
    rl.close();
  }
};
