import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeSyntheticQbGame, calculateOverall, calculateSeasonPerformance } from "../src/index.ts";
import type { QbGame, QbSeasonSimulation } from "../src/index.ts";
import { advancedPolicy, game, missing, observed, overallPolicy, evidence, policy, season, seasonWith, zeroPass } from "./simulation-fixtures.ts";

const rushingGame: QbGame = {
  ...zeroPass, gameId: "sim-rushing-game", teamId: "sim-transfer-team", stats: {
    ...zeroPass.stats,
    rushing: { attempts: observed(6), yards: observed(60), touchdowns: observed(0), turnovers: observed(0) },
    situation: { opportunities: observed(0), actualPointsAdded: missing, expectedPointsAdded: missing },
  },
};

const rushOnly = {
  version: { ...policy.version, path: "QB_RUSH_ONLY_SPECIAL", methodVersion: "sim-rush-only", contextVersion: "sim-no-context" },
  components: { rushingContribution: { weight: 1, score: ({ yardsPerAttempt }) => yardsPerAttempt } },
  calibration: { ...policy.calibration, version: "sim-cal-rush-only" },
} satisfies QbSeasonSimulation;

test("SIMULATION | a zero-pass transfer stint changes rushing by carries and leaves passing and situation intact", () => {
  const transfer = { id: "sim-rush-stint", teamId: rushingGame.teamId, expectedGameIds: [rushingGame.gameId], games: [rushingGame] };
  const input = { ...season, stints: [...season.stints, transfer] };
  const base = calculateSeasonPerformance(season, advancedPolicy);
  const mixed = calculateSeasonPerformance(input, advancedPolicy);
  assert.equal(base.status, "PROVISIONAL");
  assert.equal(mixed.status, "PROVISIONAL");
  assert.equal(mixed.confidence.passingAttempts, 10);
  assert.ok(Math.abs(mixed.latent - base.latent - 0.25 * (8 - 5)) < 1e-12);
  assert.deepEqual(mixed, calculateSeasonPerformance({ ...input, stints: [...input.stints].reverse() }, advancedPolicy));
});

test("SIMULATION | missing rushing on a zero-pass game blocks Advanced while verified zero is neutral", () => {
  const local = { ...rushingGame, teamId: game.teamId };
  const noRuns = { ...local, stats: { ...local.stats, rushing: {
    attempts: observed(0), yards: missing, touchdowns: missing, turnovers: missing,
  } } };
  assert.deepEqual(
    calculateSeasonPerformance(seasonWith(game, noRuns), advancedPolicy).score,
    calculateSeasonPerformance(season, advancedPolicy).score,
  );
  const result = calculateSeasonPerformance(seasonWith(game, {
    ...noRuns, stats: { ...noRuns.stats, rushing: { ...noRuns.stats.rushing, attempts: missing } },
  }), advancedPolicy);
  assert.equal(result.status, "NOT_RATED");
  assert.equal(result.reason, "MISSING_COMPONENT");
});

test("SIMULATION | production residualizes non-TD first downs without reusing yards or touchdown events", () => {
  const { components } = analyzeSyntheticQbGame(game, advancedPolicy.context);
  assert.deepEqual(components.passingProduction, {
    status: "AVAILABLE",
    value: { expectedTouchdowns: 1, residualPerAttempt: 0.1, nonTouchdownFirstDowns: { expected: 2, residualPerAttempt: 0.1 } },
  });
  const impossible = { ...game, stats: { ...game.stats, advancedPassing: {
    ...game.stats.advancedPassing, nonTouchdownFirstDowns: observed(5),
  } } };
  assert.equal(analyzeSyntheticQbGame(impossible, advancedPolicy.context).components.passingProduction.status, "INVALID");
  const wrongVersion = { ...game, stats: { ...game.stats, situationDefinitionVersion: "sim-incompatible" } };
  const result = calculateSeasonPerformance(seasonWith(wrongVersion), advancedPolicy);
  assert.equal(result.status, "NOT_RATED");
  assert.equal(result.reason, "MISSING_COMPONENT");
});

test("SIMULATION | extended passing is an explicit partial path with its own version and no fallback", () => {
  const { situationDefinitionVersion: _, ...version } = advancedPolicy.version;
  const extended = {
    ...policy, context: advancedPolicy.context, version: { ...version, path: "QB_EXTENDED_PRODUCTION" },
  } satisfies QbSeasonSimulation;
  const { advancedPassing: _missing, ...stats } = game.stats;
  const absent = { ...game, stats };
  assert.equal(calculateSeasonPerformance(season, extended).status, "PROVISIONAL");
  assert.equal(calculateSeasonPerformance(seasonWith(absent), extended).status, "NOT_RATED");
  assert.equal(calculateSeasonPerformance(seasonWith(absent), policy).status, "PROVISIONAL");
  const mismatch = calculateOverall(
    { playerId: game.playerId, position: "QB", asOf: season.asOf }, "SYNTHETIC",
    [{ ...evidence, model: { ...extended.version, firstDownDefinitionVersion: "sim-wrong" } }],
    { ...overallPolicy, version: { ...extended.version, methodVersion: "sim-extended-ovr" }, evidenceModel: extended.version },
  );
  assert.equal(mismatch.status, "NOT_RATED");
  assert.equal(mismatch.reason, "NO_COMPATIBLE_HISTORY");
});

test("SIMULATION | rush-only requires verified zero passes and a complete rushing opportunity", () => {
  const result = calculateSeasonPerformance(seasonWith(zeroPass), rushOnly);
  assert.equal(result.status, "PROVISIONAL");
  assert.equal(result.latent, 5);
  assert.equal(result.rankingEligible, false);
  assert.equal(result.label, "SIMULATION");
  const passer = calculateSeasonPerformance(seasonWith(game), rushOnly);
  assert.equal(passer.status, "NOT_RATED");
  assert.equal(passer.reason, "PASSING_EXPOSURE_IN_RUSH_ONLY");
  const unknownAttempts = calculateSeasonPerformance(seasonWith({
    ...zeroPass, stats: { ...zeroPass.stats, passing: { ...zeroPass.stats.passing, attempts: missing } },
  }), rushOnly);
  assert.equal(unknownAttempts.status, "NOT_RATED");
  assert.equal(unknownAttempts.reason, "MISSING_CORE");
  const overall = calculateOverall(
    { playerId: game.playerId, position: "QB", asOf: season.asOf }, "SYNTHETIC", [],
    { ...overallPolicy, version: rushOnly.version, evidenceModel: rushOnly.version },
  );
  assert.equal(overall.status, "NOT_RATED");
  assert.equal(overall.reason, "NO_VALIDATED_MODEL_PATH");
});
