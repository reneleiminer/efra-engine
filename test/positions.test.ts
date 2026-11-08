import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateFieldSeasonPerformance, calculateOverall, calculateSeasonPerformance, describePositionModel, estimateSyntheticLeagueStrength,
} from "../src/index.ts";
import type {
  ComponentDefinition, FieldPath, FieldPosition, FieldSeason, FieldSeasonSimulation, LeagueBridge, LeagueContextRequest, Observation,
} from "../src/index.ts";
import { evidence, game, missing, observed, overallPolicy, policy, season, source } from "./simulation-fixtures.ts";

const positions = [
  "RB", "FB", "WR", "TE", "OT", "OG", "C", "DT", "NT", "EDGE", "ILB", "MLB", "OLB", "CB", "FS", "SS", "S",
  "K", "P", "KR", "PR", "LS", "GUNNER",
] as const satisfies readonly FieldPosition[];
const paths = ["POSITION_CORE", "POSITION_SUPPORTING", "POSITION_ADVANCED"] as const satisfies readonly FieldPath[];

function fixture<P extends FieldPosition>(position: P, path: FieldPath = "POSITION_CORE") {
  const { definitionVersion, tiers } = describePositionModel(position);
  const selected: readonly ComponentDefinition[] = [
    ...tiers.CORE, ...(path === "POSITION_CORE" ? [] : tiers.SUPPORTING), ...(path === "POSITION_ADVANCED" ? tiers.ADVANCED : []),
  ];
  const observations: Record<string, Observation> = {};
  // Use consistent, synthetic component inputs. Shared counters retain their first value.
  for (const term of selected) {
    observations[term.denominator] ??= observed(10);
    observations[term.numerator] ??= observed(4);
    if (term.expected) observations[term.expected] = observed(2);
  }
  // The generic fixture derives all keys from the selected position's typed catalog.
  const stats: FieldSeason<P>["stints"][number]["games"][number]["stats"] = {
    definitionVersion, observations: observations as FieldSeason<P>["stints"][number]["games"][number]["stats"]["observations"],
    leagueStrengthExcluded: true,
  };
  const sample = { ...game, position, stats };
  const input: FieldSeason<P> = { ...season, position, stints: [{ ...season.stints[0], games: [sample] }] };
  const model: FieldSeasonSimulation<P> = {
    version: {
      ...policy.version, path, fieldPosition: position, featureDefinitionVersion: definitionVersion,
      methodVersion: `sim-${position}-spr`, parameterVersion: `sim-${position}-${path}`,
      comparisonScope: { basis: "LEAGUE", leagueId: season.season.leagueId },
    },
    components: Object.fromEntries(selected.map(({ id }) => [id, {
      weight: 1 / selected.length, scale: 1, center: 0,
    }])) as FieldSeasonSimulation<P>["components"],
    calibration: policy.calibration,
  };
  return { input, model, sample, selected, observations };
}

for (const position of positions) {
  test(`SIMULATION | ${position} evaluates all three versioned paths with independent component evidence`, () => {
    for (const path of paths) {
      const { input, model, selected } = fixture(position, path);
      assert.equal(new Set(selected.map(({ id }) => id)).size, selected.length);
      assert.equal(new Set(selected.map(({ numerator }) => numerator)).size, selected.length);
      const result = calculateFieldSeasonPerformance(input, model);
      assert.equal(result.status, "PROVISIONAL");
      assert.equal(result.scope.position, position);
      assert.equal(result.model.path, path);
      assert.equal(result.label, "SIMULATION");
      assert.equal(result.rankingEligible, false);
      assert.equal(result.confidence.score, null);
      assert.equal(Object.keys(result.confidence.componentExposures ?? {}).length, selected.length);
    }
  });
}

