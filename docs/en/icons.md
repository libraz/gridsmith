# Icons

`mode: "icon"` draws a 24-unit UI icon with `grid.divisions` 12 and no margin: one module is one pixel at 24 px. Coordinates keep the origin at the centre with y up and range over -12 to 12. To use them as SVG coordinates (0 to 24, y down) take `x + 12` and `12 - y`. `paint` mixes `fill` and `stroke` layers in any order, and a later layer lies on top. To fill and outline the same shape, write one layer of each. Elements that share a vertex, such as the filled dot at the end of a polyline, refer to one `point` by id. `gridsmith_guide` with `icon` returns the full reference.

<p><img src="../gallery/line-chart-sheet.png" alt="line-chart construction sheet" width="300"> <img src="../gallery/line-chart-sizes.png" alt="line-chart at 24 and 16 px, enlarged 8x" width="300"></p>

The `sizes` view of an icon draws the final SVG at 24 px and at 16 px on white and enlarges both 8x with nearest-neighbour sampling (336 x 192 px), so each pixel is visible. The `segments` view and `gridsmith_export` give `<name>.segments.json`: the path data of the icon, one segment per paint layer in paint order, in a 24-unit canvas with the origin at the top left and y down. Each segment has `d` (absolute `M`, `L`, `A` and `Z` commands) and either `fill` and `fillRule`, or `stroke`, `strokeWidth`, `strokeLinecap`, `strokeLinejoin` and, for a dashed stroke, `strokeDasharray`. A consumer that renders one `path` element per segment draws the same picture as the final SVG.

```json
{ "canvas": 24,
  "segments": [
    { "d": "M2 5L22 5L22 19L2 19Z", "fill": "#ffffff", "fillRule": "evenodd" },
    { "d": "M4 15L8 11L12 14L16 8", "stroke": "#107c41", "strokeWidth": 1.3,
      "strokeLinecap": "round", "strokeLinejoin": "round" }
  ] }
```

`gridsmith_import` takes segments of this shape from an existing icon and returns a spec. Curves become lines and circular arcs within 0.025 units (0.05 or 0.1 when a finer fit needs more than 40 circles), and a single elliptical arc becomes an arc on an oval. A filled closed path of lines and circular arcs becomes an `outline` with its support circles and lines; when the path is not stroked, one whose lines cross becomes an outline per loop, and an arc that turns back at both ends becomes its chord less its circle. A filled path with elliptical arcs becomes its chords united with, or less, the `oval`s of those arcs (its stroke drawn as lines and `arc`s on those ovals). The cut, capped and oval forms are used only when they fill the same area as the source. The spec is then rounded to a grid step, `step` or else the one whose drawing stays closest to the original (returned as `snap.step`). Polylines evenly stepped in the source get equal steps, the others keep theirs with an `uneven_steps` exception (`snap: false` skips the rounding). `status` is `clean`, `violations`, `partial` (some subpaths were skipped; a skipped path of mixed lines and arcs lists them in `pieces`, with `detail` when it could not become an outline) or `failed`. `diff` is the share of pixels that differ from the original; `faithful` is the same share before rounding.
