import assert from "node:assert/strict";
import { test } from "node:test";
import { compileCanonicalValidation, describePositionDataRequirements, positionMetricRegistry,
  positionMetricRegistryVersion, positionProjectionVersion, runSyntheticValidation } from "../src/index.ts";
import type { CanonicalValidationEntry, CanonicalValidationRecipe, CanonicalValidationRelease, Observation, Position, ValidationPlan } from "../src/index.ts";
import { canonicalSha256 } from "../src/ingest/determinism.ts";
import { coverageRequirements } from "../src/validation/dataset.ts";
import { observed, source } from "./simulation-fixtures.ts";

const date = (month: number, day: number) => new Date(Date.UTC(2045, month - 1, day)).toISOString();
const registry = positionMetricRegistry();
const positions = [...new Set(registry.metrics.map(({ position }) => position))];
const modelArtifactSha256 = canonicalSha256("SIMULATION model");
const engineArtifactSha256 = canonicalSha256("SIMULATION engine");

function fixture(position: Position = "QB", pathId = position === "QB" ? "QB_STANDARD_CORE" : "POSITION_CORE") {
  const product = "SPR";
  const plan: ValidationPlan = {
    origin: "SYNTHETIC", version: "sim-canonical-plan", dataVersion: "sim-canonical-data", modelVersion: "sim-canonical-model",
    registryVersion: positionMetricRegistryVersion, position, pathId, outcome: { kind: "SEASON_REFERENCE", definitionVersion: "sim-target" },
    windows: { train: { start: date(1, 1), end: date(2, 1) }, validation: { start: date(2, 1), end: date(3, 1) },
      test: { start: date(3, 1), end: date(4, 1) } }, frozenAt: date(4, 10),
    coverage: { minimumGames: 1, minimumExposure: {} }, playerDisjoint: true,
    minimumGroupSize: 1, minimumPartitionClusters: { train: 1, validation: 1, test: 1 },
  };
  const requirements = describePositionDataRequirements(position);
  const path = requirements.paths.find(({ id }) => id === pathId)!;
  const metrics = registry.metrics.filter((m) => m.position === position);
  const zeros = new Set(pathId === "QB_RUSH_ONLY_SPECIAL" ? [...(path.requiredFields ?? []), "advancedPassing.nonTouchdownFirstDowns"]
    : pathId === "P_UNRETURNED_ONLY_V1" ? ["returnedPunts", "returnedFieldPositionAboveExpected"]
      : pathId === "LS_PUNT_SNAP_ONLY_V1" ? ["placekickSnaps", "accuratePlacekickSnaps"] : []);
  const exposure = Object.fromEntries(metrics.filter(({ roles, field, tiers }) => roles.includes("EXPOSURE") && !zeros.has(field)
    && (path.requiredFields?.includes(field) || tiers.some((tier) => path.requiredTiers?.includes(tier)))).map(({ field }) => [field, 1]));
  const header: CanonicalValidationRecipe["header"] = {
    plan: { ...plan, coverage: { ...plan.coverage, minimumExposure: exposure } },
    product, populations: [1, 2, 3].map((month) => ({
      id: "sim-pop-" + month, version: "sim-ref", origin: "SYNTHETIC", position, leagueId: "sim-league",
      seasonId: "sim-season-" + month, competitionLevel: "sim-level", startsAt: date(month, 1), endsAt: date(month + 1, 1),
      membershipLockedAt: date(month, 1), memberPlayerIds: ["sim-player-" + month],
    })),
    candidates: [{ id: "sim-candidate", weights: { main: 1 } }], sensitivity: [],
  };
  const needed = coverageRequirements({ ...header, samples: [] });
  const releases = new Map<string, CanonicalValidationRelease>();
  const entries = header.populations.map((population, index): CanonicalValidationEntry => {
    const month = index + 1;
    const { seasonId } = population;
    const playerId = population.memberPlayerIds[0]!;
    const snapshotId = "sim-snapshot-" + month;
    const stageId = String(month);
    const gameId = "sim-game-" + month;
    const identity = { gameId, playerId, teamId: "sim-team", opponentId: "sim-opponent", seasonId,
      playedAt: date(month, 7), usage: { status: "PLAYED" as const, source } };
    const value = (field: string) => zeros.has(field) ? 0 : field.endsWith(".attempts") ? 12
      : field === "passing.completions" ? 7 : field === "passing.interceptions" ? 0 : 3;
    const observation = (field: string) => observed(value(field));
    const observations = Object.fromEntries(metrics.filter(({ storage }) => storage === "GAME").map(({ field }) => [field, observation(field)]));
    const game = position === "QB" ? { ...identity, position, stats: {
      passing: { attempts: observation("passing.attempts"), completions: observation("passing.completions"), yards: observation("passing.yards"),
        touchdowns: observation("passing.touchdowns"), interceptions: observation("passing.interceptions") },
      rushing: { attempts: observation("rushing.attempts"), yards: observation("rushing.yards"), touchdowns: observation("rushing.touchdowns"),
        turnovers: observation("rushing.turnovers") },
      situation: { opportunities: observation("situation.opportunities"), actualPointsAdded: observation("situation.actualPointsAdded"),
        expectedPointsAdded: observation("situation.expectedPointsAdded") },
      advancedPassing: { definitionVersion: "sim-adv", nonTouchdownFirstDowns: observation("advancedPassing.nonTouchdownFirstDowns") },
    } } as const : { ...identity, position, stats: { definitionVersion: requirements.definitionVersion, observations } };
    const facts = metrics.filter(({ storage }) => storage === "GAME").map(({ field, unit }) => ({
      stageId, field, unit, observation: observation(field) as Extract<Observation, { value: number }>,
      observationId: "sim-observation-" + month + "-" + field,
    }));
    releases.set(snapshotId, {
      projectedAt: date(month, 9), availableAt: date(month, 9), proofs: facts.map(({ field }) => ({
        stageId, field, sourceUuid: "sim-canonical-source", sourceProtocolSha256: canonicalSha256("sim-protocol"),
        featureVersion: requirements.definitionVersion, attestedAt: date(month, 7), attestedBy: "sim-attestor",
        artifacts: (() => {
          const capability = metrics.find((metric) => metric.field === field)!.sourceCapability;
          const kinds = capability === "PLAY_BY_PLAY_AND_MODEL" ? ["PLAY_BY_PLAY", "MODEL_REFERENCE"]
            : [capability === "BOX_SCORE_CANDIDATE" ? "BOX_SCORE" : capability];
          return kinds.map((kind) => ({ kind, reference: "sim-artifact", sha256: canonicalSha256([gameId, field, kind]),
            gameId, playerId, position, field }));
        })(),
      })),
      release: { registryVersion: positionMetricRegistryVersion, projectionVersion: positionProjectionVersion, facts,
        snapshot: { origin: "SYNTHETIC", label: "SIMULATION", snapshotId, seasonId, competitionId: population.leagueId,
          asOf: date(month, 8), schemaVersion: "sim-schema", games: [{
            stageId, game, sourceRecordId: "sim-record-" + month, sourceId: source.sourceId, sourceRevision: source.revisionId,
            supersedesSourceRevision: null, payloadSha256: canonicalSha256(gameId), mappingVersion: "sim-mapping",
            batchKey: "sim-batch-" + month, retrievedAt: date(month, 7), reviewedAt: date(month, 8),
            reviewerId: "sim-reviewer", reviewReason: "SIMULATION",
          }] } },
    });
    return {
      id: "sim-sample-" + month, snapshotId, populationId: population.id, playerId, stintId: "sim-stint-" + month,
      clusterId: "sim-cluster-" + month, predictedAt: date(month, 10), expectedGames: [{ gameId, teamId: identity.teamId }],
      target: { eventAt: date(month, 8), availableAt: date(month, 20), value: 10, evidenceIds: ["sim-target-" + month],
        artifactSha256: canonicalSha256(["sim-independent", month]) },
      policyFields: Object.fromEntries(needed.required.filter(({ storage }) => storage === "RATING_POLICY").map(({ field }) => [
        field, { observation: observation(field), availableAt: date(month, 1), evidenceIds: ["sim-policy-" + month + "-" + field] },
      ])),
      features: { main: { kind: "CANONICAL_METRIC", field: needed.exposure[0]!.field, offset: 0, scale: 1 } },
    };
  });
  return { recipe: { header, modelArtifactSha256, engineArtifactSha256, entries }, releases,
    read: async (id: string) => releases.get(id) ?? null };
}

