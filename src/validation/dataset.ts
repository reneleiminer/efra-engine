import { isCount, isVerifiedSource, readObservation } from "../contracts/observations.ts";
import { timestamp } from "../contracts/time.ts";
import { describePositionModel, limitedFieldPaths } from "../models/positions/catalog.ts";
import { describePositionDataRequirements } from "../models/positions/data-requirements.ts";
import { positionMetricRegistry, positionMetricRegistryVersion } from "../models/positions/metric-registry.ts";
import { compareId } from "../season/scope.ts";
import type { Partition, ReferencePopulation, TimedEvidence, ValidationSample, ValidationStudy } from "./contracts.ts";

export const partitions = ["train", "validation", "test"] as const;

export function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function ids(values: readonly string[], message: string) {
  requireValid(values.length > 0 && values.every((value) => typeof value === "string" && !!value.trim())
    && new Set(values).size === values.length, message);
}

export function ordered<T extends { readonly id: string }>(values: readonly T[]): T[] {
  return [...values].sort((a, b) => compareId(a.id, b.id));
}

export function coverageRequirements(study: ValidationStudy) {
  const { plan } = study;
  const definition = describePositionDataRequirements(plan.position);
  const path = definition.paths.find(({ id }) => id === plan.pathId);
  requireValid(path, "Unknown position path");
  const registry = positionMetricRegistry();
  const metrics = registry.metrics.filter(({ position }) => position === plan.position);
  const required = metrics.filter(({ field, tiers }) => path.requiredFields?.includes(field)
    || tiers.some((tier) => path.requiredTiers?.includes(tier)));
  const zeros = new Set<string>();
  if (path.id === "QB_RUSH_ONLY_SPECIAL") {
    for (const field of path.requiredFields ?? []) zeros.add(field);
  }
  if (path.verifiedAbsentComponent && plan.position !== "QB") {
    const term = describePositionModel(plan.position).tiers.CORE.find(({ id }) => id === path.verifiedAbsentComponent);
    requireValid(term && Object.hasOwn(limitedFieldPaths, path.id), "Unknown absent component");
    zeros.add(term.denominator);
    zeros.add(term.numerator);
    if ("expected" in term) zeros.add(term.expected);
  }
  // A study can impose a positive aggregate minimum even when the game model accepts verified zero.
  const exposure = required.filter(({ field, roles }) => roles.includes("EXPOSURE") && !zeros.has(field));
  requireValid(isCount(plan.coverage.minimumGames) && plan.coverage.minimumGames > 0, "Invalid minimum games");
  requireValid(Object.keys(plan.coverage.minimumExposure).length === exposure.length
    && exposure.every(({ field }) => isCount(plan.coverage.minimumExposure[field] ?? -1)
      && (plan.coverage.minimumExposure[field] ?? 0) > 0), "Missing or invalid position exposure threshold");
  return { metrics, required, zeros, exposure, limited: !!path.verifiedAbsentComponent,
    rules: registry.rules.filter(({ position }) => position === plan.position) };
}

export function coverageIssues(
  sample: ValidationSample, study: ValidationStudy, requirements: ReturnType<typeof coverageRequirements>, removed?: string,
) {
  const issues: string[] = [];
  const verifiedGames = sample.participation.filter(({ status, source }) =>
    status === "VERIFIED_AT_POSITION" && isVerifiedSource(source, "SYNTHETIC"));
  if (verifiedGames.length < study.plan.coverage.minimumGames) issues.push("PARTICIPATION");
  const values = new Map<string, number>();
  for (const metric of requirements.metrics) {
    const { field, domain } = metric;
    const observation = field === removed ? undefined : Object.hasOwn(sample.fields, field) ? sample.fields[field]?.observation : undefined;
    const value = observation && readObservation(observation, "SYNTHETIC", (n) => {
      if (domain === "COUNT") return isCount(n);
      if (domain === "SIGNED_INTEGER") return Number.isSafeInteger(n);
      return domain === "SIGNED_DECIMAL" || n >= 0;
    });
    if (value?.status === "AVAILABLE") values.set(field, value.value);
    if (!requirements.required.includes(metric)) continue;
    if (!value || value.status !== "AVAILABLE") {
      const status = observation?.status;
      issues.push(field + ":" + (status === "OBSERVED" || status === "VERIFIED_ZERO" ? value?.status : status ?? "MISSING"));
    } else if (requirements.zeros.has(field) && value.value !== 0) {
      issues.push(field + ":REQUIRES_ZERO");
    } else if (requirements.exposure.some((entry) => entry.field === field)
      && value.value < (study.plan.coverage.minimumExposure[field] ?? 0)) {
      issues.push(field + ":LOW_EXPOSURE");
    }
  }
  for (const rule of requirements.rules) {
    const upper = values.get(rule.upper);
    const terms = rule.fields.map((field) => values.get(field));
    if (upper === undefined || !terms.every((value) => value !== undefined)) continue;
    const inconsistent = rule.kind === "SUM_AT_MOST" ? terms.reduce((sum, value) => sum + value, 0) > upper
      : upper === 0 && terms.some((value) => value !== 0);
    if (inconsistent) issues.push(rule.upper + ":INCONSISTENT_" + rule.fields.join(","));
  }
  return issues;
}

