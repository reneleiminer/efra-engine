import type { ModelVersion } from "../../contracts/rating.ts";
import type { PassingContextModel } from "../../context/adjustment.ts";
import type { SimulationCalibration } from "../../simulation/calibration.ts";
import type {
  BallControl, PassingEfficiency, PassingProduction, QbComponents, RushingContribution, SituationalImpact,
} from "./components.ts";

interface ComponentModel<T> {
  readonly weight: number;
  readonly score: (features: T) => number;
}

interface PassingModels {
  readonly passingEfficiency: ComponentModel<PassingEfficiency>;
  readonly passingProduction: ComponentModel<PassingProduction>;
  readonly ballControl: ComponentModel<BallControl>;
}

interface SimulationPolicy {
  readonly context: PassingContextModel;
  readonly calibration: SimulationCalibration;
}

export type QbSeasonSimulation = SimulationPolicy & (
  | {
      readonly version: ModelVersion & { readonly path: "QB_STANDARD_CORE" };
      readonly components: PassingModels;
    }
  | {
      readonly version: ModelVersion & { readonly path: "QB_ADVANCED" };
      readonly components: PassingModels & {
        readonly rushingContribution: ComponentModel<RushingContribution>;
        readonly situationalImpact: ComponentModel<SituationalImpact>;
      };
    }
);

export function scoreQbComponents(components: QbComponents, policy: QbSeasonSimulation) {
  const { passingEfficiency, passingProduction, ballControl, rushingContribution, situationalImpact } = components;
  if (passingEfficiency.status !== "AVAILABLE" || passingProduction.status !== "AVAILABLE" || ballControl.status !== "AVAILABLE") {
    return { status: "NOT_RATED", reason: "MISSING_COMPONENT" } as const;
  }
  const model = policy.components;
  const terms = [
    { weight: model.passingEfficiency.weight, score: model.passingEfficiency.score(passingEfficiency.value) },
    { weight: model.passingProduction.weight, score: model.passingProduction.score(passingProduction.value) },
    { weight: model.ballControl.weight, score: model.ballControl.score(ballControl.value) },
  ];
  if ("rushingContribution" in model) {
    if (rushingContribution.status !== "AVAILABLE" || situationalImpact.status !== "AVAILABLE") {
      return { status: "NOT_RATED", reason: "MISSING_COMPONENT" } as const;
    }
    terms.push(
      { weight: model.rushingContribution.weight, score: model.rushingContribution.score(rushingContribution.value) },
      { weight: model.situationalImpact.weight, score: model.situationalImpact.score(situationalImpact.value) },
    );
  }
  if (terms.some(({ weight, score }) => !Number.isFinite(weight) || weight < 0 || !Number.isFinite(score))
    || Math.abs(terms.reduce((sum, { weight }) => sum + weight, 0) - 1) > 1e-12) {
    return { status: "NOT_RATED", reason: "INVALID_MODEL_OUTPUT" } as const;
  }
  const latent = terms.reduce((sum, { weight, score }) => sum + weight * score, 0);
  return { status: "AVAILABLE", value: latent } as const;
}
