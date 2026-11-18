# はじめに

gridsmith は Node.js 24 以上で動きます。GitHub からインストールし、インストール時に自身をビルドします。npm レジストリには公開していません。

## MCP サーバーを登録する

対話式のセットアップを実行します。

```sh
npx -y github:libraz/gridsmith init
```

更新する設定ファイルを番号で選ぶと（カンマ区切り。例: `1,3`）、それぞれに `gridsmith` サーバーのエントリーを書き込みます。

- **Claude Code**（`~/.claude.json`）: そのユーザーのすべての Claude Code セッションで有効
- **Claude Code (project)**（`./.mcp.json`）: カレントディレクトリで開いた Claude Code でのみ有効
- **Codex CLI**（`~/.codex/config.toml`）

`init` を再実行しても置き換わるのは `gridsmith` のエントリーだけで、他のサーバーはそのまま残ります。削除するには `npx -y github:libraz/gridsmith uninstall` を実行します。どちらの後も MCP クライアントを再起動してください。

### 手動で設定する

Claude Code では `claude mcp add gridsmith -- npx -y github:libraz/gridsmith` を実行するか、`~/.claude.json` または `.mcp.json` に次のエントリーを書きます。

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

Codex CLI では `~/.codex/config.toml` に書きます。

```toml
[mcp_servers.gridsmith]
command = "npx"
args = ["-y", "github:libraz/gridsmith"]
```

チェックアウトから使う場合は `yarn install && yarn build` を実行し、クライアントには `node /absolute/path/to/gridsmith/dist/cli.js` を指定します。

## モデルに描かせる

1. `gridsmith_guide` を `overview` で呼び、続けて `examples` で手本になる仕様を読みます。
2. 仕様を絶対パスの JSON ファイル（例: `/tmp/work/mark.json`）に書きます。
3. `spec` にそのパスを指定して `gridsmith_render` を呼びます。レポートと画像を確認し、ファイルを直して再度描画します。
4. `violations` が空（`exportable` が true）になったら、`dir`、`name`、同じ仕様のパスを指定して `gridsmith_export` を呼びます。

ツールと引数は [MCP ツール](mcp-tools.md)、仕様の文法は [仕様の書式](spec.md) にあります。

## ライブラリとして使う

```sh
npm install github:libraz/gridsmith
```

パッケージは ESM のみで、`@libraz/gridsmith` として import します。`render` は仕様を解いて検査し、図を返します。

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

`exportSpec`、`importIcon`、`guide`、`createServer` は [ライブラリ API](api-reference.md) で説明しています。
