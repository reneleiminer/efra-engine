import type { ModelVersion, QbPath } from "../../contracts/rating.ts";
import type { Evidence } from "../../contracts/observations.ts";
import type { PassingContextModel, PassingProduction } from "../../context/adjustment.ts";
import type { SimulationCalibration } from "../../simulation/calibration.ts";
import type { BallControl, PassingEfficiency, QbGameAnalysis, RushingContribution, SituationalImpact } from "./components.ts";

interface ComponentModel<T> {
  readonly weight: number;
  readonly score: (features: T) => number;
}

interface PassingModels {
  readonly passingEfficiency: ComponentModel<PassingEfficiency>;
  readonly passingProduction: ComponentModel<PassingProduction>;
  readonly ballControl: ComponentModel<BallControl>;
}

interface AdvancedModels {
  readonly rushingContribution: ComponentModel<RushingContribution>;
  readonly situationalImpact: ComponentModel<SituationalImpact>;
}

type Simulation<P extends QbPath, C> = {
  readonly version: ModelVersion & { readonly path: P };
  readonly components: C;
  readonly calibration: SimulationCalibration;
  readonly leagueAdjustmentScale?: number;
};

export type QbSeasonSimulation =
  | (Simulation<"QB_STANDARD_CORE" | "QB_EXTENDED_PRODUCTION", PassingModels> & { readonly context: PassingContextModel })
  | (Simulation<"QB_ADVANCED", PassingModels & AdvancedModels> & { readonly context: PassingContextModel })
  | (Simulation<"QB_RUSH_ONLY_SPECIAL", Pick<AdvancedModels, "rushingContribution">> & { readonly context?: never });

export function validQbPolicy(policy: QbSeasonSimulation): boolean {
  const { version, components, context } = policy;
  if (version.maturity !== "UNVALIDATED_SIMULATION"
    || [version.methodVersion, version.parameterVersion, version.contextVersion].some((id) => !id.trim())) return false;
  if (version.fieldPosition !== undefined || version.featureDefinitionVersion !== undefined
    || (version.comparisonScope && !version.comparisonScope.leagueId.trim())) return false;
  const hasPassing = "passingEfficiency" in components && "passingProduction" in components && "ballControl" in components;
  const hasRushing = "rushingContribution" in components;
  const hasSituation = "situationalImpact" in components;
  if (version.path === "QB_RUSH_ONLY_SPECIAL") {
    return !context && !hasPassing && hasRushing && !hasSituation && version.comparisonScope?.basis !== "BRIDGE_REFERENCE"
      && version.firstDownDefinitionVersion === undefined && version.situationDefinitionVersion === undefined;
  }
  if (!context || context.version !== version.contextVersion || !hasPassing) return false;
  if (version.comparisonScope?.basis === "BRIDGE_REFERENCE" && context.leagueStrengthExcluded !== true) return false;
  const firstDowns = context.nonTouchdownFirstDowns;
  if (version.path === "QB_STANDARD_CORE") {
    return !hasRushing && !hasSituation && !firstDowns
      && version.firstDownDefinitionVersion === undefined && version.situationDefinitionVersion === undefined;
  }
  if (!firstDowns?.definitionVersion.trim() || firstDowns.definitionVersion !== version.firstDownDefinitionVersion) return false;
  if (version.path === "QB_EXTENDED_PRODUCTION") {
    return !hasRushing && !hasSituation && version.situationDefinitionVersion === undefined;
  }
  return version.path === "QB_ADVANCED" && hasRushing && hasSituation && !!version.situationDefinitionVersion?.trim();
}

export function scoreQbSeason(games: readonly QbGameAnalysis[], policy: QbSeasonSimulation) {
  const { components: models, version } = policy;
  const played = games.filter(({ core }) => core.status === "PASSING" || core.status === "VERIFIED_ZERO_ATTEMPTS");
  const passing = played.flatMap(({ core, components }) =>
    core.status === "PASSING" ? [{ attempts: core.stats.attempts, components }] : []);
  const terms = [];
  if ("passingEfficiency" in models) {
    terms.push(
      aggregate(models.passingEfficiency, passing.map((game) => sample(game.components.passingEfficiency, game.attempts))),
      aggregate(models.passingProduction, passing.map((game) => sample(game.components.passingProduction, game.attempts))),
      aggregate(models.ballControl, passing.map((game) => sample(game.components.ballControl, game.attempts))),
    );
  }
  if ("rushingContribution" in models) {
    terms.push(aggregate(models.rushingContribution, played.map(({ components: { rushingContribution: evidence } }) =>
      sample(evidence, evidence.status === "AVAILABLE" ? evidence.value.attempts : 0))));
  }
  if ("situationalImpact" in models) {
    terms.push(aggregate(models.situationalImpact, played.map((game) => {
      const evidence = game.components.situationalImpact;
      if (game.situationDefinitionVersion !== version.situationDefinitionVersion) return { status: "UNUSABLE" };
      if (version.comparisonScope?.basis === "BRIDGE_REFERENCE" && !game.situationLeagueStrengthExcluded) return { status: "UNUSABLE" };
      return sample(evidence, evidence.status === "AVAILABLE" ? evidence.value.opportunities : 0);
    })));
  }
  const missing = terms.some(({ status }) => status === "MISSING");
  if (missing) return { status: "NOT_RATED", reason: "MISSING_COMPONENT" } as const;
  const available = terms.filter((term) => term.status === "AVAILABLE");
  if (available.length !== terms.length
    || Math.abs(available.reduce((sum, { weight }) => sum + weight, 0) - 1) > 1e-12) {
    return { status: "NOT_RATED", reason: "INVALID_MODEL_OUTPUT" } as const;
  }
  const latent = available.reduce((sum, { weight, score }) => sum + weight * score, 0);
  return { status: "AVAILABLE", value: latent } as const;
}

function sample<T>(evidence: Evidence<T>, exposure: number): Evidence<{ readonly feature: T; readonly exposure: number }> {
  if (evidence.status === "NOT_APPLICABLE" && exposure > 0) return { status: "MISSING" };
  return evidence.status === "AVAILABLE" ? { status: "AVAILABLE", value: { feature: evidence.value, exposure } } : evidence;
}

function aggregate<T>(model: ComponentModel<T>, samples: readonly Evidence<{ feature: T; exposure: number }>[]) {
  if (samples.some(({ status }) => status !== "AVAILABLE" && status !== "NOT_APPLICABLE")) {
    return { status: "MISSING" } as const;
  }
  const available = samples.flatMap((entry) => entry.status === "AVAILABLE" ? [entry.value] : []);
  const total = available.reduce((sum, { exposure }) => sum + exposure, 0);
  if (total === 0) return { status: "MISSING" } as const;
  if (!Number.isSafeInteger(total) || !Number.isFinite(model.weight) || model.weight < 0) {
    return { status: "INVALID" } as const;
  }
  const score = available.reduce((sum, { feature, exposure }) => sum + model.score(feature) * (exposure / total), 0);
  if (!Number.isFinite(score)) return { status: "INVALID" } as const;
  return { status: "AVAILABLE", weight: model.weight, score } as const;
}
