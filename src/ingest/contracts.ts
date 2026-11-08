import type { DataOrigin } from "../contracts/observations.ts";
import type { GameStatistics, QbGame } from "../contracts/statistics.ts";
import type { FieldPosition, FieldStatistics } from "../models/positions/catalog.ts";

export interface ImportManifest {
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly supersedesSourceRevision?: string;
  readonly origin: DataOrigin;
  readonly competitionId: string;
  readonly seasonId: string;
  readonly mappingVersion: string;
  readonly schemaVersion: string;
  readonly payloadSha256: string;
  readonly retrievedAt: string;
}

export interface ImportSourcePolicy {
  readonly sourceId: string;
  readonly competitionId: string;
  readonly seasonId: string;
  readonly mappingVersion: string;
  readonly permission: "PENDING" | "SYNTHETIC_FIXTURE";
}

export interface ImportCandidate {
  readonly sourceRecordId: string;
  readonly game: QbGame | GameStatistics<FieldPosition, FieldStatistics<FieldPosition>>;
}

export type ImportQualityIssue =
  | "INVALID_IDENTITY_OR_SCOPE" | "DUPLICATE_RECORD" | "DUPLICATE_GAME_POSITION"
  | "UNVERIFIED_USAGE" | "UNEXPECTED_FIELD" | "FEATURE_VERSION_MISMATCH" | "SOURCE_MISMATCH"
  | "CORE_INCOMPLETE" | "INVALID_EVIDENCE" | "UNUSABLE_EVIDENCE";

export type ImportRowDecision = {
  readonly sourceRecordId: string;
  readonly issues: readonly ImportQualityIssue[];
} & (
  | { readonly status: "STAGE" | "STAGE_INCOMPLETE"; readonly candidate: ImportCandidate }
  | { readonly status: "QUARANTINE" }
);

export type ImportPlan =
  | { readonly status: "BLOCKED"; readonly reason: "INVALID_MANIFEST" | "SOURCE_NOT_APPROVED" | "REAL_IMPORT_DISABLED" }
  | {
      readonly status: "DRY_RUN";
      readonly label: "SIMULATION";
      readonly batchKey: string;
      readonly manifest: ImportManifest;
      readonly rows: readonly ImportRowDecision[];
    };

/** Persistence must be atomic and replay-safe. */
export interface ImportStageStore {
  stage(plan: Extract<ImportPlan, { status: "DRY_RUN" }>): Promise<"STAGED" | "ALREADY_STAGED" | "REVISION_CONFLICT">;
}
