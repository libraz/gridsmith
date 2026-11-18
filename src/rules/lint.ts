import type { FillResult } from '../geom/arrangement.js';
import type { ChainPiece } from '../geom/chain.js';
import type { Circle, Line, Vec } from '../geom/primitives.js';
import { centerOf, distance, EPS, pointOnCircle, signedDistance } from '../geom/primitives.js';
import type { ArcGeometry, ResolvedModel } from '../resolve/resolve.js';
import { lengthSignature } from '../spec/length.js';
import type { Point, RuleId, Shape, Spec } from '../spec/schema.js';
import {
  isCircleLike,
  paintReferences,
  RESERVED_ID,
  RULE_IDS,
  shapeReferences,
} from '../spec/schema.js';

type Mode = Spec['mode'];

type RuleDefinition = { description: string; modes: readonly Mode[] } & Record<string, unknown>;

/** Rule table: what each rule checks, where it applies and the numbers it uses. */
export const RULES = {
  ratio_count: {
    description:
      'Length expressions (circle radii and stroke widths) may use at most 3 distinct ratios. ' +
      'Ratios are compared as normalised signatures, so "R/2" and "R*2" count once, as do "R*phi*phi" and "R*phi2"; ' +
      'plain numbers carry no ratio. Target: "spec".',
    modes: ['mark', 'figure'],
    maxRatios: 3,
  },
  circle_count: {
    description:
      'At most 8 circles (circle and tangent_circle) in a mark and 16 in a figure, counted as declared, ' +
      'before repeat expansion; arcs are not circles. A mark with an outline that a fill reaches may have 40, ' +
      'and an icon 40. ' +
      'Target: "spec".',
    modes: ['mark', 'figure', 'icon'],
    maxCircles: { mark: 8, mark_outline: 40, figure: 16, icon: 40 },
  },
  off_grid: {
    description:
      'Numeric point coordinates and numeric lengths (radii, rect.r, oval rx and ry) must be multiples of 0.5 module ' +
      '(a rect.r of half its shorter side is exempt) in a mark and an icon and 0.25 module in a figure. Length expressions, references, widths, dashes ' +
      'and anything inside near/toward are exempt. Target: the element id.',
    modes: ['mark', 'figure', 'icon'],
    gridStep: { mark: 0.5, figure: 0.25, icon: 0.5 },
    tolerance: 1e-9,
  },
  angle: {
    description:
      'Angles written in degrees (on.angle, polygon.rotate, oval.rotate, repeat.axis, arc from/to) must be a multiple of 180/n for some n in ' +
      '{2, 3, 4, 5, 6, 8, 10, 12, 20, 24}; polygon.n and repeat.n (when 2 or more) must be in that set. ' +
      'Target: the element id.',
    modes: ['mark', 'figure', 'icon'],
    divisors: [2, 3, 4, 5, 6, 8, 10, 12, 20, 24],
    tolerance: 1e-9,
  },
  off_canvas: {
    description:
      'Everything drawn must stay inside the square canvas of half side R + margin. A stroke counts ' +
      'half its width beyond the geometry (an arc or outline by its own bounding box); a fill counts the bounding box of the filled region. ' +
      'Target: the element id (stroke) or "paint[i]" (fill).',
    modes: ['mark', 'figure', 'icon'],
    tolerance: 1e-9,
  },
  empty_fill: {
    description: 'A fill layer must produce at least one closed outline. Target: "paint[i]".',
    modes: ['mark', 'icon'],
  },
  thin_stroke: {
    description:
      'In a figure, with the canvas drawn 512 px wide, a stroke must be at least 1 px wide ' +
      '(width * 512 / (2 * (R + margin)) >= 1); in an icon it must be at least 0.5 module wide. Target: "paint[i]".',
    modes: ['figure', 'icon'],
    canvasPx: 512,
    minPx: 1,
    minWidth: { icon: 0.5 },
  },
  unused_shape: {
    description:
      'Every element must be reachable from a paint layer (stroke or erase) through references. Helper circles that a drawn ' +
      'element refers to are fine; a chain that nothing paints is reported element by element. Target: the element id.',
    modes: ['mark', 'figure', 'icon'],
  },
  uneven_steps: {
    description:
      'A polyline of 3 or more segments whose x (or y) runs one way in every segment while the other axis also moves ' +
      'in every segment must have equal steps along that axis. Flat segments (stairs, letter shapes) are not checked. ' +
      'Target: the element id.',
    modes: ['figure', 'icon'],
    tolerance: 1e-9,
  },
  width_count: {
    description:
      'An icon may use at most 3 distinct stroke widths (widths within 1e-9 count once). Target: "spec".',
    modes: ['icon'],
    maxWidths: 3,
    tolerance: 1e-9,
  },
  unused_exception: {
    description:
      'An exception that matches no violation is reported. This rule cannot itself be excepted. ' +
      'Target: "exceptions[i]".',
    modes: ['mark', 'figure', 'icon'],
  },
} satisfies Record<RuleId, RuleDefinition>;

