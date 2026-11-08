export type MetricTier = "CORE" | "SUPPORTING" | "ADVANCED";

export interface ComponentDefinition {
  readonly id: string;
  readonly numerator: string;
  readonly denominator: string;
  readonly kind: "RATE" | "PER_OPPORTUNITY" | "BINOMIAL_RESIDUAL";
  readonly expected?: string;
  readonly minimum?: number;
  readonly direction: 1 | -1;
}

export interface PositionDefinition {
  readonly CORE: readonly ComponentDefinition[];
  readonly SUPPORTING: readonly ComponentDefinition[];
  readonly ADVANCED: readonly ComponentDefinition[];
}

export function rate<I extends string, N extends string, D extends string>(
  id: I, numerator: N, denominator: D, direction: 1 | -1 = 1,
) {
  return { id, numerator, denominator, kind: "RATE", direction } as const;
}

export function perOpportunity<I extends string, N extends string, D extends string>(
  id: I, numerator: N, denominator: D, direction: 1 | -1 = 1, minimum?: number,
) {
  return { id, numerator, denominator, kind: "PER_OPPORTUNITY", direction, ...(minimum === undefined ? {} : { minimum }) } as const;
}

export function binomialResidual<I extends string, N extends string, D extends string, E extends string>(
  id: I, numerator: N, denominator: D, expected: E,
) {
  return { id, numerator, denominator, expected, kind: "BINOMIAL_RESIDUAL", direction: 1 } as const;
}
