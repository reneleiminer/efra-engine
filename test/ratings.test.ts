import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateOverall, calculateSeasonPerformance } from "../src/index.ts";
import type { RatingResult } from "../src/index.ts";
import { advancedPolicy, evidence, game, missing, observed, overallPolicy, passing, policy, season, seasonWith, source, zeroPass } from "./simulation-fixtures.ts";

function blocked(result: RatingResult, reason: string) {
  assert.equal(result.status, "NOT_RATED");
  assert.equal(result.reason, reason);
  assert.equal(result.score, null);
  assert.equal(result.rankingEligible, false);
}

test("SIMULATION | scores the core and advanced paths separately with traceable versions", () => {
  const result = calculateSeasonPerformance(season, policy);
  assert.equal(result.status, "PROVISIONAL");
  assert.equal(result.kind, "SEASON_PERFORMANCE");
  assert.equal(result.label, "SIMULATION");
  assert.equal(result.rankingEligible, false);
  assert.equal(result.latent, 0.3);
  assert.equal(result.displayScore, result.score.toFixed(1));
  assert.equal(result.dataVersion, season.snapshot.dataVersion);
  assert.equal(result.calibrationVersion, policy.calibration.version);
  assert.deepEqual(result.confidence, {
    status: "UNCALIBRATED", score: null, interval: null, expectedGames: 1,
    verifiedUsageGames: 1, usableCoreGames: 1, passingAttempts: 10,
  });

  const advanced = calculateSeasonPerformance(season, advancedPolicy);
  assert.equal(advanced.status, "PROVISIONAL");
  assert.equal(advanced.latent, 1.5375);
  const noRushing = { ...game, stats: { ...game.stats, rushing: { ...game.stats.rushing, attempts: missing } } };
  blocked(calculateSeasonPerformance(seasonWith(noRushing), advancedPolicy), "MISSING_COMPONENT");
  assert.equal(calculateSeasonPerformance(seasonWith(noRushing), policy).status, "PROVISIONAL");
});

test("SIMULATION | never scores zero pass exposure or drops games with incomplete QB evidence", () => {
  blocked(calculateSeasonPerformance(seasonWith(zeroPass), policy), "NO_PASSING_EXPOSURE");
  const dnp = { ...zeroPass, gameId: "sim-dnp", usage: { status: "DID_NOT_PLAY", source } } as const;
  const zero = { ...zeroPass, gameId: "sim-zero" };
  const withNoExposure = calculateSeasonPerformance(seasonWith(game, zero, dnp), policy);
  assert.equal(withNoExposure.status, "PROVISIONAL");
  assert.equal(withNoExposure.latent, 0.3);
  assert.equal(withNoExposure.confidence.usableCoreGames, 2);
  assert.equal(withNoExposure.confidence.verifiedUsageGames, 3);

  const unknown = { ...zero, usage: { status: "UNKNOWN" } } as const;
  const withUnknown = calculateSeasonPerformance(seasonWith(game, unknown), policy);
  blocked(withUnknown, "UNVERIFIED_USAGE");
  assert.equal(withUnknown.confidence.verifiedUsageGames, 1);
  blocked(calculateSeasonPerformance(seasonWith(game, { ...passing({ attempts: missing }), gameId: "sim-incomplete" }), policy),
    "MISSING_CORE");
  blocked(calculateSeasonPerformance({
    ...season, stints: [{ ...season.stints[0], expectedGameIds: [game.gameId, "sim-missing"] }],
  }, policy), "INCOMPLETE_COVERAGE");
});

