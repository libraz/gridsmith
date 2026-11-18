import { z } from 'zod';
import {
  LENGTH_EXPRESSION_MAX_CHARS,
  LENGTH_EXPRESSION_PATTERN,
  parseLengthExpression,
} from './length.js';

/** Every rule id a lint pass can report. */
export const RULE_IDS = [
  'ratio_count',
  'circle_count',
  'off_grid',
  'angle',
  'off_canvas',
  'empty_fill',
  'thin_stroke',
  'unused_shape',
  'uneven_steps',
  'width_count',
  'unused_exception',
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export const ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
/** Id reserved as the exception target for whole-spec rules. */
export const RESERVED_ID = 'spec';

export const LENGTH_MIN = 0.05;
export const LENGTH_MAX = 64;
export const WIDTH_MIN = 0.005;
export const WIDTH_MAX = 8;
export const COORDINATE_MAX = 64;
export const ANGLE_MAX = 3600;
/** Deepest chain of `intersect` points allowed inside a `near` or `toward`. */
export const MAX_POINT_NESTING = 2;
export const MAX_REGION_DEPTH = 8;
/** Support curves a `mark` may hold after `repeat` expansion. */
export const MAX_SUPPORT_CURVES = 256;
/** Elements a `figure` may draw after `repeat` expansion. */
export const MAX_DRAWN_ELEMENTS = 2048;

export type Point =
  | [number, number]
  | string
  | { on: string; angle: number }
  | { intersect: [string, string]; near?: Point | undefined };

export type Region =
  | string
  | { half: string; toward: Point }
  | { union: Region[] }
  | { intersect: Region[] }
  | { subtract: Region[] };

/** A length: modules as a number, or a length expression string. */
export type Length = number | string;

type RawIssue = z.core.$ZodRawIssue;
type Path = (string | number)[];

const show = (value: unknown): string => {
  if (typeof value === 'number') {
    return String(value);
  }
  if (value === undefined) {
    return 'undefined';
  }
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  text ??= String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

const complain = (what: string, allowed: string) => (iss: RawIssue) =>
  `${what} is invalid (received: ${show(iss.input)}; allowed: ${allowed})`;

const unionError =
  (what: string, allowed: string, pick: (input: unknown) => number | undefined) =>
  (iss: RawIssue) => {
    const base = `${what} is invalid (received: ${show(iss.input)}; allowed: ${allowed})`;
    if (iss.code !== 'invalid_union') {
      return base;
    }
    const index = pick(iss.input);
    const nested = index === undefined ? [] : (iss.errors[index] ?? []);
    if (nested.length === 0) {
      return base;
    }
    const detail = nested
      .slice(0, 3)
      .map((i) =>
        i.path.length > 0 ? `${i.path.map(String).join('.')}: ${i.message}` : i.message,
      );
    return `${base}: ${detail.join('; ')}`;
  };

const numberIn = (what: string, lo: number, hi: number) => {
  const error = complain(what, `a finite number from ${lo} to ${hi}`);
  return z.number({ error }).min(lo, { error }).max(hi, { error });
};

const intIn = (what: string, lo: number, hi: number) => {
  const error = complain(what, `an integer from ${lo} to ${hi}`);
  return z.int({ error }).min(lo, { error }).max(hi, { error });
};

const listOf = <T extends z.ZodType>(item: T, what: string, min: number, max: number) => {
  const error = complain(what, `an array of ${min} to ${max} items`);
  return z.array(item, { error }).min(min, { error }).max(max, { error });
};

// Zod counts code points; the spec counts UTF-16 code units.
const unitsAtMost = (max: number) => (text: string) => text.length <= max;

const refId = (what: string) => z.string({ error: complain(what, 'an element id string') });

const coordinate = numberIn('coordinate', -COORDINATE_MAX, COORDINATE_MAX);
const angle = numberIn('angle', -ANGLE_MAX, ANGLE_MAX);

const idPair = (what: string) =>
  z.tuple([refId(what), refId(what)], {
    error: complain(what, 'an array of exactly 2 element ids'),
  });

const lengthSchema: z.ZodType<Length, Length> = z.union(
  [
    numberIn('length', LENGTH_MIN, LENGTH_MAX),
    z.string().max(LENGTH_EXPRESSION_MAX_CHARS).regex(LENGTH_EXPRESSION_PATTERN),
  ],
  {
    error: complain(
      'length',
      `a number from ${LENGTH_MIN} to ${LENGTH_MAX} modules, or an expression such as "R/2" or "a.r*sqrt2" (base R or <circle id>.r, then * or / with 2 to 16, sqrt2, sqrt3, phi or phi2; at most ${LENGTH_EXPRESSION_MAX_CHARS} characters)`,
    ),
  },
);

const widthSchema: z.ZodType<Length, Length> = z.union(
  [
    numberIn('width', WIDTH_MIN, WIDTH_MAX),
    z.string().max(LENGTH_EXPRESSION_MAX_CHARS).regex(LENGTH_EXPRESSION_PATTERN),
  ],
  {
    error: complain(
      'width',
      `a number from ${WIDTH_MIN} to ${WIDTH_MAX} modules, or a length expression such as "R/16" (result must also be within that range)`,
    ),
  },
);

const pointSchema: z.ZodType<Point, Point> = z.union(
  [
    z.tuple([coordinate, coordinate], {
      error: complain(
        'point',
        `an array of 2 coordinates, each from -${COORDINATE_MAX} to ${COORDINATE_MAX}`,
      ),
    }),
    refId('point'),
    z.strictObject({ on: refId('on'), angle }),
    z.strictObject({
      intersect: idPair('intersect'),
      get near() {
        return pointSchema.optional();
      },
    }),
  ],
  {
    error: unionError(
      'point',
      '[x, y], an element id, { on, angle } or { intersect: [a, b], near? }',
      (input) => {
        if (Array.isArray(input)) {
          return 0;
        }
        if (typeof input === 'string') {
          return 1;
        }
        if (typeof input === 'object' && input !== null) {
          if ('on' in input) {
            return 2;
          }
          if ('intersect' in input) {
            return 3;
          }
        }
        return undefined;
      },
    ),
  },
);

const operands = () => listOf(regionSchema, 'region operand list', 2, 16);

const regionSchema: z.ZodType<Region, Region> = z.union(
  [
    refId('region'),
    z.strictObject({ half: refId('half'), toward: pointSchema }),
    z.strictObject({
      get union() {
        return operands();
      },
    }),
    z.strictObject({
      get intersect() {
        return operands();
      },
    }),
    z.strictObject({
      get subtract() {
        return operands();
      },
    }),
  ],
  {
    error: unionError(
      'region',
      'an element id, { half, toward }, { union: [...] }, { intersect: [...] } or { subtract: [...] }',
      (input) => {
        if (typeof input === 'string') {
          return 0;
        }
        if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
          const keys = ['half', 'union', 'intersect', 'subtract'];
          const at = keys.findIndex((k) => k in input);
          return at < 0 ? undefined : at + 1;
        }
        return undefined;
      },
    ),
  },
);

const idSchema = z
  .string({ error: complain('id', 'a string matching ^[a-z][a-z0-9_]{0,31}$') })
  .regex(ID_PATTERN, { error: complain('id', 'a string matching ^[a-z][a-z0-9_]{0,31}$') });

const colorSchema = z
  .string({ error: complain('color', 'a string like "#1a2B3c"') })
  .regex(COLOR_PATTERN, { error: complain('color', 'a string like "#1a2B3c"') })
  .default('#000000');

const origin = (): [number, number] => [0, 0];

const pointShape = z.strictObject({
  id: idSchema,
  type: z.literal('point'),
  at: pointSchema,
});

const circleShape = z.strictObject({
  id: idSchema,
  type: z.literal('circle'),
  center: pointSchema.default(origin),
  r: lengthSchema,
});

const tangentCircleShape = z.strictObject({
  id: idSchema,
  type: z.literal('tangent_circle'),
  r: lengthSchema,
  to: idPair('to'),
  near: pointSchema,
});

const lineShape = z.strictObject({
  id: idSchema,
  type: z.literal('line'),
  from: pointSchema,
  to: pointSchema,
});

const polygonShape = z
  .strictObject({
    id: idSchema,
    type: z.literal('polygon'),
    in: refId('in'),
    n: intIn('n', 3, 36),
    step: intIn('step', 1, 17).default(1),
    rotate: angle.default(0),
  })
  .superRefine((shape, ctx) => {
    if (2 * shape.step >= shape.n) {
      ctx.addIssue({
        code: 'custom',
        path: ['step'],
        message: `step is out of range for n (received: ${shape.step} with n=${shape.n}; allowed: an integer with 1 <= step < n/2 = ${shape.n / 2})`,
      });
    }
  });

const arcEnd = z.union([angle, pointSchema], {
  error: complain(
    'arc end',
    `an angle in degrees from -${ANGLE_MAX} to ${ANGLE_MAX}, or a point on the circle ([x, y], an element id, { on, angle } or { intersect: [a, b], near? })`,
  ),
});

const arcShape = z.strictObject({
  id: idSchema,
  type: z.literal('arc'),
  on: refId('on'),
  from: arcEnd,
  to: arcEnd,
});

const pointsShape = z.strictObject({
  id: idSchema,
  type: z.literal('points'),
  through: listOf(pointSchema, 'through', 3, 32),
});

const outlinePiece = z.union(
  [
    refId('piece'),
    z.strictObject({
      on: refId('on'),
      concave: z.boolean({ error: complain('concave', 'true or false') }).optional(),
      corner: pointSchema.optional(),
    }),
  ],
  {
    error: unionError('outline piece', 'an element id or { on, concave?, corner? }', (input) => {
      if (typeof input === 'string') {
        return 0;
      }
      return typeof input === 'object' && input !== null && !Array.isArray(input) ? 1 : undefined;
    }),
  },
);

const outlineShape = z.strictObject({
  id: idSchema,
  type: z.literal('outline'),
  through: listOf(outlinePiece, 'through', 2, 64),
});

const repeatShape = z
  .strictObject({
    id: idSchema,
    type: z.literal('repeat'),
    of: listOf(refId('of'), 'of', 1, 8),
    n: intIn('n', 1, 36),
    center: pointSchema.default(origin),
    mirror: z.boolean({ error: complain('mirror', 'true or false') }).default(false),
    axis: angle.default(90),
  })
  .superRefine((shape, ctx) => {
    if (!shape.mirror && shape.n < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['n'],
        message: `n is too small without mirror (received: ${shape.n}; allowed: 2 to 36, or 1 when mirror is true)`,
      });
    }
  });

