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
}

export function adjustPassingProduction(
  observed: number,
  input: PassingContextInput,
  model: PassingContextModel,
): Evidence<{ readonly expectedTouchdowns: number; readonly residualPerAttempt: number }> {
  const expected = model.expectedTouchdowns(input);
  if (expected === null) return { status: "MISSING" };
  if (!Number.isFinite(expected) || expected < 0 || expected > input.attempts) {
    return { status: "INVALID" };
  }
  return {
    status: "AVAILABLE",
    value: { expectedTouchdowns: expected, residualPerAttempt: (observed - expected) / input.attempts },
  };
}
