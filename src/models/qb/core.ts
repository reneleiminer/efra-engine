import { isCount, isVerifiedSource, readObservation } from "../../contracts/observations.ts";
import type { DataOrigin } from "../../contracts/observations.ts";
import type { RatingReason } from "../../contracts/rating.ts";
import type { QbGame } from "../../contracts/statistics.ts";

export interface PassingCore {
  readonly attempts: number;
  readonly completions: number;
  readonly yards: number;
  readonly touchdowns: number;
  readonly interceptions: number;
}

export type CoreAssessment =
  | { readonly status: "PASSING"; readonly stats: PassingCore }
  | { readonly status: "VERIFIED_ZERO_ATTEMPTS"; readonly stats: PassingCore }
  | { readonly status: "DID_NOT_PLAY" }
  | {
      readonly status: "UNAVAILABLE";
      readonly reason: Extract<RatingReason, "UNVERIFIED_USAGE" | "MISSING_CORE" | "UNUSABLE_CORE" | "INVALID_CORE">;
    };

export function assessQbCore(game: QbGame, origin: DataOrigin): CoreAssessment {
  const { usage, stats: { passing } } = game;
  if (usage.status === "UNKNOWN" || !isVerifiedSource(usage.source, origin)) {
    return { status: "UNAVAILABLE", reason: "UNVERIFIED_USAGE" };
  }

  const attempts = readObservation(passing.attempts, origin, isCount);
  const completions = readObservation(passing.completions, origin, isCount);
  const yards = readObservation(passing.yards, origin, Number.isSafeInteger);
  const touchdowns = readObservation(passing.touchdowns, origin, isCount);
  const interceptions = readObservation(passing.interceptions, origin, isCount);
  const fields = [attempts, completions, yards, touchdowns, interceptions];

  if (fields.some((field) => field.status === "INVALID")) {
    return { status: "UNAVAILABLE", reason: "INVALID_CORE" };
  }
  if (usage.status === "DID_NOT_PLAY") {
    if (fields.some((field) => field.status === "AVAILABLE" && field.value !== 0)) {
      return { status: "UNAVAILABLE", reason: "INVALID_CORE" };
    }
    if (fields.some((field) => field.status === "UNUSABLE")) {
      return { status: "UNAVAILABLE", reason: "UNUSABLE_CORE" };
    }
    return { status: "DID_NOT_PLAY" };
  }
  if (fields.some((field) => field.status === "UNUSABLE")) {
    return { status: "UNAVAILABLE", reason: "UNUSABLE_CORE" };
  }
  if (attempts.status !== "AVAILABLE" || completions.status !== "AVAILABLE" || yards.status !== "AVAILABLE"
    || touchdowns.status !== "AVAILABLE" || interceptions.status !== "AVAILABLE") {
    return { status: "UNAVAILABLE", reason: "MISSING_CORE" };
  }
  if (completions.value > attempts.value || interceptions.value > attempts.value - completions.value
    || touchdowns.value > completions.value || (completions.value === 0 && yards.value !== 0)) {
    return { status: "UNAVAILABLE", reason: "INVALID_CORE" };
  }
  return {
    status: attempts.value === 0 ? "VERIFIED_ZERO_ATTEMPTS" : "PASSING",
    stats: {
      attempts: attempts.value,
      completions: completions.value,
      yards: yards.value,
      touchdowns: touchdowns.value,
      interceptions: interceptions.value,
    },
  };
}
