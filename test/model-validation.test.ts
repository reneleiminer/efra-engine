import assert from "node:assert/strict";
import { test } from "node:test";
import { describePositionDataRequirements, positionMetricRegistry, positionMetricRegistryVersion, runSyntheticValidation } from "../src/index.ts";
import type { Observation, Position, ReferencePopulation, ValidationPlan, ValidationSample, ValidationStudy } from "../src/index.ts";
import { observed, source } from "./simulation-fixtures.ts";

type ScoreStudy = Extract<ValidationStudy, { readonly product: "SPR" | "OVR" }>;
const date = (month: number, day: number) => new Date(Date.UTC(2042, month - 1, day)).toISOString();
const registry = positionMetricRegistry();
const positions = [...new Set(registry.metrics.map(({ position }) => position))];

function fixture(position: Position = "QB", pathId = position === "QB" ? "QB_STANDARD_CORE" : "POSITION_CORE"): ScoreStudy {
  const { paths } = describePositionDataRequirements(position);
  const path = paths.find(({ id }) => id === pathId)!;
  const required = registry.metrics.filter((metric) => metric.position === position
    && (path.requiredFields?.includes(metric.field) || metric.tiers.some((tier) => path.requiredTiers?.includes(tier))));
  const zeros = new Set(pathId === "QB_RUSH_ONLY_SPECIAL" ? path.requiredFields : pathId === "P_UNRETURNED_ONLY_V1"
    ? ["returnedPunts", "returnedFieldPositionAboveExpected"] : []);
  const plan: ValidationPlan = {
    origin: "SYNTHETIC", version: "sim-plan-1", dataVersion: "sim-data-1", modelVersion: "sim-model-1",
    registryVersion: positionMetricRegistryVersion, position, pathId,
    windows: { train: { start: date(1, 1), end: date(2, 1) }, validation: { start: date(2, 1), end: date(3, 1) },
      test: { start: date(3, 1), end: date(4, 1) } },
    frozenAt: date(4, 10), outcome: { kind: "SEASON_REFERENCE", definitionVersion: "sim-outcome-1" },
    coverage: { minimumGames: 1, minimumExposure: Object.fromEntries(required.filter(({ roles, field }) =>
      roles.includes("EXPOSURE") && !zeros.has(field)).map(({ field }) => [field, 2])) },
    playerDisjoint: true, minimumGroupSize: 2, minimumPartitionClusters: { train: 2, validation: 2, test: 2 },
  };
  const samples = [1, 2, 3].flatMap((month) => [0, 1, 2].map((i): ValidationSample => {
    const id = "sim-" + month + "-" + i;
    const predictedAt = date(month, 10 + i);
    const target = 20 + i * 25;
    const evidence = (name: string) => ({ availableAt: date(month, 9), evidenceIds: [id + "-" + name] });
    return {
      id, origin: "SYNTHETIC", playerId: id, stintId: id, clusterId: id, populationId: "sim-pop-" + month,
      position, leagueId: "sim-league-a", seasonId: "sim-season-" + month, predictedAt,
      participation: [{ ...evidence("assignment"), gameId: id, playedAt: date(month, 8),
        status: "VERIFIED_AT_POSITION", source }],
      fields: Object.fromEntries(required.map(({ field }) => [field, {
        ...evidence(field), observation: observed(zeros.has(field) ? 0 : field.endsWith(".attempts") ? 12
          : field === "passing.completions" ? 7 : 3),
      }])),
      features: { main: { ...evidence("feature-main"), value: target, metricFields: [] },
        alternate: { ...evidence("feature-alt"), value: [20, 70, 45][i]!, metricFields: [] } },
      target: { ...evidence("external-target"), eventAt: date(month, 9), availableAt: date(month, 20), value: target },
    };
  }));
  const populations = [1, 2, 3].map((month): ReferencePopulation => ({
    id: "sim-pop-" + month, version: "sim-cohort-1", origin: "SYNTHETIC", position, leagueId: "sim-league-a",
    seasonId: "sim-season-" + month, competitionLevel: "sim-level-a",
    startsAt: date(month, 1), endsAt: date(month + 1, 1), membershipLockedAt: date(month, 1),
    memberPlayerIds: samples.filter(({ seasonId }) => seasonId === "sim-season-" + month).map(({ playerId }) => playerId),
  }));
  return {
    product: "SPR", plan, populations, samples,
    candidates: [{ id: "sim-b", weights: { main: 0, alternate: 1 } }, { id: "sim-a", weights: { main: 1, alternate: 0 } }],
    sensitivity: [
      { id: "sim-weights", kind: "WEIGHTS", weights: { main: 0.5, alternate: 0.5 } },
      { id: "sim-shift", kind: "BASELINE_SHIFT", shift: 10 },
      { id: "sim-field", kind: "REMOVE_FIELD", field: required[0]!.field },
    ],
  };
}