const polylineShape = z.strictObject({
  id: idSchema,
  type: z.literal('polyline'),
  through: z
    .array(pointSchema, { error: complain('through', 'an array of 3 to 32 points') })
    .min(3, { error: complain('through', 'an array of 3 to 32 points') })
    .max(32, { error: complain('through', 'an array of 3 to 32 points') }),
});

const rectShape = z.strictObject({
  id: idSchema,
  type: z.literal('rect'),
  corners: z.tuple([pointSchema, pointSchema], {
    error: complain('corners', 'an array of 2 points'),
  }),
  r: lengthSchema.optional(),
});

const ovalShape = z.strictObject({
  id: idSchema,
  type: z.literal('oval'),
  center: pointSchema,
  rx: lengthSchema,
  ry: lengthSchema,
  rotate: angle.default(0),
});

const shapeSchema = z.discriminatedUnion(
  'type',
  [
    pointShape,
    circleShape,
    tangentCircleShape,
    lineShape,
    arcShape,
    polygonShape,
    pointsShape,
    outlineShape,
    repeatShape,
    polylineShape,
    rectShape,
    ovalShape,
  ],
  {
    error: complain(
      'type',
      'one of "point", "circle", "tangent_circle", "line", "arc", "polygon", "points", "outline", "repeat", "polyline", "rect", "oval"',
    ),
  },
);

