import { estimateSyntheticLeagueStrength } from "../context/league-strength.ts";
import { readObservation } from "../contracts/observations.ts";
import { timestamp } from "../contracts/time.ts";
import { canonicalSha256 } from "../ingest/determinism.ts";
import { compareId } from "../season/scope.ts";
import { confidenceErrors, confidenceStudy, errors, mean, scoreStudy } from "./calibration.ts";
import type { Prediction } from "./calibration.ts";
import type { ValidationSample, ValidationStudy } from "./contracts.ts";
import { coverageIssues, ids, ordered, partitions, prepareStudy, requireValid } from "./dataset.ts";

export const validationProtocolVersion = "efra-synthetic-validation-v1";

type Dataset = ReturnType<typeof prepareStudy>;
const sorted = (values: readonly string[]) => [...values].sort(compareId);

function leagueDiagnostics(study: ValidationStudy, dataset: Dataset) {
  const context = study.plan.leagueContext;
  if (!context) return [];
  const { referenceLeagueId, version } = context;
  const cutoff = timestamp(study.plan.windows.train.end) - 1;
  const bridges = ordered(context.bridges);
  requireValid(referenceLeagueId.trim() && version.trim()
    && dataset.populations.some(({ leagueId }) => leagueId === referenceLeagueId), "Invalid reference league");
  if (bridges.length) ids(bridges.map(({ id }) => id), "Duplicate or missing league bridge");
  const evidence = bridges.flatMap(({ evidenceIds }) => evidenceIds);
  if (evidence.length) ids(evidence, "League bridge evidence counted more than once");
  requireValid(evidence.every((id) => !dataset.inputSplits.has(id) && !dataset.targetIds.has(id)),
    "League bridge overlaps study evidence");
  const knownLeagues = new Set(dataset.populations.map(({ leagueId }) => leagueId));
  for (const bridge of bridges) {
    ids(bridge.evidenceIds, "Missing league bridge evidence");
    requireValid(bridge.position === study.plan.position && knownLeagues.has(bridge.leagueId)
      && knownLeagues.has(bridge.referenceLeagueId) && bridge.leagueId !== bridge.referenceLeagueId
      && ["TRANSFER", "INTERLEAGUE"].includes(bridge.kind)
      && timestamp(bridge.observedAt) <= timestamp(bridge.availableAt)
      && timestamp(bridge.availableAt) <= timestamp(study.plan.frozenAt)
      && readObservation(bridge.difficultyDifference, "SYNTHETIC", Number.isFinite).status === "AVAILABLE"
      && Number.isFinite(bridge.simulationVariance) && bridge.simulationVariance > 0, "Invalid league bridge");
  }
  return [...knownLeagues].sort(compareId).map((leagueId) => ({
    leagueId,
    competitionLevels: sorted([...new Set(dataset.populations.filter((p) => p.leagueId === leagueId).map((p) => p.competitionLevel))]),
    estimate: estimateSyntheticLeagueStrength({
      origin: "SYNTHETIC", position: study.plan.position, leagueId, referenceLeagueId, version,
      dataVersion: study.plan.dataVersion, asOf: new Date(cutoff).toISOString(),
    }, bridges),
  }));
}

function groupedTest(study: ValidationStudy, dataset: Dataset, rows: readonly Prediction[], baseline: number) {
  const groups = new Map<string, { count: number; rows: Prediction[] }>();
  const predictions = new Map(rows.map((row) => [row.sample.id, row]));
  for (const sample of dataset.samples) {
    if (sample.predictedAt < study.plan.windows.test.start || sample.predictedAt >= study.plan.windows.test.end) continue;
    const population = dataset.populationById.get(sample.populationId)!;
    for (const [dimension, value] of [
      ["league", sample.leagueId], ["competitionLevel", population.competitionLevel],
      ["transfer", sample.transfer ? "LEAGUE_CHANGE" : "NO_RECORDED_LEAGUE_CHANGE"],
    ] as const) {
      const key = JSON.stringify([dimension, value]);
      const group = groups.get(key) ?? { count: 0, rows: [] };
      group.count++;
      const prediction = predictions.get(sample.id);
      if (prediction) group.rows.push(prediction);
      groups.set(key, group);
    }
  }
  return [...groups].sort(([a], [b]) => compareId(a, b)).map(([key, { count, rows: group }]) => {
    const [dimension, value] = JSON.parse(key) as [string, string];
    const independentClusters = new Set(group.map(({ sample }) => sample.clusterId)).size;
    return {
      dimension, value, submitted: count, eligible: group.length, independentClusters, coverage: group.length / count,
      metrics: independentClusters < study.plan.minimumGroupSize ? null : study.product === "CONFIDENCE"
        ? confidenceErrors(group, baseline, study.binEdges, study.plan.minimumGroupSize) : errors(group, baseline),
    };
  });
}