function mutate(study: ScoreStudy, index: number, update: (sample: ValidationSample) => ValidationSample): ScoreStudy {
  return { ...study, samples: study.samples.map((sample, i) => i === index ? update(sample) : sample) };
}

function score(study: ScoreStudy) {
  const result = runSyntheticValidation(study);
  assert.notEqual(result.product, "CONFIDENCE");
  assert.ok("selected" in result);
  return result;
}

for (const position of positions) {
  test("SIMULATION validation coverage for " + position, () => {
    const study = fixture(position);
    const result = score(study);
    assert.equal(result.test.count, 3);
    assert.equal(result.test.mae, 0);
    assert.equal(result.selected.id, "sim-a");
    assert.equal(result.officialEligible, false);
    assert.equal(result.empiricalValidation, false);
    const field = Object.keys(study.plan.coverage.minimumExposure)[0]!;
    const partial = mutate(study, 6, (sample) => ({
      ...sample, fields: { ...sample.fields, [field]: { ...sample.fields[field]!, observation: { status: "MISSING" } } },
    }));
    assert.deepEqual(score(partial).excluded[0]?.issues, [field + ":MISSING"]);
  });
}

test("SIMULATION reference population fingerprints and reports reproduce independent of input order", () => {
  assert.equal(positions.length, 24);
  const study = fixture();
  const first = score(study);
  const reordered = { ...study, candidates: [...study.candidates].reverse(), sensitivity: [...study.sensitivity].reverse(),
    samples: [...study.samples].reverse(), populations: [...study.populations].reverse().map((p) => ({
      ...p, memberPlayerIds: [...p.memberPlayerIds].reverse(),
    })) };
  assert.deepEqual(first, score(reordered));
  const revised = { ...study, populations: study.populations.map((p) => ({ ...p, version: "sim-cohort-2" })) };
  assert.notEqual(first.inputSha256, score(revised).inputSha256);
  assert.notEqual(first.populations[0]!.sha256, score(revised).populations[0]!.sha256);
  assert.throws(() => score({ ...study, populations: study.populations.map((p) => ({
    ...p, membershipLockedAt: date(3, 25),
  })) }), /reference population/);
});

test("SIMULATION candidate selection and fitting do not use test targets", () => {
  const study = fixture();
  const before = score(study);
  const after = score(mutate(study, 6, (sample) => ({ ...sample, target: { ...sample.target, value: 100 } })));
  assert.deepEqual(before.selected, after.selected);
  assert.equal(before.protocolSha256, after.protocolSha256);
  assert.deepEqual(before.candidateValidation, after.candidateValidation);
  assert.equal(after.overfitDiagnostics.validationMinusTrainMae, 0);
  assert.ok(after.overfitDiagnostics.testMinusValidationMae > 0);
  assert.notEqual(before.test.mae, after.test.mae);
  assert.notEqual(before.inputSha256, after.inputSha256);
  assert.ok(before.sensitivity.find(({ scenario }) => scenario.kind === "WEIGHTS")!.pairedMaeChange! > 0);
  assert.equal(before.sensitivity.find(({ scenario }) => scenario.kind === "BASELINE_SHIFT")!.meanAbsolutePredictionChange, 10);
  assert.equal(before.sensitivity.find(({ scenario }) => scenario.kind === "REMOVE_FIELD")!.retained, 0);
});