test("SIMULATION | distance-adjusted K, negative returns, and attributed OL evidence have distinct behavior", () => {
  const kicker = fixture("K");
  const kicking = calculateFieldSeasonPerformance(kicker.input, kicker.model);
  assert.equal(kicking.status, "PROVISIONAL");
  assert.ok(Math.abs(kicking.latent - 0.3) < 1e-12); // (4 - 2) / 10 and 4 / 10
  kicker.observations["expectedFieldGoalsByDistance"] = missing;
  assert.equal(calculateFieldSeasonPerformance(kicker.input, kicker.model).status, "NOT_RATED");
  kicker.observations["expectedFieldGoalsByDistance"] = observed(11);
  const invalid = calculateFieldSeasonPerformance(kicker.input, kicker.model);
  assert.equal(invalid.status, "NOT_RATED");
  assert.equal(invalid.reason, "INVALID_CORE");

  const returned = fixture("PR");
  returned.observations["puntReturnYardsAboveExpected"] = observed(-10);
  returned.observations["puntReturnFumbles"] = observed(0);
  const result = calculateFieldSeasonPerformance(returned.input, returned.model);
  assert.equal(result.status, "PROVISIONAL");
  assert.equal(result.latent, -0.5);
  const tackle = fixture("OT");
  tackle.observations["edgeProtectionLosses"] = { status: "CONFLICTED", sources: [source] };
  const conflict = calculateFieldSeasonPerformance(tackle.input, tackle.model);
  assert.equal(conflict.status, "NOT_RATED");
  assert.equal(conflict.reason, "UNUSABLE_CORE");
});

test("SIMULATION | declared zero opportunity may be skipped but missing or N/A denominator cannot masquerade as zero", () => {
  const { input, model, sample } = fixture("CB");
  const second = { ...sample, gameId: "sim-cb-2", stats: {
    ...sample.stats, observations: { ...sample.stats.observations, nonTurnoverCoverageTargets: observed(0),
      nonTurnoverYardsAllowed: { status: "NOT_APPLICABLE" } as const },
  } };
  const stints = [{ ...season.stints[0], expectedGameIds: [sample.gameId, second.gameId], games: [sample, second] }];
  const result = calculateFieldSeasonPerformance({ ...input, stints }, model);
  assert.equal(result.status, "PROVISIONAL");
  assert.equal(result.confidence.componentExposures?.["targetCoverage"], 10);
  assert.equal(result.confidence.componentExposures?.["runSupport"], 20);
  for (const bad of [missing, { status: "NOT_APPLICABLE" }, { status: "OBSERVED", value: 0, source }] as const) {
    const invalid = { ...second, stats: { ...second.stats, observations: { ...second.stats.observations,
      nonTurnoverCoverageTargets: bad,
    } } };
    assert.equal(calculateFieldSeasonPerformance({ ...input, stints: [{ ...stints[0]!, games: [sample, invalid] }] }, model).status, "NOT_RATED");
  }
});

test("SIMULATION | field paths reject missing Advanced data, mismatched definition versions and unverified usage", () => {
  const { input, model, observations, sample } = fixture("RB", "POSITION_ADVANCED");
  observations["passBlockFailures"] = missing;
  const result = calculateFieldSeasonPerformance(input, model);
  assert.equal(result.status, "NOT_RATED");
  assert.equal(result.reason, "MISSING_COMPONENT");
  assert.equal(calculateFieldSeasonPerformance(fixture("RB").input, fixture("RB").model).status, "PROVISIONAL");
  const withGame = (next: typeof sample | FieldSeason<"RB">["stints"][number]["games"][number]) =>
    ({ ...input, stints: [{ ...season.stints[0], games: [next] }] });
  const version = calculateFieldSeasonPerformance(withGame({
    ...sample, stats: { ...sample.stats, definitionVersion: "sim-wrong-version" },
  }), model);
  assert.equal(version.status, "NOT_RATED");
  assert.equal(version.reason, "UNUSABLE_CORE");
  const unverified = calculateFieldSeasonPerformance(withGame({
    ...sample, usage: { status: "PLAYED", source: { ...source, verification: "UNVERIFIED" } },
  }), model);
  assert.equal(unverified.status, "NOT_RATED");
  assert.equal(unverified.reason, "UNVERIFIED_USAGE");
  const real = calculateFieldSeasonPerformance({ ...input, snapshot: { ...input.snapshot, origin: "REAL" } }, model);
  assert.equal(real.status, "NOT_RATED");
  assert.equal(real.reason, "REAL_DATA_DISABLED");
});