function stability(rows: readonly Prediction[]) {
  const byPlayer = new Map<string, Prediction[]>();
  for (const row of rows) {
    const prior = byPlayer.get(row.sample.playerId) ?? [];
    prior.push(row);
    byPlayer.set(row.sample.playerId, prior);
  }
  const deltas: { absolute: number; excess: number; leagueChanged: boolean; stintChanged: boolean }[] = [];
  let simultaneousDates = 0;
  for (const playerRows of byPlayer.values()) {
    const byDate = new Map<string, Prediction[]>();
    for (const row of playerRows) {
      const sameDate = byDate.get(row.sample.predictedAt) ?? [];
      sameDate.push(row);
      byDate.set(row.sample.predictedAt, sameDate);
    }
    const dates = [...byDate].sort(([a], [b]) => compareId(a, b));
    simultaneousDates += dates.filter(([, sameDate]) => sameDate.length > 1).length;
    for (let i = 1; i < dates.length; i++) {
      const previous = dates[i - 1]![1];
      const current = dates[i]![1];
      if (previous.length !== 1 || current.length !== 1) continue;
      const a = previous[0]!;
      const b = current[0]!;
      const absolute = Math.abs(b.prediction - a.prediction);
      const actual = Math.abs(b.sample.target.value - a.sample.target.value);
      deltas.push({ absolute, excess: absolute - actual, leagueChanged: a.sample.leagueId !== b.sample.leagueId,
        stintChanged: a.sample.stintId !== b.sample.stintId });
    }
  }
  const summarize = (group: typeof deltas) => ({
    pairs: group.length, meanAbsoluteDrift: group.length ? mean(group.map(({ absolute }) => absolute)) : null,
    meanDriftMinusTargetDrift: group.length ? mean(group.map(({ excess }) => excess)) : null,
  });
  return { simultaneousDates, all: summarize(deltas),
    sameStint: summarize(deltas.filter(({ leagueChanged, stintChanged }) => !leagueChanged && !stintChanged)),
    changedStint: summarize(deltas.filter(({ leagueChanged, stintChanged }) => leagueChanged || stintChanged)),
    changedLeague: summarize(deltas.filter(({ leagueChanged }) => leagueChanged)) };
}

function normalizedSample(sample: ValidationSample) {
  const normalized = <T extends { readonly evidenceIds: readonly string[] }>(item: T) => ({
    ...item, evidenceIds: sorted(item.evidenceIds),
  });
  const fields = Object.fromEntries(Object.entries(sample.fields).map(([key, item]) => {
    const { observation } = item;
    const orderedObservation = "sources" in observation ? {
      ...observation, sources: [...observation.sources].sort((a, b) => compareId(canonicalSha256(a), canonicalSha256(b))),
    } : observation;
    return [key, { ...normalized(item), observation: orderedObservation }];
  }));
  return {
    ...sample, fields, target: normalized(sample.target), ...(sample.transfer && { transfer: normalized(sample.transfer) }),
    participation: [...sample.participation].sort((a, b) => compareId(a.gameId, b.gameId)).map(normalized),
    features: Object.fromEntries(Object.entries(sample.features).map(([key, item]) => [
      key, { ...normalized(item), metricFields: sorted(item.metricFields) },
    ])),
  };
}

