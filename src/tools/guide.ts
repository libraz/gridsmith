import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { EXAMPLES } from '../guide/examples.js';
import { HINTS, RULES } from '../rules/lint.js';
import type { RuleId } from '../spec/schema.js';
import { complain, guarded, jsonText, parseArgs, specJsonSchema } from './shared.js';

const TOOL = 'gridsmith_guide';
const TOPICS = ['overview', 'spec', 'rules', 'examples', 'icon'] as const;
type Topic = (typeof TOPICS)[number];

const argsSchema = z.strictObject({
  topic: z
    .enum(TOPICS, {
      error: complain('topic', 'one of "overview", "spec", "rules", "examples", "icon"'),
    })
    .optional(),
});

const inputSchema = z.looseObject({
  topic: z
    .unknown()
    .optional()
    .describe(
      'One of "overview" (default; coordinates, modes, workflow), "spec" (full JSON Schema of a spec), "rules" (every lint rule with its thresholds), "examples" (complete specs that pass every rule), "icon" (drawing a 24-unit UI icon).',
    ),
});

const DESCRIPTION =
  'Documentation for the gridsmith drawing spec. Start with topic "overview", a short cheat sheet. ' +
  'Use "spec" for the exact JSON Schema, "rules" for the rule table, "examples" for complete specs to copy from, and "icon" before drawing a UI icon.';