test("SIMULATION | combines same-season team stints deterministically and rejects double counting", () => {
  const second = {
    ...passing({ attempts: observed(5), completions: observed(3), yards: observed(40),
      touchdowns: observed(0), interceptions: observed(1) }),
    gameId: "sim-game-2", teamId: "sim-team-c",
  };
  const secondStint = { id: "sim-stint-2", teamId: second.teamId, expectedGameIds: [second.gameId], games: [second] };
  const stints = [...season.stints, secondStint];
  const result = calculateSeasonPerformance({ ...season, stints }, policy);
  assert.equal(result.status, "PROVISIONAL");
  assert.equal(result.confidence.passingAttempts, 15);
  assert.ok(Math.abs(result.latent - (10 * 0.3 + 5 * 0.225) / 15) < 1e-12);
  assert.deepEqual(calculateSeasonPerformance({ ...season, stints: [...stints].reverse() }, policy), result);
  blocked(calculateSeasonPerformance({
    ...season, stints: [...season.stints, { ...season.stints[0], id: "sim-duplicate-stint" }],
  }, policy), "INVALID_SCOPE");
  blocked(calculateSeasonPerformance(seasonWith({ ...game, playedAt: "2025-02-02T00:00:00.000Z" }), policy), "INVALID_SCOPE");
  blocked(calculateSeasonPerformance(seasonWith({ ...game, seasonId: "sim-other-season" }), policy), "INVALID_SCOPE");
  blocked(calculateSeasonPerformance({
    ...season, snapshot: { ...season.snapshot, availableAt: "2025-02-02T00:00:00.000Z" },
  }, policy), "INVALID_SCOPE");
});

test("SIMULATION | rejects mismatched context, invalid parameters, and unapproved input origin", () => {
  const mustNotRun = () => { throw new Error("simulation callback must not run"); };
  blocked(calculateSeasonPerformance({
    ...season, snapshot: { ...season.snapshot, origin: "REAL" },
  }, { ...policy, context: { ...policy.context, expectedTouchdowns: mustNotRun } }), "REAL_DATA_DISABLED");
  blocked(calculateSeasonPerformance(season, {
    ...policy, context: { ...policy.context, version: "sim-wrong", expectedTouchdowns: mustNotRun },
  }), "NO_VALIDATED_MODEL_PATH");
  blocked(calculateSeasonPerformance(season, { ...policy, calibration: { ...policy.calibration, slope: 0 } }), "INVALID_MODEL_OUTPUT");
  blocked(calculateSeasonPerformance(season, {
    ...policy, components: { ...policy.components, ballControl: { ...policy.components.ballControl, weight: 0.1 } },
  }), "INVALID_MODEL_OUTPUT");
  blocked(calculateSeasonPerformance(season, {
    ...policy, context: { ...policy.context, expectedTouchdowns: () => null },
  }), "MISSING_COMPONENT");
});

const scope = { playerId: game.playerId, position: "QB", asOf: season.asOf } as const;

test("SIMULATION | updates longitudinal ability separately and grows uncertainty during inactivity", () => {
  const later = {
    ...evidence, evidenceId: "sim-evidence-2", dataVersion: "sim-data-2", latent: 4, measurementVariance: 3,
    observedAt: "2025-01-12T00:00:00.000Z", availableAt: "2025-01-13T00:00:00.000Z",
  };
  const history = [later, evidence];
  const result = calculateOverall(scope, "SYNTHETIC", history, overallPolicy);
  assert.equal(result.status, "PROVISIONAL");
  assert.equal(result.kind, "OVERALL");
  assert.equal(result.label, "SIMULATION");
  assert.equal(result.latent, 2.5);
  assert.equal(result.simulationVariance, 11.5);
  assert.equal(result.confidence.score, null);
  assert.equal(result.calibrationVersion, overallPolicy.calibration.version);
  assert.deepEqual(result.history.map(({ evidenceId }) => evidenceId), [evidence.evidenceId, later.evidenceId]);
  assert.deepEqual(calculateOverall(scope, "SYNTHETIC", [...history].reverse(), overallPolicy), result);
});

test("SIMULATION | excludes future releases and incompatible evidence and rejects duplicate observations", () => {
  const future = { ...evidence, availableAt: "2025-02-02T00:00:00.000Z" };
  const other = { ...evidence, model: { ...evidence.model, parameterVersion: "sim-other-params" } };
  blocked(calculateOverall(scope, "SYNTHETIC", [future, other], overallPolicy), "NO_COMPATIBLE_HISTORY");
  blocked(calculateOverall(scope, "SYNTHETIC", [evidence, evidence], overallPolicy), "INVALID_SCOPE");
  blocked(calculateOverall(scope, "SYNTHETIC", [{ ...evidence, measurementVariance: 0 }], overallPolicy), "INVALID_MODEL_OUTPUT");
  blocked(calculateOverall(scope, "SYNTHETIC", [evidence], { ...overallPolicy, processVariancePerDay: -1 }), "INVALID_MODEL_OUTPUT");
  blocked(calculateOverall(scope, "REAL", [evidence], overallPolicy), "REAL_DATA_DISABLED");
});
