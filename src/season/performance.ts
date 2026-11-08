import { summarizeConfidence } from "../confidence/evidence.ts";
import { resolveLeagueAdjustment } from "../context/league-strength.ts";
import type { LeagueStrengthEstimate } from "../context/league-strength.ts";
import type { RatingReason, RatingResult } from "../contracts/rating.ts";
import type { QbSeason } from "../contracts/statistics.ts";
import { compareId, validateSeasonScope } from "./scope.ts";
import { analyzeSyntheticQbGame } from "../models/qb/components.ts";
import { scoreQbSeason, validQbPolicy } from "../models/qb/scoring.ts";
import type { QbSeasonSimulation } from "../models/qb/scoring.ts";
import { calibrateSimulation } from "../simulation/calibration.ts";

export function calculateSeasonPerformance(input: QbSeason, policy: QbSeasonSimulation, context?: LeagueStrengthEstimate): RatingResult {
  const { season, playerId, position, asOf, snapshot, stints } = input;
  const { origin, dataVersion, schemaVersion } = snapshot;
  const ordered = [...stints].sort((left, right) => compareId(left.id, right.id));
  const base = {
    kind: "SEASON_PERFORMANCE", scope: { playerId, position, asOf }, model: policy.version, origin,
    seasonId: season.id, leagueId: season.leagueId, competitionId: season.competitionId, dataVersion, schemaVersion,
    stintIds: ordered.map(({ id }) => id), flags: [], rankingEligible: false,
  } as const;
  const expectedGames = stints.reduce((count, stint) => count + stint.expectedGameIds.length, 0);
  let confidence = summarizeConfidence(expectedGames);
  const blocked = (reason: RatingReason): RatingResult => ({ ...base, confidence, status: "NOT_RATED", reason, score: null });

  if (origin !== "SYNTHETIC") return blocked("REAL_DATA_DISABLED");
  const scopeIssue = position === "QB" ? validateSeasonScope(input) : "INVALID_SCOPE";
  if (scopeIssue) return blocked(scopeIssue);
  if (!validQbPolicy(policy)) return blocked("NO_VALIDATED_MODEL_PATH");
  const adjustment = resolveLeagueAdjustment(season.leagueId, position, asOf, policy.version, policy.leagueAdjustmentScale, context);
  if (!adjustment) return blocked("LEAGUE_CONTEXT_UNAVAILABLE");

  const analyses = ordered.flatMap((stint) => [...stint.games]
    .sort((left, right) => compareId(left.gameId, right.gameId))
    .map((game) => analyzeSyntheticQbGame(game, policy.context)));
  confidence = summarizeConfidence(expectedGames, analyses.map(({ core }) => core));
  const coreIssue = analyses.find(({ core }) => core.status === "UNAVAILABLE")?.core;
  if (coreIssue?.status === "UNAVAILABLE") return blocked(coreIssue.reason);
  if (!Number.isSafeInteger(confidence.passingAttempts)) return blocked("INVALID_CORE");
  if (policy.version.path === "QB_RUSH_ONLY_SPECIAL") {
    if (confidence.passingAttempts > 0) return blocked("PASSING_EXPOSURE_IN_RUSH_ONLY");
  } else if (confidence.passingAttempts === 0) {
    return blocked("NO_PASSING_EXPOSURE");
  }
  const scored = scoreQbSeason(analyses, policy);
  if (scored.status === "NOT_RATED") return blocked(scored.reason);
  const calibrated = calibrateSimulation(scored.value + adjustment.value, policy.calibration);
  if (!calibrated) return blocked("INVALID_MODEL_OUTPUT");
  return {
    ...base, confidence, ...(policy.version.comparisonScope?.basis === "BRIDGE_REFERENCE"
      ? { leagueContextEvidenceIds: adjustment.evidenceIds } : {}),
    status: "PROVISIONAL", origin: "SYNTHETIC", label: "SIMULATION", ...calibrated,
  };
}
