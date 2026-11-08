import type { Observation } from "../../contracts/observations.ts";
import type { Position, SeasonStatistics } from "../../contracts/statistics.ts";
import { defense } from "./defense.ts";
import type { ComponentDefinition, MetricTier, PositionDefinition } from "./metrics.ts";
import { offense } from "./offense.ts";
import { specialTeams } from "./special-teams.ts";

export type FieldPosition = Exclude<Position, "QB">;

const catalog = { ...offense, ...defense, ...specialTeams } as const satisfies Record<FieldPosition, PositionDefinition>;

type PositionTerm<P extends FieldPosition> = (typeof catalog)[P][MetricTier][number];
export type FieldComponentId<P extends FieldPosition> = PositionTerm<P>["id"];
type ExpectedField<T> = T extends { readonly expected: infer Field extends string } ? Field : never;
type PositionField<P extends FieldPosition> = PositionTerm<P>["numerator"] | PositionTerm<P>["denominator"]
  | ExpectedField<PositionTerm<P>>;

export interface FieldStatistics<P extends FieldPosition> {
  readonly definitionVersion: string;
  readonly leagueStrengthExcluded?: true;
  readonly observations: Readonly<Partial<Record<PositionField<P>, Observation>>>;
}

export type FieldSeason<P extends FieldPosition> = SeasonStatistics<P, FieldStatistics<P>>;
export type FieldPath = "POSITION_CORE" | "POSITION_SUPPORTING" | "POSITION_ADVANCED";

export function describePositionModel<P extends FieldPosition>(position: P) {
  return { position, definitionVersion: `efra-${position.toLowerCase()}-features-v1`, tiers: catalog[position] } as const;
}

export function positionComponents(definition: PositionDefinition, path: FieldPath): readonly ComponentDefinition[] {
  switch (path) {
    case "POSITION_CORE": return definition.CORE;
    case "POSITION_SUPPORTING": return [...definition.CORE, ...definition.SUPPORTING];
    case "POSITION_ADVANCED": return [...definition.CORE, ...definition.SUPPORTING, ...definition.ADVANCED];
  }
}
