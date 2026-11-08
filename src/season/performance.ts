import { summarizeConfidence } from "../confidence/evidence.ts";
import type { RatingReason, RatingResult } from "../contracts/rating.ts";
import type { QbSeason } from "../contracts/statistics.ts";
import { timestamp } from "../contracts/time.ts";
import { analyzeSyntheticQbGame } from "../models/qb/components.ts";
import { scoreQbComponents } from "../models/qb/scoring.ts";
import type { QbSeasonSimulation } from "../models/qb/scoring.ts";
import { calibrateSimulation } from "../simulation/calibration.ts";

export function calculateSeasonPerformance(input: QbSeason, policy: QbSeasonSimulation): RatingResult {
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
  const scopeIssue = validateScope(input);
  if (scopeIssue) return blocked(scopeIssue);
  const path = policy.version.path;
  const advanced = path === "QB_ADVANCED";
  if (policy.version.maturity !== "UNVALIDATED_SIMULATION" || policy.context.version !== policy.version.contextVersion
    || (path !== "QB_STANDARD_CORE" && !advanced)
    || advanced !== ("rushingContribution" in policy.components)
    || advanced !== ("situationalImpact" in policy.components)
    || [policy.version.methodVersion, policy.version.parameterVersion, policy.version.contextVersion].some((id) => !id.trim())) {
    return blocked("NO_VALIDATED_MODEL_PATH");
  }

  const analyses = ordered.map((stint) => [...stint.games]
    .sort((left, right) => compareId(left.gameId, right.gameId))
    .map((game) => analyzeSyntheticQbGame(game, policy.context)));
  confidence = summarizeConfidence(expectedGames, analyses.flatMap((stint) => stint.map(({ core }) => core)));
  const coreIssue = analyses.flat().find(({ core }) => core.status === "UNAVAILABLE")?.core;
  if (coreIssue?.status === "UNAVAILABLE") return blocked(coreIssue.reason);
  if (confidence.passingAttempts === 0) return blocked("NO_PASSING_EXPOSURE");
  if (!Number.isSafeInteger(confidence.passingAttempts)) return blocked("INVALID_CORE");

  let seasonLatent = 0;
  for (const stint of analyses) {
    const passing = stint.flatMap(({ core, components }) =>
      core.status === "PASSING" ? [{ attempts: core.stats.attempts, components }] : []);
    const attempts = passing.reduce((sum, game) => sum + game.attempts, 0);
    let stintLatent = 0;
    for (const game of passing) {
      const scored = scoreQbComponents(game.components, policy);
      if (scored.status === "NOT_RATED") return blocked(scored.reason);
      stintLatent += scored.value * (game.attempts / attempts);
    }
    seasonLatent += stintLatent * (attempts / confidence.passingAttempts);
  }
  const calibrated = calibrateSimulation(seasonLatent, policy.calibration);
  if (!calibrated) return blocked("INVALID_MODEL_OUTPUT");
  return { ...base, confidence, status: "PROVISIONAL", origin: "SYNTHETIC", label: "SIMULATION", ...calibrated };
}

function validateScope(input: QbSeason): "INVALID_SCOPE" | "INCOMPLETE_COVERAGE" | null {
  const { asOf, season, stints, playerId, position, snapshot } = input;
  const start = timestamp(season.startsAt);
  const end = timestamp(season.endsAt);
  const cutoff = timestamp(asOf);
  const available = timestamp(snapshot.availableAt);
  const ids = [season.id, season.leagueId, season.competitionId, playerId, snapshot.dataVersion, snapshot.schemaVersion];
  if (position !== "QB" || ids.some((id) => !id.trim()) || ![start, end, cutoff, available].every(Number.isFinite)
    || start > end || cutoff < start || available > cutoff) return "INVALID_SCOPE";

  const stintIds = new Set<string>();
  const seasonGameIds = new Set<string>();
  for (const stint of stints) {
    if (!stint.id.trim() || !stint.teamId.trim() || stintIds.has(stint.id)) return "INVALID_SCOPE";
    stintIds.add(stint.id);
    const pending = new Set(stint.expectedGameIds);
    if (pending.size !== stint.expectedGameIds.length) return "INVALID_SCOPE";
    for (const game of stint.games) {
      const played = timestamp(game.playedAt);
      if (!game.gameId.trim() || !game.opponentId.trim() || game.teamId === game.opponentId
        || game.playerId !== playerId || game.position !== position || game.seasonId !== season.id
        || game.teamId !== stint.teamId || seasonGameIds.has(game.gameId) || !Number.isFinite(played)
        || played < start || played > end || played > available || !pending.delete(game.gameId)) {
        return "INVALID_SCOPE";
      }
      seasonGameIds.add(game.gameId);
    }
    if (pending.size > 0) return "INCOMPLETE_COVERAGE";
  }
  return null;
}

function compareId(left: string, right: string): number {
  if (left < right) return -1;
  return left === right ? 0 : 1;
}
