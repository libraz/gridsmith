import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { FillResult } from '../geom/arrangement.js';
import { ArrangementInvariantError, arrange } from '../geom/arrangement.js';
import type { ResolvedModel, ResolveError } from '../resolve/resolve.js';
import { resolveSpec } from '../resolve/resolve.js';
import type { AppliedException, Hint, Violation } from '../rules/lint.js';
import { lint } from '../rules/lint.js';
import type { Spec } from '../spec/schema.js';
import { specSchema } from '../spec/schema.js';

/** Prefix of every error line: an MCP tool name, or `gridsmith` for the library functions. */
export type ToolName =
  | 'gridsmith_guide'
  | 'gridsmith_render'
  | 'gridsmith_export'
  | 'gridsmith_import'
  | 'gridsmith';

export const RESPONSE_MAX_CHARS = 20000;
export const ERROR_MAX_CHARS = 10000;
export const SPEC_FILE_MAX_BYTES = 256 * 1024;
const MAX_INPUT_ERRORS = 10;

/**
 * A failure caused by the caller's input. The MCP tools return it as an `isError` result; the
 * library functions throw it. Every line starts with the tool name, or `gridsmith`.
 */
export class GridsmithError extends Error {
  readonly lines: readonly string[];

  constructor(lines: readonly string[]) {
    super(lines[0] ?? 'tool failure');
    this.name = 'GridsmithError';
    this.lines = lines;
  }
}

type Json = Record<string, unknown>;
type Path = readonly PropertyKey[];

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Shortened JSON rendering of a received value for messages. */
export function show(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  text ??= String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** Error message builder for zod schemas: `<what> is invalid (received: ...; allowed: ...)`. */
export const complain = (what: string, allowed: string) => (iss: { input?: unknown }) =>
  `${what} is invalid (received: ${show(iss.input)}; allowed: ${allowed})`;

/** Rounds to 4 decimals and folds -0 into 0. */
export const round4 = (x: number): number => Math.round(x * 1e4) / 1e4 + 0;

export function formatPath(path: Path): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') {
      out += `[${seg}]`;
    } else {
      const key = String(seg);
      out += out === '' ? key : `.${key}`;
    }
  }
  return out;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

const commonPrefix = (a: string, b: string): number => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) {
    n++;
  }
  return n;
};