const fillLayer = z.strictObject({ fill: regionSchema, color: colorSchema });

const dashLength = z
  .number({ error: complain('dash', 'an array of 2 lengths: dash, gap') })
  .gt(0, { error: complain('dash', 'an array of 2 lengths: dash, gap') })
  .max(64, { error: complain('dash', 'an array of 2 lengths: dash, gap') });

const strokeLayer = z.strictObject({
  stroke: listOf(refId('stroke'), 'stroke', 1, 32),
  width: widthSchema,
  color: colorSchema,
  cap: z
    .enum(['round', 'butt', 'square'], { error: complain('cap', '"round", "butt" or "square"') })
    .optional(),
  join: z
    .enum(['round', 'miter', 'bevel'], { error: complain('join', '"round", "miter" or "bevel"') })
    .optional(),
  dash: z
    .tuple([dashLength, dashLength], {
      error: complain('dash', 'an array of 2 lengths: dash, gap'),
    })
    .optional(),
});

const eraseLayer = z.strictObject({ erase: listOf(refId('erase'), 'erase', 1, 32) });

const paintSchema = z.union([fillLayer, strokeLayer, eraseLayer], {
  error: unionError(
    'paint layer',
    '{ fill: Region, color? } (mark), or { stroke: [ids], width, color? } or { erase: [ids] } (figure)',
    (input) => {
      if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
        if ('fill' in input) {
          return 0;
        }
        if ('stroke' in input) {
          return 1;
        }
        if ('erase' in input) {
          return 2;
        }
      }
      return undefined;
    },
  ),
});

const exceptionSchema = z.strictObject({
  rule: z.enum(RULE_IDS).exclude(['unused_exception'], {
    error: complain(
      'rule',
      `one of ${RULE_IDS.filter((r) => r !== 'unused_exception').join(', ')} (unused_exception cannot be excepted)`,
    ),
  }),
  target: z
    .string({ error: complain('target', 'a string: a shape id, "spec" or "paint[i]"') })
    .min(1),
  reason: z
    .string({ error: complain('reason', 'a string of 1 to 200 characters') })
    .min(1, { error: complain('reason', 'a string of 1 to 200 characters') })
    .max(200, { error: complain('reason', 'a string of 1 to 200 characters') })
    .refine(unitsAtMost(200), { error: complain('reason', 'a string of 1 to 200 characters') }),
});

