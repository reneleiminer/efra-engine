import type { DataOrigin } from "./observations.ts";
import type { Position } from "./statistics.ts";
import type { FieldPath, FieldPosition } from "../models/positions/catalog.ts";

export type RatingKind = "SEASON_PERFORMANCE" | "OVERALL";
export type RatingStatus = "NOT_RATED" | "PROVISIONAL" | "OFFICIAL";
export type RatingFlag = "UNDER_REVIEW" | "SUSPENDED" | "STALE" | "SUPERSEDED";
export type QbPath = "QB_STANDARD_CORE" | "QB_EXTENDED_PRODUCTION" | "QB_ADVANCED" | "QB_RUSH_ONLY_SPECIAL";
export type RatingReason = "REAL_DATA_DISABLED" | "INVALID_SCOPE" | "INCOMPLETE_COVERAGE"
  | "UNVERIFIED_USAGE" | "NO_PASSING_EXPOSURE" | "MISSING_CORE" | "UNUSABLE_CORE"
  | "INVALID_CORE" | "MISSING_COMPONENT" | "NO_VALIDATED_MODEL_PATH" | "INVALID_MODEL_OUTPUT"
  | "NO_COMPATIBLE_HISTORY" | "PASSING_EXPOSURE_IN_RUSH_ONLY" | "LEAGUE_CONTEXT_UNAVAILABLE";

export interface ModelVersion {
  readonly methodVersion: string;
  readonly parameterVersion: string;
  readonly contextVersion: string;
  readonly path: QbPath | FieldPath;
  readonly maturity: "UNVALIDATED_SIMULATION";
  readonly firstDownDefinitionVersion?: string;
  readonly situationDefinitionVersion?: string;
  readonly fieldPosition?: FieldPosition;
  readonly featureDefinitionVersion?: string;
  readonly comparisonScope?: {
    readonly basis: "LEAGUE" | "BRIDGE_REFERENCE";
    readonly leagueId: string;
  };
}

export interface Confidence {
  readonly status: "UNCALIBRATED";
  readonly score: null;
  readonly interval: null;
  readonly expectedGames: number;
  readonly verifiedUsageGames: number;
  readonly usableCoreGames: number;
  readonly passingAttempts: number;
  readonly componentExposures?: Readonly<Record<string, number>>;
}

export interface RatingScope {
  readonly playerId: string;
  readonly position: Position;
  readonly asOf: string;
}

interface ResultBase {
  readonly scope: RatingScope;
  readonly model: ModelVersion;
  readonly origin: DataOrigin;
  readonly confidence: Confidence;
  readonly flags: readonly RatingFlag[];
  readonly rankingEligible: false;
}

type ResultProduct =
  | {
      readonly kind: "SEASON_PERFORMANCE";
      readonly seasonId: string;
      readonly competitionId: string;
      readonly leagueId: string;
      readonly dataVersion: string;
      readonly schemaVersion: string;
      readonly stintIds: readonly string[];
      readonly leagueContextEvidenceIds?: readonly string[];
    }
  | {
      readonly kind: "OVERALL";
      readonly history: readonly { readonly evidenceId: string; readonly dataVersion: string }[];
      readonly simulationVariance: number | null;
    };

export type RatingResult = ResultBase & ResultProduct & (
  | { readonly status: "NOT_RATED"; readonly reason: RatingReason; readonly score: null }
  | {
      readonly status: "PROVISIONAL";
      readonly label: "SIMULATION";
      readonly origin: "SYNTHETIC";
      readonly latent: number;
      readonly score: number;
      readonly displayScore: string;
      readonly calibrationVersion: string;
    }
);