export function prepareStudy(study: ValidationStudy) {
  const { plan, product } = study;
  const { outcome } = plan;
  requireValid(plan.origin === "SYNTHETIC" && plan.registryVersion === positionMetricRegistryVersion
    && ["SPR", "OVR", "CONFIDENCE"].includes(product)
    && [plan.version, plan.dataVersion, plan.modelVersion, plan.pathId].every((value) => value.trim())
    && isCount(plan.minimumGroupSize) && plan.minimumGroupSize > 0
    && partitions.every((key) => isCount(plan.minimumPartitionClusters[key]) && plan.minimumPartitionClusters[key] > 0)
    && typeof plan.playerDisjoint === "boolean" && outcome.definitionVersion.trim()
    && (product === "SPR" ? outcome.kind === "SEASON_REFERENCE" : outcome.kind === "FUTURE_EVENT"
      && isCount(outcome.minimumHorizonDays) && outcome.minimumHorizonDays > 0
      && isCount(outcome.maximumHorizonDays) && outcome.maximumHorizonDays >= outcome.minimumHorizonDays),
  "Invalid or non-synthetic validation plan or outcome");
  const windows = partitions.map((name) => ({
    name, start: timestamp(plan.windows[name].start), end: timestamp(plan.windows[name].end),
  }));
  const frozen = timestamp(plan.frozenAt);
  requireValid(windows.every(({ start, end }, i) => start < end && (i === 0 || start >= windows[i - 1]!.end))
    && frozen >= windows[2]!.end, "Invalid, overlapping, or unfrozen temporal windows");
  const populations = ordered(study.populations);
  ids(populations.map(({ id }) => id), "Duplicate or missing reference population");
  const scopes = new Set<string>();
  const populationById = new Map<string, ReferencePopulation>();
  for (const population of populations) {
    requireValid(population.origin === "SYNTHETIC" && population.position === plan.position
      && [population.leagueId, population.seasonId, population.competitionLevel, population.version].every((value) => value.trim())
      && timestamp(population.startsAt) < timestamp(population.endsAt)
      && timestamp(population.membershipLockedAt) < timestamp(population.endsAt), "Invalid reference population");
    ids(population.memberPlayerIds, "Duplicate or missing reference population members");
    const scope = JSON.stringify([population.leagueId, population.seasonId]);
    requireValid(!scopes.has(scope), "Multiple populations for one league and season");
    scopes.add(scope);
    populationById.set(population.id, population);
  }
  const requirements = coverageRequirements(study);
  requireValid(!requirements.limited || (!plan.leagueContext
    && new Set(populations.map(({ leagueId }) => leagueId)).size === 1), "Limited position paths are within-league only");
  const samples = ordered(study.samples);
  ids(samples.map(({ id }) => id), "Duplicate or missing sample ID");
  const scopesSeen = new Set<string>();
  const clusterSplits = new Map<string, Partition>();
  const playerSplits = new Map<string, Partition>();
  const inputSplits = new Map<string, Partition>();
  const gameSplits = new Map<string, Partition>();
  const targetIds = new Set<string>();
  const split = { train: [], validation: [], test: [] } as Record<Partition, ValidationSample[]>;
  const excluded: { id: string; partition: Partition; issues: string[] }[] = [];

  for (const sample of samples) {
    const at = timestamp(sample.predictedAt);
    const window = windows.find(({ start, end }) => at >= start && at < end);
    const population = populationById.get(sample.populationId);
    requireValid(sample.origin === "SYNTHETIC" && window && population && sample.position === population.position
      && sample.seasonId === population.seasonId && sample.leagueId === population.leagueId
      && population.memberPlayerIds.includes(sample.playerId)
      && at >= timestamp(population.startsAt) && at < timestamp(population.endsAt)
      && timestamp(population.membershipLockedAt) <= at
      && sample.clusterId.trim() && sample.stintId.trim(),
    "Sample outside its reference population or partition");
    const scope = JSON.stringify([sample.playerId, sample.position, sample.leagueId, sample.seasonId, sample.predictedAt]);
    requireValid(!scopesSeen.has(scope), "Duplicate sample scope");
    scopesSeen.add(scope);
    for (const [index, key, indexEnabled] of [
      [clusterSplits, sample.clusterId, true], [playerSplits, sample.playerId, plan.playerDisjoint],
    ] as const) {
      if (!indexEnabled) continue;
      const prior = index.get(key);
      requireValid(!prior || prior === window.name, "Dependent cluster or player spans partitions");
      index.set(key, window.name);
    }

    const addInput = (item: TimedEvidence) => {
      requireValid(timestamp(item.availableAt) <= at, "Future or invalid input evidence");
      ids(item.evidenceIds, "Duplicate or missing input lineage");
      for (const id of item.evidenceIds) {
        const prior = inputSplits.get(id);
        requireValid(!prior || prior === window.name, "Input evidence reused across partitions");
        inputSplits.set(id, window.name);
      }
    };
    if (sample.transfer) {
      requireValid(sample.transfer.priorLeagueId.trim() && sample.transfer.priorLeagueId !== sample.leagueId
        && timestamp(sample.transfer.effectiveAt) <= timestamp(sample.transfer.availableAt), "Invalid transfer evidence");
      addInput(sample.transfer);
    }
    const gameIds = sample.participation.map(({ gameId }) => gameId);
    if (gameIds.length) ids(gameIds, "Duplicate or missing participation game");
    const participationIds = sample.participation.flatMap(({ evidenceIds }) => evidenceIds);
    if (participationIds.length) ids(participationIds, "Duplicate participation evidence");
    for (const game of sample.participation) {
      requireValid(timestamp(game.playedAt) >= timestamp(population.startsAt)
        && timestamp(game.playedAt) <= timestamp(game.availableAt) && game.source.origin === "SYNTHETIC"
        && game.source.officiality === "SYNTHETIC", "Invalid participation evidence");
      const prior = gameSplits.get(game.gameId);
      requireValid(!prior || prior === window.name, "Game spans partitions");
      gameSplits.set(game.gameId, window.name);
      addInput(game);
    }
    for (const [field, item] of Object.entries(sample.fields)) {
      requireValid(requirements.metrics.some((metric) => metric.field === field), "Unknown position metric");
      const observation = item.observation;
      const sources = "source" in observation ? [observation.source] : "sources" in observation ? observation.sources : [];
      requireValid(sources.every(({ origin, officiality }) => origin === "SYNTHETIC" && officiality === "SYNTHETIC"),
        "Non-synthetic observation source");
      addInput(item);
    }
    const featureIds = Object.values(sample.features).flatMap(({ evidenceIds }) => evidenceIds);
    if (featureIds.length) ids(featureIds, "Feature evidence overlaps (double counting)");
    for (const feature of Object.values(sample.features)) {
      requireValid(Number.isFinite(feature.value) && feature.value >= 0 && feature.value <= 100, "Invalid feature value");
      if (feature.metricFields.length) ids(feature.metricFields, "Invalid feature metric dependencies");
      for (const field of feature.metricFields) {
        const item = Object.hasOwn(sample.fields, field) ? sample.fields[field] : undefined;
        requireValid(item && timestamp(item.availableAt) <= timestamp(feature.availableAt)
          && item.evidenceIds.every((id) => feature.evidenceIds.includes(id)), "Untraceable feature metric dependency");
      }
      addInput(feature);
    }
    const { target } = sample;
    const event = timestamp(target.eventAt);
    const available = timestamp(target.availableAt);
    const next = windows[windows.indexOf(window) + 1];
    const horizonDays = (event - at) / 86_400_000;
    requireValid(event <= available && available <= frozen && (!next || available < next.start)
      && (outcome.kind === "SEASON_REFERENCE" ? event >= timestamp(population.startsAt) && event <= at
        : horizonDays >= outcome.minimumHorizonDays && horizonDays <= outcome.maximumHorizonDays)
      && (product === "CONFIDENCE" ? target.value === 0 || target.value === 1
        : Number.isFinite(target.value) && target.value >= 0 && target.value <= 100), "Invalid, premature, or leaked target");
    ids(target.evidenceIds, "Duplicate or missing target evidence");
    for (const id of target.evidenceIds) {
      requireValid(!targetIds.has(id), "Target evidence counted more than once");
      targetIds.add(id);
    }

    const issues = coverageIssues(sample, study, requirements);
    for (const field of new Set(Object.values(sample.features).flatMap(({ metricFields }) => metricFields).sort(compareId))) {
      const item = sample.fields[field]!;
      if (readObservation(item.observation, "SYNTHETIC", Number.isFinite).status !== "AVAILABLE") {
        issues.push(field + ":UNUSABLE_FEATURE_INPUT");
      }
    }
    if (issues.length) excluded.push({ id: sample.id, partition: window.name, issues });
    else split[window.name].push(sample);
  }
  requireValid([...targetIds].every((id) => !inputSplits.has(id)), "Target evidence reused as an input");
  requireValid(partitions.every((partition) =>
    new Set(split[partition].map(({ clusterId }) => clusterId)).size >= plan.minimumPartitionClusters[partition]),
  "Insufficient eligible clusters in a partition");
  return { populations, populationById, samples, split, excluded, requirements, inputSplits, targetIds };
}
