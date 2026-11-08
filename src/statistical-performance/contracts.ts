import type { DataOrigin } from "../contracts/observations.ts";
import type { Position } from "../contracts/statistics.ts";
import type { PassingCore } from "../models/qb/core.ts";
import type { PilotKeyTrust, SignedPilotEnvelope } from "../pilot/signatures.ts";

export const statisticalVersion = "efra-statistical-performance-v1";
export const qbPassingDefinitionVersion = "efra-stat-qb-passing-v1";
export const qbFields = ["attempts", "completions", "yards", "touchdowns", "interceptions"] as const;
export const qbUnits = {
  attempts: "attempts", completions: "completions", yards: "yards", touchdowns: "touchdowns", interceptions: "interceptions",
} as const;
export const qbMetrics = ["completionPercentage", "yardsPerAttempt", "touchdownRate", "interceptionRate", "passingVolume"] as const;
export type QbMetric = typeof qbMetrics[number];
export type Competition = "EFA" | "GFL" | "GFL2";
export type SeasonStage = "REGULAR_SEASON" | "PLAYOFFS";
export type StatisticalSource = "EPFR" | "EFA_OFFICIAL" | "STATS_N_SCORE";

export interface ComparisonGroup {
  readonly version: string;
  readonly competition: Competition;
  readonly competitionId: string;
  readonly seasonId: string;
  readonly year: 2026;
  readonly stage: SeasonStage;
  readonly startsAt: string;
  readonly endsBefore: string;
}

export interface QbScheduledGame {
  readonly gameId: string;
  readonly competitionId: string;
  readonly seasonId: string;
  readonly stage: SeasonStage;
  readonly playedAt: string;
  readonly homeTeamId: string;
  readonly awayTeamId: string;
  /** Includes expected QB candidates and unresolved roles; absence from a source is never DNP. */
  readonly candidates: readonly { readonly playerId: string; readonly teamId: string }[];
}

export type StatisticalObservation =
  | { readonly status: "MISSING" | "NOT_APPLICABLE" | "CONFLICTED" }
  | { readonly status: "REPORTED_ZERO" | "REPORTED_VALUE"; readonly value: number }
  | { readonly status: "VERIFIED_ZERO" | "VERIFIED_VALUE"; readonly value: number; readonly evidenceSha256: string };

export interface QbStatRow {
  readonly recordId: string;
  readonly playerId: string;
  readonly teamId: string;
  readonly reportedRole?: "REPORTED_PLAYED" | "REPORTED_DID_NOT_PLAY" | "UNKNOWN";
  readonly role:
    | { readonly status: "UNKNOWN" }
    | { readonly status: "PLAYED_QB" | "DID_NOT_PLAY_QB"; readonly evidenceSha256: string };
  readonly fields: { readonly [K in keyof PassingCore]: StatisticalObservation & { readonly unit: typeof qbUnits[K] } };
}

export interface QbGameRevision {
  readonly gameId: string;
  readonly id: string;
  readonly supersedes?: string;
  readonly availableAt: string;
  readonly finality: "FINAL" | "PROVISIONAL";
  readonly source: StatisticalSource;
  readonly artifactSha256: string;
  readonly mappingVersion: string;
  readonly conventionVersion: string;
  readonly rows: readonly QbStatRow[];
}

export interface QbStatDataset {
  readonly schema: typeof statisticalVersion;
  readonly passingDefinition: typeof qbPassingDefinitionVersion;
  readonly version: string;
  readonly origin: DataOrigin;
  readonly group: ComparisonGroup;
  readonly asOf: string;
  readonly manifest: { readonly status: "COMPLETE" | "INCOMPLETE"; readonly evidenceSha256: string };
  readonly games: readonly QbScheduledGame[];
  readonly players: readonly { readonly id: string; readonly name: string }[];
  readonly teams: readonly { readonly id: string; readonly name: string }[];
  readonly revisions: readonly QbGameRevision[];
}

export interface QbEligibilityPolicy {
  readonly schema: typeof statisticalVersion;
  readonly version: string;
  readonly groupSha256: string;
  readonly status: "PROVISIONAL" | "APPROVED";
  readonly minimumAttempts: number;
  readonly completeness: "ALL_EXPECTED_GAMES";
  readonly rationale: string;
}

export interface StatisticalRights {
  readonly schema: typeof statisticalVersion;
  readonly licenseId: string;
  readonly evidenceSha256: string;
  readonly source: StatisticalSource;
  readonly groupSha256: string;
  readonly datasetSha256: string;
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly permits: readonly ("IMPORT" | "STORE" | "DERIVE" | "PUBLISH")[];
}

export interface StatisticalContext {
  readonly environment: string;
  readonly keys: PilotKeyTrust;
  /** Server configuration. Omission keeps the environment synthetic-only. */
  readonly licensedDataEnabled?: true;
  /** Resolve a stable authenticated person across all of their keys, or undefined for revoked/unassigned keys. */
  readonly personForKey: (keyId: string) => string | undefined;
  /** Trusted service time. */
  readonly now: string;
}

export interface QbStatInput {
  readonly dataset: SignedPilotEnvelope<QbStatDataset>;
  readonly policy: SignedPilotEnvelope<QbEligibilityPolicy>;
  readonly rights?: readonly SignedPilotEnvelope<StatisticalRights>[];
}

export const statisticalExtensions = {
  RB: "Rushing efficiency: reviewed yards and carries",
  WR: "Receiving production and efficiency: catches, yards and verified targets for target rates",
  TE: "Receiving only: verified role, catches and yards; no inference about blocking",
  K: "Field goals and extra points: separate attempts and makes",
  KR: "Kick returns: reviewed returns, yards and kick-return role",
  PR: "Punt returns: reviewed returns, yards and punt-return role",
  P: "Punting: attempts and gross yards; no net result without supporting evidence",
  DT: "Defensive box-score events only", NT: "Defensive box-score events only", EDGE: "Defensive box-score events only",
  ILB: "Defensive box-score events only", MLB: "Defensive box-score events only", OLB: "Defensive box-score events only",
  CB: "Defensive box-score events only", FS: "Defensive box-score events only", SS: "Defensive box-score events only",
  S: "Defensive box-score events only",
} as const satisfies Partial<Record<Position, string>>;