test("SIMULATION | transfers aggregate once and one player can have independent WR and KR ratings", () => {
  const { input, model, sample } = fixture("WR");
  const transfer = { ...sample, gameId: "sim-new-game", teamId: "sim-new-team", stats: {
    ...sample.stats, observations: { cleanTargets: observed(20), cleanReceivingYards: observed(40), receivingFumbles: observed(0), receptions: observed(5) },
  } };
  const second = { id: "sim-transfer", teamId: transfer.teamId, expectedGameIds: [transfer.gameId], games: [transfer] };
  const stints = [...input.stints, second];
  const result = calculateFieldSeasonPerformance({ ...input, stints }, model);
  assert.equal(result.status, "PROVISIONAL");
  assert.equal(result.confidence.componentExposures?.["receiving"], 30);
  assert.ok(Math.abs(result.latent - (44 / 30 - 4 / 15) / 2) < 1e-12);
  assert.deepEqual(result, calculateFieldSeasonPerformance({ ...input, stints: [...stints].reverse() }, model));
  const dup = calculateFieldSeasonPerformance({ ...input, stints: [...input.stints, {
    ...season.stints[0], id: "sim-duplicate", games: [sample],
  }] }, model);
  assert.equal(dup.status, "NOT_RATED");
  assert.equal(dup.reason, "INVALID_SCOPE");
  const returner = fixture("KR");
  const independent = calculateFieldSeasonPerformance(returner.input, returner.model);
  assert.equal(independent.status, "PROVISIONAL");
  assert.equal(independent.scope.playerId, result.scope.playerId);
  assert.notEqual(independent.scope.position, result.scope.position);
});

test("SIMULATION | verified non-participation contributes no exposure and contradictory stats block the path", () => {
  const { input, model, sample } = fixture("P");
  const dnp = {
    ...sample, gameId: "sim-punter-dnp", usage: { status: "DID_NOT_PLAY", source } as const,
    stats: { ...sample.stats, observations: {} },
  };
  const stints = [{ ...season.stints[0], expectedGameIds: [sample.gameId, dnp.gameId], games: [sample, dnp] }];
  const result = calculateFieldSeasonPerformance({ ...input, stints }, model);
  assert.equal(result.status, "PROVISIONAL");
  assert.equal(result.confidence.verifiedUsageGames, 2);
  assert.equal(result.confidence.usableCoreGames, 1);
  assert.equal(result.confidence.componentExposures?.["returnedFieldPosition"], 10);
  const contradiction = calculateFieldSeasonPerformance({
    ...input, stints: [{ ...season.stints[0], games: [{ ...sample, usage: dnp.usage }] }],
  }, model);
  assert.equal(contradiction.status, "NOT_RATED");
  assert.equal(contradiction.reason, "INVALID_CORE");
  const extraParameter = calculateFieldSeasonPerformance(input, {
    ...model, components: { ...model.components, operation: { center: 0, scale: 1, weight: 0 } },
  });
  assert.equal(extraParameter.status, "NOT_RATED");
  assert.equal(extraParameter.reason, "INVALID_MODEL_OUTPUT");
});

const request = {
  origin: "SYNTHETIC", position: "RB", leagueId: season.season.leagueId, referenceLeagueId: "sim-anchor",
  version: "sim-league-context-1", asOf: season.asOf,
} as const satisfies LeagueContextRequest;
const bridge = {
  id: "sim-bridge", kind: "TRANSFER", position: "RB", leagueId: request.leagueId, referenceLeagueId: request.referenceLeagueId,
  observedAt: "2025-01-10T00:00:00.000Z", availableAt: "2025-01-20T00:00:00.000Z",
  difficultyDifference: observed(2), simulationVariance: 4,
} as const satisfies LeagueBridge;

