import { compareId } from "../season/scope.ts";
import { ids, ordered, partitions, requireValid } from "./dataset.ts";
import type { Partition, ScoreCandidate, ValidationSample, ValidationStudy } from "./contracts.ts";

export const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

type ScoreStudy = Extract<ValidationStudy, { readonly product: "SPR" | "OVR" }>;
type ConfidenceStudy = Extract<ValidationStudy, { readonly product: "CONFIDENCE" }>;
type Split = Readonly<Record<Partition, readonly ValidationSample[]>>;

export interface Prediction {
  readonly sample: ValidationSample;
  readonly prediction: number;
}

export function errors(rows: readonly Prediction[], baseline: number) {
  if (!rows.length) return { count: 0, mae: null, rmse: null, signedError: null, baselineMae: null };
  const residuals = rows.map(({ sample, prediction }) => prediction - sample.target.value);
  return {
    count: rows.length,
    mae: mean(residuals.map(Math.abs)),
    rmse: Math.sqrt(mean(residuals.map((error) => error ** 2))),
    signedError: mean(residuals),
    baselineMae: mean(rows.map(({ sample }) => Math.abs(baseline - sample.target.value))),
  };
}

function weights(candidate: ScoreCandidate, featureNames: readonly string[]) {
  const entries = Object.entries(candidate.weights).sort(([a], [b]) => compareId(a, b));
  ids(entries.map(([name]) => name), "Invalid or missing candidate features");
  requireValid(entries.length === featureNames.length
    && entries.every(([name, weight], i) => name === featureNames[i] && Number.isFinite(weight) && weight >= 0)
    && Math.abs(entries.reduce((sum, [, weight]) => sum + weight, 0) - 1) <= 1e-12,
  "Candidate weights must use the same feature set and sum to one");
  return entries;
}

function fit(entries: ReturnType<typeof weights>, train: readonly ValidationSample[]) {
  const raw = (sample: ValidationSample) => entries.reduce((sum, [key, weight]) => sum + weight * sample.features[key]!.value, 0);
  const pairs = train.map((sample) => ({ x: raw(sample), y: sample.target.value }));
  const xMean = mean(pairs.map(({ x }) => x));
  const yMean = mean(pairs.map(({ y }) => y));
  const variance = pairs.reduce((sum, { x }) => sum + (x - xMean) ** 2, 0);
  const covariance = pairs.reduce((sum, { x, y }) => sum + (x - xMean) * (y - yMean), 0);
  const slope = variance === 0 ? 0 : Math.max(0, covariance / variance);
  const intercept = yMean - slope * xMean;
  requireValid(Number.isFinite(slope) && Number.isFinite(intercept), "Unstable calibration fit");
  return {
    slope, intercept,
    predict: (sample: ValidationSample, baselineShift = 0) =>
      Math.min(100, Math.max(0, yMean + slope * (raw(sample) - xMean) + baselineShift)),
  };
}

export function scoreStudy(study: ScoreStudy, split: Split, knownFields: ReadonlySet<string>) {
  const candidates = ordered(study.candidates);
  ids(candidates.map(({ id }) => id), "Duplicate or missing candidate ID");
  const scenarios = ordered(study.sensitivity);
  if (scenarios.length) ids(scenarios.map(({ id }) => id), "Duplicate or missing sensitivity scenario ID");
  const features = Object.keys(candidates[0]!.weights).sort(compareId);
  const inputs = partitions.flatMap((partition) => split[partition]);
  requireValid(inputs.every(({ features: values }) => features.every((key) => Object.hasOwn(values, key))),
    "Missing candidate feature on an eligible sample");
  const baseline = mean(split.train.map(({ target }) => target.value));
  const predictions = (samples: readonly ValidationSample[], model: ReturnType<typeof fit>, shift = 0) =>
    samples.map((sample) => ({ sample, prediction: model.predict(sample, shift) }));
  const evaluated = candidates.map((candidate) => {
    const model = fit(weights(candidate, features), split.train);
    const validation = errors(predictions(split.validation, model), baseline);
    return { candidate, model, validationMae: validation.mae! };
  });
  evaluated.sort((a, b) => a.validationMae - b.validationMae || compareId(a.candidate.id, b.candidate.id));
  const selected = evaluated[0]!;
  const rows = {
    train: predictions(split.train, selected.model),
    validation: predictions(split.validation, selected.model),
    test: predictions(split.test, selected.model),
  };
  const sensitivity = scenarios.map((scenario) => {
    let model = selected.model;
    let shift = 0;
    switch (scenario.kind) {
      case "WEIGHTS":
        model = fit(weights({ id: scenario.id, weights: scenario.weights }, features), split.train);
        break;
      case "BASELINE_SHIFT":
        requireValid(Number.isFinite(scenario.shift) && Math.abs(scenario.shift) <= 100, "Invalid baseline shift");
        shift = scenario.shift;
        break;
      case "REMOVE_FIELD":
        requireValid(knownFields.has(scenario.field), "Unregistered sensitivity field");
        break;
    }
    return { scenario, model, shift };
  });
  return {
    selected: { id: selected.candidate.id, weights: selected.candidate.weights,
      slope: selected.model.slope, intercept: selected.model.intercept },
    candidates: evaluated.map(({ candidate, validationMae }) => ({ id: candidate.id, validationMae })),
    baseline, rows, sensitivity, predictions,
  };
}

export function confidenceStudy(study: ConfidenceStudy, split: Split) {
  const { binEdges } = study;
  requireValid(study.probabilityFeature.trim() && binEdges.length >= 2 && binEdges[0] === 0
    && binEdges.at(-1) === 1 && binEdges.every((edge, i) => i === 0 || edge > binEdges[i - 1]!),
  "Invalid confidence bins");
  const baseline = mean(split.train.map(({ target }) => target.value));
  const rows = Object.fromEntries(partitions.map((partition) => [partition, split[partition].map((sample) => {
    const probability = Object.hasOwn(sample.features, study.probabilityFeature) && sample.features[study.probabilityFeature]?.value;
    requireValid(typeof probability === "number" && probability <= 1, "Missing or invalid confidence probability");
    return { sample, prediction: probability };
  })])) as Record<Partition, Prediction[]>;
  return { baseline, rows };
}

export function confidenceErrors(rows: readonly Prediction[], baseline: number, edges: readonly number[], minimum: number) {
  const bins = edges.slice(0, -1).map((lower, i) => {
    const upper = edges[i + 1]!;
    const members = rows.filter(({ prediction }) => prediction >= lower && (upper === 1 ? prediction <= upper : prediction < upper));
    const independentClusters = new Set(members.map(({ sample }) => sample.clusterId)).size;
    return { lower, upper, count: members.length, independentClusters, ...(independentClusters >= minimum
      ? { predicted: mean(members.map(({ prediction }) => prediction)), observed: mean(members.map(({ sample }) => sample.target.value)) }
      : {}) };
  });
  return {
    count: rows.length,
    brier: mean(rows.map(({ sample, prediction }) => (prediction - sample.target.value) ** 2)),
    baselineBrier: mean(rows.map(({ sample }) => (baseline - sample.target.value) ** 2)),
    bins,
  };
}
