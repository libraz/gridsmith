# MCP ツール

| ツール | 入力 | 返すもの |
|---|---|---|
| `gridsmith_guide` | `topic`: `overview`（既定）、`spec`、`rules`、`examples`、`icon` | 早見表、仕様の JSON Schema、規則表、規則を通る完全な例、アイコンモードの解説 |
| `gridsmith_render` | `spec`（オブジェクト、または 256 KB 以下の JSON ファイルの絶対パス）、`views` と `underlay`（どちらも省略可） | JSON レポートと指定したビュー。何も書き込みません |
| `gridsmith_export` | `spec`、`dir`（絶対パス）、`name`、`overwrite`（省略可） | `dir` に書き出したファイル |
| `gridsmith_import` | `segments`（アイコンのパスセグメント 1〜64 個）、`snap`（省略可、既定は true）、`step`（省略可。0.5、0.25、0.1） | アイコンの仕様、状態、違反、元の絵との画素差。何も書き込みません |

**`gridsmith_render`** は、JSON レポート（解決済みの幾何、違反、適用済みの例外、近接接触のヒント、レイヤーごとの統計、`exportable`）に続けて、指定した順にビューを返します。PNG ビューは `sheet`（構築シート）、`final`（512 px）、`sizes`（mark は 64、32、16 px を並べたもの。アイコンは画素プレビューで、[アイコン](icons.md)を参照。figure では使えません）、`guides`（完成図に構築要素をすべて重ねたもの、512 px）、`match`（完成図と `underlay` の画像の比較、512 px。[outline と underlay](spec.md#outline-と-underlay) を参照）です。SVG ビューはテキストで返ります（`svg`、`sheet_svg`、`guides_svg`）。アイコンにはさらに、パスデータを JSON 文字列で返す `segments` があります。60000 文字を超えるテキストのビューは返さず、`truncated` に記載します。既定は mark とアイコンなら `sheet` と `sizes`、figure なら `sheet` と `final` です。規則違反があっても報告したうえで描画します。

**`gridsmith_export`** は `<name>.svg`、`<name>-sheet.svg`、`<name>-guides.svg`、`<name>.spec.json` と PNG を書き出します。PNG は mark なら `-512`、`-64`、`-32`、`-16`、figure なら `-1024`、アイコンなら `-512`、`-48`、`-24`、`-16` です。アイコンでは `<name>.segments.json` も書き出します（[アイコン](icons.md)を参照）。違反が残る仕様は拒否します。出力先に同名のファイルがあるときも、`overwrite` が true でなければ拒否します。`dir` がなければ作成します。
