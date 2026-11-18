# Getting started

gridsmith runs on Node.js 24 or later. It installs from GitHub and builds itself on install; it is not on the npm registry.

## Register the MCP server

Run the interactive setup:

```sh
npx -y github:libraz/gridsmith init
```

It asks which configs to update (comma-separated, e.g. `1,3`) and writes a `gridsmith` server entry into each:

- **Claude Code** (`~/.claude.json`): every Claude Code session of the user
- **Claude Code (project)** (`./.mcp.json`): Claude Code opened in the current directory
- **Codex CLI** (`~/.codex/config.toml`)

Re-running `init` replaces only the `gridsmith` entry; other servers are kept. `npx -y github:libraz/gridsmith uninstall` removes it again. Restart the MCP client after either.

### Manual setup

For Claude Code, either run `claude mcp add gridsmith -- npx -y github:libraz/gridsmith`, or add the entry to `~/.claude.json` or `.mcp.json` by hand:

```json
{
  "mcpServers": {
    "gridsmith": {
      "command": "npx",
      "args": ["-y", "github:libraz/gridsmith"]
    }
  }
}
```

For Codex CLI, in `~/.codex/config.toml`:

```toml
[mcp_servers.gridsmith]
command = "npx"
args = ["-y", "github:libraz/gridsmith"]
```

From a checkout, `yarn install && yarn build` and point the client at `node /absolute/path/to/gridsmith/dist/cli.js` instead.

## Draw with a model

1. Call `gridsmith_guide` with `overview`, then `examples` for specs to copy from.
2. Write the spec to a JSON file with an absolute path, for example `/tmp/work/mark.json`.
3. Call `gridsmith_render` with `spec` set to that path. Read the report and the images, edit the file, and render again.
4. When `violations` is empty (`exportable` is true), call `gridsmith_export` with `dir`, `name` and the same spec path.

The tools and their arguments are in [MCP tools](mcp-tools.md); the spec grammar is in [Spec format](spec.md).

## Use it as a library

```sh
npm install github:libraz/gridsmith
```

The package is ESM only and imports as `@libraz/gridsmith`. `render` solves and lints a spec and returns the drawing:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from '@libraz/gridsmith';

const drawing = render({
  version: 1,
  mode: 'mark',
  grid: { divisions: 4 },
  shapes: [
    { id: 'body', type: 'circle', r: 'R' },
    { id: 'bite', type: 'circle', center: [1, 1], r: 3 },
  ],
  paint: [{ fill: { subtract: ['body', 'bite'] }, color: '#1f2328' }],
});

if (!drawing.exportable) {
  throw new Error(drawing.violations.map((v) => `${v.rule} on ${v.target}`).join('\n'));
}
const out = await mkdtemp(join(tmpdir(), 'gridsmith-'));
await writeFile(join(out, 'crescent.svg'), drawing.svg);
await writeFile(join(out, 'crescent-64.png'), drawing.png(64));
```

`exportSpec`, `importIcon`, `guide` and `createServer` are covered in [Library API](api-reference.md).
