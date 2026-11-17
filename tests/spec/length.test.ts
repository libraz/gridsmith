import { describe, expect, it } from 'vitest';
import {
  evaluateFactors,
  evaluateLengthExpression,
  type LengthExpression,
  lengthLabel,
  lengthSignature,
  PHI,
  parseLengthExpression,
  ratioSignature,
  SQRT2,
  SQRT3,
} from '../../src/spec/length.js';

const parse = (text: string): LengthExpression => {
  const expr = parseLengthExpression(text);
  if (expr === null) {
    throw new Error(`expected ${text} to parse`);
  }
  return expr;
};

const sig = (text: string) => ratioSignature(parse(text));

describe('parseLengthExpression', () => {
  it.each([
    'R',
    'R/2',
    'R*16',
    'R*10/13',
    'R*sqrt2',
    'R/sqrt3',
    'R*phi*phi2',
    'a.r',
    'ring_1.r/3*phi',
    `${'a'.repeat(31)}.r`,
  ])('accepts %s', (text) => {
    expect(parseLengthExpression(text)).not.toBeNull();
  });

  it.each([
    'R/pi',
    '2.5',
    'R/17',
    'R*1',
    'R*0',
    'R*20',
    'R + 1',
    'R * 2',
    '(R)',
    'R/-2',
    'r/2',
    'A.r',
    '.r',
    'a.R',
    'a',
    'R**2',
    'R/',
    '',
    `R${'*2'.repeat(32)}`,
  ])('rejects %j', (text) => {
    expect(parseLengthExpression(text)).toBeNull();
  });

  it('enforces the 64 character limit', () => {
    const ok = `R${'*2'.repeat(31)}`;
    expect(ok).toHaveLength(63);
    expect(parseLengthExpression(ok)).not.toBeNull();
    expect(parseLengthExpression(`${ok}*2`)).toBeNull();
    expect(parseLengthExpression(`R${'*sqrt2'.repeat(11)}`)).toBeNull();
    expect(parseLengthExpression(`R${'*sqrt2'.repeat(10)}`)).not.toBeNull();
  });

  it('splits base and factors', () => {
    expect(parse('R')).toEqual({ text: 'R', base: { kind: 'R' }, factors: [] });
    expect(parse('a_b.r*sqrt2/3')).toEqual({
      text: 'a_b.r*sqrt2/3',
      base: { kind: 'circle', id: 'a_b' },
      factors: [
        { op: '*', name: 'sqrt2' },
        { op: '/', name: '3' },
      ],
    });
  });
});

describe('evaluation', () => {
  it('exports the constants', () => {
    expect(SQRT2).toBe(Math.SQRT2);
    expect(SQRT3).toBeCloseTo(1.7320508075688772, 15);
    expect(PHI).toBeCloseTo(1.618033988749895, 14);
  });

  it.each([
    ['R', 4, 4],
    ['R/2', 4, 2],
    ['R*16', 1, 16],
    ['R*sqrt2', 1, SQRT2],
    ['R/sqrt3', 3, 3 / SQRT3],
    ['R*phi', 2, 2 * PHI],
    ['R*phi2', 1, PHI * PHI],
    ['a.r*3/4', 2, 1.5],
    ['R*10/12', 6, 5],
  ])('evaluates %s with base %d', (text, base, expected) => {
    expect(evaluateLengthExpression(parse(text), base)).toBeCloseTo(expected, 12);
  });

  it('applies factors directly', () => {
    expect(evaluateFactors(8, parse('R/2/2').factors)).toBe(2);
    expect(evaluateFactors(8, [])).toBe(8);
  });

  it('uses the expression as its label', () => {
    expect(lengthLabel(parse('a.r/sqrt2'))).toBe('a.r/sqrt2');
  });

  it('phi2 equals phi squared numerically', () => {
    expect(evaluateLengthExpression(parse('R*phi2'), 1)).toBeCloseTo(PHI + 1, 12);
  });
});

describe('ratioSignature', () => {
  it.each([
    ['R*sqrt2/2', 'R/sqrt2'],
    ['R/2', 'R*2'],
    ['R*phi*phi', 'R*phi2'],
    ['R/phi', 'R*phi'],
    ['R*4', 'R/4'],
    ['R*6', 'R*2*3'],
    ['R*sqrt2*sqrt2', 'R*2'],
    ['R*16', 'R*4*4'],
    ['R*14/7', 'R*2'],
    ['a.r/2', 'b.r*2'],
    ['R*sqrt3*3', 'R*9/sqrt3'],
  ])('%s is the same ratio as %s', (a, b) => {
    expect(sig(a)).not.toBeNull();
    expect(sig(a)).toBe(sig(b));
  });

  it.each([
    ['R*2/2'],
    ['R'],
    ['a.r'],
    ['R*sqrt2*sqrt2/2'],
    ['R*phi/phi'],
    ['R*phi2/phi/phi'],
    ['R*6/2/3'],
    ['R*15/3/5'],
  ])('%s has no signature', (text) => {
    expect(sig(text)).toBeNull();
  });

  it.each([
    ['R/2', 'R/3'],
    ['R*2', 'R*sqrt2'],
    ['R*sqrt2', 'R*sqrt3'],
    ['R*phi', 'R*phi2'],
    ['R*phi', 'R*2'],
    ['R*4', 'R*2'],
    ['R*sqrt2', 'R*8'],
    ['R*6', 'R*2'],
    ['R*7', 'R*11'],
    ['R*13', 'R*phi'],
  ])('%s differs from %s', (a, b) => {
    expect(sig(a)).not.toBe(sig(b));
  });

  it('treats the chain a.r/2 repeated as one step', () => {
    expect(sig('a.r/2')).toBe(sig('b.r/2'));
  });

  it('gives numbers no signature and parses strings', () => {
    expect(lengthSignature(2)).toBeNull();
    expect(lengthSignature('R/2')).toBe(sig('R/2'));
    expect(lengthSignature('R*2/2')).toBeNull();
    expect(lengthSignature('not a length')).toBeNull();
  });
});
