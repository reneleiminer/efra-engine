import type { Observation } from "../contracts/observations.ts";
import { isVerifiedSource } from "../contracts/observations.ts";
import { timestamp } from "../contracts/time.ts";
import { canonicalJson, canonicalSha256 } from "../ingest/determinism.ts";
import type { PositionRelease } from "../ingest/postgres-position-pipeline.ts";
import { gameObservations, positionMetricRegistry, positionProjectionVersion } from "../models/positions/metric-registry.ts";
import { compareId } from "../season/scope.ts";
import type { Partition, TimedEvidence, ValidationSample, ValidationStudy } from "./contracts.ts";
import { coverageIssues, coverageRequirements, ids, ordered, partitions, prepareStudy, requireValid } from "./dataset.ts";

export const canonicalValidationBridgeVersion = "efra-canonical-validation-v1";
export const isSha256 = (value: string) => /^[a-f0-9]{64}$/.test(value);

export interface CanonicalMetricProof {
  readonly stageId: string;
  readonly field: string;
  readonly sourceUuid: string;
  readonly sourceProtocolSha256: string;
  readonly featureVersion: string;
  readonly attestedAt: string;
  readonly attestedBy: string;
  readonly artifacts: readonly {
    readonly kind: string;
    readonly reference: string;
    readonly sha256: string;
    readonly gameId: string;
    readonly playerId: string;
    readonly position: string;
    readonly field: string;
  }[];
}

export interface CanonicalValidationRelease {
  readonly release: PositionRelease;
  readonly projectedAt: string;
  /** First observation of the committed projection by the separate custodian login. */
  readonly availableAt: string;
  readonly proofs: readonly CanonicalMetricProof[];
}

type SampleFields = ValidationSample["fields"];
type StudyHeader = ValidationStudy extends infer S ? S extends ValidationStudy ? Omit<S, "samples"> : never : never;

export interface CanonicalValidationEntry {
  readonly id: string;
  readonly snapshotId: string;
  readonly populationId: string;
  readonly playerId: string;
  readonly stintId: string;
  readonly clusterId: string;
  readonly predictedAt: string;
  readonly expectedGames: readonly { readonly gameId: string; readonly teamId: string }[];
  readonly transfer?: NonNullable<ValidationSample["transfer"]>;
  readonly target: ValidationSample["target"] & { readonly artifactSha256: string };
  readonly policyFields?: SampleFields;
  readonly features: Readonly<Record<string,
    | { readonly kind: "CANONICAL_METRIC"; readonly field: string; readonly scale: number; readonly offset: number }
    | (TimedEvidence & { readonly kind: "FROZEN_OUTPUT"; readonly value: number; readonly metricFields: readonly string[];
        readonly modelArtifactSha256: string })
  >>;
}

export interface CanonicalValidationRecipe {
  readonly header: StudyHeader;
  readonly engineArtifactSha256: string;
  readonly modelArtifactSha256: string;
  readonly entries: readonly CanonicalValidationEntry[];
}

const key = (parts: readonly string[]) => canonicalSha256(parts);
const sorted = (items: Iterable<string>) => [...items].sort(compareId);

function partitionOf(header: StudyHeader, at: string): Partition {
  const matches = partitions.filter((name) => timestamp(at) >= timestamp(header.plan.windows[name].start)
    && timestamp(at) < timestamp(header.plan.windows[name].end));
  requireValid(matches.length === 1, "Canonical entry outside its partition");
  return matches[0]!;
}