test("SIMULATION refuses future inputs, delayed labels and a forward target with wrong horizon", () => {
  const study = fixture();
  const future = mutate(study, 0, (sample) => ({ ...sample, features: { ...sample.features,
    main: { ...sample.features.main!, availableAt: date(1, 29) } } }));
  assert.throws(() => score(future), /Future or invalid input/);
  const late = mutate(study, 0, (sample) => ({ ...sample, target: { ...sample.target, availableAt: date(2, 1) } }));
  assert.throws(() => score(late), /leaked target/);
  const futureOutcome = { kind: "FUTURE_EVENT", definitionVersion: "sim-forecast-1", minimumHorizonDays: 1,
    maximumHorizonDays: 5 } as const;
  const ovr = { ...study, product: "OVR", plan: { ...study.plan, outcome: futureOutcome },
    samples: study.samples.map((sample) => ({ ...sample, target: { ...sample.target,
      eventAt: new Date(Date.parse(sample.predictedAt) + 2 * 86_400_000).toISOString() } })) } as const;
  assert.equal(score(ovr).test.mae, 0);
  assert.throws(() => score(mutate(ovr, 0, (sample) => ({ ...sample,
    target: { ...sample.target, eventAt: sample.predictedAt } }))), /leaked target/);
});

test("SIMULATION refuses duplicate labels, duplicate scope, and shared or circular evidence", () => {
  const study = fixture();
  assert.throws(() => score({ ...study, samples: [...study.samples, study.samples[0]!] }), /sample ID/);
  assert.throws(() => score({ ...study, samples: [...study.samples, { ...study.samples[0]!, id: "sim-new",
    stintId: "sim-renamed-stint" }] }), /Duplicate sample scope/);
  const labelIds = study.samples[0]!.target.evidenceIds;
  assert.throws(() => score(mutate(study, 7, (s) => ({ ...s, target: { ...s.target, evidenceIds: labelIds } }))), /Target evidence counted/);
  const replaceFeature = (s: ValidationSample, evidenceIds: readonly string[]) => ({
    ...s, features: { ...s.features, main: { ...s.features.main!, evidenceIds } },
  });
  assert.throws(() => score(mutate(study, 0, (s) => replaceFeature(s, labelIds))), /Target evidence reused/);
  assert.throws(() => score(mutate(study, 0, (s) => replaceFeature(s, s.features.alternate!.evidenceIds))), /double counting/);
  assert.throws(() => score(mutate(study, 6, (s) =>
    replaceFeature(s, study.samples[0]!.features.main!.evidenceIds))), /Input evidence reused across partitions/);
  assert.throws(() => score(mutate(study, 6, (s) => ({ ...s, clusterId: study.samples[0]!.clusterId }))), /cluster or player/);
  assert.throws(() => score(mutate(study, 6, (s) => ({ ...s, participation: [{ ...s.participation[0]!,
    gameId: study.samples[0]!.participation[0]!.gameId }] }))), /Game spans partitions/);
});

