# gridsmith

**gridsmith は、JSON の作図仕様からロゴマーク、魔法陣の図形、24 単位の UI アイコンを描きます。** モデルがグリッド上の円、接円、線、円弧、正多角形（アイコンでは折れ線、四角、楕円も）を宣言すると、gridsmith が幾何を解き、作図規則（少数の半径比、粗いグリッド、n 回対称）で検査して、PNG と SVG を構築シートとともに返します。

stdio の MCP サーバーです。

<p><img src="docs/gallery/sigil-medallions-sheet.png" alt="sigil-medallions の構築シート" width="420"></p>

## できること

| ツール | 入力 | 返すもの |
|---|---|---|
| `gridsmith_guide` | `topic`: `overview`（既定）、`spec`、`rules`、`examples`、`icon` | 早見表、仕様の JSON Schema、規則表、規則を通る完全な例、アイコンモードの解説 |
| `gridsmith_render` | `spec`（オブジェクト、または 256 KB 以下の JSON ファイルの絶対パス）、`views` と `underlay`（どちらも省略可） | JSON レポートと指定したビュー。何も書き込みません |
| `gridsmith_export` | `spec`、`dir`（絶対パス）、`name`、`overwrite`（省略可） | `dir` に書き出したファイル |
| `gridsmith_import` | `segments`（アイコンのパスセグメント 1〜64 個）、`snap`（省略可、既定は true）、`step`（省略可。0.5、0.25、0.1） | アイコンの仕様、状態、違反、元の絵との画素差。何も書き込みません |

**`gridsmith_render`** は、JSON レポート（解決済みの幾何、違反、適用済みの例外、近接接触のヒント、レイヤーごとの統計、`exportable`）に続けて、指定した順にビューを返します。PNG ビューは `sheet`（構築シート）、`final`（512 px）、`sizes`（mark は 64、32、16 px を並べたもの。アイコンは画素プレビューで、後述。figure では使えません）、`guides`（完成図に構築要素をすべて重ねたもの、512 px）、`match`（完成図と `underlay` の画像の比較、512 px。後述）です。SVG ビューはテキストで返ります（`svg`、`sheet_svg`、`guides_svg`）。アイコンにはさらに、パスデータを JSON 文字列で返す `segments` があります。60000 文字を超えるテキストのビューは返さず、`truncated` に記載します。既定は mark とアイコンなら `sheet` と `sizes`、figure なら `sheet` と `final` です。規則違反があっても報告したうえで描画します。

**`gridsmith_export`** は `<name>.svg`、`<name>-sheet.svg`、`<name>-guides.svg`、`<name>.spec.json` と PNG を書き出します。PNG は mark なら `-512`、`-64`、`-32`、`-16`、figure なら `-1024`、アイコンなら `-512`、`-48`、`-24`、`-16` です。アイコンでは `<name>.segments.json` も書き出します（「アイコン」を参照）。違反が残る仕様は拒否します。出力先に同名のファイルがあるときも、`overwrite` が true でなければ拒否します。`dir` がなければ作成します。

## インストール

Node.js 24 以上と Yarn 4 が必要です。パッケージは private で、レジストリには公開していません。チェックアウトからビルドしてください。

```sh
yarn install && yarn build
```

MCP クライアントに登録します。Claude Code の場合は次のとおりです。

```sh
claude mcp add gridsmith -- node /absolute/path/to/gridsmith/dist/index.js
```

## クイックスタート

1. `gridsmith_guide` を `overview` で呼び、続けて `examples` で手本になる仕様を読みます。
2. 仕様を絶対パスの JSON ファイル（例: `/tmp/work/mark.json`）に書きます。
3. `spec` にそのパスを指定して `gridsmith_render` を呼びます。レポートと画像を確認し、ファイルを直して再度描画します。
4. `violations` が空（`exportable` が true）になったら、`dir`、`name`、同じ仕様のパスを指定して `gridsmith_export` を呼びます。

## ソースからビルド

```sh
yarn test      # Vitest
yarn check     # Biome と tsc --noEmit
yarn gallery   # src/guide/examples.ts の例から docs/gallery/ を再生成
```

`docs/gallery/` のファイルは生成物です。手で編集しないでください。

## 仕様の組み立て方

仕様は `version`（1）、`mode`、`grid`、`shapes`、`paint` と、省略可能な `concept`、`exceptions` からなります。正確なスキーマは `gridsmith_guide` の `spec` で取得できます。