for (const position of positions) {
  test("SIMULATION canonical validation supports every registered path for " + position, async () => {
    for (const { id } of describePositionDataRequirements(position).paths) {
      const { recipe, read } = fixture(position, id);
      const result = await compileCanonicalValidation(read, recipe);
      assert.equal(result.study.samples.length, 3);
      assert.ok(result.batches.every(({ payload }) => payload.every(({ trace }) => trace.proofs.length === trace.facts.length)));
      assert.equal(runSyntheticValidation(result.study).empiricalValidation, false);
    }
  });
}

test("SIMULATION canonical bridge retains raw proof and zero and checks projected availability", async () => {
  const { recipe, read } = fixture();
  const first = await compileCanonicalValidation(read, recipe);
  const repeated = await compileCanonicalValidation(read, { ...recipe, entries: [...recipe.entries].reverse() });
  assert.equal(first.datasetSha256, repeated.datasetSha256);
  const { sample, trace } = first.batches[0]!.payload[0]!;
  assert.equal(sample.fields["passing.interceptions"]?.observation.status, "VERIFIED_ZERO");
  assert.equal(trace.facts.find(({ field }) => field === "passing.interceptions")?.unit, "interceptions");
  assert.equal(trace.proofs[0]?.attestedBy, "sim-attestor");
  await assert.rejects(compileCanonicalValidation(async (id) => {
    const release = await read(id);
    return release && { ...release, availableAt: date(4, 2) };
  }, recipe), /availability mismatch/);
  await assert.rejects(compileCanonicalValidation(async (id) => {
    const release = await read(id);
    return release && { ...release, proofs: [] };
  }, recipe), /canonical facts or proofs/);
});