/** Thresholds of the near-tangent hint (not a rule: hints never block export). */
export const HINTS = {
  nearTangent: { maxGap: 0.05, maxCount: 16 },
} as const;

export type Violation = { rule: RuleId; target: string; message: string };
export type AppliedException = { rule: RuleId; target: string; reason: string };
export type Hint = { kind: 'near_tangent'; a: string; b: string; gap: number };

type Finding = { target: string; message: string };

const fmt = (x: number): string => String(Number(x.toPrecision(6)));

export const isMultiple = (value: number, unit: number, tolerance: number): boolean => {
  const k = value / unit;
  return Math.abs(k - Math.round(k)) <= tolerance;
};

// Numeric coordinates of a literal [x, y] point; references, on-points and near are exempt.
function literalCoordinates(point: Point): [number, number] | null {
  return Array.isArray(point) ? point : null;
}

// Every on.angle inside a point, including those nested under near.
function pointAngles(point: Point): number[] {
  if (typeof point === 'string' || Array.isArray(point)) {
    return [];
  }
  if ('on' in point) {
    return [point.angle];
  }
  return point.near === undefined ? [] : pointAngles(point.near);
}

/** Named point slots of a shape, in the order they are written. */
export function pointSlots(shape: Shape): { label: string; point: Point }[] {
  switch (shape.type) {
    case 'point':
      return [{ label: 'at', point: shape.at }];
    case 'circle':
      return [{ label: 'center', point: shape.center }];
    case 'tangent_circle':
      return [{ label: 'near', point: shape.near }];
    case 'line':
      return [
        { label: 'from', point: shape.from },
        { label: 'to', point: shape.to },
      ];
    case 'arc':
      return [
        ...(typeof shape.from === 'number' ? [] : [{ label: 'from', point: shape.from }]),
        ...(typeof shape.to === 'number' ? [] : [{ label: 'to', point: shape.to }]),
      ];
    case 'points':
      return shape.through.map((point, k) => ({ label: `through[${k}]`, point }));
    case 'repeat':
      return [{ label: 'center', point: shape.center }];
    case 'outline':
      return shape.through.flatMap((piece, k) =>
        typeof piece === 'string' || piece.corner === undefined
          ? []
          : [{ label: `through[${k}] corner`, point: piece.corner }],
      );
    case 'polyline':
      return shape.through.map((point, k) => ({ label: `through[${k}]`, point }));
    case 'rect':
      return shape.corners.map((point, k) => ({ label: `corners[${k}]`, point }));
    case 'oval':
      return [{ label: 'center', point: shape.center }];
    case 'polygon':
      return [];
  }
}

function checkRatioCount(spec: Spec): Finding[] {
  const lengths: (number | string)[] = [];
  for (const shape of spec.shapes) {
    if (shape.type === 'circle' || shape.type === 'tangent_circle') {
      lengths.push(shape.r);
    }
  }
  for (const layer of spec.paint) {
    if ('stroke' in layer) {
      lengths.push(layer.width);
    }
  }
  const examples = new Map<string, string>();
  for (const length of lengths) {
    const signature = lengthSignature(length);
    if (signature !== null && !examples.has(signature)) {
      examples.set(signature, String(length));
    }
  }
  const max = RULES.ratio_count.maxRatios;
  if (examples.size <= max) {
    return [];
  }
  return [
    {
      target: RESERVED_ID,
      message: `${examples.size} distinct ratios, at most ${max} allowed: ${[...examples.values()].join(', ')}`,
    },
  ];
}

