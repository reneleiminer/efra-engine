import { adjustPassingProduction } from "../../context/adjustment.ts";
import type { PassingContextModel } from "../../context/adjustment.ts";
import { isCount, readObservation } from "../../contracts/observations.ts";
import type { Evidence } from "../../contracts/observations.ts";
import type { QbGame, QbStatistics } from "../../contracts/statistics.ts";
import { assessQbCore } from "./core.ts";
import type { CoreAssessment } from "./core.ts";

export interface PassingEfficiency {
  readonly completionRate: number;
  readonly yardsPerAttempt: number;
}

export interface PassingProduction {
  readonly expectedTouchdowns: number;
  readonly residualPerAttempt: number;
}

export interface BallControl {
  readonly interceptionRate: number;
}

export interface RushingContribution {
  readonly attempts: number;
  readonly yardsPerAttempt: number;
  readonly touchdownRate: number;
  readonly turnoverRate: number;
}

export interface SituationalImpact {
  readonly opportunities: number;
  readonly pointsAboveExpectationPerOpportunity: number;
}

export interface QbComponents {
  readonly passingEfficiency: Evidence<PassingEfficiency>;
  readonly passingProduction: Evidence<PassingProduction>;
  readonly ballControl: Evidence<BallControl>;
  readonly rushingContribution: Evidence<RushingContribution>;
  readonly situationalImpact: Evidence<SituationalImpact>;
}

export interface QbGameAnalysis {
  readonly label: "SIMULATION";
  readonly gameId: string;
  readonly contextVersion: string;
  readonly core: CoreAssessment;
  readonly components: QbComponents;
}

export function analyzeSyntheticQbGame(game: QbGame, context: PassingContextModel): QbGameAnalysis {
  const core = assessQbCore(game, "SYNTHETIC");
  const provenance = { label: "SIMULATION", gameId: game.gameId, contextVersion: context.version } as const;
  if (core.status !== "PASSING") {
    const status = core.status === "UNAVAILABLE" ? "UNUSABLE" : "NOT_APPLICABLE";
    const unavailable = { status } as const;
    const { rushing, situation } = game.stats;
    return {
      ...provenance,
      core,
      components: {
        passingEfficiency: unavailable,
        passingProduction: unavailable,
        ballControl: unavailable,
        rushingContribution: core.status === "VERIFIED_ZERO_ATTEMPTS" ? rushingContribution(rushing) : unavailable,
        situationalImpact: core.status === "VERIFIED_ZERO_ATTEMPTS" ? situationalImpact(situation) : unavailable,
      },
    };
  }

  const { attempts, completions, yards, touchdowns, interceptions } = core.stats;
  const efficiency = { completionRate: completions / attempts, yardsPerAttempt: yards / attempts };
  const { gameId, seasonId, teamId, opponentId } = game;
  return {
    ...provenance,
    core,
    components: {
      passingEfficiency: { status: "AVAILABLE", value: efficiency },
      passingProduction: adjustPassingProduction(
        touchdowns, { gameId, seasonId, teamId, opponentId, attempts, ...efficiency }, context,
      ),
      ballControl: { status: "AVAILABLE", value: { interceptionRate: interceptions / attempts } },
      rushingContribution: rushingContribution(game.stats.rushing),
      situationalImpact: situationalImpact(game.stats.situation),
    },
  };
}

function rushingContribution(rushing: QbStatistics["rushing"]): Evidence<RushingContribution> {
  const attempts = readObservation(rushing.attempts, "SYNTHETIC", isCount);
  if (attempts.status !== "AVAILABLE") return attempts;
  const yards = readObservation(rushing.yards, "SYNTHETIC", Number.isSafeInteger);
  const touchdowns = readObservation(rushing.touchdowns, "SYNTHETIC", isCount);
  const turnovers = readObservation(rushing.turnovers, "SYNTHETIC", isCount);
  if (yards.status === "INVALID" || touchdowns.status === "INVALID" || turnovers.status === "INVALID") {
    return { status: "INVALID" };
  }
  if (yards.status === "UNUSABLE" || touchdowns.status === "UNUSABLE" || turnovers.status === "UNUSABLE") {
    return { status: "UNUSABLE" };
  }
  if (attempts.value === 0) {
    const hasActivity = [yards, touchdowns, turnovers].some((field) => field.status === "AVAILABLE" && field.value !== 0);
    return { status: hasActivity ? "INVALID" : "NOT_APPLICABLE" };
  }
  if (yards.status !== "AVAILABLE" || touchdowns.status !== "AVAILABLE" || turnovers.status !== "AVAILABLE") {
    return { status: "MISSING" };
  }
  if (touchdowns.value > attempts.value || turnovers.value > attempts.value - touchdowns.value) {
    return { status: "INVALID" };
  }
  return {
    status: "AVAILABLE",
    value: {
      attempts: attempts.value,
      yardsPerAttempt: yards.value / attempts.value,
      touchdownRate: touchdowns.value / attempts.value,
      turnoverRate: turnovers.value / attempts.value,
    },
  };
}

function situationalImpact(situation: QbStatistics["situation"]): Evidence<SituationalImpact> {
  const opportunities = readObservation(situation.opportunities, "SYNTHETIC", isCount);
  if (opportunities.status !== "AVAILABLE") return opportunities;
  const actual = readObservation(situation.actualPointsAdded, "SYNTHETIC", Number.isFinite);
  const expected = readObservation(situation.expectedPointsAdded, "SYNTHETIC", Number.isFinite);
  if (actual.status === "INVALID" || expected.status === "INVALID") return { status: "INVALID" };
  if (actual.status === "UNUSABLE" || expected.status === "UNUSABLE") return { status: "UNUSABLE" };
  if (opportunities.value === 0) {
    const hasActivity = [actual, expected].some((field) => field.status === "AVAILABLE" && field.value !== 0);
    return { status: hasActivity ? "INVALID" : "NOT_APPLICABLE" };
  }
  if (actual.status !== "AVAILABLE" || expected.status !== "AVAILABLE") return { status: "MISSING" };
  const impact = (actual.value - expected.value) / opportunities.value;
  if (!Number.isFinite(impact)) return { status: "INVALID" };
  return {
    status: "AVAILABLE",
    value: { opportunities: opportunities.value, pointsAboveExpectationPerOpportunity: impact },
  };
}
