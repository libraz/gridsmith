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