export type Shape = z.infer<typeof shapeSchema>;
export type PointShape = z.infer<typeof pointShape>;
export type CircleShape = z.infer<typeof circleShape>;
export type TangentCircleShape = z.infer<typeof tangentCircleShape>;
export type LineShape = z.infer<typeof lineShape>;
export type PolygonShape = z.infer<typeof polygonShape>;
export type ArcShape = z.infer<typeof arcShape>;
export type PointsShape = z.infer<typeof pointsShape>;
export type OutlineShape = z.infer<typeof outlineShape>;
export type PolylineShape = z.infer<typeof polylineShape>;
export type RectShape = z.infer<typeof rectShape>;
export type OvalShape = z.infer<typeof ovalShape>;
export type OutlinePiece = z.infer<typeof outlinePiece>;
export type RepeatShape = z.infer<typeof repeatShape>;
export type CircleLikeShape = CircleShape | TangentCircleShape;
export type FillLayer = z.infer<typeof fillLayer>;
export type StrokeLayer = z.infer<typeof strokeLayer>;
export type EraseLayer = z.infer<typeof eraseLayer>;
export type PaintLayer = z.infer<typeof paintSchema>;
export type RuleException = z.infer<typeof exceptionSchema>;

/** True for `circle` and `tangent_circle`. */
export function isCircleLike(shape: { type: string }): shape is CircleLikeShape {
  return shape.type === 'circle' || shape.type === 'tangent_circle';
}

/** Ids referenced by a length expression (its `<id>.r` base), or none. */
export function lengthReferences(length: Length): string[] {
  if (typeof length === 'number') {
    return [];
  }
  const base = parseLengthExpression(length)?.base;
  return base?.kind === 'circle' ? [base.id] : [];
}

/** Ids referenced by a point, including nested `near` points. */
export function pointReferences(point: Point): string[] {
  if (typeof point === 'string') {
    return [point];
  }
  if (Array.isArray(point)) {
    return [];
  }
  if ('on' in point) {
    return [point.on];
  }
  return [...point.intersect, ...(point.near === undefined ? [] : pointReferences(point.near))];
}

/** Ids referenced by a region, including `half` lines and `toward` points. */
export function regionReferences(region: Region): string[] {
  if (typeof region === 'string') {
    return [region];
  }
  if ('half' in region) {
    return [region.half, ...pointReferences(region.toward)];
  }
  const children =
    'union' in region ? region.union : 'intersect' in region ? region.intersect : region.subtract;
  return children.flatMap(regionReferences);
}

/** Distinct ids a shape references (points, bases, circles, lines, repeated shapes). */
export function shapeReferences(shape: Shape): string[] {
  let ids: string[];
  switch (shape.type) {
    case 'point':
      ids = pointReferences(shape.at);
      break;
    case 'circle':
      ids = [...pointReferences(shape.center), ...lengthReferences(shape.r)];
      break;
    case 'tangent_circle':
      ids = [...lengthReferences(shape.r), ...shape.to, ...pointReferences(shape.near)];
      break;
    case 'line':
      ids = [...pointReferences(shape.from), ...pointReferences(shape.to)];
      break;
    case 'arc':
      ids = [
        shape.on,
        ...(typeof shape.from === 'number' ? [] : pointReferences(shape.from)),
        ...(typeof shape.to === 'number' ? [] : pointReferences(shape.to)),
      ];
      break;
    case 'polygon':
      ids = [shape.in];
      break;
    case 'points':
      ids = shape.through.flatMap(pointReferences);
      break;
    case 'outline':
      ids = shape.through.flatMap((piece) =>
        typeof piece === 'string'
          ? [piece]
          : [piece.on, ...(piece.corner === undefined ? [] : pointReferences(piece.corner))],
      );
      break;
    case 'repeat':
      ids = [...shape.of, ...pointReferences(shape.center)];
      break;
    case 'polyline':
      ids = shape.through.flatMap(pointReferences);
      break;
    case 'rect':
      ids = [
        ...shape.corners.flatMap(pointReferences),
        ...(shape.r === undefined ? [] : lengthReferences(shape.r)),
      ];
      break;
    case 'oval':
      ids = [
        ...pointReferences(shape.center),
        ...lengthReferences(shape.rx),
        ...lengthReferences(shape.ry),
      ];
      break;
  }
  return [...new Set(ids)];
}