function snapshotTrace(input: CanonicalValidationRelease, entry: CanonicalValidationEntry, header: StudyHeader) {
  const { release, projectedAt, availableAt } = input;
  const { snapshot } = release;
  const population = header.populations.find(({ id }) => id === entry.populationId);
  requireValid(population && snapshot.origin === "SYNTHETIC" && snapshot.label === "SIMULATION"
    && release.registryVersion === header.plan.registryVersion && release.projectionVersion === positionProjectionVersion
    && snapshot.snapshotId === entry.snapshotId
    && snapshot.seasonId === population.seasonId && snapshot.competitionId === population.leagueId
    && timestamp(snapshot.asOf) <= timestamp(projectedAt) && timestamp(projectedAt) <= timestamp(availableAt)
    && timestamp(availableAt) <= timestamp(entry.predictedAt)
    && population.position === header.plan.position && population.memberPlayerIds.includes(entry.playerId)
    && timestamp(population.membershipLockedAt) <= timestamp(entry.predictedAt)
    && timestamp(population.startsAt) <= timestamp(entry.predictedAt) && timestamp(entry.predictedAt) < timestamp(population.endsAt)
    && [entry.playerId, entry.stintId, entry.clusterId].every((id) => id.trim()), "Canonical scope, version or availability mismatch");
  const expected = [...entry.expectedGames].sort((a, b) => compareId(a.gameId, b.gameId));
  ids(expected.map(({ gameId }) => gameId), "Duplicate or missing expected game");
  const byGame = new Map(expected.map(({ gameId, teamId }) => [gameId, teamId]));
  requireValid(expected.every(({ teamId }) => teamId.trim()) && new Set(expected.map(({ teamId }) => teamId)).size === 1,
    "One canonical team is required per stint");
  const team = expected[0]!.teamId;
  const games = release.snapshot.games.filter(({ game }) => game.playerId === entry.playerId
    && game.position === header.plan.position && (byGame.has(game.gameId) || game.teamId === team))
    .sort((a, b) => compareId(a.game.gameId, b.game.gameId));
  const stages = new Set(games.map(({ stageId }) => stageId));
  requireValid(stages.size === games.length && new Set(games.map(({ game }) => game.gameId)).size === games.length
    && games.every(({ game }) => byGame.get(game.gameId) === game.teamId && game.seasonId === snapshot.seasonId
      && timestamp(game.playedAt) <= timestamp(snapshot.asOf)), "Canonical game identity mismatch");
  const compareFact = (a: { stageId: string; field: string }, b: { stageId: string; field: string }) =>
    compareId(a.stageId, b.stageId) || compareId(a.field, b.field);
  const facts = release.facts.filter(({ stageId }) => stages.has(stageId)).sort(compareFact);
  const proofs = input.proofs.filter(({ stageId }) => stages.has(stageId)).sort(compareFact);
  const proofIndex = new Map(proofs.map((proof) => [key([proof.stageId, proof.field]), proof]));
  const registry = positionMetricRegistry().metrics.filter(({ position, storage }) =>
    position === header.plan.position && storage === "GAME");
  const gameByStage = new Map(games.map(({ stageId, game }) => [stageId, game]));
  const observationsByStage = new Map(games.map(({ stageId, game }) => [stageId, gameObservations(game)]));
  const fieldsByName = new Map(registry.map((metric) => [metric.field, metric]));
  requireValid(facts.length === games.length * registry.length
    && new Set(facts.map(({ stageId, field }) => key([stageId, field]))).size === facts.length
    && proofIndex.size === proofs.length && proofs.length === facts.filter(({ observationId }) => observationId !== null).length,
  "Incomplete or duplicate canonical facts or proofs");
  for (const fact of facts) {
    const game = gameByStage.get(fact.stageId)!;
    const proof = proofIndex.get(key([fact.stageId, fact.field]));
    const metric = fieldsByName.get(fact.field);
    const capability = metric?.sourceCapability;
    const kinds = capability === "PLAY_BY_PLAY_AND_MODEL" ? ["MODEL_REFERENCE", "PLAY_BY_PLAY"]
      : [capability === "BOX_SCORE_CANDIDATE" ? "BOX_SCORE" : capability];
    requireValid(metric?.unit === fact.unit
      && canonicalJson(fact.observation) === canonicalJson(observationsByStage.get(fact.stageId)?.[fact.field] ?? { status: "MISSING" })
      && (fact.observationId === null ? !proof && ["MISSING", "NOT_APPLICABLE"].includes(fact.observation.status)
        : proof && isSha256(proof.sourceProtocolSha256) && timestamp(proof.attestedAt) <= timestamp(snapshot.asOf)
          && proof.sourceUuid.trim() && proof.featureVersion.trim() && proof.attestedBy.trim()
          && canonicalJson(sorted(proof.artifacts.map(({ kind }) => kind))) === canonicalJson(kinds)
          && proof.artifacts.every((a) => isSha256(a.sha256) && a.reference.trim()
            && a.gameId === game.gameId && a.playerId === game.playerId && a.position === game.position && a.field === fact.field)
          && "source" in fact.observation && isVerifiedSource(fact.observation.source, "SYNTHETIC")),
    "Canonical field unit or attested proof mismatch");
  }
  const { games: _games, ...snapshotMetadata } = snapshot;
  return { snapshot: snapshotMetadata, projectedAt, availableAt, projectionVersion: release.projectionVersion,
    registryVersion: release.registryVersion, games, facts, proofs, expected, population };
}