export function runSyntheticValidation(study: ValidationStudy) {
  const dataset = prepareStudy(study);
  const { plan, product } = study;
  const populations = dataset.populations.map((p) => {
    const ordered = { ...p, memberPlayerIds: sorted(p.memberPlayerIds) };
    return { id: p.id, version: p.version, position: p.position, leagueId: p.leagueId, seasonId: p.seasonId,
      competitionLevel: p.competitionLevel, memberCount: p.memberPlayerIds.length, sha256: canonicalSha256(ordered) };
  });
  const league = leagueDiagnostics(study, dataset);
  const studySettings = product === "CONFIDENCE" ? { binEdges: study.binEdges, probabilityFeature: study.probabilityFeature }
    : { candidates: ordered(study.candidates), sensitivity: ordered(study.sensitivity) };
  const protocolSha256 = canonicalSha256({
    protocol: validationProtocolVersion, product, ...studySettings, plan: { ...plan,
      ...(plan.leagueContext && { leagueContext: { referenceLeagueId: plan.leagueContext.referenceLeagueId,
        version: plan.leagueContext.version } }) },
  });
  const inputSha256 = canonicalSha256({
    protocolSha256,
    bridges: ordered(plan.leagueContext?.bridges ?? []).map((bridge) => ({ ...bridge, evidenceIds: sorted(bridge.evidenceIds) })),
    populations, samples: dataset.samples.map(normalizedSample),
  });
  const report = {
    product, label: "SIMULATION" as const, officialEligible: false as const, empiricalValidation: false as const,
    protocolVersion: validationProtocolVersion, protocolSha256, inputSha256,
    scope: { position: plan.position, pathId: plan.pathId, dataVersion: plan.dataVersion,
      modelVersion: plan.modelVersion, registryVersion: plan.registryVersion, planVersion: plan.version,
      windows: plan.windows, frozenAt: plan.frozenAt, playerDisjoint: plan.playerDisjoint, coverage: plan.coverage,
      outcome: plan.outcome, minimumPartitionClusters: plan.minimumPartitionClusters, minimumGroupSize: plan.minimumGroupSize },
    populations, excluded: dataset.excluded, league,
    partitionCounts: Object.fromEntries(partitions.map((partition) => {
      const eligible = dataset.split[partition];
      return [partition, { eligible: eligible.length,
        independentClusters: new Set(eligible.map(({ clusterId }) => clusterId)).size,
        excluded: dataset.excluded.filter((row) => row.partition === partition).length }];
    })),
  };
  if (product === "CONFIDENCE") {
    const { baseline, rows } = confidenceStudy(study, dataset.split);
    const metrics = (partition: keyof typeof rows) => confidenceErrors(rows[partition], baseline, study.binEdges, plan.minimumGroupSize);
    const result = { ...report, product, baseline, train: metrics("train"), validation: metrics("validation"), test: metrics("test"),
      subgroups: groupedTest(study, dataset, rows.test, baseline) };
    return { ...result, reportSha256: canonicalSha256(result) };
  }
  const fit = scoreStudy(study, dataset.split, new Set(dataset.requirements.metrics.map(({ field }) => field)));
  const train = errors(fit.rows.train, fit.baseline);
  const validation = errors(fit.rows.validation, fit.baseline);
  const test = errors(fit.rows.test, fit.baseline);
  const stress = fit.sensitivity.map(({ scenario, model, shift }) => {
    const retained = scenario.kind === "REMOVE_FIELD" ? dataset.split.test.filter((sample) =>
      coverageIssues(sample, study, dataset.requirements, scenario.field).length === 0
      && Object.entries(fit.selected.weights).every(([key, weight]) => weight === 0
        || !sample.features[key]!.metricFields.includes(scenario.field))) : dataset.split.test;
    const comparison = fit.rows.test.filter(({ sample }) => retained.includes(sample));
    const alternatives = fit.predictions(retained, model, shift);
    const alternateErrors = errors(alternatives, fit.baseline);
    const primaryErrors = errors(comparison, fit.baseline);
    return { scenario, retained: retained.length, total: fit.rows.test.length,
      meanAbsolutePredictionChange: alternatives.length ? mean(alternatives.map(({ prediction }, i) =>
        Math.abs(prediction - comparison[i]!.prediction))) : null,
      pairedMaeChange: alternateErrors.mae === null || primaryErrors.mae === null ? null : alternateErrors.mae - primaryErrors.mae };
  });
  const result = { ...report, product, selected: fit.selected, candidateValidation: fit.candidates, baseline: fit.baseline,
    train, validation, test, overfitDiagnostics: { validationMinusTrainMae: validation.mae! - train.mae!,
      testMinusValidationMae: test.mae! - validation.mae!, testMinusBaselineMae: test.mae! - test.baselineMae! },
    subgroups: groupedTest(study, dataset, fit.rows.test, fit.baseline), stability: stability(fit.rows.test), sensitivity: stress };
  return { ...result, reportSha256: canonicalSha256(result) };
}