**グリッドと座標。** `grid.divisions` は 4、6、8 のいずれか（アイコンは 12）で、単位円の半径 R（モジュール数）になります。`grid.margin` は 0 から 4 モジュール（既定 1。アイコンは 0 だけで、これが既定です）で、キャンバスは半辺 R + margin の正方形です。アイコンは `grid.step` に 0.5（既定）、0.25、0.1 のいずれかを書けます。数値の座標と半径はこの刻みに乗せます。原点はキャンバス中心、x は右、y は上向きで、角度は +x から反時計回りの度数です。

**要素**（`shapes`、最大 64 個。参照できるのは先に宣言した要素だけです）。

| 種類 | 内容 |
|---|---|
| `point` | 名前付きの点 |
| `circle` | `center`（既定 [0, 0]）と `r` |
| `tangent_circle` | `to` の2要素（円または線）の両方に接する半径 `r` の円。候補から `near` で選びます |
| `line` | `from` と `to` を通る無限直線。描くときはその区間の線分になります |
| `arc` | 円 `on` の一部。`from` から `to` へ反時計回り（度数、または円上の点） |
| `polygon` | 円 `in` に内接する正 `n` 角形。`step` が 2 以上なら星形、`rotate` は度数 |
| `points` | 指定した点を通る閉じた多角形 |
| `outline` | 先に宣言した円と線から切り出した、閉じた1本の縁。接点か指定した角でつなぎます（後述） |
| `polyline` | 3 から 32 点を通る開いた折れ線。stroke レイヤーだけで使えます |
| `rect` | 向かい合う 2 隅 `corners` を結ぶ、軸に平行な四角。`r` を付けると 4 隅すべてが丸くなります |
| `oval` | 半軸 `rx`、`ry` の楕円で、4 本の円弧でできています。`rotate` は度数、縦横比は 4 まで |
| `repeat` | `of` を `center` まわりに `n` 回回転した複製。`mirror` を付けると角度 `axis` の線に関する反転も加わります |

**Length。** 0.05 から 64 モジュールの数値、または式です。式は `R` か `<circle id>.r` に、`*` または `/` と、2 から 16、`sqrt2`、`sqrt3`、`phi`、`phi2` のいずれかを続けます。例: `"R/2"`、`"outer.r*sqrt3/2"`。空白、括弧、`+`、`-` は使えません。

**点。** `[x, y]`、点または円の id（円なら中心）、`{ "on": 円, "angle": 度数 }`、`{ "intersect": [a, b], "near": 点 }` のいずれかです。`near` は指定した点に最も近い候補を選び、候補が1つなら省略できます。

**mark** は塗りつぶした領域を描きます。`paint: [{ "fill": Region, "color": "#rrggbb" }]` と書きます。Region は id（円、多角形、points、outline、またはそれらの repeat）、半平面を表す `{ "half": 線, "toward": 点 }`、`{ "union" | "intersect" | "subtract": [Region, ...] }` のいずれかで、有界でなければなりません。

**figure** は線を描きます。`{ "stroke": [id], "width": Length, "color": ..., "cap"?, "join"?, "dash"? }` と書きます。円は円周、線は線分、円弧は円周の一部、多角形は輪郭、repeat はすべての複製として描かれます。`{ "erase": [id] }` レイヤー（先頭には置けません）は、指定した円、多角形、points の内側にある先行レイヤーをすべて隠すので、後のレイヤーで帯の上にメダリオンを描けます。どのレイヤーにも描かれない円は補助線として使えます。

**線の指定**（figure とアイコンの stroke レイヤー）。`cap` は `"round"`（既定）、`"butt"`、`"square"`、`join` は `"round"`（既定）、`"miter"`、`"bevel"` のいずれかです。`dash` は `[線の長さ, 隙間]`（モジュール単位）で、省略すると実線になります。破線は要素の最初の点から、書いた順に始まります。円は右端から時計回りです。

mark は `fill` レイヤーだけ、figure は `stroke` と `erase` だけを受け付けます。アイコンは `fill` と `stroke` を任意の順に並べられます（`erase` は使えません）。違反は `exceptions` の `{ rule, target, reason }` で許容できます。reason は構築シートに印字されます。

### 規則