test("SIMULATION | league context needs independent timely evidence, uses orientation and applies once", () => {
  const reverse = { ...bridge, id: "sim-reverse", kind: "INTERLEAGUE" as const, leagueId: request.referenceLeagueId,
    referenceLeagueId: request.leagueId, difficultyDifference: observed(-4) };
  const estimate = estimateSyntheticLeagueStrength(request, [bridge, reverse]);
  assert.equal(estimate.status, "AVAILABLE");
  assert.equal(estimate.adjustment, 3);
  assert.equal(estimate.simulationVariance, 2);
  assert.deepEqual(estimate, estimateSyntheticLeagueStrength(request, [reverse, bridge]));
  assert.equal(estimateSyntheticLeagueStrength(request, [bridge, bridge]).status, "UNAVAILABLE");
  assert.equal(estimateSyntheticLeagueStrength(request, [{ ...bridge, availableAt: "2025-02-02T00:00:00.000Z" }]).status, "UNAVAILABLE");
  assert.equal(estimateSyntheticLeagueStrength({ ...request, origin: "REAL" }, [bridge]).status, "UNAVAILABLE");

  const { input, model } = fixture("RB");
  const contextual = { ...model, leagueAdjustmentScale: 0.5, version: { ...model.version, contextVersion: request.version,
    comparisonScope: { basis: "BRIDGE_REFERENCE", leagueId: request.referenceLeagueId } as const } };
  const baseline = calculateFieldSeasonPerformance(input, model);
  const adjusted = calculateFieldSeasonPerformance(input, contextual, estimate);
  assert.equal(baseline.status, "PROVISIONAL");
  assert.equal(adjusted.status, "PROVISIONAL");
  assert.equal(adjusted.kind, "SEASON_PERFORMANCE");
  assert.equal(adjusted.latent - baseline.latent, 1.5);
  assert.deepEqual(adjusted.leagueContextEvidenceIds, [bridge.id, reverse.id]);
  assert.equal(calculateFieldSeasonPerformance(input, contextual).status, "NOT_RATED");
  assert.equal(calculateFieldSeasonPerformance(input, model, estimate).status, "NOT_RATED");
});

test("SIMULATION | QB league adjustment requires explicit exclusion from the passing baseline", () => {
  const qbRequest = { ...request, position: "QB" as const, version: policy.context.version };
  const qbBridge = { ...bridge, position: "QB" as const };
  const context = estimateSyntheticLeagueStrength(qbRequest, [qbBridge]);
  const contextual = { ...policy, leagueAdjustmentScale: 0.5, version: { ...policy.version,
    comparisonScope: { basis: "BRIDGE_REFERENCE", leagueId: request.referenceLeagueId } as const } };
  assert.equal(calculateSeasonPerformance(season, contextual, context).status, "NOT_RATED");
  const result = calculateSeasonPerformance(season, {
    ...contextual, context: { ...contextual.context, leagueStrengthExcluded: true },
  }, context);
  assert.equal(result.status, "PROVISIONAL");
  assert.equal(result.latent, 1.3);
});

test("SIMULATION | Overall filters evidence by position, variant and league comparison scope", () => {
  const { model } = fixture("LS");
  const scope = { playerId: game.playerId, position: "LS", asOf: season.asOf } as const;
  const simulation = { ...overallPolicy, version: { ...model.version, methodVersion: "sim-ls-ovr" }, evidenceModel: model.version };
  const valid = { ...evidence, position: "LS" as const, model: model.version };
  const otherPosition = { ...valid, position: "PR" as const, evidenceId: "sim-other-pos" };
  const otherVariant = { ...valid, model: { ...valid.model, path: "POSITION_ADVANCED" as const }, evidenceId: "sim-other-path" };
  const otherLeague = { ...valid, model: { ...valid.model, comparisonScope: {
    basis: "LEAGUE" as const, leagueId: "sim-other-league",
  } }, evidenceId: "sim-other-league" };
  const result = calculateOverall(scope, "SYNTHETIC", [valid, otherPosition, otherVariant, otherLeague], simulation);
  assert.equal(result.status, "PROVISIONAL");
  assert.equal(result.kind, "OVERALL");
  assert.equal(result.scope.position, "LS");
  assert.deepEqual(result.history.map(({ evidenceId }) => evidenceId), [valid.evidenceId]);
  assert.equal(calculateOverall(scope, "SYNTHETIC", [otherLeague], simulation).status, "NOT_RATED");
});