// Ids reachable from a paint layer through references.
function reachableIds(spec: Spec): Set<string> {
  const byId = new Map(spec.shapes.map((shape) => [shape.id, shape]));
  const reached = new Set<string>();
  const pending = spec.paint.flatMap(paintReferences);
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (reached.has(id)) {
      continue;
    }
    reached.add(id);
    const shape = byId.get(id);
    if (shape !== undefined) {
      pending.push(...shapeReferences(shape));
    }
  }
  return reached;
}

function checkCircleCount(spec: Spec): Finding[] {
  const count = spec.shapes.filter(isCircleLike).length;
  const { maxCircles } = RULES.circle_count;
  const reached = spec.mode === 'mark' ? reachableIds(spec) : null;
  const withOutline =
    reached !== null &&
    spec.shapes.some((shape) => shape.type === 'outline' && reached.has(shape.id));
  const max = withOutline ? maxCircles.mark_outline : maxCircles[spec.mode];
  if (count <= max) {
    return [];
  }
  return [
    {
      target: RESERVED_ID,
      message: `${count} circles declared, at most ${max} allowed in ${spec.mode}${withOutline ? ' with an outline' : ''}`,
    },
  ];
}

function checkOffGrid(spec: Spec): Finding[] {
  const { gridStep, tolerance } = RULES.off_grid;
  const step = gridStep[spec.mode];
  const findings: Finding[] = [];
  for (const shape of spec.shapes) {
    const problems: string[] = [];
    const test = (label: string, value: number): void => {
      if (!isMultiple(value, step, tolerance)) {
        problems.push(`${label} ${fmt(value)} is not a multiple of ${step}`);
      }
    };
    // The only points of a tangent circle and an outline are hints (`near`, `corner`): exempt.
    const hintOnly = shape.type === 'tangent_circle' || shape.type === 'outline';
    const slots = hintOnly ? [] : pointSlots(shape);
    for (const { label, point } of slots) {
      const xy = literalCoordinates(point);
      if (xy !== null) {
        test(`${label} x`, xy[0]);
        test(`${label} y`, xy[1]);
      }
    }
    if (isCircleLike(shape) && typeof shape.r === 'number') {
      test('r', shape.r);
    }
    if (shape.type === 'rect' && typeof shape.r === 'number') {
      const [a, b] = shape.corners;
      const halfShort =
        Array.isArray(a) && Array.isArray(b)
          ? Math.min(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / 2
          : null;
      // A radius of half the shorter side is derived from the corners, not chosen.
      if (halfShort === null || Math.abs(shape.r - halfShort) > tolerance) {
        test('r', shape.r);
      }
    } else if (shape.type === 'oval') {
      if (typeof shape.rx === 'number') {
        test('rx', shape.rx);
      }
      if (typeof shape.ry === 'number') {
        test('ry', shape.ry);
      }
    }
    if (problems.length > 0) {
      findings.push({ target: shape.id, message: problems.join('; ') });
    }
  }
  return findings;
}

function checkAngle(spec: Spec): Finding[] {
  const { divisors, tolerance } = RULES.angle;
  const allowed = divisors.join(', ');
  const isAllowedAngle = (theta: number): boolean =>
    divisors.some((n) => isMultiple(theta * n, 180, tolerance));
  const findings: Finding[] = [];
  for (const shape of spec.shapes) {
    const problems: string[] = [];
    const testAngle = (label: string, theta: number): void => {
      if (!isAllowedAngle(theta)) {
        problems.push(
          `${label} ${fmt(theta)} is not a multiple of 180/n for any n in {${allowed}}`,
        );
      }
    };
    const testCount = (label: string, n: number): void => {
      if (!divisors.includes(n)) {
        problems.push(`${label} ${n} is not in {${allowed}}`);
      }
    };
    for (const { label, point } of pointSlots(shape)) {
      for (const theta of pointAngles(point)) {
        testAngle(`${label} angle`, theta);
      }
    }
    if (shape.type === 'arc') {
      for (const label of ['from', 'to'] as const) {
        const end = shape[label];
        if (typeof end === 'number') {
          testAngle(label, end);
        }
      }
    } else if (shape.type === 'polygon') {
      testCount('n', shape.n);
      testAngle('rotate', shape.rotate);
    } else if (shape.type === 'repeat') {
      if (shape.n >= 2) {
        testCount('n', shape.n);
      }
      testAngle('axis', shape.axis);
    } else if (shape.type === 'oval') {
      testAngle('rotate', shape.rotate);
    }
    if (problems.length > 0) {
      findings.push({ target: shape.id, message: problems.join('; ') });
    }
  }
  return findings;
}

// Bounding-box extent of an arc: its ends plus each axis extreme inside the sweep.
function arcReach(arc: ArcGeometry): number {
  const { circle, from, sweep } = arc;
  const points: Vec[] = [arc.start, arc.end];
  for (const axis of [0, 90, 180, 270]) {
    if ((axis - from + 360) % 360 <= sweep) {
      points.push(pointOnCircle(circle, axis));
    }
  }
  return Math.max(...points.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))));
}