function buildEntry(input: CanonicalValidationRelease, recipe: CanonicalValidationRecipe, entry: CanonicalValidationEntry) {
  const { header } = recipe;
  const trace = snapshotTrace(input, entry, header);
  const { snapshot, games, availableAt, population, facts, proofs, expected } = trace;
  const played = games.filter(({ game }) => game.usage.status === "PLAYED" && isVerifiedSource(game.usage.source, "SYNTHETIC"));
  const playedStages = new Set(played.map(({ stageId }) => stageId));
  const participation = played.flatMap(({ game }) => game.usage.status === "PLAYED" ? [{
    availableAt, playedAt: game.playedAt, gameId: game.gameId, status: "VERIFIED_AT_POSITION" as const,
    source: game.usage.source, evidenceIds: ["usage:" + key([game.gameId, game.playerId, game.position])],
  }] : []);
  const requirements = coverageRequirements({ ...header, samples: [] });
  const fields: Record<string, SampleFields[string]> = {};
  for (const [field, item] of Object.entries(entry.policyFields ?? {})) {
    requireValid(requirements.metrics.some((m) => m.storage === "RATING_POLICY" && m.field === field)
      && timestamp(item.availableAt) <= timestamp(entry.predictedAt), "Invalid or late model policy field");
    ids(item.evidenceIds, "Missing policy lineage");
    fields[field] = item;
  }
  for (const [field, rows] of Map.groupBy(facts.filter(({ stageId }) => playedStages.has(stageId)), ({ field }) => field)) {
    const numeric = rows.flatMap(({ observation }) => "value" in observation ? [observation.value] : []);
    let observation: Observation;
    if (rows.some((row) => row.observation.status === "MISSING")) observation = { status: "MISSING" };
    else if (numeric.length !== rows.length) observation = { status: "NOT_APPLICABLE" };
    else {
      const value = numeric.reduce((sum, next) => sum + next, 0);
      observation = { status: value === 0 ? "VERIFIED_ZERO" : "OBSERVED", value,
        source: { origin: "SYNTHETIC", verification: "VERIFIED", officiality: "SYNTHETIC",
          sourceId: canonicalValidationBridgeVersion, revisionId: snapshot.snapshotId, conventionVersion: trace.registryVersion } };
    }
    fields[field] = { observation, availableAt, evidenceIds: rows.map((row) =>
      "field:" + key([games.find(({ stageId }) => stageId === row.stageId)!.game.gameId, entry.playerId, population.position, field])) };
  }
  requireValid(isSha256(entry.target.artifactSha256), "Missing independent target artifact");
  const { artifactSha256: targetArtifact, ...target } = entry.target;
  const sample: ValidationSample = {
    id: entry.id, origin: "SYNTHETIC", populationId: population.id, playerId: entry.playerId, stintId: entry.stintId,
    clusterId: entry.clusterId, position: population.position, leagueId: population.leagueId, seasonId: population.seasonId,
    predictedAt: entry.predictedAt, ...(entry.transfer && { transfer: entry.transfer }), participation, fields, features: {},
    target: { ...target, evidenceIds: [...target.evidenceIds, "artifact:" + targetArtifact] },
  };
  const issues = coverageIssues(sample, { ...header, samples: [] }, requirements);
  if (games.length !== expected.length || games.some(({ game }) => game.usage.status === "UNKNOWN")) issues.push("INCOMPLETE_EXPECTED_GAMES");
  const features: Record<string, ValidationSample["features"][string]> = {};
  for (const [name, feature] of Object.entries(entry.features).sort(([a], [b]) => compareId(a, b))) {
    if (feature.kind === "FROZEN_OUTPUT") {
      requireValid(feature.modelArtifactSha256 === recipe.modelArtifactSha256
        && timestamp(feature.availableAt) <= timestamp(entry.predictedAt), "Model output artifact or availability mismatch");
      features[name] = { value: feature.value, evidenceIds: feature.evidenceIds,
        availableAt: feature.availableAt, metricFields: feature.metricFields };
      continue;
    }
    requireValid(requirements.metrics.some(({ field }) => field === feature.field)
      && Number.isFinite(feature.scale) && Number.isFinite(feature.offset), "Invalid canonical feature rule");
    const item = fields[feature.field];
    if (!item || !("value" in item.observation)) issues.push(feature.field + ":UNUSABLE_FEATURE_INPUT");
    else features[name] = { value: Math.max(0, Math.min(100, feature.offset + feature.scale * item.observation.value)),
      evidenceIds: item.evidenceIds, availableAt: item.availableAt, metricFields: [feature.field] };
  }
  const evidence = new Set([
    "snapshot:" + snapshot.snapshotId, "cluster:" + entry.clusterId, ...expected.map(({ gameId }) => "game:" + gameId),
    ...(header.plan.playerDisjoint ? ["player:" + entry.playerId] : []),
    ...proofs.flatMap(({ artifacts }) => artifacts.map(({ sha256 }) => "evidence:artifact:" + sha256)),
    ...[...Object.values(fields), ...Object.values(features), ...participation, sample.target,
      ...(sample.transfer ? [sample.transfer] : [])].flatMap(({ evidenceIds }) => evidenceIds.map((id) => "evidence:" + id)),
  ]);
  return { sample: { ...sample, features }, trace, issues, evidence, targetArtifact };
}

