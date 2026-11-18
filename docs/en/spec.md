# Spec format

A spec has `version` (1), `mode`, `grid`, `shapes`, `paint`, and optionally `concept` and `exceptions`. `gridsmith_guide` with `spec` returns the exact schema.

**Grid and coordinates.** `grid.divisions` is 4, 6 or 8 (12 for an icon) and sets R, the radius of the unit circle in modules. `grid.margin` is 0 to 4 modules (default 1; an icon takes only 0, its default), so the canvas is a square of half side R + margin. An icon may set `grid.step` to 0.5 (the default), 0.25 or 0.1: the step its numeric coordinates and radii sit on. The origin is the canvas centre, x points right and y up. Angles are degrees counter-clockwise from +x.

**Elements** (`shapes`, at most 256; each refers only to earlier ones).

| Kind | Meaning |
|---|---|
| `point` | A named point |
| `circle` | `center` (default [0, 0]) and `r` |
| `tangent_circle` | The circle of radius `r` touching both elements in `to` (circles or lines); `near` picks among the candidates |
| `line` | Infinite line through `from` and `to`; drawn as that segment when stroked |
| `arc` | Part of circle or oval `on`, counter-clockwise from `from` to `to` (degrees or points on a circle; degrees only on an oval) |
| `polygon` | Regular `n`-gon inscribed in circle `in`; `step` of 2 or more gives a star; `rotate` in degrees |
| `points` | Closed polygon through listed points |
| `outline` | One closed edge cut from circles and lines declared earlier, joined by tangency or at chosen corners; see [Outlines and underlay](#outlines-and-underlay) |
| `polyline` | Open polyline through 3 to 32 points; stroke layers only |
| `rect` | Axis-parallel rectangle between two opposite `corners`; `r` rounds all four corners |
| `oval` | Oval of semi-axes `rx` and `ry` whose outline follows the true ellipse as 28 circular arcs, within 0.06% of the longer semi-axis, turned by `rotate` degrees; the ratio is at most 4 |
| `repeat` | `n` rotated copies of `of` about `center`; `mirror` adds the reflection across the line at angle `axis` |

**Length.** A number from 0.05 to 64 modules, or an expression: `R` or `<circle id>.r`, followed by `*` or `/` with 2 to 16, `sqrt2`, `sqrt3`, `phi` or `phi2`. For example `"R/2"` or `"outer.r*sqrt3/2"`. No spaces, parentheses, `+` or `-`.

**Point.** `[x, y]`; the id of a point or circle (its centre); `{ "on": circle, "angle": degrees }`; or `{ "intersect": [a, b], "near": point }`, where `near` picks the candidate closest to the point given and may be omitted when there is only one.

**mark** paints filled regions: `paint: [{ "fill": Region, "color": "#rrggbb" }]`. A Region is an id (a circle, polygon, points, outline or a repeat of those), `{ "half": line, "toward": point }` for a half-plane, or `{ "union" | "intersect" | "subtract": [Region, ...] }`. A region must be bounded.

**figure** paints strokes: `{ "stroke": [ids], "width": Length, "color": ..., "cap"?, "join"?, "dash"? }`. Circles draw as circumferences, lines as segments, arcs as partial circumferences, polygons as outlines and a repeat as every copy. An `{ "erase": [ids] }` layer (never first) hides every earlier layer inside the listed circles, polygons or points, so later layers can draw medallions over bands. Circles that nothing strokes may serve as helpers.

**Stroke options** (stroke layers of a figure or an icon): `cap` is `"round"` (default), `"butt"` or `"square"`; `join` is `"round"` (default), `"miter"` or `"bevel"`; `dash` is `[length, gap]` in modules, and a stroke is solid without it. A dash starts at the first point of the element, in the order it is written; a circle starts at its rightmost point and runs clockwise.

A mark takes only `fill` layers, a figure only `stroke` and `erase`, and an icon `fill` and `stroke` in any order (no `erase`). A violation can be excused with an `exceptions` entry `{ rule, target, reason }`; the reason is printed on the construction sheet.

## Rules

| Rule | Meaning |
|---|---|
| `ratio_count` | At most 3 distinct ratios across radii and widths; "R/2" and "R*2" count once. Not applied to an icon |
| `circle_count` | At most 8 circles in a mark, 16 in a figure, 40 in an icon; arcs do not count. A mark whose fill reaches an `outline` may have 40 |
| `off_grid` | Numeric coordinates and radii are multiples of 0.5 module (mark), 0.25 (figure) or `grid.step` (icon, default 0.5); stroke widths and `dash` are exempt |
| `angle` | Angles, including `oval.rotate`, are multiples of 180/n for n in 2, 3, 4, 5, 6, 8, 10, 12, 20, 24; `polygon.n` and `repeat.n` come from the same set |
| `off_canvas` | Everything drawn stays inside the canvas; a stroke counts half its width beyond its geometry |
| `empty_fill` | A fill layer produces at least one closed outline (mark, icon) |
| `thin_stroke` | A stroke is at least 1 px wide with the canvas drawn at 512 px (figure), or at least 0.5 module wide (icon) |
| `uneven_steps` | A polyline of 3 or more segments that rises or falls steadily along one axis has equal steps along that axis (figure, icon). A polyline with a segment that stays level on the other axis is not checked |
| `width_count` | At most 3 distinct stroke widths in one spec (icon) |
| `unused_shape` | Every element is reachable from a paint layer |
| `unused_exception` | An exception that matches no violation is reported; it cannot itself be excused |

## Outlines and underlay

**`outline`** draws a figurative silhouette from construction circles instead of coordinates. `through` lists 2 to 64 pieces counter-clockwise, with the inside on the left. A piece is an id, or `{ "on": id, "concave": true, "corner": point }`; `on` is a circle, `tangent_circle` or `line`. A circle piece bulges outward, and `concave: true` carves inward. Each piece ends where it meets the next one, and the last meets the first. Pieces that touch are joined at the tangent point. Pieces that cross are joined at a corner, and `corner` picks which of the two intersections. An outline works where `points` does: as a mark fill, a figure stroke or erase, or in a `repeat`. The report's `geometry` lists its pieces, its corners with the signed turn in degrees (left turns positive) and its area.

**`underlay`** compares a drawing with a reference image. Pass `underlay: { "path": ..., "box"?, "threshold"?, "invert"?, "fit"? }` to `gridsmith_render`. `path` is an absolute path to a PNG or JPEG of at most 4 MiB and 16 million pixels. The foreground is found from the alpha channel, or from luminance with an Otsu threshold (`threshold` 1 to 254 overrides it, `invert` swaps the sides). Its bounding box is fitted into `box` (modules, default the grid square) and the sheet shows it in orange behind the drawing. `fit` is `"shape"` (default) or `"image"`; `"image"` places the whole image in `box` instead of its foreground, which suits a PNG of a whole 24-unit canvas. Every opaque pixel counts as ink, so cut a hole with `subtract` instead of painting it white.

With an underlay the report gains `match`: `iou` (1 means identical), `missing` and `excess` as shares, `offset` (drawing centre minus reference centre), `grid` (12 rows, top first: `-` missing, `+` excess, `.` fine), up to three `blobs` (kind, share of the reference area, centre, box) and `underlay` (the placement, threshold and polarity used). The `match` view is a 512 px PNG: both in dark grey, reference only in orange, drawing only in blue. Fix the largest blob or grid region and render again. Compare a figure with a line drawing, not with a filled silhouette. `gridsmith_export` does not take an underlay.
