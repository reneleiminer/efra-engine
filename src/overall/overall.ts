import { summarizeConfidence } from "../confidence/evidence.ts";
import type { DataOrigin } from "../contracts/observations.ts";
import type { ModelVersion, RatingReason, RatingResult, RatingScope } from "../contracts/rating.ts";
import { timestamp } from "../contracts/time.ts";
import { calibrateSimulation } from "../simulation/calibration.ts";
import type { SimulationCalibration } from "../simulation/calibration.ts";

export interface OverallEvidence {
  readonly label: "SIMULATION";
  readonly origin: "SYNTHETIC";
  readonly playerId: string;
  readonly position: "QB";
  readonly evidenceId: string;
  readonly dataVersion: string;
  readonly model: ModelVersion;
  readonly observedAt: string;
  readonly availableAt: string;
  readonly latent: number;
  readonly measurementVariance: number;
}

export interface OverallSimulation {
  readonly version: ModelVersion;
  readonly evidenceModel: ModelVersion;
  readonly calibration: SimulationCalibration;
  readonly processVariancePerDay: number;
}

export function calculateOverall(
  scope: RatingScope,
  origin: DataOrigin,
  history: readonly OverallEvidence[],
  policy: OverallSimulation,
): RatingResult {
  const confidence = summarizeConfidence();
  const base = {
    kind: "OVERALL", scope, origin, model: policy.version, confidence, flags: [], rankingEligible: false,
  } as const;
  const blocked = (reason: RatingReason): RatingResult => ({
    ...base, history: [], simulationVariance: null, status: "NOT_RATED", reason, score: null,
  });
  if (origin !== "SYNTHETIC") return blocked("REAL_DATA_DISABLED");
  const cutoff = timestamp(scope.asOf);
  if (scope.position !== "QB" || !scope.playerId.trim() || !Number.isFinite(cutoff)) return blocked("INVALID_SCOPE");
  if (!validSimulationVersion(policy.version) || !validSimulationVersion(policy.evidenceModel)
    || policy.version.path !== policy.evidenceModel.path) {
    return blocked("NO_VALIDATED_MODEL_PATH");
  }
  const drift = policy.processVariancePerDay;
  if (!Number.isFinite(drift) || drift < 0) return blocked("INVALID_MODEL_OUTPUT");

  const eligible = [];
  const ids = new Set<string>();
  for (const evidence of history) {
    if (evidence.playerId !== scope.playerId || evidence.position !== scope.position
      || evidence.label !== "SIMULATION" || evidence.origin !== "SYNTHETIC"
      || !sameVersion(evidence.model, policy.evidenceModel)) continue;

    const observed = timestamp(evidence.observedAt);
    const available = timestamp(evidence.availableAt);
    if (![observed, available].every(Number.isFinite) || available < observed) return blocked("INVALID_SCOPE");
    if (available > cutoff) continue;
    if (!evidence.evidenceId.trim() || !evidence.dataVersion.trim() || ids.has(evidence.evidenceId)) return blocked("INVALID_SCOPE");
    ids.add(evidence.evidenceId);
    if (!Number.isFinite(evidence.latent) || !Number.isFinite(evidence.measurementVariance) || evidence.measurementVariance <= 0) {
      return blocked("INVALID_MODEL_OUTPUT");
    }
    eligible.push({ evidence, observed });
  }
  eligible.sort((left, right) => left.observed - right.observed
    || (left.evidence.evidenceId < right.evidence.evidenceId ? -1 : 1));
  const [first, ...remaining] = eligible;
  if (!first) return blocked("NO_COMPATIBLE_HISTORY");

  let mean = first.evidence.latent;
  let variance = first.evidence.measurementVariance;
  let lastObserved = first.observed;
  for (const { evidence, observed } of remaining) {
    const predictedVariance = variance + drift * ((observed - lastObserved) / 86_400_000);
    const innovationVariance = predictedVariance + evidence.measurementVariance;
    if (!Number.isFinite(innovationVariance)) return blocked("INVALID_MODEL_OUTPUT");
    const gain = predictedVariance / innovationVariance;
    mean = (1 - gain) * mean + gain * evidence.latent;
    variance = (evidence.measurementVariance / innovationVariance) * predictedVariance;
    lastObserved = observed;
  }

  const calibrated = calibrateSimulation(mean, policy.calibration);
  const simulationVariance = variance + drift * ((cutoff - lastObserved) / 86_400_000);
  if (!calibrated || !Number.isFinite(simulationVariance)) return blocked("INVALID_MODEL_OUTPUT");
  return {
    ...base, origin: "SYNTHETIC", status: "PROVISIONAL", label: "SIMULATION",
    history: eligible.map(({ evidence: { evidenceId, dataVersion } }) => ({ evidenceId, dataVersion })),
    simulationVariance, ...calibrated,
  };
}

function validSimulationVersion(version: ModelVersion): boolean {
  if (version.maturity !== "UNVALIDATED_SIMULATION"
    || [version.methodVersion, version.parameterVersion, version.contextVersion].some((id) => !id.trim())) return false;
  switch (version.path) {
    case "QB_STANDARD_CORE":
      return version.firstDownDefinitionVersion === undefined && version.situationDefinitionVersion === undefined;
    case "QB_EXTENDED_PRODUCTION":
      return !!version.firstDownDefinitionVersion?.trim() && version.situationDefinitionVersion === undefined;
    case "QB_ADVANCED":
      return !!version.firstDownDefinitionVersion?.trim() && !!version.situationDefinitionVersion?.trim();
    default:
      return false;
  }
}

function sameVersion(left: ModelVersion, right: ModelVersion): boolean {
  return left.maturity === right.maturity && left.path === right.path && left.methodVersion === right.methodVersion
    && left.parameterVersion === right.parameterVersion && left.contextVersion === right.contextVersion
    && left.firstDownDefinitionVersion === right.firstDownDefinitionVersion
    && left.situationDefinitionVersion === right.situationDefinitionVersion;
}
