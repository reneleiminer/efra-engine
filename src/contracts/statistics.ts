import type { DataOrigin, Observation, SourceQuality } from "./observations.ts";

export type Position =
  | "QB" | "RB" | "FB" | "WR" | "TE" | "OT" | "OG" | "C"
  | "DT" | "NT" | "EDGE" | "ILB" | "MLB" | "OLB" | "CB" | "FS" | "SS" | "S"
  | "K" | "P" | "KR" | "PR" | "LS" | "GUNNER";

export interface Player {
  readonly id: string;
  readonly displayName: string;
}

export interface CompetitionSeason {
  readonly id: string;
  readonly competitionId: string;
  readonly leagueId: string;
  readonly label: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export type PositionUsage =
  | { readonly status: "PLAYED" | "DID_NOT_PLAY"; readonly source: SourceQuality }
  | { readonly status: "UNKNOWN" };

export interface GameStatistics<P extends Position, T> {
  readonly gameId: string;
  readonly playerId: string;
  readonly position: P;
  readonly seasonId: string;
  readonly teamId: string;
  readonly opponentId: string;
  readonly playedAt: string;
  readonly usage: PositionUsage;
  readonly stats: T;
}

export interface Stint<P extends Position, T> {
  readonly id: string;
  readonly teamId: string;
  readonly expectedGameIds: readonly string[];
  readonly games: readonly GameStatistics<P, T>[];
}

export interface SeasonStatistics<P extends Position, T> {
  readonly playerId: string;
  readonly position: P;
  readonly season: CompetitionSeason;
  readonly asOf: string;
  readonly snapshot: {
    readonly origin: DataOrigin;
    readonly dataVersion: string;
    readonly schemaVersion: string;
    readonly availableAt: string;
  };
  readonly stints: readonly Stint<P, T>[];
}

export interface QbStatistics {
  readonly passing: Readonly<Record<
    "attempts" | "completions" | "yards" | "touchdowns" | "interceptions", Observation
  >>;
  readonly rushing: Readonly<Record<"attempts" | "yards" | "touchdowns" | "turnovers", Observation>>;
  readonly situation: Readonly<Record<"opportunities" | "actualPointsAdded" | "expectedPointsAdded", Observation>>;
  readonly advancedPassing?: {
    readonly definitionVersion: string;
    readonly nonTouchdownFirstDowns: Observation;
  };
  /** Situational sacks attributed to the QB and excluded from both passing and rushing attempts. */
  readonly situationDefinitionVersion?: string;
}

export type QbGame = GameStatistics<"QB", QbStatistics>;
export type QbSeason = SeasonStatistics<"QB", QbStatistics>;