test("SIMULATION verifies positional participation and distinguishes unavailable values from verified zero", () => {
  const study = fixture();
  const missingStates: Observation[] = [{ status: "MISSING" }, { status: "NOT_APPLICABLE" },
    { status: "CONFLICTED", sources: [source] }, observed(0)];
  for (const observation of missingStates) {
    const changed = mutate(study, 6, (sample) => ({ ...sample, fields: { ...sample.fields,
      "passing.attempts": { ...sample.fields["passing.attempts"]!, observation } } }));
    const suffix = observation.status === "VERIFIED_ZERO" ? "LOW_EXPOSURE" : observation.status;
    assert.equal(score(changed).excluded[0]?.issues[0], "passing.attempts:" + suffix);
  }
  const unverified = mutate(study, 6, (s) => ({ ...s, participation: [{ ...s.participation[0]!, status: "UNVERIFIED" }] }));
  assert.deepEqual(score(unverified).excluded[0]?.issues, ["PARTICIPATION"]);
  const none = mutate(unverified, 7, (s) => ({ ...s, participation: [] }));
  assert.throws(() => score(none), /Insufficient eligible clusters/);
  const realSource = mutate(study, 6, (s) => ({ ...s, participation: [{ ...s.participation[0]!,
    source: { ...source, origin: "REAL", officiality: "OFFICIAL_SOURCE" } }] }));
  assert.throws(() => score(realSource), /Invalid participation evidence/);
  assert.equal(score(fixture("QB", "QB_RUSH_ONLY_SPECIAL")).test.count, 3);
  assert.equal(score(fixture("P", "P_UNRETURNED_ONLY_V1")).test.count, 3);
  assert.equal(score(fixture("QB", "QB_ADVANCED")).test.count, 3);
});

test("SIMULATION rejects contradictory counters and reports optional field dependence without reweighting", () => {
  const study = fixture();
  const inconsistent = mutate(study, 6, (sample) => ({ ...sample, fields: { ...sample.fields,
    "passing.completions": { ...sample.fields["passing.completions"]!, observation: observed(13) } } }));
  assert.ok(score(inconsistent).excluded[0]?.issues.includes("passing.attempts:INCONSISTENT_passing.completions,passing.interceptions"));
  const field = "advancedPassing.nonTouchdownFirstDowns";
  const declared = mutate(study, 6, (sample) => ({ ...sample, features: { ...sample.features,
    main: { ...sample.features.main!, metricFields: [field] } } }));
  assert.throws(() => score(declared), /Untraceable feature metric dependency/);
  const dependent = mutate(declared, 6, (sample) => ({ ...sample, fields: { ...sample.fields,
    [field]: { availableAt: sample.features.main!.availableAt, evidenceIds: sample.features.main!.evidenceIds, observation: observed(1) },
  } }));
  const invalid = mutate(dependent, 6, (sample) => ({ ...sample, fields: { ...sample.fields,
    [field]: { ...sample.fields[field]!, observation: observed(0.5) },
  } }));
  assert.ok(score(invalid).excluded[0]?.issues.includes(field + ":UNUSABLE_FEATURE_INPUT"));
  const stressed = score({ ...dependent,
    sensitivity: [{ id: "sim-optional-drop", kind: "REMOVE_FIELD", field }] });
  assert.deepEqual(stressed.sensitivity.map(({ retained, total, pairedMaeChange }) => ({ retained, total, pairedMaeChange })),
    [{ retained: 2, total: 3, pairedMaeChange: 0 }]);
});

test("SIMULATION separates new-player generalization from longitudinal cohorts", () => {
  const study = fixture();
  const repeatedPlayer = study.samples[0]!.playerId;
  const acrossSplits = mutate({ ...study, populations: study.populations.map((p, index) => index === 2
    ? { ...p, memberPlayerIds: [...p.memberPlayerIds, repeatedPlayer] } : p) }, 6,
  (sample) => ({ ...sample, playerId: repeatedPlayer }));
  assert.throws(() => score(acrossSplits), /cluster or player/);
  const longitudinal = score({ ...acrossSplits, plan: { ...acrossSplits.plan, playerDisjoint: false } });
  assert.equal(longitudinal.test.count, 3);
});

