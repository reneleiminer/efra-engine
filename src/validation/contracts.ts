import type { LeagueBridge } from "../context/league-strength.ts";
import type { Observation, SourceQuality } from "../contracts/observations.ts";
import type { Position } from "../contracts/statistics.ts";

export type ValidationProduct = "SPR" | "OVR" | "CONFIDENCE";
export type Partition = "train" | "validation" | "test";

export interface ReferencePopulation {
  readonly id: string;
  readonly version: string;
  readonly origin: "SYNTHETIC";
  readonly position: Position;
  readonly leagueId: string;
  readonly seasonId: string;
  readonly competitionLevel: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly membershipLockedAt: string;
  readonly memberPlayerIds: readonly string[];
}

export interface TimedEvidence {
  readonly availableAt: string;
  /** Stable identifiers for independently attributed evidence atoms. */
  readonly evidenceIds: readonly string[];
}

export interface ValidationSample {
  readonly id: string;
  readonly origin: "SYNTHETIC";
  readonly populationId: string;
  readonly playerId: string;
  readonly stintId: string;
  readonly transfer?: TimedEvidence & { readonly priorLeagueId: string; readonly effectiveAt: string };
  readonly position: Position;
  readonly leagueId: string;
  readonly seasonId: string;
  readonly predictedAt: string;
  /** Use a common ID for related samples that must stay in the same partition. */
  readonly clusterId: string;
  readonly participation: readonly (TimedEvidence & {
    readonly gameId: string;
    readonly playedAt: string;
    readonly status: "VERIFIED_AT_POSITION" | "UNVERIFIED";
    readonly source: SourceQuality;
  })[];
  readonly fields: Readonly<Record<string, TimedEvidence & { readonly observation: Observation }>>;
  readonly features: Readonly<Record<string, TimedEvidence & {
    readonly value: number;
    readonly metricFields: readonly string[];
  }>>;
  readonly target: TimedEvidence & { readonly eventAt: string; readonly value: number };
}

export interface ScoreCandidate {
  readonly id: string;
  readonly weights: Readonly<Record<string, number>>;
}

export type SensitivityScenario =
  | { readonly id: string; readonly kind: "WEIGHTS"; readonly weights: ScoreCandidate["weights"] }
  | { readonly id: string; readonly kind: "BASELINE_SHIFT"; readonly shift: number }
  | { readonly id: string; readonly kind: "REMOVE_FIELD"; readonly field: string };

export interface ValidationPlan {
  readonly origin: "SYNTHETIC";
  readonly version: string;
  readonly dataVersion: string;
  readonly modelVersion: string;
  readonly registryVersion: string;
  readonly position: Position;
  readonly pathId: string;
  readonly windows: Readonly<Record<Partition, { readonly start: string; readonly end: string }>>;
  readonly frozenAt: string;
  readonly outcome: { readonly definitionVersion: string } & (
    | { readonly kind: "SEASON_REFERENCE" }
    | { readonly kind: "FUTURE_EVENT"; readonly minimumHorizonDays: number; readonly maximumHorizonDays: number }
  );
  readonly coverage: {
    readonly minimumGames: number;
    /** Every positive required exposure has a separately configured lower bound. */
    readonly minimumExposure: Readonly<Record<string, number>>;
  };
  readonly playerDisjoint: boolean;
  readonly minimumPartitionClusters: Readonly<Record<Partition, number>>;
  readonly minimumGroupSize: number;
  readonly leagueContext?: {
    readonly referenceLeagueId: string;
    readonly version: string;
    readonly bridges: readonly (LeagueBridge & { readonly evidenceIds: readonly string[] })[];
  };
}

export type ValidationStudy = {
  readonly plan: ValidationPlan;
  readonly populations: readonly ReferencePopulation[];
  readonly samples: readonly ValidationSample[];
} & (
  | { readonly product: "SPR" | "OVR"; readonly candidates: readonly ScoreCandidate[]; readonly sensitivity: readonly SensitivityScenario[] }
  | { readonly product: "CONFIDENCE"; readonly probabilityFeature: string; readonly binEdges: readonly number[] }
);