/** Distinct ids a paint layer references. */
export function paintReferences(layer: PaintLayer): string[] {
  let ids: string[];
  if ('fill' in layer) {
    ids = regionReferences(layer.fill);
  } else if ('erase' in layer) {
    ids = layer.erase;
  } else {
    ids = [...layer.stroke, ...lengthReferences(layer.width)];
  }
  return [...new Set(ids)];
}

/** Structural boundedness of a region: discs and polygons are bounded, half-planes are not. */
export function isRegionBounded(region: Region): boolean {
  if (typeof region === 'string') {
    return true;
  }
  if ('half' in region) {
    return false;
  }
  if ('union' in region) {
    return region.union.every(isRegionBounded);
  }
  if ('intersect' in region) {
    return region.intersect.some(isRegionBounded);
  }
  const [head] = region.subtract;
  return head !== undefined && isRegionBounded(head);
}

type KindSet = { label: string; types: readonly Shape['type'][] };

const kindSet = (label: string, types: readonly Shape['type'][]): KindSet => ({ label, types });

const CIRCLE_LIKE = kindSet('the id of a circle or tangent_circle', ['circle', 'tangent_circle']);
const ARC_BASE = kindSet('the id of a circle, tangent_circle or oval', [
  'circle',
  'tangent_circle',
  'oval',
]);
const CIRCLE_OR_LINE = kindSet('the id of a circle, tangent_circle or line', [
  'circle',
  'tangent_circle',
  'line',
]);
const POINT_REF = kindSet('the id of a point, circle or tangent_circle', [
  'point',
  'circle',
  'tangent_circle',
]);
const LINE_ONLY = kindSet('the id of a line', ['line']);
const REPEATABLE = kindSet(
  'the id of a circle, tangent_circle, line, arc, polygon, points, outline, polyline, rect or oval',
  [
    'circle',
    'tangent_circle',
    'line',
    'arc',
    'polygon',
    'points',
    'outline',
    'polyline',
    'rect',
    'oval',
  ],
);
const STROKABLE = kindSet('the id of any shape except point', [
  'circle',
  'tangent_circle',
  'line',
  'arc',
  'polygon',
  'points',
  'outline',
  'repeat',
  'polyline',
  'rect',
  'oval',
]);
const ERASABLE = kindSet(
  'the id of a circle, tangent_circle, polygon, points, outline, rect, oval or repeat of those',
  ['circle', 'tangent_circle', 'polygon', 'points', 'outline', 'repeat', 'rect', 'oval'],
);
const REGION_LEAF = kindSet(
  'the id of a circle, tangent_circle, polygon, points, outline, rect, oval or repeat',
  ['circle', 'tangent_circle', 'polygon', 'points', 'outline', 'repeat', 'rect', 'oval'],
);

const TARGET_PAINT = /^paint\[(0|[1-9][0-9]*)\]$/;

const repeatCopies = (shape: RepeatShape) => shape.n * (shape.mirror ? 2 : 1);

const curveCount = (shape: Shape): number => {
  switch (shape.type) {
    case 'point':
    case 'repeat':
      return 0;
    case 'polygon':
      return shape.n;
    case 'points':
    case 'outline':
      return shape.through.length;
    case 'polyline':
      return shape.through.length - 1;
    case 'rect':
      return 8;
    case 'oval':
      return 4;
    default:
      return 1;
  }
};

const specObject = z.strictObject({
  version: z.literal(1, { error: complain('version', '1') }),
  mode: z.enum(['mark', 'figure', 'icon'], {
    error: complain('mode', '"mark", "figure" or "icon"'),
  }),
  grid: z.strictObject({
    divisions: z.literal([4, 6, 8, 12], {
      error: complain('divisions', '4, 6 or 8, or 12 for an icon'),
    }),
    margin: intIn('margin', 0, 4).optional(),
  }),
  concept: z
    .string({ error: complain('concept', 'a string of 1 to 400 characters') })
    .min(1, { error: complain('concept', 'a string of 1 to 400 characters') })
    .max(400, { error: complain('concept', 'a string of 1 to 400 characters') })
    .refine(unitsAtMost(400), { error: complain('concept', 'a string of 1 to 400 characters') })
    .optional(),
  shapes: listOf(shapeSchema, 'shapes', 1, 64),
  paint: listOf(paintSchema, 'paint', 1, 16),
  exceptions: listOf(exceptionSchema, 'exceptions', 0, 16).default([]),
});