// Bounding-box extent of a chain: its joints plus each axis extreme inside an arc's range.
function chainReach(pieces: readonly ChainPiece[]): number {
  const points: Vec[] = [];
  for (const piece of pieces) {
    points.push(piece.start);
    if (piece.kind === 'arc') {
      for (let k = 0; k < 4; k++) {
        const offset = ((k * Math.PI) / 2 - piece.from) * (piece.ccw ? 1 : -1);
        const wrapped = ((offset % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        if (wrapped <= piece.sweep) {
          points.push(pointOnCircle(piece.circle, k * 90));
        }
      }
    }
  }
  // An open run ends away from where it starts; a closed chain's last end is its first start.
  const last = pieces[pieces.length - 1];
  if (last !== undefined) {
    points.push(last.end);
  }
  return Math.max(...points.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))));
}

// Largest distance from the origin along either axis, the canvas being a square about it.
function strokeReach(item: ResolvedModel['strokes'][number]['items'][number]): number {
  switch (item.kind) {
    case 'circle':
      return Math.max(Math.abs(item.circle.cx), Math.abs(item.circle.cy)) + item.circle.r;
    case 'arc':
      return arcReach(item);
    case 'segment':
      return Math.max(
        Math.abs(item.from.x),
        Math.abs(item.from.y),
        Math.abs(item.to.x),
        Math.abs(item.to.y),
      );
    case 'polygon':
      return Math.max(...item.loops.flat().map((v) => Math.max(Math.abs(v.x), Math.abs(v.y))));
    case 'chain':
      return chainReach(item.pieces);
    case 'polyline':
      return Math.max(...item.points.map((v) => Math.max(Math.abs(v.x), Math.abs(v.y))));
  }
}

function checkOffCanvas(spec: Spec, model: ResolvedModel, fills: readonly FillResult[]): Finding[] {
  const { tolerance } = RULES.off_canvas;
  const half = model.canvasHalf;
  const fillFindings: Finding[] = [];
  model.fills.forEach((fill, i) => {
    const box = fills[i]?.bbox;
    if (box === null || box === undefined) {
      return;
    }
    const reach = Math.max(-box.minX, box.maxX, -box.minY, box.maxY);
    if (reach > half + tolerance) {
      fillFindings.push({
        target: `paint[${fill.index}]`,
        message: `fill reaches ${fmt(reach)} from the centre, canvas half side is ${fmt(half)}`,
      });
    }
  });
  const worst = new Map<string, { reach: number; halfWidth: number }>();
  for (const stroke of model.strokes) {
    const halfWidth = stroke.width / 2;
    for (const item of stroke.items) {
      const reach = strokeReach(item) + halfWidth;
      const seen = worst.get(item.via);
      if (reach > half + tolerance && (seen === undefined || reach > seen.reach)) {
        worst.set(item.via, { reach, halfWidth });
      }
    }
  }
  const strokeFindings = spec.shapes.flatMap((shape) => {
    const found = worst.get(shape.id);
    return found === undefined
      ? []
      : [
          {
            target: shape.id,
            message: `reaches ${fmt(found.reach)} from the centre including half the stroke width ${fmt(found.halfWidth)}, canvas half side is ${fmt(half)}`,
          },
        ];
  });
  return [...fillFindings, ...strokeFindings];
}