| 規則 | 内容 |
|---|---|
| `ratio_count` | 半径と線幅で使う比は最大 3 種類。"R/2" と "R*2" は同じ比として数えます。アイコンには適用しません |
| `circle_count` | 円は mark で最大 8 個、figure で最大 16 個、アイコンで最大 40 個。円弧は数えません。塗りから届く `outline` を持つ mark は 40 個まで |
| `off_grid` | 数値の座標と半径は 0.5 モジュール（mark）、0.25（figure）、`grid.step`（アイコン、既定 0.5）の倍数。線幅と `dash` は対象外 |
| `angle` | 角度（`oval.rotate` を含む）は n が 2、3、4、5、6、8、10、12、20、24 のいずれかのときの 180/n の倍数。`polygon.n` と `repeat.n` も同じ集合から選ぶ |
| `off_canvas` | 描画物はキャンバスの内側に収まる。線は幾何から線幅の半分まで外へ出る分も数える |
| `empty_fill` | fill レイヤーは閉じた輪郭を1つ以上生む（mark、アイコン） |
| `thin_stroke` | キャンバスを 512 px で描いたとき、線幅が 1 px 以上（figure）。アイコンでは線幅が 0.5 モジュール以上 |
| `uneven_steps` | 3 区間以上の折れ線が一方の軸に沿って一定の向きに進むとき、その軸の刻みが等しい（figure、アイコン）。もう一方の軸で動かない区間を含む折れ線は検査しません |
| `width_count` | 1 つの仕様で使う線幅は最大 3 種類（アイコン） |
| `unused_shape` | すべての要素が paint レイヤーから参照でたどれる |
| `unused_exception` | どの違反にも一致しない例外は報告される。この規則自体は許容できない |

### outline と underlay

**`outline`** は、座標を書かずに、構築用の円から具象的なシルエットを描きます。`through` に 2 から 64 個の部品を、内側が左になる反時計回りで並べます。部品は id、または `{ "on": id, "concave": true, "corner": 点 }` です。`on` は円、`tangent_circle`、`line` のいずれかです。円の部品は外側にふくらみ、`concave: true` なら内側へえぐります。各部品は次の部品と出会う所で終わり、最後の部品は最初の部品と出会います。接する部品は接点でつなぎ、交わる部品は角でつなぎます。2つの交点のどちらを使うかは `corner` で選びます。`outline` は `points` が使える所で使えます。mark の fill、figure の stroke と erase、`repeat` です。レポートの `geometry` には、部品、角（符号つきの度数で、左に曲がる角が正）、面積が載ります。

**`underlay`** は、描いた図形と参照画像を比べます。`gridsmith_render` に `underlay: { "path": ..., "box"?, "threshold"?, "invert"?, "fit"? }` を渡します。`path` は 4 MiB 以下、1600 万画素以下の PNG または JPEG の絶対パスです。前景はアルファチャンネルから、なければ輝度の大津の二値化で求めます（`threshold` の 1 から 254 で上書きでき、`invert` で前景と背景を入れ替えます）。前景の外接矩形を `box`（モジュール単位、既定はグリッドの正方形）に収め、構築シートでは完成図の後ろにオレンジで表示します。`fit` は `"shape"`（既定）または `"image"` で、`"image"` は前景ではなく画像全体を `box` に置きます。24 単位のキャンバス全体を描いた PNG に向いています。不透明な画素はすべてインクとして数えるので、穴は白で塗らず `subtract` で抜いてください。

下絵を渡すと、レポートに `match` が加わります。`iou`（1 なら完全に一致）、割合で表した `missing` と `excess`、`offset`（図形の中心から参照の中心を引いたもの）、`grid`（12 行、上から順に。`-` が不足、`+` が余分、`.` が一致）、最大 3 つの `blobs`（種別、参照の面積に対する割合、中心、外接矩形）、`underlay`（実際に使った配置、しきい値、極性）です。`match` ビューは 512 px の PNG で、両方にある部分は濃いグレー、参照だけはオレンジ、図形だけは青です。最も大きい blob かグリッドの領域を直して、再度描画してください。figure は、塗りのシルエットではなく線画と比べてください。`gridsmith_export` は下絵を受け付けません。

## アイコン

`mode: "icon"` は 24 単位の UI アイコンを描きます。`grid.divisions` は 12、余白はなしで、1 モジュールは 24 px 表示での 1 px です。座標は原点が中心、y が上向きのままで、範囲は -12 から 12 です。SVG の座標（0 から 24、y が下向き）にするには `x + 12`、`12 - y` とします。`paint` には `fill` と `stroke` のレイヤーを任意の順に並べ、後のレイヤーが上に重なります。同じ形を塗って縁取るときは、それぞれのレイヤーを 1 つずつ書きます。折れ線の端にある塗りの点のように頂点を共有する要素は、1 つの `point` を id で参照します。詳しい解説は `gridsmith_guide` の `icon` で取得できます。

