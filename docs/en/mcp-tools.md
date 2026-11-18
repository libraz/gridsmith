# MCP tools

| Tool | Takes | Returns |
|---|---|---|
| `gridsmith_guide` | `topic`: `overview` (default), `spec`, `rules`, `examples` or `icon` | The cheat sheet, the JSON Schema of a spec, the rule table, the complete example specs, or the icon-mode reference |
| `gridsmith_render` | `spec` (an object, or an absolute path to a JSON file of at most 256 KB), `views` and `underlay` (both optional) | A JSON report and the requested views. Writes nothing |
| `gridsmith_export` | `spec`, `dir` (absolute), `name`, `overwrite` (optional) | The files written to `dir` |
| `gridsmith_import` | `segments` (1 to 64 path segments of an icon), `snap` (optional, default true), `step` (optional: 0.5, 0.25 or 0.1) | An icon spec, its status, violations and the pixel difference from the original. Writes nothing |

**`gridsmith_render`** returns a JSON report (resolved geometry, violations, applied exceptions, near-tangent hints, per-layer statistics, `exportable`) followed by the views in the order requested. PNG views are `sheet` (construction sheet), `final` (512 px), `sizes` (a mark: 64, 32 and 16 px side by side; an icon: a pixel preview, see [Icons](icons.md); not for a figure), `guides` (the final drawing with every construction element over it, 512 px) and `match` (the drawing against an `underlay` image, 512 px; see [Outlines and underlay](spec.md#outlines-and-underlay)). SVG views are returned as text: `svg`, `sheet_svg` and `guides_svg`. An icon also has `segments`, its path data as a JSON string. A text view longer than 60000 characters is not returned; it is listed in `truncated` instead. The default is `sheet` and `sizes` for a mark or an icon, `sheet` and `final` for a figure. Rule violations are reported and the drawing is still produced.

**`gridsmith_export`** writes `<name>.svg`, `<name>-sheet.svg`, `<name>-guides.svg`, `<name>.spec.json` and PNGs: `-512`, `-64`, `-32` and `-16` for a mark, `-1024` for a figure, `-512`, `-48`, `-24` and `-16` for an icon. An icon also gets `<name>.segments.json`; see [Icons](icons.md). It refuses a spec that still has violations, and refuses when any target file exists unless `overwrite` is true. `dir` is created if missing.
