import type {
  Observation, OverallEvidence, OverallSimulation, QbGame, QbSeason, QbSeasonSimulation, SourceQuality,
} from "../src/index.ts";

export const source = {
  sourceId: "sim-source", revisionId: "sim-revision-1", conventionVersion: "sim-boxscore-1",
  origin: "SYNTHETIC", verification: "VERIFIED", officiality: "SYNTHETIC",
} as const satisfies SourceQuality;

export function observed(value: number): Observation {
  return { status: value === 0 ? "VERIFIED_ZERO" : "OBSERVED", source, value };
}

export const missing = { status: "MISSING" } as const;
export const game = {
  gameId: "sim-game-1", playerId: "sim-player", position: "QB", seasonId: "sim-season",
  teamId: "sim-team-a", opponentId: "sim-team-b", playedAt: "2025-01-10T00:00:00.000Z",
  usage: { status: "PLAYED", source },
  stats: {
    passing: {
      attempts: observed(10), completions: observed(6), yards: observed(80),
      touchdowns: observed(2), interceptions: observed(1),
    },
    rushing: { attempts: observed(4), yards: observed(20), touchdowns: observed(1), turnovers: observed(0) },
    situation: { opportunities: observed(4), actualPointsAdded: observed(3), expectedPointsAdded: observed(1) },
  },
} as const satisfies QbGame;

export function passing(overrides: Partial<QbGame["stats"]["passing"]>): QbGame {
  return { ...game, stats: { ...game.stats, passing: { ...game.stats.passing, ...overrides } } };
}

export const zeroPass = passing({
  attempts: observed(0), completions: observed(0), yards: observed(0), touchdowns: observed(0), interceptions: observed(0),
});

export const season = {
  playerId: game.playerId, position: "QB", asOf: "2025-02-01T00:00:00.000Z",
  season: {
    id: game.seasonId, leagueId: "sim-league", competitionId: "sim-competition", label: "Simulation",
    startsAt: "2025-01-01T00:00:00.000Z", endsAt: "2025-12-31T00:00:00.000Z",
  },
  snapshot: {
    origin: "SYNTHETIC", dataVersion: "sim-data-1", schemaVersion: "sim-schema-1", availableAt: "2025-01-20T00:00:00.000Z",
  },
  stints: [{ id: "sim-stint-1", teamId: game.teamId, expectedGameIds: [game.gameId], games: [game] }],
} as const satisfies QbSeason;

export function seasonWith(...games: QbGame[]): QbSeason {
  return { ...season, stints: [{ ...season.stints[0], expectedGameIds: games.map(({ gameId }) => gameId), games }] };
}

// All coefficients below are arbitrary test inputs. No simulation defaults ship in src/.
export const policy = {
  version: {
    methodVersion: "sim-qb-spr-1", parameterVersion: "sim-params-1", contextVersion: "sim-context-1",
    maturity: "UNVALIDATED_SIMULATION", path: "QB_STANDARD_CORE",
  },
  context: { version: "sim-context-1", expectedTouchdowns: ({ attempts, completionRate }) => attempts * completionRate / 6 },
  calibration: { version: "sim-cal-spr-1", midpoint: 0, slope: 1 },
  components: {
    passingEfficiency: { weight: 0.5, score: ({ completionRate }) => completionRate },
    passingProduction: { weight: 0.25, score: ({ residualPerAttempt }) => residualPerAttempt },
    ballControl: { weight: 0.25, score: ({ interceptionRate }) => -interceptionRate },
  },
} satisfies QbSeasonSimulation;

export const advancedPolicy = {
  ...policy,
  version: { ...policy.version, parameterVersion: "sim-advanced-1", path: "QB_ADVANCED" },
  components: {
    ...policy.components,
    passingEfficiency: { ...policy.components.passingEfficiency, weight: 0.25 },
    passingProduction: { ...policy.components.passingProduction, weight: 0.125 },
    ballControl: { ...policy.components.ballControl, weight: 0.125 },
    rushingContribution: { weight: 0.25, score: ({ yardsPerAttempt }) => yardsPerAttempt },
    situationalImpact: { weight: 0.25, score: ({ pointsAboveExpectationPerOpportunity }) => pointsAboveExpectationPerOpportunity },
  },
} satisfies QbSeasonSimulation;

export const overallPolicy = {
  version: { ...policy.version, methodVersion: "sim-qb-ovr-1", parameterVersion: "sim-ovr-params-1" },
  evidenceModel: policy.version,
  calibration: { version: "sim-cal-ovr-1", midpoint: 1, slope: 2 },
  processVariancePerDay: 0.5,
} satisfies OverallSimulation;

export const evidence = {
  label: "SIMULATION", origin: "SYNTHETIC", playerId: game.playerId, position: "QB",
  evidenceId: "sim-evidence-1", dataVersion: "sim-data-1", model: policy.version,
  observedAt: game.playedAt, availableAt: "2025-01-11T00:00:00.000Z", latent: 1, measurementVariance: 2,
} as const satisfies OverallEvidence;
