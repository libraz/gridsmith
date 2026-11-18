import { describe, expect, it } from 'vitest';
import { arrange } from '../../src/geom/arrangement.js';
import { EXAMPLES } from '../../src/guide/examples.js';
import { resolveSpec } from '../../src/resolve/resolve.js';
import { lint } from '../../src/rules/lint.js';
import { specSchema } from '../../src/spec/schema.js';

const evaluateExample = (input: unknown) => {
  const spec = specSchema.parse(input);
  const resolved = resolveSpec(spec);
  if (!resolved.ok) {
    throw new Error(`resolve failed: ${JSON.stringify(resolved.errors)}`);
  }
  const fills = resolved.model.fills.map((layer) => arrange(layer.region));
  return { spec, fills, result: lint(spec, resolved.model, fills) };
};

const ofMode = (mode: string) => EXAMPLES.filter((e) => e.spec.mode === mode);

describe('guide examples', () => {
  it('has at least three examples of each mode', () => {
    expect(ofMode('mark').length).toBeGreaterThanOrEqual(3);
    expect(ofMode('figure').length).toBeGreaterThanOrEqual(3);
  });

  it('uses unique kebab-case names and one-sentence descriptions', () => {
    const names = EXAMPLES.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const example of EXAMPLES) {
      expect(example.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(example.description.length).toBeGreaterThan(0);
    }
  });

  it('includes the two reference examples', () => {
    expect(EXAMPLES.some((e) => e.name === 'crescent' && e.spec.mode === 'mark')).toBe(true);
    expect(EXAMPLES.some((e) => e.name === 'hexagram-circle' && e.spec.mode === 'figure')).toBe(
      true,
    );
  });

  it('shows the new figure features: erase layers, arcs between intersection points and arcs in a repeat', () => {
    const find = (name: string) => EXAMPLES.find((e) => e.name === name)?.spec;
    const sigil = find('sigil-medallions');
    expect(sigil?.paint.some((layer) => 'erase' in layer)).toBe(true);
    expect(sigil?.paint.findIndex((layer) => 'erase' in layer)).toBeGreaterThan(0);

    const moon = find('crescent-moon');
    const arcs = moon?.shapes.filter((s) => s.type === 'arc') ?? [];
    expect(arcs).toHaveLength(2);

    const rosette = find('petal-rosette');
    const ids = new Set(rosette?.shapes.filter((s) => s.type === 'arc').map((s) => s.id));
    expect(ids.size).toBeGreaterThan(0);
    expect(
      rosette?.shapes.some((s) => s.type === 'repeat' && s.of.every((id) => ids.has(id))),
    ).toBe(true);
  });

  it('puts every petal tip of the rosette on its outer circle', () => {
    const spec = specSchema.parse(EXAMPLES.find((e) => e.name === 'petal-rosette')?.spec);
    const resolved = resolveSpec(spec);
    if (!resolved.ok) {
      throw new Error('resolve failed');
    }
    const tip = resolved.model.elements.find((el) => el.id === 'tip');
    expect(tip?.type).toBe('point');
    if (tip?.type === 'point') {
      expect(Math.hypot(tip.x, tip.y)).toBeCloseTo(resolved.model.R, 9);
    }
  });

  it('erases the bands behind the medallions of the sigil and keeps its circle count within the cap', () => {
    const example = EXAMPLES.find((e) => e.name === 'sigil-medallions');
    const resolved = resolveSpec(specSchema.parse(example?.spec));
    if (!resolved.ok) {
      throw new Error(JSON.stringify(resolved.errors));
    }
    expect(resolved.model.erases[0]?.shapes).toHaveLength(8);
    const circles = example?.spec.shapes.filter(
      (s) => s.type === 'circle' || s.type === 'tangent_circle',
    );
    expect(circles?.length).toBeLessThanOrEqual(16);
  });

  it('keeps the hexagram circle within 700 characters', () => {
    const example = EXAMPLES.find((e) => e.name === 'hexagram-circle');
    expect(JSON.stringify(example?.spec).length).toBeLessThanOrEqual(700);
  });

  describe('whale', () => {
    const example = EXAMPLES.find((e) => e.name === 'whale');
    const resolved = () => {
      const result = resolveSpec(specSchema.parse(example?.spec));
      if (!result.ok) {
        throw new Error(JSON.stringify(result.errors));
      }
      return result.model;
    };

    it('is a mark with one outline of seven pieces', () => {
      expect(example?.spec.mode).toBe('mark');
      const outlines = example?.spec.shapes.filter((s) => s.type === 'outline') ?? [];
      expect(outlines).toHaveLength(1);
      expect(outlines[0]?.type === 'outline' && outlines[0].through).toHaveLength(7);
    });

    it('has twelve circles, three corners and two concave pieces', () => {
      const shapes = example?.spec.shapes ?? [];
      expect(shapes.filter((s) => s.type === 'circle' || s.type === 'tangent_circle')).toHaveLength(
        12,
      );
      const outline = shapes.find((s) => s.type === 'outline');
      const pieces = outline?.type === 'outline' ? outline.through : [];
      const objects = pieces.filter((p) => typeof p !== 'string');
      expect(objects.filter((p) => p.corner !== undefined)).toHaveLength(3);
      expect(objects.filter((p) => p.concave === true)).toHaveLength(2);
    });

    it('fills the silhouette minus the eye plus two spout crescents', () => {
      const { fills } = evaluateExample(example?.spec);
      expect(fills).toHaveLength(1);
      expect(fills[0]?.area).toBeCloseTo(87.6634, 4);
    });

    it('resolves its outline and eye into the model', () => {
      const model = resolved();
      expect(model.elements.some((el) => el.id === 'whale')).toBe(true);
      expect(model.fills).toHaveLength(1);
    });
  });

  describe('line-chart', () => {
    const example = EXAMPLES.find((e) => e.name === 'line-chart');

    it('is an icon that mixes fill and stroke layers', () => {
      expect(example?.spec.mode).toBe('icon');
      const kinds = example?.spec.paint.map((layer) => ('fill' in layer ? 'fill' : 'stroke'));
      expect(kinds).toEqual(['fill', 'stroke', 'stroke', 'fill']);
    });

    it('shares the last vertex of the trend with the dot through one point', () => {
      const shapes = example?.spec.shapes ?? [];
      const trend = shapes.find((s) => s.id === 'trend');
      const dot = shapes.find((s) => s.id === 'dot');
      expect(trend?.type === 'polyline' && trend.through.at(-1)).toBe('p4');
      expect(dot?.type === 'circle' && dot.center).toBe('p4');
    });

    it('draws one fill and one stroke segment per paint layer', () => {
      const resolved = resolveSpec(specSchema.parse(example?.spec));
      if (!resolved.ok) {
        throw new Error(JSON.stringify(resolved.errors));
      }
      expect(resolved.model.fills).toHaveLength(2);
      expect(resolved.model.strokes).toHaveLength(2);
    });
  });

  for (const example of EXAMPLES) {
    describe(example.name, () => {
      it('validates, resolves and lints without violations or exceptions', () => {
        const { spec, result } = evaluateExample(example.spec);
        expect(spec.exceptions).toEqual([]);
        expect(result.violations).toEqual([]);
        expect(result.exceptionsApplied).toEqual([]);
      });

      if (example.spec.mode === 'mark') {
        it('fills at least one loop with positive area', () => {
          const { fills } = evaluateExample(example.spec);
          expect(fills.length).toBeGreaterThan(0);
          for (const fill of fills) {
            expect(fill.loops.length).toBeGreaterThanOrEqual(1);
            expect(fill.area).toBeGreaterThan(0);
          }
        });
      }
    });
  }
});