test("SIMULATION canonical bridge excludes missing expected games and refuses cross-partition artifact aliases", async () => {
  const { recipe, read, releases } = fixture();
  const entry = recipe.entries[2]!;
  const amended = { ...entry, id: "sim-extra", predictedAt: date(3, 11), clusterId: "sim-other-cluster",
    expectedGames: [...entry.expectedGames, { gameId: "sim-absent-game", teamId: "sim-team" }],
    target: { ...entry.target, evidenceIds: ["sim-unused-target"], artifactSha256: canonicalSha256("sim-unique-target") } };
  const dataset = await compileCanonicalValidation(read, { ...recipe, entries: [...recipe.entries, amended] });
  assert.ok(dataset.batches[2]?.payload.find(({ sample }) => sample.id === amended.id)?.issues.includes("INCOMPLETE_EXPECTED_GAMES"));
  const firstRelease = releases.get(recipe.entries[0]!.snapshotId)!;
  const finalRelease = releases.get(entry.snapshotId)!;
  const shared = firstRelease.proofs[0]!.artifacts[0]!.sha256;
  await assert.rejects(compileCanonicalValidation(read, { ...recipe, entries: recipe.entries.map((row) =>
    row === entry ? { ...row, target: { ...row.target, artifactSha256: shared } } : row) }), /Target artifact overlaps/);
  releases.set(entry.snapshotId, { ...finalRelease, proofs: finalRelease.proofs.map((proof) => ({
    ...proof, artifacts: proof.artifacts.map((artifact) => ({ ...artifact, sha256: shared })),
  })) });
  await assert.rejects(compileCanonicalValidation(read, recipe), /partition overlap/);
});

test("SIMULATION bridge feeds distinct OVR and confidence studies from frozen outputs", async () => {
  const { recipe, read } = fixture();
  const outcome = { kind: "FUTURE_EVENT", definitionVersion: "sim-prospective", minimumHorizonDays: 1, maximumHorizonDays: 5 } as const;
  const plan = { ...recipe.header.plan, outcome };
  const entries = recipe.entries.map((entry, i): CanonicalValidationEntry => ({ ...entry,
    target: { ...entry.target, eventAt: date(i + 1, 12), value: i % 2 },
    features: { main: { kind: "FROZEN_OUTPUT", modelArtifactSha256, value: 0.5, availableAt: entry.predictedAt,
      metricFields: [], evidenceIds: ["sim-frozen-prediction-" + i] } },
  }));
  const ovr = await compileCanonicalValidation(read, { ...recipe, entries, header: { plan, populations: recipe.header.populations,
    product: "OVR", candidates: [{ id: "sim-ovr", weights: { main: 1 } }], sensitivity: [] } });
  assert.equal(runSyntheticValidation(ovr.study).product, "OVR");
  const confidence = await compileCanonicalValidation(read, { ...recipe, entries, header: { plan, populations: recipe.header.populations,
    product: "CONFIDENCE", probabilityFeature: "main", binEdges: [0, 0.5, 1] } });
  assert.equal(runSyntheticValidation(confidence.study).product, "CONFIDENCE");
});
