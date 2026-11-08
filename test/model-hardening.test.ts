import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateFieldSeasonPerformance, calculateOverall, describePositionDataRequirements, describePositionModel,
  positionDataAvailabilityMatrix,
} from "../src/index.ts";
import type { FieldPath, FieldPosition, FieldSeason, FieldSeasonSimulation, RatingResult } from "../src/index.ts";
import { readComponent } from "../src/models/positions/evidence.ts";
import { evidence, game, missing, observed, overallPolicy, policy, season, source } from "./simulation-fixtures.ts";

const na = { status: "NOT_APPLICABLE" } as const;
const term = {
  id: "fieldGoals", numerator: "makes", denominator: "attempts", expected: "expected",
  kind: "BINOMIAL_RESIDUAL", direction: 1,
} as const;

test("SIMULATION | zero exposure requires a verified zero or explicit N/A for each paired input", () => {
  const zero = observed(0);
  for (const [makes, expected, status] of [
    [zero, zero, "NOT_APPLICABLE"], [na, na, "NOT_APPLICABLE"], [na, zero, "NOT_APPLICABLE"],
    [missing, zero, "MISSING"], [zero, missing, "MISSING"], [na, undefined, "MISSING"],
    [observed(1), na, "INVALID"], [zero, observed(0.2), "INVALID"],
    [{ status: "VERIFIED_ZERO", value: 0, source: { ...source, verification: "UNVERIFIED" } }, zero, "UNUSABLE"],
  ] as const) {
    assert.equal(readComponent(term, { attempts: zero, makes, expected }).status, status);
  }
  assert.equal(readComponent(term, { attempts: na, makes: zero, expected: zero }).status, "MISSING");
  assert.equal(readComponent(term, { attempts: observed(2), makes: zero, expected: na }).status, "MISSING");
  assert.deepEqual(readComponent(term, { attempts: observed(2), makes: zero, expected: observed(1) }),
    { status: "AVAILABLE", value: { exposure: 2, value: -0.5 } });
});

function fixture<P extends FieldPosition>(
  position: P, observations: FieldSeason<P>["stints"][number]["games"][number]["stats"]["observations"],
  path: FieldPath, components: FieldSeasonSimulation<P>["components"],
) {
  const { definitionVersion } = describePositionModel(position);
  const input: FieldSeason<P> = { ...season, position, stints: [{
    ...season.stints[0], games: [{ ...game, position, stats: { definitionVersion, observations } }],
  }] };
  const model: FieldSeasonSimulation<P> = {
    version: {
      ...policy.version, path, fieldPosition: position, featureDefinitionVersion: definitionVersion,
      methodVersion: `sim-${position}-hardening`, parameterVersion: `sim-${path}`,
      comparisonScope: { basis: "LEAGUE", leagueId: season.season.leagueId },
    },
    components, calibration: policy.calibration,
  };
  return { input, model };
}

function blocked(result: RatingResult, reason: string, componentId: string) {
  assert.equal(result.status, "NOT_RATED");
  assert.equal(result.reason, reason);
  assert.equal(result.componentIssue?.componentId, componentId);
  assert.equal(result.score, null);
  assert.equal(result.rankingEligible, false);
}

const only = { weight: 1, scale: 1, center: 0 };
const half = { ...only, weight: 0.5 };