function checkEmptyFill(model: ResolvedModel, fills: readonly FillResult[]): Finding[] {
  return model.fills.flatMap((fill, i) =>
    fills[i]?.loops.length === 0
      ? [{ target: `paint[${fill.index}]`, message: 'fill has no closed outline (it is empty)' }]
      : [],
  );
}

function checkThinStroke(model: ResolvedModel): Finding[] {
  const { canvasPx, minPx, minWidth } = RULES.thin_stroke;
  if (model.mode === 'icon') {
    return model.strokes.flatMap((stroke) =>
      stroke.width < minWidth.icon - EPS
        ? [
            {
              target: `paint[${stroke.index}]`,
              message: `stroke is ${fmt(stroke.width)} wide, at least ${minWidth.icon} required`,
            },
          ]
        : [],
    );
  }
  return model.strokes.flatMap((stroke) => {
    const px = (stroke.width * canvasPx) / (2 * model.canvasHalf);
    return px < minPx
      ? [
          {
            target: `paint[${stroke.index}]`,
            message: `stroke is ${fmt(px)} px wide when the canvas is ${canvasPx} px, at least ${minPx} px required`,
          },
        ]
      : [];
  });
}

function checkUnusedShape(spec: Spec): Finding[] {
  const reached = reachableIds(spec);
  return spec.shapes
    .filter((shape) => !reached.has(shape.id))
    .map((shape) => ({
      target: shape.id,
      message: `${shape.type} is not reachable from any paint layer through references`,
    }));
}

const signOf = (d: number, tolerance: number): number =>
  Math.abs(d) <= tolerance ? 0 : Math.sign(d);

// True when every delta moves the same way and none is zero.
const runsOneWay = (deltas: readonly number[], tolerance: number): boolean => {
  const first = signOf(deltas[0] ?? 0, tolerance);
  return first !== 0 && deltas.every((d) => signOf(d, tolerance) === first);
};

const movesEverywhere = (deltas: readonly number[], tolerance: number): boolean =>
  deltas.every((d) => signOf(d, tolerance) !== 0);

/**
 * The axis a polyline of 4 or more vertices must have equal steps along, with the signed
 * steps along it; null when `uneven_steps` does not look at the polyline.
 */
export function stepAxis(
  vertices: readonly Vec[],
  tolerance: number = RULES.uneven_steps.tolerance,
): { axis: 'x' | 'y'; deltas: number[] } | null {
  if (vertices.length < 4) {
    return null;
  }
  const dx: number[] = [];
  const dy: number[] = [];
  vertices.slice(1).forEach((v, k) => {
    const prev = vertices[k] as Vec;
    dx.push(v.x - prev.x);
    dy.push(v.y - prev.y);
  });
  if (runsOneWay(dx, tolerance) && movesEverywhere(dy, tolerance)) {
    return { axis: 'x', deltas: dx };
  }
  if (runsOneWay(dy, tolerance) && movesEverywhere(dx, tolerance)) {
    return { axis: 'y', deltas: dy };
  }
  return null;
}

function checkUnevenSteps(model: ResolvedModel): Finding[] {
  const { tolerance } = RULES.uneven_steps;
  const findings: Finding[] = [];
  for (const el of model.elements) {
    if (el.type !== 'polyline') {
      continue;
    }
    const found = stepAxis(el.vertices, tolerance);
    if (found === null) {
      continue;
    }
    const steps = found.deltas.map(Math.abs);
    if (Math.max(...steps) - Math.min(...steps) > tolerance) {
      findings.push({
        target: el.id,
        message: `${steps.length} segments with uneven steps along ${found.axis}: ${steps.map(fmt).join(', ')}`,
      });
    }
  }
  return findings;
}

