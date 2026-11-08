import type { Observation } from "../../contracts/observations.ts";
import type { Position } from "../../contracts/statistics.ts";
import type { ImportCandidate } from "../../ingest/contracts.ts";
import { describePositionModel } from "./catalog.ts";
import { describePositionDataRequirements, positionDataAvailabilityMatrix } from "./data-requirements.ts";
import type { SourceCapability } from "./data-requirements.ts";
import type { ComponentDefinition, MetricTier } from "./metrics.ts";

export const positionMetricRegistryVersion = "efra-position-metrics-v1";
export const positionProjectionVersion = "efra-all-positions-v1";

export interface PositionMetric {
  readonly position: Position;
  readonly field: string;
  readonly code: string;
  readonly unit: "count" | "attempts" | "completions" | "yards" | "touchdowns" | "interceptions" | "points" | "seconds" | "expected_count";
  readonly domain: "COUNT" | "SIGNED_INTEGER" | "SIGNED_DECIMAL" | "NONNEGATIVE_DECIMAL";
  readonly tiers: readonly MetricTier[];
  readonly roles: readonly ("NUMERATOR" | "EXPOSURE" | "REFERENCE")[];
  readonly sourceCapability: SourceCapability;
  readonly storage: "GAME" | "RATING_POLICY";
  readonly definitionVersion: string;
}

interface MetricRule {
  readonly position: Position;
  readonly upper: string;
  readonly fields: readonly string[];
  readonly kind: "SUM_AT_MOST" | "ZERO_IF_ZERO";
}

const qbPassingCodes = {
  "passing.attempts": ["passing_attempts", "attempts"], "passing.completions": ["passing_completions", "completions"],
  "passing.yards": ["passing_yards", "yards"], "passing.touchdowns": ["passing_touchdowns", "touchdowns"],
  "passing.interceptions": ["passing_interceptions", "interceptions"],
} as const;
const yardFields = new Set([
  "passing.yards", "rushing.yards", "cleanRushingYards", "receivingYards", "cleanReceivingYards",
  "coverageYardsAllowed", "middleYardsAllowed", "flatYardsAllowed", "nonTurnoverYardsAllowed", "deepYardsAllowed",
  "shortYardsAllowed", "returnedFieldPositionAboveExpected", "unreturnedFieldPositionAboveExpected",
  "kickReturnYardsAboveExpected", "puntReturnYardsAboveExpected",
]);
const tierOrder: readonly MetricTier[] = ["CORE", "SUPPORTING", "ADVANCED"];

export function positionMetricRegistry(): {
  readonly version: typeof positionMetricRegistryVersion;
  readonly metrics: readonly PositionMetric[];
  readonly rules: readonly MetricRule[];
} {
  const positions = (Object.keys(positionDataAvailabilityMatrix().positions) as Position[]).sort();
  const metrics: PositionMetric[] = [];
  const rules: MetricRule[] = [];
  for (const position of positions) {
    const requirement = describePositionDataRequirements(position);
    const terms: readonly ComponentDefinition[] = position === "QB" ? []
      : tierOrder.flatMap((tier) => [...describePositionModel(position).tiers[tier]]);
    const fields = new Set(tierOrder.flatMap((tier) => requirement.tiers[tier].fields.map(({ field }) => field)));
    for (const field of [...fields].sort()) {
      const byTier = tierOrder.filter((tier) => requirement.tiers[tier].fields.some((entry) => entry.field === field));
      const uses = byTier.flatMap((tier) => requirement.tiers[tier].fields.filter((entry) => entry.field === field));
      const role = uses[0];
      if (!role || uses.some(({ sourceCapability }) => sourceCapability !== role.sourceCapability)) {
        throw new Error(`Conflicting source semantics for ${position}/${field}`);
      }
      const legacy = qbPassingCodes[field as keyof typeof qbPassingCodes];
      const code = legacy?.[0] ?? `${position.toLowerCase()}.${field}`;
      const storage = field.startsWith("context.") ? "RATING_POLICY" : "GAME";
      const domain = yardFields.has(field) ? field.endsWith("AboveExpected") ? "SIGNED_DECIMAL" : "SIGNED_INTEGER"
        : field === "accuratePuntSnapTotalSeconds" || role.sourceCapability === "MODEL_REFERENCE" && !field.endsWith("PointsAdded")
          ? "NONNEGATIVE_DECIMAL" : field.endsWith("PointsAdded") ? "SIGNED_DECIMAL" : "COUNT";
      if (domain === "COUNT" && terms.some((term) => term.kind === "PER_OPPORTUNITY" && term.numerator === field)) {
        throw new Error(`Explicit physical unit required for ${position}/${field}`);
      }
      const unit = legacy?.[1] ?? (yardFields.has(field) ? "yards" : domain === "SIGNED_DECIMAL" ? "points"
        : domain === "NONNEGATIVE_DECIMAL" ? field === "accuratePuntSnapTotalSeconds" ? "seconds" : "expected_count" : "count");
      metrics.push({
        position, field, code, unit, domain, storage, tiers: byTier, roles: [...new Set(uses.map(({ role }) => role))],
        sourceCapability: role.sourceCapability, definitionVersion: requirement.definitionVersion,
      });
    }
    for (const term of terms) {
      rules.push({ position, upper: term.denominator, fields: [term.numerator], kind: term.kind === "PER_OPPORTUNITY"
        ? "ZERO_IF_ZERO" : "SUM_AT_MOST" });
      if (term.expected) rules.push({ position, upper: term.denominator, fields: [term.expected], kind: "SUM_AT_MOST" });
    }
  }
  const qb = (upper: string, fields: readonly string[], kind: MetricRule["kind"] = "SUM_AT_MOST"): MetricRule => ({ position: "QB", upper, fields, kind });
  rules.push(
    qb("passing.attempts", ["passing.completions", "passing.interceptions"]),
    qb("passing.completions", ["passing.touchdowns", "advancedPassing.nonTouchdownFirstDowns"]),
    qb("passing.completions", ["passing.touchdowns"]),
    qb("passing.completions", ["passing.yards"], "ZERO_IF_ZERO"),
    qb("rushing.attempts", ["rushing.touchdowns", "rushing.turnovers"]),
    qb("rushing.attempts", ["rushing.yards"], "ZERO_IF_ZERO"),
    qb("situation.opportunities", ["situation.actualPointsAdded", "situation.expectedPointsAdded"], "ZERO_IF_ZERO"),
  );
  return { version: positionMetricRegistryVersion, metrics, rules };
}

export function gameObservations(game: ImportCandidate["game"]): Readonly<Record<string, Observation | undefined>> {
  if (game.position !== "QB") return game.stats.observations;
  return Object.fromEntries([
    ...Object.entries(game.stats.passing).map(([key, value]) => [`passing.${key}`, value] as const),
    ...Object.entries(game.stats.rushing).map(([key, value]) => [`rushing.${key}`, value] as const),
    ...Object.entries(game.stats.situation).map(([key, value]) => [`situation.${key}`, value] as const),
    ["advancedPassing.nonTouchdownFirstDowns", game.stats.advancedPassing?.nonTouchdownFirstDowns] as const,
  ]);
}
