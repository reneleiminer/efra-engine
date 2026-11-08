import type { DataOrigin } from "./observations.ts";
import type { Position } from "./statistics.ts";

export type RatingKind = "SEASON_PERFORMANCE" | "OVERALL";
export type RatingStatus = "NOT_RATED" | "PROVISIONAL" | "OFFICIAL";
export type RatingFlag = "UNDER_REVIEW" | "SUSPENDED" | "STALE" | "SUPERSEDED";
export type QbPath = "QB_STANDARD_CORE" | "QB_ADVANCED" | "QB_RUSH_ONLY_SPECIAL";
export type RatingReason = "REAL_DATA_DISABLED" | "INVALID_SCOPE" | "INCOMPLETE_COVERAGE"
  | "UNVERIFIED_USAGE" | "NO_PASSING_EXPOSURE" | "MISSING_CORE" | "UNUSABLE_CORE"
  | "INVALID_CORE" | "MISSING_COMPONENT" | "NO_VALIDATED_MODEL_PATH" | "INVALID_MODEL_OUTPUT"
  | "NO_COMPATIBLE_HISTORY";

export interface ModelVersion {
  readonly methodVersion: string;
  readonly parameterVersion: string;
  readonly contextVersion: string;
  readonly path: QbPath;
  readonly maturity: "UNVALIDATED_SIMULATION";
}

export interface Confidence {
  readonly status: "UNCALIBRATED";
  readonly score: null;
  readonly interval: null;
  readonly expectedGames: number;
  readonly verifiedUsageGames: number;
  readonly usableCoreGames: number;
  readonly passingAttempts: number;
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