export async function compileCanonicalValidation(
  reader: (snapshotId: string) => Promise<CanonicalValidationRelease | null>, recipe: CanonicalValidationRecipe,
) {
  recipe = structuredClone(recipe);
  const { header, engineArtifactSha256, modelArtifactSha256 } = recipe;
  requireValid(header.plan.origin === "SYNTHETIC" && isSha256(modelArtifactSha256) && isSha256(engineArtifactSha256),
    "Expected locked synthetic model and engine artifacts");
  const entries = ordered(recipe.entries);
  ids(entries.map(({ id }) => id), "Duplicate or missing canonical entry ID");
  const releases = new Map<string, CanonicalValidationRelease>();
  for (const id of sorted(new Set(entries.map(({ snapshotId }) => snapshotId)))) {
    const input = await reader(id);
    requireValid(input, "Missing approved canonical projection");
    releases.set(id, structuredClone(input));
  }
  const datasets = partitions.map((partition) => ({ partition,
    entries: entries.filter((entry) => partitionOf(header, entry.predictedAt) === partition)
      .map((entry) => buildEntry(releases.get(entry.snapshotId)!, recipe, entry)),
  }));
  const trainContext = new Set<string>();
  for (const bridge of header.plan.leagueContext?.bridges ?? []) {
    requireValid(timestamp(bridge.availableAt) < timestamp(header.plan.windows.train.end), "League bridge was unavailable for training");
    ids(bridge.evidenceIds, "League bridge lacks source evidence");
    for (const id of bridge.evidenceIds) {
      const evidence = "evidence:" + id;
      requireValid(!trainContext.has(evidence), "Duplicate league bridge evidence");
      trainContext.add(evidence);
    }
  }
  const evidencePartition = new Map<string, Partition>();
  const rawArtifacts = new Set(datasets.flatMap(({ entries }) => entries.flatMap(({ trace }) =>
    trace.proofs.flatMap(({ artifacts }) => artifacts.map(({ sha256 }) => sha256)))));
  const targetArtifacts = datasets.flatMap(({ entries }) => entries.map(({ targetArtifact }) => targetArtifact));
  ids(targetArtifacts, "Target artifact reused");
  requireValid(targetArtifacts.every((digest) => !rawArtifacts.has(digest) && digest !== modelArtifactSha256
    && digest !== engineArtifactSha256), "Target artifact overlaps canonical or model input");
  for (const { partition, entries } of datasets) for (const entry of entries) for (const evidence of entry.evidence) {
    const prior = evidencePartition.get(evidence);
    requireValid(!trainContext.has(evidence) && (!prior || prior === partition), "Canonical holdout partition overlap");
    evidencePartition.set(evidence, partition);
  }
  const study: ValidationStudy = { ...header, samples: datasets.flatMap(({ entries }) => entries.flatMap(({ sample, issues }) =>
    issues.length ? [] : [sample])) };
  const excluded = new Map(prepareStudy(study).excluded.map(({ id, issues }) => [id, issues]));
  const batches = datasets.map(({ partition, entries }) => ({
    partition, evidenceKeys: sorted(new Set([...entries.flatMap(({ evidence }) => [...evidence]),
      ...(partition === "train" ? trainContext : [])])),
    payload: entries.map(({ evidence: _evidence, ...entry }) => ({
      ...entry, issues: excluded.get(entry.sample.id) ?? entry.issues,
    })),
  }));
  const frozenRecipe = { ...recipe, entries };
  const manifest = { version: canonicalValidationBridgeVersion, engineArtifactSha256, modelArtifactSha256,
    recipeSha256: canonicalSha256(frozenRecipe), recipe: frozenRecipe, study, batches };
  return { ...manifest, datasetSha256: canonicalSha256(manifest) };
}

export type CanonicalValidationDataset = Awaited<ReturnType<typeof compileCanonicalValidation>>;
