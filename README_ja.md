# gridsmith

[![CI](https://img.shields.io/github/actions/workflow/status/libraz/gridsmith/ci.yml?branch=main&label=CI)](https://github.com/libraz/gridsmith/actions)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/libraz/gridsmith/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

**gridsmith は、JSON の作図仕様から幾何学的な SVG ロゴ、24 px の UI アイコン、魔法陣の図形を生成します。AI アシスタント向けの MCP サーバーとしても、TypeScript のライブラリとしても使えます。** 仕様にはグリッド上の円、接円、線、円弧、正多角形を宣言します。gridsmith が幾何を解き、作図規則（少数の半径比、粗いグリッド、n 回対称）で検査して、SVG と PNG を構築シートとともに出力します。仕様を書くモデルは、座標を推測する代わりに正確な接点と交点を得られます。

📖 **[ドキュメント](https://github.com/libraz/gridsmith/blob/main/docs/ja/getting-started.md)** &nbsp;·&nbsp; **[ギャラリー](https://github.com/libraz/gridsmith/blob/main/docs/ja/gallery.md)** &nbsp;·&nbsp; **[ライブラリ API](https://github.com/libraz/gridsmith/blob/main/docs/ja/api-reference.md)**

> 1.0 未満です。仕様の文法と規則のしきい値は今後変わる可能性があります。

<p>
<img src="https://raw.githubusercontent.com/libraz/gridsmith/main/docs/gallery/whale-sheet.png" alt="接円で組み立てたクジラのロゴマークの構築シート" width="260">
<img src="https://raw.githubusercontent.com/libraz/gridsmith/main/docs/gallery/sigil-medallions-sheet.png" alt="輪の上にメダリオンを並べた魔法陣の図形の構築シート" width="260">
<img src="https://raw.githubusercontent.com/libraz/gridsmith/main/docs/gallery/line-chart-sheet.png" alt="24 単位のグリッド上に描いた折れ線グラフのアイコンの構築シート" width="260">
</p>

## できること

- **ロゴマーク** — 円、多角形、半平面の和・積・差で塗りの領域を作り、64、32、16 px でのプレビューを確認できます。[仕様の書式](https://github.com/libraz/gridsmith/blob/main/docs/ja/spec.md)
- **魔法陣の図形** — 線で描く輪、星形、円弧、繰り返しのメダリオン。erase レイヤーで帯を切り抜けます。[ギャラリー](https://github.com/libraz/gridsmith/blob/main/docs/ja/gallery.md)
- **UI アイコン** — 塗りと線を混ぜた 24 単位のアイコンを、SVG、PNG、レイヤーごとのパスセグメントで書き出します。[アイコン](https://github.com/libraz/gridsmith/blob/main/docs/ja/icons.md)
- **SVG アイコンの取り込み** — 既存のアイコンのパスを、グリッドに丸めた仕様に変換し、元の絵との画素差を返します。[アイコン](https://github.com/libraz/gridsmith/blob/main/docs/ja/icons.md)
- **作図規則** — グリッドから外れた値、多すぎる比、許された分割から外れた角度、細すぎる線を報告します。違反がなくなった仕様だけを書き出せます。[規則](https://github.com/libraz/gridsmith/blob/main/docs/ja/spec.md#規則)
- **参照画像との照合** — PNG や JPEG を図の下に重ねて一致度を測り、シルエットをなぞれるようにします。[outline と underlay](https://github.com/libraz/gridsmith/blob/main/docs/ja/spec.md#outline-と-underlay)
- **4 つの MCP ツール** — stdio で `gridsmith_guide`、`gridsmith_render`、`gridsmith_export`、`gridsmith_import` を提供します。[MCP ツール](https://github.com/libraz/gridsmith/blob/main/docs/ja/mcp-tools.md)

## インストール

Node.js 24 以上が必要です。Claude Code や Codex CLI に MCP サーバーを登録します。

```sh
npx -y github:libraz/gridsmith init
```

`init` は更新する設定ファイルを尋ね、`gridsmith` のエントリーだけを書き込みます。`uninstall` で削除できます。Claude Code ではプラグインとしても入れられます。

```text
/plugin install gridsmith --marketplace libraz/gridsmith
```

他のクライアントの手動設定は [はじめに](https://github.com/libraz/gridsmith/blob/main/docs/ja/getting-started.md) にあります。

ライブラリとして使う場合は次のとおりです。

```sh
npm install github:libraz/gridsmith
```

## クイックスタート

### MCP

アシスタントにロゴマーク、図形、アイコンを頼みます。アシスタントは `gridsmith_guide` を読んで仕様を JSON ファイルに書き、レポートの違反がなくなるまで `gridsmith_render` で描き直してから、`gridsmith_export` でファイルを書き出します。

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

console.log(drawing.violations); // すべての規則を満たせば []
const out = await mkdtemp(join(tmpdir(), 'gridsmith-'));
await writeFile(join(out, 'crescent.svg'), drawing.svg);
await writeFile(join(out, 'crescent-64.png'), drawing.png(64));
```

→ [ライブラリ API](https://github.com/libraz/gridsmith/blob/main/docs/ja/api-reference.md)

## ソースからビルド

```sh
yarn install && yarn build   # src/ を dist/ にコンパイル
yarn test                    # Vitest（README.md と docs/en/ のコード例も実行）
yarn check                   # Biome と tsc --noEmit
yarn gallery                 # src/guide/examples.ts の例から docs/gallery/ を再生成
```

`docs/gallery/` のファイルは生成物です。手で編集しないでください。

## ドキュメント

ドキュメントは `docs/en/` と `docs/ja/` の Markdown です。

- **学ぶ** — [はじめに](https://github.com/libraz/gridsmith/blob/main/docs/ja/getting-started.md) · [ギャラリー](https://github.com/libraz/gridsmith/blob/main/docs/ja/gallery.md)
- **ガイド** — [仕様の書式](https://github.com/libraz/gridsmith/blob/main/docs/ja/spec.md) · [アイコン](https://github.com/libraz/gridsmith/blob/main/docs/ja/icons.md)
- **リファレンス** — [MCP ツール](https://github.com/libraz/gridsmith/blob/main/docs/ja/mcp-tools.md) · [ライブラリ API](https://github.com/libraz/gridsmith/blob/main/docs/ja/api-reference.md)

## 含まないもの（Non-goals）

gridsmith が扱うのは幾何だけです。文字は描画せず、完成図に文字は含まれません。ビットマップの自動トレースも行いません。underlay は、仕様が描いた図との一致度を測るためのものです。

## ライセンス

[Apache-2.0](LICENSE)
