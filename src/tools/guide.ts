import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { EXAMPLES } from '../guide/examples.js';
import { HINTS, RULES } from '../rules/lint.js';
import type { RuleId } from '../spec/schema.js';
import { complain, guarded, jsonText, parseArgs, specJsonSchema } from './shared.js';

const TOOL = 'gridsmith_guide';
const TOPICS = ['overview', 'spec', 'rules', 'examples'] as const;
type Topic = (typeof TOPICS)[number];

const argsSchema = z.strictObject({
  topic: z
    .enum(TOPICS, { error: complain('topic', 'one of "overview", "spec", "rules", "examples"') })
    .optional(),
});

const inputSchema = z.looseObject({
  topic: z
    .unknown()
    .optional()
    .describe(
      'One of "overview" (default; coordinates, modes, workflow), "spec" (full JSON Schema of a spec), "rules" (every lint rule with its thresholds), "examples" (complete specs that pass every rule).',
    ),
});

const DESCRIPTION =
  'Documentation for the gridsmith drawing spec. Start with topic "overview", a short cheat sheet. ' +
  'Use "spec" for the exact JSON Schema, "rules" for the rule table, and "examples" for complete specs to copy from.';

const OVERVIEW = `gridsmith draws logo marks and magic-circle figures from a JSON construction spec. You declare circles, lines and polygons; the server solves the geometry, checks the rules and renders the drawing and a construction sheet.

COORDINATES
- Origin at the canvas centre, x right, y up. Angles are degrees counter-clockwise from +x (90 = straight up).
- The unit is the module. R = grid.divisions modules (4, 6 or 8). The canvas is a square of half side R + grid.margin (margin defaults to 1).
- A length is a number (0.05 to 64 modules) or an expression: R or <circle id>.r, followed by * or / with 2 to 16, sqrt2, sqrt3, phi or phi2 (phi squared). Examples: "R/2", "outer.r*sqrt3/2". No spaces, parentheses, + or -.

MODES (one per spec)
- mark: filled shapes only. paint = [{ fill: Region, color? }]. A Region is an id (disc, polygon, points, repeat of those), { half, toward }, or { union | intersect | subtract: [Region, ...] }. At most 8 circles. Keep it legible at 64, 32 and 16 px.
- figure: line drawing only. paint = [{ stroke: [ids], width, color? }, { erase: [ids] }]. Circles draw as circumferences, lines as segments, arcs as partial circumferences, polygons as outlines, a repeat as every copy. At most 16 circles; arcs do not count. Helper circles that nothing strokes are fine when a stroked shape refers to them.
- erase layer (figure only, never first): hides every earlier layer inside the listed circles, polygons or points (or repeats of those), leaving the background transparent. Later layers draw on top. Use it for medallions that cut the bands behind them.

ELEMENTS (shapes[]; ids are lowercase, unique, not "spec")
point, circle, tangent_circle, line, arc, polygon, points, repeat. Topic "spec" has the exact schema.

REFERENCES
- An element may refer only to elements declared earlier in shapes.
- A point is [x, y], an element id (a point, or a circle's centre), { on: circle id, angle } or { intersect: [a, b], near: point }.
- Two circles, or a circle and a line, can meet in two points. near picks the candidate closest to the point you give; a rough location is enough. When there is one candidate (tangent, or two lines) near may be omitted. Zero candidates, infinitely many, or a tie are resolve errors that list the candidates.
- tangent_circle { r, to: [a, b], near } is the circle of radius r touching both a and b (circles or lines). Candidates include external and internal contact with circles and both sides of a line; the one whose centre is closest to near wins. The render report lists each contact point.
- { half: line id, toward: point } is the side of the infinite line that contains the point. Lines are infinite in intersections, tangents and half-planes; they are drawn as segments only when stroked.
- repeat { of: [ids], n, center?, mirror?, axis? } copies the shapes n times about center, 360/n degrees apart. mirror adds the reflection across the line at angle axis through center.
- arc { on: circle id, from, to } runs counter-clockwise from from to to along the circle. Each end is degrees or a point on the circle, typically { intersect: [circle, other], near }: an arc between two intersection points. Stroke it or repeat it; it cannot be a region or a reference base.
- polygon { in: circle id, n, step?, rotate? } inscribes a regular n-gon; step 2 or more draws a star ({6/2} is a hexagram).

RULES (topic "rules" has the table)
At most 3 distinct ratios; numeric radii and coordinates on a 0.5 grid (mark) or 0.25 grid (figure); degree angles that are multiples of 180/n for n in 2, 3, 4, 5, 6, 8, 10, 12, 20, 24; polygon.n and repeat.n from that same set; everything inside the canvas; no unused shapes. Violations do not stop gridsmith_render, but gridsmith_export refuses until each is fixed or excused by an exceptions entry { rule, target, reason }.

WORKFLOW
1. Write the spec to a JSON file with an absolute path, e.g. /tmp/work/mark.json.
2. Call gridsmith_render with spec set to that path. Read geometry (resolved centres, radii, tangent points), violations and hints in the JSON, and look at the images. A mark returns the sheet and 64/32/16 px sizes; a figure returns the sheet and the final drawing. Other views: guides (final drawing with every construction element over it), and svg, sheet_svg, guides_svg (SVG markup as text).
3. Edit the file and render again. Resolve errors list every failing element at once, root causes first.
4. When violations is empty (exportable is true), call gridsmith_export with dir (absolute), name and the same spec path. Existing files are never replaced unless overwrite is true.
An inline spec object also works; a path avoids resending it.`;

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
};

const LAYER_NOTES: Record<string, string> = {
  erase:
    'figure only, never paint[0]: { erase: [ids] } hides all earlier layers inside the listed circles, tangent_circles, polygons, points or repeats of those (a polygon counts as the area its outline encloses). Later layers are not hidden. Ids are distinct.',
};

const CONSTRAINTS = [
  'An element refers only to elements declared earlier in shapes. Ids are unique, match ^[a-z][a-z0-9_]{0,31}$ and are never "spec".',
  'polygon.step must satisfy 1 <= step < n/2. repeat.n is at least 2 unless mirror is true.',
  'mode "mark" accepts only fill layers and "figure" only stroke and erase layers. A fill region must be bounded: a half-plane needs a disc or polygon to intersect with, or to be subtracted from.',
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
