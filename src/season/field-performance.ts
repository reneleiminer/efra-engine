import { summarizeConfidence } from "../confidence/evidence.ts";
import { resolveLeagueAdjustment } from "../context/league-strength.ts";
import type { LeagueStrengthEstimate } from "../context/league-strength.ts";
import { isVerifiedSource, readObservation } from "../contracts/observations.ts";
import type { Observation } from "../contracts/observations.ts";
import type { ModelVersion, RatingReason, RatingResult } from "../contracts/rating.ts";
import { describePositionModel, positionComponents } from "../models/positions/catalog.ts";
import type { FieldComponentId, FieldPath, FieldPosition, FieldSeason } from "../models/positions/catalog.ts";
import { readComponent } from "../models/positions/evidence.ts";
import type { ComponentSample } from "../models/positions/evidence.ts";
import { calibrateSimulation } from "../simulation/calibration.ts";
import type { SimulationCalibration } from "../simulation/calibration.ts";
import { compareId, validateSeasonScope } from "./scope.ts";

interface ComponentParameters {
  readonly weight: number;
  readonly scale: number;
  readonly center: number;
}

export interface FieldSeasonSimulation<P extends FieldPosition> {
  readonly version: ModelVersion & {
    readonly path: FieldPath;
    readonly fieldPosition: P;
    readonly featureDefinitionVersion: string;
    readonly comparisonScope: NonNullable<ModelVersion["comparisonScope"]>;
  };
  readonly components: Readonly<Partial<Record<FieldComponentId<P>, ComponentParameters>>>;
  readonly calibration: SimulationCalibration;
  readonly leagueAdjustmentScale?: number;
}

