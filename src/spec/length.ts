/** Numeric constants used by length expression factors. */
export const SQRT2 = Math.SQRT2;
export const SQRT3 = Math.sqrt(3);
/** Golden ratio (1 + sqrt(5)) / 2. */
export const PHI = (1 + Math.sqrt(5)) / 2;

/** Maximum length of a length expression string. */
export const LENGTH_EXPRESSION_MAX_CHARS = 64;

/** Grammar of a length expression: base `R` or `<id>.r`, then `*`/`/` factors. */
export const LENGTH_EXPRESSION_PATTERN =
  /^(R|[a-z][a-z0-9_]{0,31}\.r)([*/](1[0-6]|[2-9]|sqrt2|sqrt3|phi|phi2))*$/;

/** Factor tokens a length expression accepts. */
export type FactorName =
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | '10'
  | '11'
  | '12'
  | '13'
  | '14'
  | '15'
  | '16'
  | 'sqrt2'
  | 'sqrt3'
  | 'phi'
  | 'phi2';

export type LengthFactor = { op: '*' | '/'; name: FactorName };

/** Base of a length expression: the radius unit `R`, or the radius of a circle-like element. */
export type LengthBase = { kind: 'R' } | { kind: 'circle'; id: string };

export type LengthExpression = {
  /** The expression as written; doubles as its display label. */
  text: string;
  base: LengthBase;
  factors: LengthFactor[];
};

/** Primes tracked by the ratio signature, in normalisation order. */
const SIGNATURE_PRIMES = [2, 3, 5, 7, 11, 13] as const;

/** Parses a length expression, or returns null when it violates the grammar. */
export function parseLengthExpression(text: string): LengthExpression | null {
  if (text.length > LENGTH_EXPRESSION_MAX_CHARS || !LENGTH_EXPRESSION_PATTERN.test(text)) {
    return null;
  }
  const parts = text.split(/([*/])/);
  const head = parts[0] ?? '';
  const base: LengthBase =
    head === 'R' ? { kind: 'R' } : { kind: 'circle', id: head.slice(0, -'.r'.length) };
  const factors: LengthFactor[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    factors.push({ op: parts[i] as '*' | '/', name: parts[i + 1] as FactorName });
  }
  return { text, base, factors };
}

/** Numeric value of one factor token. */
export function factorValue(name: FactorName): number {
  switch (name) {
    case 'sqrt2':
      return SQRT2;
    case 'sqrt3':
      return SQRT3;
    case 'phi':
      return PHI;
    case 'phi2':
      return PHI * PHI;
    default:
      return Number(name);
  }
}

/** Applies the factor list to a base value, left to right. */
export function evaluateFactors(baseValue: number, factors: readonly LengthFactor[]): number {
  let value = baseValue;
  for (const factor of factors) {
    const v = factorValue(factor.name);
    value = factor.op === '*' ? value * v : value / v;
  }
  return value;
}

/** Evaluates an expression given the value of its base (`R` or the referenced radius). */
export function evaluateLengthExpression(expr: LengthExpression, baseValue: number): number {
  return evaluateFactors(baseValue, expr.factors);
}

/** Display label of a length expression (the expression itself). */
export function lengthLabel(expr: LengthExpression): string {
  return expr.text;
}

/** Exponent contribution of one factor, in the order [2, 3, 5, 7, 11, 13, phi]; primes are doubled. */
function factorExponents(name: FactorName): number[] {
  const out = [0, 0, 0, 0, 0, 0, 0];
  if (name === 'sqrt2') {
    out[0] = 1;
  } else if (name === 'sqrt3') {
    out[1] = 1;
  } else if (name === 'phi') {
    out[6] = 1;
  } else if (name === 'phi2') {
    out[6] = 2;
  } else {
    let n = Number(name);
    SIGNATURE_PRIMES.forEach((p, k) => {
      while (n % p === 0) {
        out[k] = (out[k] ?? 0) + 2;
        n /= p;
      }
    });
  }
  return out;
}

/**
 * Ratio signature of an expression as a canonical key, or null when the factors cancel.
 *
 * The key is the exponents of 2, 3, 5, 7, 11, 13 (doubled, so half-integer steps stay
 * integers) and phi, joined by commas, with the sign fixed so the first nonzero is positive.
 */
export function ratioSignature(expr: LengthExpression): string | null {
  const total = [0, 0, 0, 0, 0, 0, 0];
  for (const factor of expr.factors) {
    const sign = factor.op === '*' ? 1 : -1;
    factorExponents(factor.name).forEach((e, k) => {
      total[k] = (total[k] ?? 0) + sign * e;
    });
  }
  const first = total.find((e) => e !== 0);
  if (first === undefined) {
    return null;
  }
  const flip = first < 0 ? -1 : 1;
  return total.map((e) => (e === 0 ? 0 : e * flip)).join(',');
}

/** Ratio signature of a spec length: numbers have none, strings are parsed. */
export function lengthSignature(length: number | string): string | null {
  if (typeof length === 'number') {
    return null;
  }
  const expr = parseLengthExpression(length);
  return expr === null ? null : ratioSignature(expr);
}