function checkWidthCount(model: ResolvedModel): Finding[] {
  const { maxWidths, tolerance } = RULES.width_count;
  const widths = model.strokes.map((stroke) => stroke.width).sort((a, b) => a - b);
  const distinct = widths.filter((w, k) => k === 0 || w - (widths[k - 1] as number) > tolerance);
  if (distinct.length <= maxWidths) {
    return [];
  }
  return [
    {
      target: RESERVED_ID,
      message: `${distinct.length} distinct stroke widths, at most ${maxWidths} allowed: ${distinct.map(fmt).join(', ')}`,
    },
  ];
}

function nearTangentHints(model: ResolvedModel): Hint[] {
  const { maxGap, maxCount } = HINTS.nearTangent;
  const items = model.elements.flatMap((el): { id: string; circle?: Circle; line?: Line }[] =>
    el.type === 'circle' || el.type === 'tangent_circle'
      ? [{ id: el.id, circle: el.circle }]
      : el.type === 'line'
        ? [{ id: el.id, line: el.line }]
        : [],
  );
  const hints: Hint[] = [];
  items.forEach((a, i) => {
    for (const b of items.slice(i + 1)) {
      let gap: number | null = null;
      if (a.circle !== undefined && b.circle !== undefined) {
        const d = distance(centerOf(a.circle), centerOf(b.circle));
        gap = Math.min(
          Math.abs(d - (a.circle.r + b.circle.r)),
          Math.abs(d - Math.abs(a.circle.r - b.circle.r)),
        );
      } else if (a.circle !== undefined && b.line !== undefined) {
        gap = Math.abs(Math.abs(signedDistance(b.line, centerOf(a.circle))) - a.circle.r);
      } else if (a.line !== undefined && b.circle !== undefined) {
        gap = Math.abs(Math.abs(signedDistance(a.line, centerOf(b.circle))) - b.circle.r);
      }
      if (gap !== null && gap > EPS && gap <= maxGap) {
        hints.push({ kind: 'near_tangent', a: a.id, b: b.id, gap });
      }
    }
  });
  return hints.sort((x, y) => x.gap - y.gap).slice(0, maxCount);
}

/**
 * Checks a resolved spec against every rule.
 *
 * `fills[i]` is the arrangement of `model.fills[i]`; pass an empty array for a figure.
 * Exceptions in the spec remove matching violations; those matching nothing are reported
 * as `unused_exception`.
 */
export function lint(
  spec: Spec,
  model: ResolvedModel,
  fills: readonly FillResult[],
): { violations: Violation[]; exceptionsApplied: AppliedException[]; hints: Hint[] } {
  const checks: Record<Exclude<RuleId, 'unused_exception'>, () => Finding[]> = {
    ratio_count: () => checkRatioCount(spec),
    circle_count: () => checkCircleCount(spec),
    off_grid: () => checkOffGrid(spec),
    angle: () => checkAngle(spec),
    off_canvas: () => checkOffCanvas(spec, model, fills),
    empty_fill: () => checkEmptyFill(model, fills),
    thin_stroke: () => checkThinStroke(model),
    unused_shape: () => checkUnusedShape(spec),
    uneven_steps: () => checkUnevenSteps(model),
    width_count: () => checkWidthCount(model),
  };
  const all: Violation[] = [];
  for (const rule of RULE_IDS) {
    if (rule !== 'unused_exception' && (RULES[rule].modes as readonly Mode[]).includes(spec.mode)) {
      for (const f of checks[rule]()) {
        all.push({ rule, ...f });
      }
    }
  }

  const exceptionsApplied: AppliedException[] = [];
  const suppressed = new Set<Violation>();
  const unused: Violation[] = [];
  spec.exceptions.forEach((exception, i) => {
    const matches = all.filter((v) => v.rule === exception.rule && v.target === exception.target);
    if (matches.length === 0) {
      unused.push({
        rule: 'unused_exception',
        target: `exceptions[${i}]`,
        message: `exception for ${exception.rule} on "${exception.target}" matches no violation`,
      });
      return;
    }
    for (const v of matches) {
      suppressed.add(v);
    }
    exceptionsApplied.push({
      rule: exception.rule,
      target: exception.target,
      reason: exception.reason,
    });
  });

  return {
    violations: [...all.filter((v) => !suppressed.has(v)), ...unused],
    exceptionsApplied,
    hints: nearTangentHints(model),
  };
}