<p><img src="docs/gallery/line-chart-sheet.png" alt="line-chart の構築シート" width="300"> <img src="docs/gallery/line-chart-sizes.png" alt="line-chart の 24 px と 16 px を 8 倍に拡大したもの" width="300"></p>

アイコンの `sizes` ビューは、最終の SVG を白地に 24 px と 16 px で描き、どちらも最近傍補間で 8 倍に拡大して並べた画像（336 x 192 px）です。画素が 1 つずつ見えます。`segments` ビューと `gridsmith_export` の `<name>.segments.json` は、アイコンのパスデータです。セグメントはペイントレイヤーごとに 1 つで、`paint` の順に並びます。座標は 24 単位のキャンバスで、原点は左上、y は下向きです。各セグメントは `d`（絶対座標の `M`、`L`、`A`、`Z`）を持ち、塗りなら `fill` と `fillRule`、線なら `stroke`、`strokeWidth`、`strokeLinecap`、`strokeLinejoin`（破線なら `strokeDasharray` も）を持ちます。セグメントごとに `path` 要素を 1 つ描く利用側では、最終の SVG と同じ絵になります。

```json
{ "canvas": 24,
  "segments": [
    { "d": "M2 5L22 5L22 19L2 19Z", "fill": "#ffffff", "fillRule": "evenodd" },
    { "d": "M4 15L8 11L12 14L16 8", "stroke": "#107c41", "strokeWidth": 1.3,
      "strokeLinecap": "round", "strokeLinejoin": "round" }
  ] }
```

`gridsmith_import` は、既存のアイコンからこの形のセグメントを受け取り、仕様を返します。曲線は 0.025 単位以内で直線と円弧に置き換えます（細かく当てはめると円が 40 個を超えるときは 0.05 か 0.1）。楕円弧が 1 本だけなら楕円上の円弧になります。直線と円弧からなる塗りの閉じたパスは、支えの円と直線を持つ `outline` になります。線を描かないパスでは、直線どうしが交差するものを輪ごとの outline に分け、両端で折り返す円弧を弦からその円を引いた形にします。楕円弧を含む塗りのパスは、弦の形にそれらの弧の `oval` を足すか引くかした形になります（線は直線と、その楕円上の `arc` で描きます）。分けた形、円を引いた形、楕円を使う形は、元と同じ範囲を塗るときだけ使います。そのあと仕様を格子の刻みに丸めます。刻みは `step` で指定でき、指定がなければ元の絵に最も近くなる刻みを選んで `snap.step` に返します。元で等間隔の折れ線は等間隔にし、そうでない折れ線は元の刻みのまま `uneven_steps` の例外を付けます（`snap: false` で丸めません）。`status` は `clean`、`violations`、`partial`（読み飛ばしたサブパスがあります。直線と円弧が混ざるパスは `pieces` に部品を並べ、outline にできなかったときは `detail` に理由を書きます）、`failed` のいずれかです。`diff` は元の絵と違う画素の割合で、`faithful` は丸める前の同じ割合です。

## ギャラリー

どの例も、すべての規則を通る完全な仕様です。左が完成図、右が構築シート（グリッド、構築用の円と線、凡例）で、SVG も含めたファイルは `docs/gallery/` にあります。

### mark

#### crescent

<p><img src="docs/gallery/crescent.png" alt="crescent" width="300"> <img src="docs/gallery/crescent-sheet.png" alt="crescent の構築シート" width="300"></p>

1つの円板を、もう1つの円板で切り取った三日月です。`body` の半径は R（4モジュール）、`bite` は半径 3 で中心を [1, 1] にずらしています。塗りは `body` から `bite` を引いた領域です。

<p><img src="docs/gallery/crescent-guides.png" alt="crescent のガイド線付き" width="300"></p>

仕様: [`docs/gallery/crescent.json`](docs/gallery/crescent.json)

#### leaf

<p><img src="docs/gallery/leaf.png" alt="leaf" width="300"> <img src="docs/gallery/leaf-sheet.png" alt="leaf の構築シート" width="300"></p>

半径 R の2つの円板（中心 [-1.5, 1.5] と [1.5, -1.5]）の重なりがレンズ形になり、これが葉です。同じ軸に沿ってずらした半径 R*2 の円板の組の共通部分を、葉から引いて主脈にしています。もう1組の R*2 の円板の共通部分は茎で、葉と合成しています。使う比は R と R*2 の2つです。