/** The known key closest to `key` by edit distance; ties go to the longer shared prefix. */
export function nearestKey(key: string, known: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore: [number, number] = [Number.POSITIVE_INFINITY, 0];
  for (const candidate of known) {
    const score: [number, number] = [editDistance(key, candidate), -commonPrefix(key, candidate)];
    if (score[0] < bestScore[0] || (score[0] === bestScore[0] && score[1] < bestScore[1])) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

let specJson: Json | undefined;

/** JSON Schema of the spec's input form, with `$ref`s into `$defs`. */
export function specJsonSchema(): Json {
  specJson ??= z.toJSONSchema(specSchema, { io: 'input' }) as Json;
  return specJson;
}

const flatten = (root: Json, node: unknown): Json[] => {
  if (!isRecord(node)) {
    return [];
  }
  const ref = node.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
    const defs = root.$defs;
    return isRecord(defs) ? flatten(root, defs[ref.slice('#/$defs/'.length)]) : [];
  }
  const alternatives = node.anyOf ?? node.oneOf;
  return Array.isArray(alternatives) ? alternatives.flatMap((a) => flatten(root, a)) : [node];
};

const branchScore = (branch: Json, data: Json): number => {
  const props = branch.properties;
  if (!isRecord(props)) {
    return -1;
  }
  let score = 0;
  for (const [key, value] of Object.entries(data)) {
    const prop = props[key];
    if (prop !== undefined) {
      score += isRecord(prop) && prop.const === value ? 101 : 1;
    }
  }
  return score;
};

// The schema branch that describes `data`: by array-ness, then by matching keys and `const`s.
const pickBranch = (root: Json, node: unknown, data: unknown): Json | undefined => {
  const branches = flatten(root, node);
  if (Array.isArray(data)) {
    return branches.find((b) => b.type === 'array');
  }
  if (!isRecord(data)) {
    return branches[0];
  }
  let best: Json | undefined;
  let bestScore = -1;
  for (const branch of branches) {
    const score = branchScore(branch, data);
    if (score > bestScore) {
      best = branch;
      bestScore = score;
    }
  }
  return best;
};

/** Keys the spec schema accepts on the object found at `path` inside `spec`. */
export function specKeysAt(spec: unknown, path: Path): string[] {
  const root = specJsonSchema();
  let node: unknown = root;
  let data: unknown = spec;
  for (const seg of path) {
    const branch = pickBranch(root, node, data);
    if (branch === undefined) {
      return [];
    }
    if (typeof seg === 'number') {
      node = Array.isArray(branch.prefixItems) ? branch.prefixItems[seg] : branch.items;
      data = Array.isArray(data) ? data[seg] : undefined;
    } else {
      const props = branch.properties;
      node = isRecord(props) ? props[String(seg)] : undefined;
      data = isRecord(data) ? data[String(seg)] : undefined;
    }
  }
  const props = pickBranch(root, node, data)?.properties;
  return isRecord(props) ? Object.keys(props) : [];
}

type FlatIssue = { path: Path; issue: z.core.$ZodIssue };

// A failed union reports the branch that got furthest into the input, at its full path.
function flattenIssues(issues: readonly z.core.$ZodIssue[], parent: Path): FlatIssue[] {
  return issues.flatMap((issue) => {
    const path = [...parent, ...issue.path];
    if (issue.code === 'invalid_union') {
      let best: readonly z.core.$ZodIssue[] | undefined;
      let bestDepth = 0;
      for (const branch of issue.errors) {
        const depth = Math.max(0, ...branch.map((i) => i.path.length));
        if (
          depth > bestDepth ||
          (depth === bestDepth && depth > 0 && branch.length < (best?.length ?? 0))
        ) {
          best = branch;
          bestDepth = depth;
        }
      }
      if (best !== undefined) {
        return flattenIssues(best, path);
      }
    }
    return [{ path, issue }];
  });
}

/** One line per zod issue; unknown keys get the allowed keys and a nearest-key suggestion. */
function issueLines(
  tool: ToolName,
  prefix: Path,
  issues: readonly z.core.$ZodIssue[],
  knownKeys: (path: Path) => string[],
): string[] {
  const lines: string[] = [];
  for (const { path, issue } of flattenIssues(issues, [])) {
    if (issue.code === 'unrecognized_keys') {
      const known = knownKeys(path);
      for (const key of issue.keys) {
        const near = nearestKey(key, known);
        const hint = near === undefined ? '' : ` Did you mean "${near}"?`;
        lines.push(
          `${tool}: ${formatPath([...prefix, ...path, key])}: unknown key (received: ${show(key)}; allowed: ${known.join(', ')}).${hint}`,
        );
      }
    } else {
      const text = formatPath([...prefix, ...path]);
      lines.push(`${tool}: ${text === '' ? 'arguments' : text}: ${issue.message}`);
    }
  }
  return lines;
}

const capInputLines = (lines: string[]): string[] =>
  lines.length > MAX_INPUT_ERRORS
    ? [...lines.slice(0, MAX_INPUT_ERRORS), `… and ${lines.length - MAX_INPUT_ERRORS} more`]
    : lines;

/** Keys of the strict object found at `path` inside `schema`, looking through optional wrappers. */
function schemaKeysAt(schema: z.ZodObject, path: Path): string[] {
  let node: unknown = schema;
  for (const seg of [...path, undefined]) {
    while (node instanceof z.ZodOptional) {
      node = node.unwrap();
    }
    if (!(node instanceof z.ZodObject)) {
      return [];
    }
    if (seg === undefined) {
      return Object.keys(node.shape);
    }
    node = (node.shape as Record<string, unknown>)[String(seg)];
  }
  return [];
}

/** Validates a tool's raw arguments against its strict schema, rejecting unknown keys. */
export function parseArgs<S extends z.ZodObject>(
  tool: ToolName,
  raw: unknown,
  schema: S,
): z.output<S> {
  const input = raw === undefined ? {} : raw;
  if (!isRecord(input)) {
    throw new GridsmithError([
      `${tool}: arguments: arguments are invalid (received: ${show(input)}; allowed: an object)`,
    ]);
  }
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  throw new GridsmithError(
    capInputLines(issueLines(tool, [], result.error.issues, (path) => schemaKeysAt(schema, path))),
  );
}

/** The `spec` argument: an object, or the absolute path of a JSON file holding one. */
export const specArgSchema = z.union([z.record(z.string(), z.unknown()), z.string()], {
  error: complain('spec', 'a spec object, or the absolute path of a JSON file holding a spec'),
});

export type LoadedSpec = { raw: unknown; path?: string };

const failSpec = (tool: ToolName, what: string, allowed: string): GridsmithError =>
  new GridsmithError([`${tool}: spec: ${what} (allowed: ${allowed})`]);

/** Returns the spec object, reading it from disk when `spec` is a path. */
export async function loadSpec(tool: ToolName, spec: Json | string): Promise<LoadedSpec> {
  if (typeof spec !== 'string') {
    return { raw: spec };
  }
  if (spec.trimStart().startsWith('{')) {
    throw failSpec(
      tool,
      'spec is a string of JSON text',
      'the spec as an object, or the absolute path of a .json file',
    );
  }
  if (!isAbsolute(spec)) {
    throw failSpec(
      tool,
      `spec path must be absolute (received: ${show(spec)})`,
      'an absolute path such as /tmp/work/spec.json',
    );
  }
  let size: number;
  try {
    const info = await stat(spec);
    if (!info.isFile()) {
      throw failSpec(tool, `spec path is not a file (received: ${show(spec)})`, 'a JSON file');
    }
    size = info.size;
  } catch (error) {
    if (error instanceof GridsmithError) {
      throw error;
    }
    throw failSpec(
      tool,
      `spec file cannot be read (received: ${show(spec)}, ${errorCode(error)})`,
      'an existing readable JSON file',
    );
  }
  if (size > SPEC_FILE_MAX_BYTES) {
    throw failSpec(
      tool,
      `spec file is too large (received: ${size} bytes)`,
      `at most ${SPEC_FILE_MAX_BYTES} bytes`,
    );
  }
  let text: string;
  try {
    text = await readFile(spec, 'utf8');
  } catch (error) {
    throw failSpec(
      tool,
      `spec file cannot be read (received: ${show(spec)}, ${errorCode(error)})`,
      'an existing readable JSON file',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw failSpec(tool, `spec file is not valid JSON (received: ${show(spec)})`, 'a JSON file');
  }
  if (!isRecord(raw)) {
    throw failSpec(
      tool,
      `spec file does not hold a JSON object (received: ${show(spec)})`,
      'a JSON object',
    );
  }
  return { raw, path: spec };
}

export const errorCode = (error: unknown): string =>
  isRecord(error) && typeof error.code === 'string' ? error.code : 'unknown error';

function parseSpec(tool: ToolName, raw: unknown): Spec {
  const result = specSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  throw new GridsmithError(
    capInputLines(issueLines(tool, ['spec'], result.error.issues, (path) => specKeysAt(raw, path))),
  );
}

function resolveLine(tool: ToolName, spec: Spec, error: ResolveError): string {
  const index = spec.shapes.findIndex((s) => s.id === error.id);
  const where = index >= 0 ? `spec.shapes[${index}] (id "${error.id}")` : `spec.${error.id}`;
  return `${tool}: ${where}: ${error.message}`;
}

export type Evaluation = {
  spec: Spec;
  model: ResolvedModel;
  fills: FillResult[];
  violations: Violation[];
  exceptionsApplied: AppliedException[];
  hints: Hint[];
  exportable: boolean;
};

/**
 * Parses, resolves, arranges and lints a raw spec. `check` runs on the parsed spec before any geometry.
 *
 * @throws GridsmithError for invalid input, unresolvable elements and internal invariant failures.
 */
export function evaluate(tool: ToolName, raw: unknown, check?: (spec: Spec) => void): Evaluation {
  const spec = parseSpec(tool, raw);
  check?.(spec);
  const resolved = resolveSpec(spec);
  if (!resolved.ok) {
    throw new GridsmithError(resolved.errors.map((e) => resolveLine(tool, spec, e)));
  }
  const { model } = resolved;
  let fills: FillResult[];
  try {
    fills = model.fills.map((layer) => arrange(layer.region));
  } catch (error) {
    if (error instanceof ArrangementInvariantError) {
      const hash = createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0, 12);
      throw new GridsmithError([
        `${tool}: internal error: a fill's boundary did not close into loops (spec sha256: ${hash}). This is a bug; keep the spec so it can be reproduced.`,
      ]);
    }
    throw error;
  }
  const { violations, exceptionsApplied, hints } = lint(spec, model, fills);
  return {
    spec,
    model,
    fills,
    violations,
    exceptionsApplied,
    hints,
    exportable: violations.length === 0,
  };
}

/** Runs a rasterizing step, turning a failure of the native renderer into a tool failure. */
export function rasterize<T>(tool: ToolName, what: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    const reason = error instanceof Error ? firstLine(error.message) : 'unknown error';
    throw new GridsmithError([
      `${tool}: could not rasterize ${what} (${reason}). @resvg/resvg-js may lack a native binary for this platform; run yarn install again on a supported platform.`,
    ]);
  }
}

