import type { Confidence } from "../contracts/rating.ts";
import type { CoreAssessment } from "../models/qb/core.ts";

export function summarizeConfidence(
  expectedGames = 0,
  assessments: readonly CoreAssessment[] = [],
): Confidence {
  let verifiedUsageGames = 0;
  let usableCoreGames = 0;
  let passingAttempts = 0;
  for (const assessment of assessments) {
    if (assessment.status !== "UNAVAILABLE" || assessment.reason !== "UNVERIFIED_USAGE") {
      verifiedUsageGames++;
    }
    if (assessment.status === "PASSING" || assessment.status === "VERIFIED_ZERO_ATTEMPTS") {
      usableCoreGames++;
      passingAttempts += assessment.stats.attempts;
    }
  }
  return { status: "UNCALIBRATED", score: null, interval: null, expectedGames, verifiedUsageGames, usableCoreGames, passingAttempts };
}