test("SIMULATION | unreturned punts use a separate path and minimum exposure with zero-return proof", () => {
  const stats = {
    returnedPunts: observed(0), returnedFieldPositionAboveExpected: na,
    unreturnedPunts: observed(4), unreturnedFieldPositionAboveExpected: observed(8),
  };
  const full = fixture("P", stats, "POSITION_CORE", { returnedFieldPosition: half, unreturnedFieldPosition: half });
  blocked(calculateFieldSeasonPerformance(full.input, full.model), "NO_COMPONENT_EXPOSURE", "returnedFieldPosition");
  const limited = fixture("P", stats, "P_UNRETURNED_ONLY_V1", { unreturnedFieldPosition: { ...only, minimumExposure: 4 } });
  const result = calculateFieldSeasonPerformance(limited.input, limited.model);
  assert.equal(result.status, "PROVISIONAL");
  assert.equal(result.label, "SIMULATION");
  assert.equal(result.rankingEligible, false);
  assert.equal(result.latent, 2);
  assert.deepEqual(result.confidence.componentExposures, { unreturnedFieldPosition: 4 });

  const insufficient = calculateFieldSeasonPerformance(limited.input, {
    ...limited.model, components: { unreturnedFieldPosition: { ...only, minimumExposure: 5 } },
  });
  blocked(insufficient, "INSUFFICIENT_COMPONENT_EXPOSURE", "unreturnedFieldPosition");
  assert.equal(insufficient.status, "NOT_RATED");
  assert.equal(insufficient.componentIssue?.minimumExposure, 5);
  for (const [statsOverride, reason] of [
    [{ returnedPunts: missing }, "MISSING_CORE"],
    [{ returnedPunts: na }, "MISSING_CORE"],
    [{ returnedFieldPositionAboveExpected: missing }, "MISSING_CORE"],
    [{ returnedFieldPositionAboveExpected: observed(-1) }, "INVALID_CORE"],
    [{ returnedPunts: observed(1), returnedFieldPositionAboveExpected: observed(0) }, "LIMITED_PATH_OPPORTUNITY_PRESENT"],
  ] as const) {
    const scenario = fixture("P", { ...stats, ...statsOverride }, "P_UNRETURNED_ONLY_V1", limited.model.components);
    blocked(calculateFieldSeasonPerformance(scenario.input, scenario.model), reason, "returnedFieldPosition");
  }
});

test("SIMULATION | punt-snap specialists stay separate from full LS and cross-league paths", () => {
  const { input, model } = fixture("LS", {
    puntSnaps: observed(5), accuratePuntSnaps: observed(4), placekickSnaps: observed(0), accuratePlacekickSnaps: observed(0),
  }, "LS_PUNT_SNAP_ONLY_V1", { puntSnapAccuracy: only });
  const result = calculateFieldSeasonPerformance(input, model);
  assert.equal(result.status, "PROVISIONAL");
  assert.equal(result.latent, 0.8);
  const scope = result.scope;
  const historical = { ...evidence, position: "LS" as const, model: model.version, latent: result.latent };
  const overall = { ...overallPolicy, version: { ...model.version, methodVersion: "sim-ovr-ls-punt" }, evidenceModel: model.version };
  assert.equal(calculateOverall(scope, "SYNTHETIC", [historical], overall).status, "PROVISIONAL");
  const full = { ...historical, model: { ...historical.model, path: "POSITION_CORE" as const } };
  const mixed = calculateOverall(scope, "SYNTHETIC", [full], overall);
  assert.equal(mixed.status, "NOT_RATED");
  assert.equal(mixed.reason, "NO_COMPATIBLE_HISTORY");
  const bridge = calculateFieldSeasonPerformance(input, {
    ...model, version: { ...model.version, comparisonScope: { basis: "BRIDGE_REFERENCE", leagueId: "sim-anchor" } },
  });
  assert.equal(bridge.status, "NOT_RATED");
  assert.equal(bridge.reason, "NO_VALIDATED_MODEL_PATH");
});