const firstLine = (text: string): string => (text.split('\n')[0] ?? '').slice(0, 200);

function fitLines(lines: readonly string[]): string {
  const whole = lines.join('\n');
  if (whole.length <= ERROR_MAX_CHARS) {
    return whole;
  }
  const budget = ERROR_MAX_CHARS - 24;
  let text = '';
  let used = 0;
  for (const line of lines) {
    const next = used === 0 ? line : `${text}\n${line}`;
    if (next.length > budget) {
      break;
    }
    text = next;
    used++;
  }
  if (used === 0) {
    text = (lines[0] ?? '').slice(0, budget);
    used = 1;
  }
  return `${text}\n… and ${lines.length - used} more`;
}

export function errorResult(lines: readonly string[]): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: fitLines(lines) }] };
}

export const jsonText = (value: unknown): { type: 'text'; text: string } => ({
  type: 'text',
  text: JSON.stringify(value),
});

export const pngImage = (png: Uint8Array): { type: 'image'; data: string; mimeType: string } => ({
  type: 'image',
  data: Buffer.from(png).toString('base64'),
  mimeType: 'image/png',
});

/** Runs a tool body; failures become `isError` results and unexpected exceptions are logged to stderr. */
export async function guarded(
  tool: ToolName,
  body: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof GridsmithError) {
      return errorResult(error.lines);
    }
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    const kind = error instanceof Error ? error.name : typeof error;
    const detail = error instanceof Error ? firstLine(error.message) : String(error).slice(0, 200);
    return errorResult([
      `${tool}: internal error (${kind}: ${detail}). The server's stderr has the details.`,
    ]);
  }
}
