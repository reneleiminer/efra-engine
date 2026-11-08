import type { Evidence } from "../contracts/observations.ts";

export interface PassingContextInput {
  readonly gameId: string;
  readonly seasonId: string;
  readonly teamId: string;
  readonly opponentId: string;
  readonly attempts: number;
  readonly completionRate: number;
  readonly yardsPerAttempt: number;
}

export interface PassingContextModel {
  readonly version: string;
  readonly expectedTouchdowns: (input: PassingContextInput) => number | null;
  readonly nonTouchdownFirstDowns?: {
    readonly definitionVersion: string;
    readonly expected: (input: PassingContextInput) => number | null;
  };
}

export interface PassingProduction {
  readonly expectedTouchdowns: number;
  readonly residualPerAttempt: number;
  readonly nonTouchdownFirstDowns?: {
    readonly expected: number;
    readonly residualPerAttempt: number;
  };
}

export function adjustPassingProduction(
  observed: number,
  input: PassingContextInput,
  model: PassingContextModel,
  firstDowns?: Evidence<number>,
): Evidence<PassingProduction> {
  const expected = model.expectedTouchdowns(input);
  if (expected === null) return { status: "MISSING" };
  if (!Number.isFinite(expected) || expected < 0 || expected > input.attempts) {
    return { status: "INVALID" };
  }
  const base = { expectedTouchdowns: expected, residualPerAttempt: (observed - expected) / input.attempts };
  if (!model.nonTouchdownFirstDowns) return { status: "AVAILABLE", value: base };
  if (!firstDowns) return { status: "MISSING" };
  if (firstDowns.status !== "AVAILABLE") return firstDowns;
  const expectedFirstDowns = model.nonTouchdownFirstDowns.expected(input);
  if (expectedFirstDowns === null) return { status: "MISSING" };
  if (!Number.isFinite(expectedFirstDowns) || expectedFirstDowns < 0 || expectedFirstDowns > input.attempts - expected) {
    return { status: "INVALID" };
  }
  return { status: "AVAILABLE", value: {
    ...base, nonTouchdownFirstDowns: {
      expected: expectedFirstDowns, residualPerAttempt: (firstDowns.value - expectedFirstDowns) / input.attempts,
    },
  } };
}
