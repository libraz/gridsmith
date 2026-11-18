# Library API

`@libraz/gridsmith` is an ESM package for Node.js 24 or later. Its entry point exports the functions behind the four MCP tools, the MCP server itself, the example specs and the rule table. The functions run the same pipeline as the tools: parse, resolve, lint, then draw. Writing the spec is the same in both; see [Spec format](spec.md).

## `render(spec)`

Solves, lints and draws a spec. Rule violations are reported in the result and do not throw.

| Field | Content |
|---|---|
| `spec` | The parsed spec, defaults filled in |
| `violations` | `{ rule, target, message }` for each rule broken and not excepted |
| `exceptionsApplied` | `{ rule, target, reason }` for each exception that matched |
| `hints` | Near-tangent pairs, `{ kind, a, b, gap }` |
| `exportable` | `true` when `violations` is empty |
| `svg` | The finished drawing |
| `sheetSvg` | The construction sheet |
| `guidesSvg` | The drawing with every construction element over it, transparent ground |
| `segments` | An icon's path data (see [Icons](icons.md)); `null` for a mark or a figure |
| `png(size)` | The finished drawing as a transparent PNG `size` px wide, 1 to 4096 |

```ts
import { EXAMPLES, render } from '@libraz/gridsmith';

const chart = EXAMPLES.find((e) => e.name === 'line-chart');
if (chart === undefined) throw new Error('missing example');
const drawing = render(chart.spec);
for (const segment of drawing.segments?.segments ?? []) {
  console.log(segment.d);
}
```

## `exportSpec(spec, options)`

Writes the files `gridsmith_export` writes: `<name>.svg`, `<name>-sheet.svg`, `<name>-guides.svg`, `<name>.spec.json`, the PNG sizes of the mode and, for an icon, `<name>.segments.json`. It resolves to `{ path, bytes }` for each file.

- `dir`: output directory, created if missing. A relative path resolves against the working directory.
- `name`: base name of the files, matching `^[a-z0-9][a-z0-9_-]{0,63}$`.
- `overwrite`: replace existing files. Without it, the call is refused when any target exists.

It refuses a spec that still has violations. Nothing is written unless every file can be written.

```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXAMPLES, exportSpec } from '@libraz/gridsmith';

const dir = await mkdtemp(join(tmpdir(), 'gridsmith-'));
for (const example of EXAMPLES) {
  await exportSpec(example.spec, { dir, name: example.name });
}
```

## `importIcon(segments, options?)`

Converts a 24-unit icon given as SVG path segments (y down) into an icon spec, as `gridsmith_import` does. `options.snap` (default `true`) rounds the spec to a grid step; `options.step` (0.5, 0.25 or 0.1) fixes the step, and without it the step closest to the original is chosen. The report holds `spec`, `status` (`clean`, `violations`, `partial` or `failed`), `violations`, `diff` and `faithful`; the conversion rules are in [Icons](icons.md).

```ts
import { importIcon, render } from '@libraz/gridsmith';

const report = importIcon([
  { d: 'M4 4H20V20H4Z', fill: '#1f2328' },
  { d: 'M7 15L11 11L14 13L17 9', stroke: '#ffffff', strokeWidth: 1.5 },
]);
if (report.spec !== null) {
  console.log(report.status, render(report.spec).exportable);
}
```

## `guide(topic?)`

Returns the document of a `gridsmith_guide` topic: `overview` (default), `spec` (the JSON Schema of a spec), `rules`, `examples` or `icon`. Useful for putting the reference into a prompt of your own.

## `createServer()`

Builds the MCP server with its four tools registered, for hosting it on a transport other than the stdio one the `gridsmith` command uses.

```ts
import { createServer } from '@libraz/gridsmith';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

await createServer().connect(new StdioServerTransport());
```

## Errors

Invalid input throws a `GridsmithError`. Its `lines` hold one message per problem, each starting with `gridsmith:` and the path of the offending value, for example `gridsmith: spec.shapes[1].r: ...`. A spec that parses but breaks a rule is not an error for `render`; `exportSpec` refuses it with a `GridsmithError` listing the violations. Failures of the file system and of the native rasterizer are also reported as a `GridsmithError`.

## Constants and types

- `EXAMPLES`: the example specs of the [Gallery](gallery.md), each `{ name, description, spec }`
- `RULES`, `RULE_IDS`: the rule table and its ids, as in [Spec format](spec.md#rules)
- `GUIDE_TOPICS`, `ICON_GRID_STEPS`, `VERSION`
- Types: `SpecInput` (what you write), `Spec` (after parsing), `Drawing`, `Violation`, `AppliedException`, `Hint`, `SegmentSet`, `Segment`, `ImportSegment`, `ImportReport`, `ExportedFile`, `RuleId`, `GuideTopic`