const OVERVIEW = `gridsmith draws logo marks and magic-circle figures from a JSON construction spec. You declare circles, lines and polygons; the server solves the geometry, checks the rules and renders the drawing and a construction sheet.

COORDINATES
- Origin at the canvas centre, x right, y up. Angles are degrees counter-clockwise from +x (90 = straight up).
- The unit is the module. R = grid.divisions modules (4, 6 or 8). The canvas is a square of half side R + grid.margin (margin defaults to 1).
- A length is a number (0.05 to 64 modules) or an expression: R or <circle id>.r, followed by * or / with 2 to 16, sqrt2, sqrt3, phi or phi2 (phi squared). Examples: "R/2", "outer.r*sqrt3/2". No spaces, parentheses, + or -.

MODES (one per spec)
- mark: filled shapes only. paint = [{ fill: Region, color? }]. A Region is an id (disc, polygon, points, outline, repeat of those), { half, toward }, or { union | intersect | subtract: [Region, ...] }. At most 8 circles (40 when a painted outline exists). Keep it legible at 64, 32 and 16 px.
- figure: line drawing only. paint = [{ stroke: [ids], width, color? }, { erase: [ids] }]. Circles draw as circumferences, lines as segments, arcs as partial circumferences, polygons as outlines, a repeat as every copy. At most 16 circles; arcs do not count. Helper circles that nothing strokes are fine when a stroked shape refers to them.
- erase layer (figure only, never first): hides every earlier layer inside the listed circles, polygons or points (or repeats of those), leaving the background transparent. Later layers draw on top. Use it for medallions that cut the bands behind them.
- "icon": a 24-unit UI icon (grid.divisions 12) that mixes fill and stroke layers; read topic "icon" before writing one.

ELEMENTS (shapes[]; ids are lowercase, unique, not "spec")
point, circle, tangent_circle, line, arc, polygon, points, outline, repeat. Topic "spec" has the exact schema.

REFERENCES
- An element may refer only to elements declared earlier in shapes.
- A point is [x, y], an element id (a point, or a circle's centre), { on: circle id, angle } or { intersect: [a, b], near: point }.
- Two circles, or a circle and a line, can meet in two points. near picks the candidate closest to the point you give; a rough location is enough. When there is one candidate (tangent, or two lines) near may be omitted. Zero candidates, infinitely many, or a tie are resolve errors that list the candidates.
- tangent_circle { r, to: [a, b], near } is the circle of radius r touching both a and b (circles or lines). Candidates include external and internal contact with circles and both sides of a line; the one whose centre is closest to near wins. The render report lists each contact point.
- { half: line id, toward: point } is the side of the infinite line that contains the point. Lines are infinite in intersections, tangents and half-planes; they are drawn as segments only when stroked.
- repeat { of: [ids], n, center?, mirror?, axis? } copies the shapes n times about center, 360/n degrees apart. mirror adds the reflection across the line at angle axis through center.
- arc { on: circle id, from, to } runs counter-clockwise from from to to along the circle. Each end is degrees or a point on the circle, typically { intersect: [circle, other], near }: an arc between two intersection points. Stroke it or repeat it; it cannot be a region or a reference base.
- polygon { in: circle id, n, step?, rotate? } inscribes a regular n-gon; step 2 or more draws a star ({6/2} is a hexagram).

OUTLINES (silhouettes from arcs)
outline { through: [piece, ...] } is one closed edge cut from circles declared earlier (2 to 64 pieces). A piece is an id or { on: id, concave?, corner? }; on is a circle, tangent_circle or line. List the pieces counter-clockwise (inside on the left); clockwise is a resolve error. A circle piece bulges outward; concave: true carves inward. Each piece ends where it meets the next one, the last meeting the first:
- Tangent circles join at their touching point; no corner.
- Circles that cross meet in two points: put corner on the first piece of the joint, a point nearer the wanted crossing. Two lines meet in one point; no corner. Pieces that do not touch are an error.
- For a smooth edge make the next circle with tangent_circle. An externally tangent neighbour swaps bulge and carve: flip its concave.
An outline works wherever points does: mark fill, figure stroke or erase, repeat of.

OUTLINE PITFALLS
- Pick a tangent_circle candidate with near; check the chosen contact kind in geometry contacts.
- corner steers the joint between its piece and the next. A hint near the wrong crossing is no error but another shape: check the sign of turn (geometry corners [x, y, turn], positive = bends left) and the area.
- A piece between two corners has no concave check; the wrong choice draws the complementary arc. Look at the picture.
- Grid circles that happen to touch exactly make the joint a tangent point, not a corner.

MATCHING A REFERENCE IMAGE
Pass underlay { path, box?, threshold?, invert? } to gridsmith_render. path: absolute PNG or JPEG; box [x0, y0, x1, y1] in modules receives the shape's bounding box (default the grid square). The sheet shows the reference in orange. report.match: iou (1 = same), missing and excess (shares), offset (drawing centre minus reference centre), grid (12 rows, top first: - missing, + excess, . fine), up to 3 blobs (kind, share of the reference area, center, bbox). Fix the largest blob or grid region, then render again. views ["match"]: both dark, reference only orange, drawing only blue.
- Every opaque pixel counts as ink: cut holes with subtract, never white paint.
- A figure is compared as a line drawing: use a line reference; a filled silhouette gives a low iou.
- Specks, frames and text in the margin shift the bounding box: crop the image or set box. match.underlay shows the placement, threshold and polarity used; set threshold or invert if the wrong side was taken as the shape.

RULES (topic "rules" has the table)
At most 3 distinct ratios; numeric radii and coordinates on a 0.5 grid (mark) or 0.25 grid (figure); degree angles that are multiples of 180/n for n in 2, 3, 4, 5, 6, 8, 10, 12, 20, 24; polygon.n and repeat.n from that same set; everything inside the canvas; no unused shapes. Violations do not stop gridsmith_render, but gridsmith_export refuses until each is fixed or excused by an exceptions entry { rule, target, reason }.

WORKFLOW
1. Write the spec to a JSON file with an absolute path, e.g. /tmp/work/mark.json.
2. Call gridsmith_render with spec set to that path. Read geometry (resolved centres, radii, tangent points), violations and hints in the JSON, and look at the images. A mark returns the sheet and 64/32/16 px sizes; a figure returns the sheet and the final drawing. Other views: guides (final drawing with every construction element over it), match (with underlay), and svg, sheet_svg, guides_svg (SVG markup as text).
3. Edit the file and render again. Resolve errors list every failing element at once, root causes first.
4. When violations is empty (exportable is true), call gridsmith_export with dir (absolute), name and the same spec path. Existing files are never replaced unless overwrite is true.
An inline spec object also works; a path avoids resending it.
To start an icon from existing SVG path data, call gridsmith_import (topic "icon").`;