/** Cross-element checks: ids, references, kinds, boundedness, caps and exceptions. */
function checkSpec(spec: z.output<typeof specObject>, ctx: z.core.$RefinementCtx): void {
  const add = (path: Path, message: string): void => {
    ctx.addIssue({ code: 'custom', path, message });
  };

  const { divisions, margin } = spec.grid;
  if (spec.mode === 'icon' && divisions !== 12) {
    add(
      ['grid', 'divisions'],
      `divisions is invalid (received: ${divisions}; allowed: 12 when mode is "icon")`,
    );
  } else if (spec.mode !== 'icon' && divisions === 12) {
    add(
      ['grid', 'divisions'],
      `divisions is invalid (received: ${divisions}; allowed: 4, 6 or 8 unless mode is "icon")`,
    );
  }
  if (spec.mode === 'icon' && margin !== undefined && margin !== 0) {
    add(
      ['grid', 'margin'],
      `margin is invalid (received: ${margin}; allowed: 0 or omitted when mode is "icon")`,
    );
  }

  const byId = new Map<string, { index: number; shape: Shape }>();
  spec.shapes.forEach((shape, index) => {
    if (shape.id === RESERVED_ID) {
      add(
        ['shapes', index, 'id'],
        `id is reserved (received: "${shape.id}"; allowed: any id other than "${RESERVED_ID}")`,
      );
    }
    const first = byId.get(shape.id);
    if (first !== undefined) {
      add(
        ['shapes', index, 'id'],
        `duplicate id (received: "${shape.id}", already used by shapes[${first.index}]; allowed: each id once)`,
      );
    } else {
      byId.set(shape.id, { index, shape });
    }
  });

  // Resolves a reference; `limit` is the first index that is not yet visible.
  const lookup = (id: string, limit: number, path: Path, set: KindSet, scope: string) => {
    const found = byId.get(id);
    if (found === undefined) {
      add(path, `unknown id (received: ${show(id)}; allowed: ${set.label} ${scope})`);
    } else if (found.index >= limit) {
      add(
        path,
        `forward reference (received: ${show(id)}, declared at shapes[${found.index}]; allowed: ${set.label} ${scope})`,
      );
    } else if (!set.types.includes(found.shape.type)) {
      add(
        path,
        `wrong kind of element (received: ${show(id)}, a ${found.shape.type}; allowed: ${set.label})`,
      );
    }
  };

  const checkDistinct = (ids: readonly string[], path: Path) => {
    ids.forEach((id, k) => {
      if (ids.indexOf(id) !== k) {
        add([...path, k], `duplicate entry (received: ${show(id)}; allowed: each id at most once)`);
      }
    });
  };

  const checkPoint = (point: Point, path: Path, limit: number, scope: string, depth: number) => {
    if (typeof point === 'string') {
      lookup(point, limit, path, POINT_REF, scope);
    } else if (!Array.isArray(point) && 'on' in point) {
      lookup(point.on, limit, [...path, 'on'], CIRCLE_LIKE, scope);
    } else if (!Array.isArray(point)) {
      if (depth > MAX_POINT_NESTING) {
        add(
          path,
          `intersect is nested too deeply inside near/toward (received: depth ${depth}; allowed: at most ${MAX_POINT_NESTING} levels)`,
        );
        return;
      }
      for (const [k, id] of point.intersect.entries()) {
        lookup(id, limit, [...path, 'intersect', k], CIRCLE_OR_LINE, scope);
      }
      checkDistinct(point.intersect, [...path, 'intersect']);
      if (point.near !== undefined) {
        checkPoint(point.near, [...path, 'near'], limit, scope, depth + 1);
      }
    }
  };

  const checkLength = (length: Length, path: Path, limit: number, scope: string) => {
    for (const id of lengthReferences(length)) {
      lookup(id, limit, path, CIRCLE_LIKE, scope);
    }
  };

  const earlier = 'declared earlier in shapes';

  spec.shapes.forEach((shape, i) => {
    const at = (...rest: (string | number)[]): Path => ['shapes', i, ...rest];
    switch (shape.type) {
      case 'point':
        checkPoint(shape.at, at('at'), i, earlier, 0);
        break;
      case 'circle':
        checkPoint(shape.center, at('center'), i, earlier, 0);
        checkLength(shape.r, at('r'), i, earlier);
        break;
      case 'tangent_circle':
        checkLength(shape.r, at('r'), i, earlier);
        for (const [k, id] of shape.to.entries()) {
          lookup(id, i, at('to', k), CIRCLE_OR_LINE, earlier);
        }
        checkDistinct(shape.to, at('to'));
        checkPoint(shape.near, at('near'), i, earlier, 1);
        break;
      case 'line':
        checkPoint(shape.from, at('from'), i, earlier, 0);
        checkPoint(shape.to, at('to'), i, earlier, 0);
        break;
      case 'arc':
        lookup(shape.on, i, at('on'), ARC_BASE, earlier);
        for (const key of ['from', 'to'] as const) {
          const end = shape[key];
          if (typeof end === 'number') {
            continue;
          }
          if (byId.get(shape.on)?.shape.type === 'oval') {
            add(
              at(key),
              `arc end is invalid (received: ${show(end)}; allowed: degrees when "on" names an oval)`,
            );
          } else {
            checkPoint(end, at(key), i, earlier, 0);
          }
        }
        break;
      case 'polygon':
        lookup(shape.in, i, at('in'), CIRCLE_LIKE, earlier);
        break;
      case 'points':
        for (const [k, p] of shape.through.entries()) {
          checkPoint(p, at('through', k), i, earlier, 0);
        }
        break;
      case 'outline':
        for (const [k, piece] of shape.through.entries()) {
          if (typeof piece === 'string') {
            lookup(piece, i, at('through', k), CIRCLE_OR_LINE, earlier);
            continue;
          }
          lookup(piece.on, i, at('through', k, 'on'), CIRCLE_OR_LINE, earlier);
          if (piece.concave !== undefined && byId.get(piece.on)?.shape.type === 'line') {
            add(
              at('through', k, 'concave'),
              `concave is not allowed on a line piece (received: ${show(piece.concave)} on line ${show(piece.on)}; allowed: concave only on a circle or tangent_circle piece)`,
            );
          }
          if (piece.corner !== undefined) {
            checkPoint(piece.corner, at('through', k, 'corner'), i, earlier, 1);
          }
        }
        break;
      case 'polyline':
        for (const [k, p] of shape.through.entries()) {
          checkPoint(p, at('through', k), i, earlier, 0);
        }
        break;
      case 'rect':
        for (const [k, p] of shape.corners.entries()) {
          checkPoint(p, at('corners', k), i, earlier, 0);
        }
        if (shape.r !== undefined) {
          checkLength(shape.r, at('r'), i, earlier);
        }
        break;
      case 'oval':
        checkPoint(shape.center, at('center'), i, earlier, 0);
        checkLength(shape.rx, at('rx'), i, earlier);
        checkLength(shape.ry, at('ry'), i, earlier);
        break;
      case 'repeat': {
        shape.of.forEach((id, k) => {
          const found = byId.get(id);
          if (
            found !== undefined &&
            found.index < i &&
            !REPEATABLE.types.includes(found.shape.type)
          ) {
            add(
              at('of', k),
              `repeat cannot repeat this element (received: ${show(id)}, a ${found.shape.type}; allowed: ${REPEATABLE.label})`,
            );
          } else {
            lookup(id, i, at('of', k), REPEATABLE, earlier);
          }
        });
        checkDistinct(shape.of, at('of'));
        checkPoint(shape.center, at('center'), i, earlier, 0);
        break;
      }
    }
  });

  const total = spec.shapes.length;
  const declared = 'declared in shapes';

  const checkRegion = (region: Region, path: Path, level: number) => {
    if (typeof region === 'string') {
      lookup(region, total, path, REGION_LEAF, declared);
      const found = byId.get(region);
      if (found?.shape.type === 'repeat') {
        for (const id of found.shape.of) {
          const inner = byId.get(id);
          if (
            inner !== undefined &&
            (inner.shape.type === 'line' ||
              inner.shape.type === 'arc' ||
              inner.shape.type === 'polyline')
          ) {
            add(
              path,
              `region uses a repeat of a ${inner.shape.type} (received: ${show(region)} repeating ${show(id)}; allowed: a repeat of circles, tangent_circles, polygons or points)`,
            );
          }
        }
      }
      return;
    }
    if ('half' in region) {
      lookup(region.half, total, [...path, 'half'], LINE_ONLY, declared);
      checkPoint(region.toward, [...path, 'toward'], total, declared, 1);
      return;
    }
    const key = 'union' in region ? 'union' : 'intersect' in region ? 'intersect' : 'subtract';
    if (level > MAX_REGION_DEPTH) {
      add(
        path,
        `region is nested too deeply (received: ${key} at depth ${level}; allowed: at most ${MAX_REGION_DEPTH} levels of union/intersect/subtract)`,
      );
      return;
    }
    const children =
      'union' in region ? region.union : 'intersect' in region ? region.intersect : region.subtract;
    for (const [k, child] of children.entries()) {
      checkRegion(child, [...path, key, k], level + 1);
    }
  };

  spec.paint.forEach((layer, j) => {
    const at = (...rest: (string | number)[]): Path => ['paint', j, ...rest];
    if ('fill' in layer) {
      if (spec.mode === 'figure') {
        add(
          at(),
          `fill layer in a ${spec.mode} spec (received: fill; allowed: stroke layers when mode is "figure")`,
        );
        return;
      }
      checkRegion(layer.fill, at('fill'), 1);
      if (!isRegionBounded(layer.fill)) {
        add(
          at('fill'),
          'fill region is unbounded (received: a region that can extend to infinity; allowed: a bounded region; intersect a half-plane with a disc, or use a points shape instead)',
        );
      }
    } else if ('erase' in layer) {
      if (spec.mode === 'icon') {
        add(
          at(),
          'erase layer in an icon spec (received: erase; allowed: "fill" or "stroke" layers when mode is "icon")',
        );
        return;
      }
      if (spec.mode === 'mark') {
        add(
          at(),
          `erase layer in a ${spec.mode} spec (received: erase; allowed: fill layers when mode is "mark")`,
        );
        return;
      }
      if (j === 0) {
        add(
          at(),
          'erase layer is first (received: erase as paint[0]; allowed: a stroke layer before it, since an erase layer hides what is drawn earlier)',
        );
      }
      for (const [k, id] of layer.erase.entries()) {
        lookup(id, total, at('erase', k), ERASABLE, declared);
        const found = byId.get(id);
        if (found?.shape.type === 'repeat') {
          for (const inner of found.shape.of) {
            const type = byId.get(inner)?.shape.type;
            if (type === 'line' || type === 'arc' || type === 'polyline') {
              add(
                at('erase', k),
                `erase uses a repeat of a ${type} (received: ${show(id)} repeating ${show(inner)}; allowed: a repeat of circles, tangent_circles, polygons or points)`,
              );
            }
          }
        }
      }
      checkDistinct(layer.erase, at('erase'));
    } else {
      if (spec.mode === 'mark') {
        add(
          at(),
          `stroke layer in a ${spec.mode} spec (received: stroke; allowed: fill layers when mode is "mark")`,
        );
        return;
      }
      for (const [k, id] of layer.stroke.entries()) {
        lookup(id, total, at('stroke', k), STROKABLE, declared);
      }
      checkDistinct(layer.stroke, at('stroke'));
      checkLength(layer.width, at('width'), total, declared);
    }
  });

  if (spec.mode !== 'figure') {
    const repeated = new Set(spec.shapes.flatMap((s) => (s.type === 'repeat' ? s.of : [])));
    let curves = 0;
    for (const [index, shape] of spec.shapes.entries()) {
      if (shape.type === 'repeat') {
        const per = shape.of.reduce((sum, id) => sum + curveCount(byId.get(id)?.shape ?? shape), 0);
        curves += repeatCopies(shape) * per;
      } else if (!repeated.has(shape.id)) {
        curves += curveCount(shape);
      }
      if (curves > MAX_SUPPORT_CURVES) {
        add(
          ['shapes', index],
          `too many support curves after repeat expansion (received: at least ${curves}; allowed: at most ${MAX_SUPPORT_CURVES})`,
        );
        break;
      }
    }
  }
  if (spec.mode !== 'mark') {
    let drawn = 0;
    outer: for (const [j, layer] of spec.paint.entries()) {
      if (!('stroke' in layer)) {
        continue;
      }
      for (const [k, id] of layer.stroke.entries()) {
        const shape = byId.get(id)?.shape;
        drawn += shape?.type === 'repeat' ? repeatCopies(shape) * shape.of.length : 1;
        if (drawn > MAX_DRAWN_ELEMENTS) {
          add(
            ['paint', j, 'stroke', k],
            `too many drawn elements after repeat expansion (received: at least ${drawn}; allowed: at most ${MAX_DRAWN_ELEMENTS})`,
          );
          break outer;
        }
      }
    }
  }

  const seen = new Set<string>();
  spec.exceptions.forEach((exception, e) => {
    const path: Path = ['exceptions', e, 'target'];
    const { target } = exception;
    const paintIndex = TARGET_PAINT.exec(target)?.[1];
    const valid =
      target === RESERVED_ID ||
      byId.has(target) ||
      (paintIndex !== undefined && Number(paintIndex) < spec.paint.length);
    if (!valid) {
      add(
        path,
        `unknown exception target (received: ${show(target)}; allowed: a shape id, "spec", or "paint[i]" with i below ${spec.paint.length})`,
      );
    }
    const key = `${exception.rule}\u0000${target}`;
    if (seen.has(key)) {
      add(
        path,
        `duplicate exception (received: rule ${exception.rule} on ${show(target)}; allowed: each rule and target pair once)`,
      );
    }
    seen.add(key);
  });
}

/** The strict schema of a drawing spec, including cross-element checks. */
export const specSchema = specObject.superRefine(checkSpec).transform((spec) => ({
  ...spec,
  grid: { ...spec.grid, margin: spec.grid.margin ?? (spec.mode === 'icon' ? 0 : 1) },
}));

export type Spec = z.infer<typeof specSchema>;
export type SpecInput = z.input<typeof specSchema>;