仕様: [`docs/gallery/leaf.json`](docs/gallery/leaf.json)

#### taiji

<p><img src="docs/gallery/taiji.png" alt="taiji" width="300"> <img src="docs/gallery/taiji-sheet.png" alt="taiji の構築シート" width="300"></p>

`upper` と `lower` は半径 R/2 の tangent_circle で、どちらも円板と水平線に接し、それぞれ [0, 2] と [0, -2] の近くの解が選ばれます。円板の右半分（垂直線の半平面と円板の共通部分）に `upper` を合成し、`lower` を引くと S 字の境界ができます。上半分には半径 0.5 の点を抜き、下半分には同じ大きさの点を加えています。

<p><img src="docs/gallery/taiji-guides.png" alt="taiji のガイド線付き" width="300"></p>

仕様: [`docs/gallery/taiji.json`](docs/gallery/taiji.json)

#### open-ring

<p><img src="docs/gallery/open-ring.png" alt="open-ring" width="300"> <img src="docs/gallery/open-ring-sheet.png" alt="open-ring の構築シート" width="300"></p>

半径 R（4）と 3 の同心円板で輪をつくり、中心に半径 1 の円板を置いています。中心から外周上の +30 度と -30 度の点へ引いた2本の線が楔形を区切ります。この楔は2つの半平面の共通部分で、輪から引くと右側に 60 度の切れ目が開きます。

仕様: [`docs/gallery/open-ring.json`](docs/gallery/open-ring.json)

#### eye

<p><img src="docs/gallery/eye.png" alt="eye" width="300"> <img src="docs/gallery/eye-sheet.png" alt="eye の構築シート" width="300"></p>

半径 R の2つの円板（中心 [0, -2.5] と [0, 2.5]）の共通部分がレンズ形になります。ここから半径 1 の円板を虹彩として引き、半径 0.5 の円板を瞳として合成しています。

仕様: [`docs/gallery/eye.json`](docs/gallery/eye.json)

#### whale

<p><img src="docs/gallery/whale.png" alt="whale" width="300"> <img src="docs/gallery/whale-sheet.png" alt="whale の構築シート" width="300"></p>

8 分割のグリッド上で、7 個の円を通る1つの `outline` からクジラのシルエットを作っています。`head` は真円で、`belly` と `back` は半径 8 の接円です。それぞれ `head` に内側から、片方の湾に外側から接するため、胴体は角を作らずに尾へ細くなります。`fluke_l` と `fluke_r` は角でつながり、`bay_l` と `bay_r` は `concave` でえぐっています。半径 0.5 の円板を目として引き、潮吹きは円板から円板を引いた 2 つの三日月で作っています。この種の形を絵に合わせるときは、その絵を `underlay` に指定して描画し、`match` を読みます。

<p><img src="docs/gallery/whale-guides.png" alt="whale のガイド線付き" width="300"></p>

仕様: [`docs/gallery/whale.json`](docs/gallery/whale.json)

### icon

#### line-chart

<p><img src="docs/gallery/line-chart.png" alt="line-chart" width="300"> <img src="docs/gallery/line-chart-sheet.png" alt="line-chart の構築シート" width="300"></p>

角丸（半径 3）の `rect` の板を塗り、その上に 2 つの線レイヤーを重ねています。1 つは軸で、角を miter、線端を butt にした `polyline` です。もう 1 つは、x が 4 モジュールずつ離れた 4 つの `point` を通る右上がりの折れ線です。端の点は、最後の点を中心にした半径 1.5 の塗りの円で、折れ線と点が id で同じ点を共有しています。

<p><img src="docs/gallery/line-chart-sizes.png" alt="line-chart の画素プレビュー" width="300"> <img src="docs/gallery/line-chart-guides.png" alt="line-chart のガイド線付き" width="300"></p>

仕様: [`docs/gallery/line-chart.json`](docs/gallery/line-chart.json)

### figure

#### hexagram-circle

<p><img src="docs/gallery/hexagram-circle.png" alt="hexagram-circle" width="300"> <img src="docs/gallery/hexagram-circle-sheet.png" alt="hexagram-circle の構築シート" width="300"></p>

半径 R、3、R/2 の円を描き、半径 3.5 の補助円は描きません。六芒星は半径 3 の円に内接する多角形 {6/2}（`n: 6`、`step: 2`）です。補助円上の角度 0 に半径 0.25 の小円を置き、30 度ずつ 12 回繰り返しています。