const ICON = `ICON MODE: a 24-unit UI icon that mixes fill and stroke layers.

COORDINATES
Origin at the icon centre, x right, y up, range -12..12. A consumer's 0..24, y-down point (x', y') is x = x' - 12, y = 12 - y'. Writing 0..24 coordinates draws the icon off to the upper right and trips off_canvas.

CANVAS AND GRID
Set mode "icon" and grid { divisions: 12 }; margin is 0 or omitted. One module is 1 px when the icon is shown at 24 px. Numeric coordinates and radii sit on a 0.5 grid. Shapes may use every element type, including polyline, rect and oval.

LAYERS
paint holds fill and stroke layers in any order; a later layer draws over an earlier one. There is no erase layer. Fill { fill: Region, color } and stroke { stroke: [ids], width, color, cap?, join?, dash? } both need a "#rrggbb" color. To fill and outline one shape write two layers. At most 16 layers. Stroke width is 0.5 or more.

ELEMENTS
- polyline { through: [Point x 3..32] }: open broken line. Stroke only (or repeat of it). Two points: use line.
- rect { corners: [Point, Point], r? }: axis-parallel rectangle from two opposite corners; r is the corner radius for all four corners (0.05 up to min(w, h)/2). Fill, stroke or repeat.
- oval { center, rx, ry, rotate? }: four-arc egg; rotate is degrees counter-clockwise. rx and ry must differ by at least 0.05 and by a ratio of at most 4 (otherwise use circle). Fill, stroke or repeat.
- To fill and stroke one set of vertices, declare each as a point element once and reference the ids from points and from polyline.

STROKE STYLE
cap "round" | "butt" | "square" (default "round"). join "round" | "miter" | "bevel" (default "round"; miter limit 4). dash [dash, gap] in modules (default solid). A dash starts at the first point of an element and follows its drawing direction.

RULES
Coordinates, radii, rect.r, oval.rx and ry on a 0.5 grid; stroke width at least 0.5; at most 3 distinct stroke widths in a spec; a polyline of 3 or more segments that runs one way along x (or y) with no horizontal or vertical segment has equal steps on that axis (uneven_steps); at most 40 circles; everything inside the canvas, strokes counted with half their width. Ratio counts do not apply. Topic "rules" has the table.

CHECKING AND EXPORT
gridsmith_render views default to sheet and sizes. sizes is a pixel preview: the final drawing at 24 and 16 px, each enlarged 8x with nearest neighbour; look for blur and merged strokes. segments returns the path segments (one per layer, absolute M L A Z in 0..24 y-down) as a JSON string. gridsmith_export writes <name>.svg, -sheet.svg, -guides.svg, .spec.json, .segments.json and PNGs -512, -48, -24, -16.

IMPORTING AN EXISTING ICON
gridsmith_import takes segments (1 to 64 of { d, fill?, stroke?, strokeWidth?, strokeLinecap?, strokeLinejoin?, strokeDasharray?, fillRule?, transform? }, 24 units, y down) and returns a spec rounded to the 0.5 grid with equal polyline steps (snap: false skips the rounding). Beziers become lines and circular arcs. status: clean (every subpath converted, no violations), violations, partial (skipped is not empty) or failed. diff is the share of pixels that differ from the original, faithful the same before rounding; both are reports, not limits. A skipped subpath with reason "mixed path" lists its lines and arcs in pieces, y up, so you can draw it by hand. snap.kept names shapes left unrounded because rounding would collapse them. Write the returned spec to a file and continue with gridsmith_render.

EXAMPLE
Topic "examples" has "line-chart": a rounded plate, two axes, an evenly spaced trend line and an end dot.`;

const ELEMENT_NOTES: Record<string, string> = {
  point: 'A named point. at: Point.',
  circle: 'center: Point (default [0, 0]), r: Length.',
  tangent_circle:
    'Radius r circle touching both elements in to (circles or lines, distinct). near: Point picks the candidate whose centre is closest.',
  line: 'Infinite directed line through two distinct points, from and to. Drawn as the segment from-to.',
  arc: 'Part of the circumference of circle on, counter-clockwise from from to to. Each end is degrees or a point on the circle (within 1e-6); the ends must differ (use circle for a full circumference). Strokeable and repeatable; not a region, base or reference.',
  polygon:
    'Regular n-gon inscribed in the circle in; vertex k at angle rotate + 360k/n. step >= 2 joins vertex i to i+step (a star).',
  points:
    'Closed polygon through through: Point[] in order. Not all collinear; neighbours distinct.',
  repeat:
    'Rotates the elements in of n times about center, 360/n degrees apart; mirror also reflects across the line at angle axis through center. of holds circles, tangent_circles, lines, polygons or points shapes, never a repeat or point.',
  polyline:
    'Open broken line through through: Point[] (3 to 32), consecutive points distinct. Stroke or repeat only; for two points use line.',
  rect: 'Axis-parallel rectangle through two opposite corners: Point[2]; r (optional) rounds all four corners, at most half the shorter side. Region leaf, stroke, erase or repeat of.',
  oval: 'Four-arc oval: center, rx, ry (differ by at least 0.05, ratio at most 4), rotate degrees counter-clockwise. Region leaf, stroke, erase or repeat of.',
};