test("SIMULATION diagnoses transfer and competition-level gaps with only train-visible league bridges", () => {
  const study = fixture();
  const firstTest = study.samples[6]!;
  const thirdTest = study.samples[8]!;
  const testB = { ...study.populations[2]!, id: "sim-pop-level-b", leagueId: "sim-league-b", competitionLevel: "sim-level-b",
    memberPlayerIds: [firstTest.playerId, thirdTest.playerId] };
  const bridge = { id: "sim-transfer-bridge", kind: "TRANSFER", position: "QB", leagueId: "sim-league-b",
    referenceLeagueId: "sim-league-a", observedAt: date(1, 15), availableAt: date(1, 20),
    difficultyDifference: observed(-0.25), simulationVariance: 0.5, evidenceIds: ["sim-independent-bridge"] } as const;
  const withBridge: ScoreStudy = { ...study, populations: [...study.populations, testB],
    samples: study.samples.map((sample, i) => i === 7 || i === 8 ? { ...sample, populationId: testB.id, leagueId: testB.leagueId,
      playerId: i === 7 ? firstTest.playerId : sample.playerId, ...(i === 7 && { clusterId: firstTest.clusterId,
        transfer: { priorLeagueId: "sim-league-a", effectiveAt: date(3, 9), availableAt: date(3, 9),
          evidenceIds: ["sim-confirmed-transfer"] } }),
    } : sample),
    plan: { ...study.plan, leagueContext: { referenceLeagueId: "sim-league-a", version: "sim-strength", bridges: [bridge] } } };
  const result = score(withBridge);
  const estimate = result.league.find(({ leagueId }) => leagueId === testB.leagueId)?.estimate;
  assert.equal(estimate?.status, "AVAILABLE");
  if (estimate?.status === "AVAILABLE") assert.equal(estimate.adjustment, -0.25);
  assert.equal(result.stability.changedLeague.pairs, 1);
  assert.equal(result.subgroups.find(({ value }) => value === "LEAGUE_CHANGE")?.metrics, null);
  assert.equal(result.subgroups.find(({ value }) => value === "sim-level-b")?.eligible, 2);
  const updateBridge = (bridges: NonNullable<ValidationPlan["leagueContext"]>["bridges"]): ScoreStudy => ({
    ...withBridge, plan: { ...withBridge.plan, leagueContext: { ...withBridge.plan.leagueContext!, bridges } },
  });
  const late = score(updateBridge([{ ...bridge, availableAt: date(2, 5) }]));
  assert.equal(late.league.find(({ leagueId }) => leagueId === testB.leagueId)?.estimate.status, "UNAVAILABLE");
  assert.throws(() => score(updateBridge([bridge, { ...bridge, id: "sim-second-bridge" }])), /evidence counted/);
  assert.throws(() => score(updateBridge([{ ...bridge, evidenceIds: firstTest.target.evidenceIds }])), /overlaps study evidence/);
  const unknown = mutate(withBridge, 7, (s) => ({ ...s, transfer: { ...s.transfer!, availableAt: date(3, 25) } }));
  assert.throws(() => score(unknown), /Future or invalid input/);
});

test("SIMULATION confidence uses reliability counts and an independent prospective binary outcome", () => {
  const study = fixture();
  const confidence: ValidationStudy = { ...study, product: "CONFIDENCE", probabilityFeature: "main", binEdges: [0, 0.5, 1],
    plan: { ...study.plan, outcome: { kind: "FUTURE_EVENT", definitionVersion: "sim-confidence-event-1",
      minimumHorizonDays: 1, maximumHorizonDays: 7 } },
    samples: study.samples.map((sample, index) => ({ ...sample,
      features: { main: { ...sample.features.main!, value: [0, 0.5, 1][index % 3]! } },
      target: { ...sample.target, value: index % 3 ? 1 : 0,
        eventAt: new Date(Date.parse(sample.predictedAt) + 2 * 86_400_000).toISOString() },
    })),
  };
  const report = runSyntheticValidation(confidence);
  assert.equal(report.product, "CONFIDENCE");
  assert.ok("brier" in report.test);
  assert.equal(report.test.brier, 1 / 12);
  assert.ok(report.test.brier < report.test.baselineBrier);
  assert.deepEqual(report.test.bins.map(({ count, observed }) => [count, observed]), [[1, undefined], [2, 1]]);
  assert.equal(report.empiricalValidation, false);
  assert.throws(() => runSyntheticValidation({ ...confidence, binEdges: [0, 1, 1] }), /confidence bins/);
});
