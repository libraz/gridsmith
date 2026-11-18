# gridsmith

[![CI](https://img.shields.io/github/actions/workflow/status/libraz/gridsmith/ci.yml?branch=main&label=CI)](https://github.com/libraz/gridsmith/actions)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/libraz/gridsmith/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

**gridsmith generates geometric SVG logos, 24 px UI icons and magic-circle figures from a JSON construction spec, as an MCP server for AI assistants and as a TypeScript library.** The spec declares circles on a grid, tangent circles, lines, arcs and regular polygons; gridsmith solves the geometry, lints it against construction rules (few radius ratios, a coarse grid, n-fold symmetry) and renders SVG and PNG with a construction sheet. A model that writes the spec gets exact tangents and intersections instead of guessed coordinates.

📖 **[Documentation](https://github.com/libraz/gridsmith/blob/main/docs/en/getting-started.md)** &nbsp;·&nbsp; **[Gallery](https://github.com/libraz/gridsmith/blob/main/docs/en/gallery.md)** &nbsp;·&nbsp; **[Library API](https://github.com/libraz/gridsmith/blob/main/docs/en/api-reference.md)**

> Pre-1.0: the spec grammar and the rule thresholds may still change.

<p>
<img src="https://raw.githubusercontent.com/libraz/gridsmith/main/docs/gallery/whale-sheet.png" alt="Construction sheet of a whale logo mark built from tangent circles" width="260">
<img src="https://raw.githubusercontent.com/libraz/gridsmith/main/docs/gallery/sigil-medallions-sheet.png" alt="Construction sheet of a magic-circle figure with medallions on a ring" width="260">
<img src="https://raw.githubusercontent.com/libraz/gridsmith/main/docs/gallery/line-chart-sheet.png" alt="Construction sheet of a line-chart UI icon on its 24-unit grid" width="260">
</p>

## What's inside

- **Logo marks** — filled regions from unions, intersections and differences of discs, polygons and half-planes, previewed at 64, 32 and 16 px. [Spec format](https://github.com/libraz/gridsmith/blob/main/docs/en/spec.md)
- **Magic-circle figures** — stroked rings, stars, arcs and repeated medallions, with erase layers that cut bands. [Gallery](https://github.com/libraz/gridsmith/blob/main/docs/en/gallery.md)
- **UI icons** — 24-unit icons mixing fills and strokes, exported as SVG, PNG and per-layer path segments. [Icons](https://github.com/libraz/gridsmith/blob/main/docs/en/icons.md)
- **SVG icon import** — converts the paths of an existing icon into a spec rounded to the grid, with the pixel difference from the original. [Icons](https://github.com/libraz/gridsmith/blob/main/docs/en/icons.md)
- **Construction rules** — a lint pass reports off-grid values, too many ratios, angles off the allowed divisions and thin strokes; a spec exports only once it is clean. [Rules](https://github.com/libraz/gridsmith/blob/main/docs/en/spec.md#rules)
- **Reference matching** — overlays a PNG or JPEG on the drawing and scores the overlap, so a silhouette can be traced. [Outlines and underlay](https://github.com/libraz/gridsmith/blob/main/docs/en/spec.md#outlines-and-underlay)
- **Four MCP tools** — `gridsmith_guide`, `gridsmith_render`, `gridsmith_export`, `gridsmith_import` over stdio. [MCP tools](https://github.com/libraz/gridsmith/blob/main/docs/en/mcp-tools.md)

## Installation

Requires Node.js 24 or later. Register the MCP server with Claude Code and/or Codex CLI:

```sh
npx -y github:libraz/gridsmith init
```

`init` asks which configs to update and writes only the `gridsmith` entry; `uninstall` removes it. In Claude Code it also installs as a plugin:

```text
/plugin install gridsmith --marketplace libraz/gridsmith
```

Manual setup for other clients is in [Getting started](https://github.com/libraz/gridsmith/blob/main/docs/en/getting-started.md).

As a library:

```sh
npm install github:libraz/gridsmith
```

## Quick start

### MCP

Ask the assistant for a mark, a figure or an icon. It reads `gridsmith_guide`, writes the spec to a JSON file, iterates with `gridsmith_render` until the report shows no violations, then writes the files with `gridsmith_export`.

### TypeScript

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
  paint: [{ fill: { subtract: ['body', 'bite'] } }],
});

console.log(drawing.violations); // [] when every rule passes
const out = await mkdtemp(join(tmpdir(), 'gridsmith-'));
await writeFile(join(out, 'crescent.svg'), drawing.svg);
await writeFile(join(out, 'crescent-64.png'), drawing.png(64));
```

→ [Library API](https://github.com/libraz/gridsmith/blob/main/docs/en/api-reference.md)

## Build from source

```sh
yarn install && yarn build   # compiles src/ to dist/
yarn test                    # Vitest, including the examples in README.md and docs/en/
yarn check                   # Biome and tsc --noEmit
yarn gallery                 # rebuilds docs/gallery/ from src/guide/examples.ts
```

The files in `docs/gallery/` are generated; do not edit them by hand.

## Documentation

The docs are Markdown under `docs/en/` and `docs/ja/`.

- **Learn** — [Getting started](https://github.com/libraz/gridsmith/blob/main/docs/en/getting-started.md) · [Gallery](https://github.com/libraz/gridsmith/blob/main/docs/en/gallery.md)
- **Guides** — [Spec format](https://github.com/libraz/gridsmith/blob/main/docs/en/spec.md) · [Icons](https://github.com/libraz/gridsmith/blob/main/docs/en/icons.md)
- **Reference** — [MCP tools](https://github.com/libraz/gridsmith/blob/main/docs/en/mcp-tools.md) · [Library API](https://github.com/libraz/gridsmith/blob/main/docs/en/api-reference.md)

## Non-goals

gridsmith draws geometry only. It does not render text: finished drawings contain no glyphs. It does not trace bitmaps automatically; an underlay is scored against a drawing the spec describes.

## License

[Apache-2.0](LICENSE)