export function calculateFieldSeasonPerformance<P extends FieldPosition>(
  input: FieldSeason<P>,
  policy: FieldSeasonSimulation<NoInfer<P>>,
  context?: LeagueStrengthEstimate,
): RatingResult {
  const { season, playerId, position, asOf, snapshot, stints } = input;
  const { origin, dataVersion, schemaVersion } = snapshot;
  const ordered = [...stints].sort((left, right) => compareId(left.id, right.id));
  const version = policy.version;
  const base = {
    kind: "SEASON_PERFORMANCE", scope: { playerId, position, asOf }, model: version, origin,
    seasonId: season.id, competitionId: season.competitionId, leagueId: season.leagueId, dataVersion, schemaVersion,
    stintIds: ordered.map(({ id }) => id), flags: [], rankingEligible: false,
  } as const;
  const expectedGames = stints.reduce((count, stint) => count + stint.expectedGameIds.length, 0);
  let confidence = summarizeConfidence(expectedGames);
  const blocked = (reason: RatingReason): RatingResult => ({ ...base, confidence, status: "NOT_RATED", reason, score: null });

  if (origin !== "SYNTHETIC") return blocked("REAL_DATA_DISABLED");
  const scopeIssue = validateSeasonScope(input);
  if (scopeIssue) return blocked(scopeIssue);
  const { tiers, definitionVersion } = describePositionModel(position);
  if (!tiers || version.maturity !== "UNVALIDATED_SIMULATION" || version.fieldPosition !== position
    || version.featureDefinitionVersion !== definitionVersion
    || [version.methodVersion, version.parameterVersion, version.contextVersion].some((id) => !id.trim())
    || !version.comparisonScope?.leagueId.trim()) return blocked("NO_VALIDATED_MODEL_PATH");
  const components = positionComponents(tiers, version.path);
  if (!components) return blocked("NO_VALIDATED_MODEL_PATH");
  const parameters: Readonly<Record<string, ComponentParameters | undefined>> = policy.components;
  const selected = components.flatMap((definition) => {
    const parameter = Object.hasOwn(parameters, definition.id) ? parameters[definition.id] : undefined;
    return parameter ? [{ definition, parameter, samples: [] as ComponentSample[] }] : [];
  });
  if (selected.length !== components.length || Object.keys(parameters).length !== components.length
    || selected.some(({ parameter: { weight, scale, center } }) =>
      ![weight, scale, center].every(Number.isFinite) || weight < 0 || scale <= 0)
    || Math.abs(selected.reduce((sum, { parameter }) => sum + parameter.weight, 0) - 1) > 1e-12) {
    return blocked("INVALID_MODEL_OUTPUT");
  }
  const adjustment = resolveLeagueAdjustment(season.leagueId, position, asOf, version, policy.leagueAdjustmentScale, context);
  if (adjustment === null) return blocked("LEAGUE_CONTEXT_UNAVAILABLE");
  const fields = [...new Set(components.flatMap(({ numerator, denominator, expected }) =>
    expected === undefined ? [numerator, denominator] : [numerator, denominator, expected]))];

  let verifiedUsageGames = 0;
  let usableCoreGames = 0;
  let issue: RatingReason | null = null;
  for (const stint of ordered) {
    const games = [...stint.games].sort((left, right) => compareId(left.gameId, right.gameId));
    for (const { usage, stats } of games) {
      if (usage.status === "UNKNOWN" || !isVerifiedSource(usage.source, origin)) {
        issue ??= "UNVERIFIED_USAGE";
        continue;
      }
      verifiedUsageGames++;
      const observations: Readonly<Record<string, Observation | undefined>> = stats.observations;
      if (usage.status === "DID_NOT_PLAY") {
        if (fields.some((field) => {
          const observation = observations[field];
          if (!observation) return false;
          const evidence = readObservation(observation, origin, Number.isFinite);
          return evidence.status === "INVALID" || evidence.status === "UNUSABLE"
            || (evidence.status === "AVAILABLE" && evidence.value !== 0);
        })) issue ??= "INVALID_CORE";
        continue;
      }
      if (stats.definitionVersion !== definitionVersion) {
        issue ??= "UNUSABLE_CORE";
        continue;
      }
      if (version.comparisonScope.basis === "BRIDGE_REFERENCE" && stats.leagueStrengthExcluded !== true) {
        issue ??= "LEAGUE_CONTEXT_UNAVAILABLE";
        continue;
      }
      let completeCore = true;
      for (const { definition, samples } of selected) {
        const observed = readComponent(definition, observations);
        if (observed.status === "AVAILABLE") samples.push(observed.value);
        if (observed.status === "AVAILABLE" || observed.status === "NOT_APPLICABLE") continue;
        const core = tiers.CORE.some(({ id }) => id === definition.id);
        if (core) completeCore = false;
        issue ??= !core ? "MISSING_COMPONENT"
          : observed.status === "MISSING" ? "MISSING_CORE" : observed.status === "UNUSABLE" ? "UNUSABLE_CORE" : "INVALID_CORE";
      }
      if (completeCore) usableCoreGames++;
    }
  }
  confidence = { ...confidence, verifiedUsageGames, usableCoreGames };
  if (issue) return blocked(issue);
  const exposures: Record<string, number> = {};
  let latent = adjustment.value;
  for (const { definition, samples, parameter } of selected) {
    const total = samples.reduce((sum, { exposure }) => sum + exposure, 0);
    if (total === 0) return blocked(tiers.CORE.some(({ id }) => id === definition.id) ? "MISSING_CORE" : "MISSING_COMPONENT");
    if (!Number.isSafeInteger(total)) return blocked("INVALID_MODEL_OUTPUT");
    const value = samples.reduce((sum, sample) => sum + sample.value * (sample.exposure / total), 0);
    latent += parameter.weight * parameter.scale * (value - parameter.center);
    exposures[definition.id] = total;
  }
  const calibrated = calibrateSimulation(latent, policy.calibration);
  if (!calibrated) return blocked("INVALID_MODEL_OUTPUT");
  return {
    ...base, confidence: { ...confidence, componentExposures: exposures }, leagueContextEvidenceIds: adjustment.evidenceIds,
    status: "PROVISIONAL", origin: "SYNTHETIC", label: "SIMULATION", ...calibrated,
  };
}