const LAYER_NOTES: Record<string, string> = {
  erase:
    'figure only, never paint[0]: { erase: [ids] } hides all earlier layers inside the listed circles, tangent_circles, polygons, points or repeats of those (a polygon counts as the area its outline encloses). Later layers are not hidden. Ids are distinct.',
  cap: 'stroke layers: "round" (default), "butt" or "square" line ends.',
  join: 'stroke layers: "round" (default), "miter" or "bevel" corners.',
  dash: 'stroke layers: [dash, gap] lengths in modules; omit for a solid line.',
};

const CONSTRAINTS = [
  'An element refers only to elements declared earlier in shapes. Ids are unique, match ^[a-z][a-z0-9_]{0,31}$ and are never "spec".',
  'polygon.step must satisfy 1 <= step < n/2. repeat.n is at least 2 unless mirror is true.',
  'mode "mark" accepts only fill layers, "figure" only stroke and erase layers, "icon" fill and stroke layers. A fill region must be bounded: a half-plane needs a disc or polygon to intersect with, or to be subtracted from.',
  'near and toward may nest intersect points at most 2 levels. Regions nest at most 8 levels.',
  'A mark holds at most 256 support curves after repeat expansion; a figure draws at most 2048 elements after repeat expansion.',
  'Length expressions evaluate to 0.05..64 modules; stroke widths to 0.005..8.',
  'Unknown keys are rejected. Numbers are modules; angles are degrees with absolute value at most 3600; coordinates have absolute value at most 64.',
  'exceptions[] entries { rule, target, reason } excuse a violation with the same rule and target; unused_exception cannot be excused.',
];

function renameDefs(schema: Record<string, unknown>): Record<string, unknown> {
  const defs = schema.$defs;
  if (typeof defs !== 'object' || defs === null) {
    return schema;
  }
  let text = JSON.stringify(schema);
  for (const [key, def] of Object.entries(defs)) {
    const body = JSON.stringify(def);
    const name = body.includes('"prefixItems"')
      ? 'Point'
      : body.includes('"half"')
        ? 'Region'
        : null;
    if (name !== null) {
      text = text
        .split(`#/$defs/${key}"`)
        .join(`#/$defs/${name}"`)
        .replace(`"${key}":`, `"${name}":`);
    }
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function topicDocument(topic: Topic): unknown {
  switch (topic) {
    case 'overview':
      return { topic, text: OVERVIEW };
    case 'spec': {
      const { $schema: _omit, ...schema } = specJsonSchema();
      return {
        topic,
        schema: renameDefs(schema),
        elements: ELEMENT_NOTES,
        layers: LAYER_NOTES,
        constraints: CONSTRAINTS,
      };
    }
    case 'rules':
      return {
        topic,
        rules: (Object.keys(RULES) as RuleId[]).map((id) => {
          const { description, modes, ...limits } = RULES[id];
          return { id, modes, description, ...limits };
        }),
        ratios:
          'A length expression contributes the product of its factors as a ratio signature; reciprocals are the same ratio ("R/2" and "R*2"), as are "R*phi*phi" and "R*phi2". Each expression is taken relative to its own base, so a chain such as "a.r/2", "b.r/2" with the same step counts as one ratio. Plain numbers and a bare "R" carry no ratio.',
        exceptions:
          'Add { rule, target, reason } to exceptions to excuse a violation with that rule and target. The reason is printed on the construction sheet. An exception that matches no violation is itself reported as unused_exception.',
        hints: `Not violations. near_tangent lists circle or line pairs that nearly touch without touching (gap at most ${HINTS.nearTangent.maxGap} module, ${HINTS.nearTangent.maxCount} at most): usually a radius that should be a tangent_circle.`,
      };
    case 'examples':
      return { topic, examples: EXAMPLES };
    case 'icon':
      return { topic, text: ICON };
  }
}

export function registerGuide(server: McpServer): void {
  server.registerTool(
    TOOL,
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      guarded(TOOL, async () => {
        const { topic = 'overview' } = parseArgs(TOOL, args, argsSchema);
        return { content: [jsonText(topicDocument(topic))] };
      }),
  );
}
