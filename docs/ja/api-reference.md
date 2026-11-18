# ライブラリ API

`@libraz/gridsmith` は Node.js 24 以上向けの ESM パッケージです。エントリーポイントから、4 つの MCP ツールの中身にあたる関数、MCP サーバー本体、例の仕様、規則表を export しています。関数はツールと同じ処理（解析、解決、検査、描画）を通ります。仕様の書き方もツールと同じで、[仕様の書式](spec.md) にあります。

## `render(spec)`

仕様を解いて検査し、描画します。規則違反は結果に含めて返し、例外にはしません。

| フィールド | 内容 |
|---|---|
| `spec` | 解析済みの仕様（既定値を補ったもの） |
| `violations` | 例外で許されていない規則違反ごとの `{ rule, target, message }` |
| `exceptionsApplied` | 適用された例外ごとの `{ rule, target, reason }` |
| `hints` | 接しそうで接していない組、`{ kind, a, b, gap }` |
| `exportable` | `violations` が空なら `true` |
| `svg` | 完成図 |
| `sheetSvg` | 構築シート |
| `guidesSvg` | 完成図に構築要素をすべて重ねたもの（背景は透明） |
| `segments` | アイコンのパスデータ（[アイコン](icons.md)を参照）。mark と figure では `null` |
| `png(size)` | 完成図を幅 `size` px（1〜4096）の透過 PNG にしたもの |

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

`gridsmith_export` と同じファイルを書き出します。`<name>.svg`、`<name>-sheet.svg`、`<name>-guides.svg`、`<name>.spec.json`、モードごとのサイズの PNG、アイコンならさらに `<name>.segments.json` です。戻り値はファイルごとの `{ path, bytes }` です。

- `dir`: 出力先ディレクトリ。なければ作成します。相対パスは作業ディレクトリを基準に解決します。
- `name`: ファイルの基本名。`^[a-z0-9][a-z0-9_-]{0,63}$` に一致する文字列です。
- `overwrite`: 既存のファイルを置き換えます。指定しないと、出力先に 1 つでも同名のファイルがあれば拒否します。

違反が残る仕様は拒否します。すべてのファイルを書けるときだけ書き出します。

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

SVG のパスセグメント（y が下向き）で与えた 24 単位のアイコンを、`gridsmith_import` と同じようにアイコンの仕様に変換します。`options.snap`（既定は `true`）は仕様をグリッドの刻みに丸めます。`options.step`（0.5、0.25、0.1）で刻みを固定でき、指定しなければ元の絵に最も近い刻みを選びます。レポートには `spec`、`status`（`clean`、`violations`、`partial`、`failed`）、`violations`、`diff`、`faithful` が入ります。変換の規則は [アイコン](icons.md) にあります。

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

`gridsmith_guide` のトピックの文書を返します。トピックは `overview`（既定）、`spec`（仕様の JSON Schema）、`rules`、`examples`、`icon` です。独自のプロンプトにリファレンスを入れるときに使えます。

## `createServer()`

4 つのツールを登録した MCP サーバーを作ります。`gridsmith` コマンドが使う stdio 以外のトランスポートで動かすときに使います。

```ts
import { createServer } from '@libraz/gridsmith';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

await createServer().connect(new StdioServerTransport());
```

## エラー

不正な入力は `GridsmithError` を投げます。`lines` には問題ごとに 1 行ずつメッセージが入り、各行は `gridsmith:` と問題の値のパスで始まります（例: `gridsmith: spec.shapes[1].r: ...`）。解析は通るが規則に反する仕様は、`render` ではエラーになりません。`exportSpec` は違反を並べた `GridsmithError` で拒否します。ファイルシステムやネイティブのラスタライザーの失敗も `GridsmithError` で報告します。

## 定数と型

- `EXAMPLES`: [ギャラリー](gallery.md) の例の仕様。各要素は `{ name, description, spec }`
- `RULES`、`RULE_IDS`: 規則表とその id（[仕様の書式](spec.md#規則)を参照）
- `GUIDE_TOPICS`、`ICON_GRID_STEPS`、`VERSION`
- 型: `SpecInput`（書く側の仕様）、`Spec`（解析後）、`Drawing`、`Violation`、`AppliedException`、`Hint`、`SegmentSet`、`Segment`、`ImportSegment`、`ImportReport`、`ExportedFile`、`RuleId`、`GuideTopic`