仕様: [`docs/gallery/hexagram-circle.json`](docs/gallery/hexagram-circle.json)

#### pentagram

<p><img src="docs/gallery/pentagram.png" alt="pentagram" width="300"> <img src="docs/gallery/pentagram-sheet.png" alt="pentagram の構築シート" width="300"></p>

五芒星は半径 3.5 の `ring` に内接する {5/2} です。`core` の半径は `ring.r/phi2`（ring の半径を黄金比の2乗で割った値）で、上下を反転させた五角形が内接します。外円に内接する五角形が全体を囲み、星の頂点にあたる ring 上の5か所に小円を繰り返しています。

<p><img src="docs/gallery/pentagram-guides.png" alt="pentagram のガイド線付き" width="300"></p>

仕様: [`docs/gallery/pentagram.json`](docs/gallery/pentagram.json)

#### sigil-medallions

<p><img src="docs/gallery/sigil-medallions.png" alt="sigil-medallions" width="300"> <img src="docs/gallery/sigil-medallions-sheet.png" alt="sigil-medallions の構築シート" width="300"></p>

グリッドの分割数は 8 なので R は 8 です。二重線の同心円帯（a1/a2、c1/c2、d1/d2）の間に放射状の目盛りの輪があり、24本の目盛りを 7.5 度ずらして2組繰り返しています。内側には、`sq_a` に内接する正方形と、`sq_b`（`sq_a.r/sqrt2`）に内接して 45 度回した正方形、それに `tri_a` と `tri_a.r/2` の `tri_b` に内接する2つの三角形があります。8つのメダリオン（半径 1.75 のものと半径 1 のものを 90 度ごとに4個ずつ）は erase レイヤーで背後の帯を消し、その上に描き直して、中に星か正方形を入れています。使う比は 1/sqrt2 と 1/2 の2つです。

<p><img src="docs/gallery/sigil-medallions-guides.png" alt="sigil-medallions のガイド線付き" width="300"></p>

仕様: [`docs/gallery/sigil-medallions.json`](docs/gallery/sigil-medallions.json)

#### crescent-moon

<p><img src="docs/gallery/crescent-moon.png" alt="crescent-moon" width="300"> <img src="docs/gallery/crescent-moon-sheet.png" alt="crescent-moon の構築シート" width="300"></p>

月（半径 R）と第2の円 `bite`（半径 3.5、中心 [1.5, 0]）は2点で交わり、その交点が `horn_top` と `horn_low` です。輪郭は2点の間の2本の円弧で、月上の `outer_edge` と `bite` 上の `inner_edge` が、どちらも `horn_top` から `horn_low` へ反時計回りに進みます。三日月の脇には小さな円を描いています。

仕様: [`docs/gallery/crescent-moon.json`](docs/gallery/crescent-moon.json)

#### petal-rosette

<p><img src="docs/gallery/petal-rosette.png" alt="petal-rosette" width="300"> <img src="docs/gallery/petal-rosette-sheet.png" alt="petal-rosette の構築シート" width="300"></p>

半径 2.5 の2つの円（中心 [2, 1.5] と [2, -1.5]）が、原点付近の `base` と [4, 0] 付近の `tip` で交わります。花びら1枚は、この2点の間で各円から取った2本の円弧です。これを中心まわりに8回繰り返し、中心の円と外枠の円は別の線幅で描いています。

<p><img src="docs/gallery/petal-rosette-guides.png" alt="petal-rosette のガイド線付き" width="300"></p>

仕様: [`docs/gallery/petal-rosette.json`](docs/gallery/petal-rosette.json)

#### hexagon-rosette

<p><img src="docs/gallery/hexagon-rosette.png" alt="hexagon-rosette" width="300"> <img src="docs/gallery/hexagon-rosette-sheet.png" alt="hexagon-rosette の構築シート" width="300"></p>

各円は前の円に `sqrt3/2`（正六角形の辺心距離の比）を掛けた半径です。そのため、円に内接する六角形の辺の中点は次に小さい円に接します。六角形は1つおきに 30 度回しています。図全体で使う比は1つだけです。

仕様: [`docs/gallery/hexagon-rosette.json`](docs/gallery/hexagon-rosette.json)

## 含まないもの（Non-goals）

gridsmith が扱うのは幾何だけです。文字は描画しません。完成図に文字は含まれません。