test("SIMULATION | kicker, returner, line and safety report exact reasons when required evidence is unavailable", () => {
  const kick = fixture("K", {
    fieldGoalAttempts: observed(0), fieldGoalsMade: observed(0), expectedFieldGoalsByDistance: observed(0.2),
    extraPointAttempts: observed(2), extraPointsMade: observed(2),
  }, "POSITION_CORE", { fieldGoals: half, extraPoints: half });
  blocked(calculateFieldSeasonPerformance(kick.input, kick.model), "INVALID_CORE", "fieldGoals");
  const returns = fixture("KR", {
    cleanKickReturns: observed(0), kickReturnYardsAboveExpected: na, kickReturns: observed(0), kickReturnFumbles: na,
  }, "POSITION_CORE", { kickReturnValue: half, kickReturnSecurity: half });
  blocked(calculateFieldSeasonPerformance(returns.input, returns.model), "NO_COMPONENT_EXPOSURE", "kickReturnValue");
  const line = fixture("OT", {
    edgePassBlockAssignments: missing, edgeProtectionLosses: observed(0), edgeRunBlockAssignments: observed(2), edgeRunBlockWins: observed(1),
  }, "POSITION_CORE", { edgeProtection: half, runEdge: half });
  blocked(calculateFieldSeasonPerformance(line.input, line.model), "MISSING_CORE", "edgeProtection");
  const safety = fixture("S", {
    coverageTargets: observed(0), coverageYardsAllowed: na, runSupportTackleAttempts: observed(2), runSupportMisses: observed(0),
  }, "POSITION_CORE", { coverage: half, runSupport: half });
  blocked(calculateFieldSeasonPerformance(safety.input, safety.model), "NO_COMPONENT_EXPOSURE", "coverage");
});

test("SIMULATION | source trace preserves absent versus conflicted evidence and the exact snapshot", () => {
  const { input, model } = fixture("K", {
    fieldGoalAttempts: observed(2), fieldGoalsMade: observed(0),
    extraPointAttempts: observed(3), extraPointsMade: { status: "CONFLICTED", sources: [source] },
  }, "POSITION_CORE", { fieldGoals: half, extraPoints: half });
  const result = calculateFieldSeasonPerformance(input, model);
  assert.equal(result.kind, "SEASON_PERFORMANCE");
  blocked(result, "MISSING_CORE", "fieldGoals");
  assert.equal(result.dataVersion, input.snapshot.dataVersion);
  assert.equal(result.inputTrace?.snapshotAvailableAt, input.snapshot.availableAt);
  assert.equal(result.inputTrace?.calibrationVersion, model.calibration.version);
  assert.deepEqual(result.inputTrace?.games[0]?.fields["expectedFieldGoalsByDistance"], { status: "MISSING", sources: [] });
  assert.deepEqual(result.inputTrace?.games[0]?.fields["fieldGoalsMade"], { status: "VERIFIED_ZERO", sources: [source] });
  assert.deepEqual(result.inputTrace?.games[0]?.fields["extraPointsMade"], { status: "CONFLICTED", sources: [source] });
  assert.deepEqual(calculateFieldSeasonPerformance(input, model), result);
});

test("SIMULATION | the JSON-compatible matrix covers all positions and marks charting dependencies", () => {
  const matrix = positionDataAvailabilityMatrix();
  assert.equal(Object.keys(matrix.positions).length, 24);
  assert.equal(matrix.readiness, "REQUIREMENTS_ONLY_SOURCE_COVERAGE_UNVERIFIED");
  for (const position of Object.values(matrix.positions)) {
    assert.equal(position.participation.attribution, "PLAYER_POSITION");
    assert.ok(Object.values(position.tiers).every(({ fields }) => fields.length > 0));
  }
  for (const position of ["OT", "CB", "S", "NT", "GUNNER"] as const) {
    assert.ok(describePositionDataRequirements(position).tiers.CORE.fields.some(({ sourceCapability }) =>
      sourceCapability === "ASSIGNMENT_CHARTING"));
  }
  assert.ok(describePositionDataRequirements("QB").tiers.CORE.fields.some(({ sourceCapability }) =>
    sourceCapability === "BOX_SCORE_CANDIDATE"));
  assert.ok(describePositionDataRequirements("P").paths.some(({ verifiedAbsentComponent }) =>
    verifiedAbsentComponent === "returnedFieldPosition"));
});
