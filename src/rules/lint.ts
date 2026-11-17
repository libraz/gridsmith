import type { FillResult } from '../geom/arrangement.js';
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
      'before repeat expansion; arcs are not circles. Target: "spec".',
    modes: ['mark', 'figure'],
    maxCircles: { mark: 8, figure: 16 },
  },
  off_grid: {
    description:
      'Numeric point coordinates and numeric radii must be multiples of 0.5 module in a mark and 0.25 module ' +
      'in a figure. Length expressions, references, widths and anything inside near/toward are exempt. ' +
      'Target: the element id.',
    modes: ['mark', 'figure'],
    gridStep: { mark: 0.5, figure: 0.25 },
    tolerance: 1e-9,
  },
  angle: {
    description:
      'Angles written in degrees (on.angle, polygon.rotate, repeat.axis, arc from/to) must be a multiple of 180/n for some n in ' +
      '{2, 3, 4, 5, 6, 8, 10, 12, 20, 24}; polygon.n and repeat.n (when 2 or more) must be in that set. ' +
      'Target: the element id.',
    modes: ['mark', 'figure'],
    divisors: [2, 3, 4, 5, 6, 8, 10, 12, 20, 24],
    tolerance: 1e-9,
  },
  off_canvas: {
    description:
      'Everything drawn must stay inside the square canvas of half side R + margin. A figure stroke counts ' +
      'half its width beyond the geometry (an arc by its own bounding box); a mark counts the bounding box of the filled region. ' +
      'Target: the element id (figure) or "paint[i]" (mark).',
    modes: ['mark', 'figure'],
    tolerance: 1e-9,
  },
  empty_fill: {
    description: 'A fill layer must produce at least one closed outline. Target: "paint[i]".',
    modes: ['mark'],
  },
  thin_stroke: {
    description:
      'With the canvas drawn 512 px wide, a stroke must be at least 1 px wide ' +
      '(width * 512 / (2 * (R + margin)) >= 1). Target: "paint[i]".',
    modes: ['figure'],
    canvasPx: 512,
    minPx: 1,
  },
  unused_shape: {
    description:
      'Every element must be reachable from a paint layer (stroke or erase) through references. Helper circles that a drawn ' +
      'element refers to are fine; a chain that nothing paints is reported element by element. Target: the element id.',
    modes: ['mark', 'figure'],
  },
  unused_exception: {
    description:
      'An exception that matches no violation is reported. This rule cannot itself be excepted. ' +
      'Target: "exceptions[i]".',
    modes: ['mark', 'figure'],
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

const isMultiple = (value: number, unit: number, tolerance: number): boolean => {
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
function pointSlots(shape: Shape): { label: string; point: Point }[] {
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

function checkCircleCount(spec: Spec): Finding[] {
  const count = spec.shapes.filter(isCircleLike).length;
  const max = RULES.circle_count.maxCircles[spec.mode];
  if (count <= max) {
    return [];
  }
  return [
    {
      target: RESERVED_ID,
      message: `${count} circles declared, at most ${max} allowed in ${spec.mode}`,
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
    // A tangent circle's only point is `near`, which is exempt.
    const slots = shape.type === 'tangent_circle' ? [] : pointSlots(shape);
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
  }
}

function checkOffCanvas(spec: Spec, model: ResolvedModel, fills: readonly FillResult[]): Finding[] {
  const { tolerance } = RULES.off_canvas;
  const half = model.canvasHalf;
  if (model.mode === 'mark') {
    const findings: Finding[] = [];
    model.fills.forEach((fill, i) => {
      const box = fills[i]?.bbox;
      if (box === null || box === undefined) {
        return;
      }
      const reach = Math.max(-box.minX, box.maxX, -box.minY, box.maxY);
      if (reach > half + tolerance) {
        findings.push({
          target: `paint[${fill.index}]`,
          message: `fill reaches ${fmt(reach)} from the centre, canvas half side is ${fmt(half)}`,
        });
      }
    });
    return findings;
  }
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
  return spec.shapes.flatMap((shape) => {
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
}

function checkEmptyFill(model: ResolvedModel, fills: readonly FillResult[]): Finding[] {
  return model.fills.flatMap((fill, i) =>
    fills[i]?.loops.length === 0
      ? [{ target: `paint[${fill.index}]`, message: 'fill has no closed outline (it is empty)' }]
      : [],
  );
}

function checkThinStroke(model: ResolvedModel): Finding[] {
  const { canvasPx, minPx } = RULES.thin_stroke;
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
  return spec.shapes
    .filter((shape) => !reached.has(shape.id))
    .map((shape) => ({
      target: shape.id,
      message: `${shape.type} is not reachable from any paint layer through references`,
    }));
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
  const findings: Record<Exclude<RuleId, 'unused_exception'>, Finding[]> = {
    ratio_count: checkRatioCount(spec),
    circle_count: checkCircleCount(spec),
    off_grid: checkOffGrid(spec),
    angle: checkAngle(spec),
    off_canvas: checkOffCanvas(spec, model, fills),
    empty_fill: checkEmptyFill(model, fills),
    thin_stroke: checkThinStroke(model),
    unused_shape: checkUnusedShape(spec),
  };
  const all: Violation[] = [];
  for (const rule of RULE_IDS) {
    if (rule !== 'unused_exception') {
      for (const f of findings[rule]) {
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
