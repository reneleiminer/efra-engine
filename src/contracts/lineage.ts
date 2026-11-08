import type { Observation, SourceQuality } from "./observations.ts";
import type { PositionUsage } from "./statistics.ts";

export interface InputSourceTrace {
  readonly status: Observation["status"] | PositionUsage["status"];
  readonly sources: readonly SourceQuality[];
}

export interface SeasonGameTrace {
  readonly gameId: string;
  readonly usage: InputSourceTrace;
  readonly fields: Readonly<Record<string, InputSourceTrace>>;
}

export interface LeagueInputTrace {
  readonly dataVersion: string;
  readonly sources: readonly { readonly id: string; readonly input: InputSourceTrace }[];
}

export interface SeasonInputTrace {
  readonly snapshotAvailableAt: string;
  readonly calibrationVersion: string;
  readonly games: readonly SeasonGameTrace[];
  readonly league?: LeagueInputTrace;
}

export function traceObservation(observation: Observation | undefined): InputSourceTrace {
  if (!observation) return { status: "MISSING", sources: [] };
  if ("source" in observation) return { status: observation.status, sources: [observation.source] };
  if ("sources" in observation) return { status: observation.status, sources: observation.sources };
  return { status: observation.status, sources: [] };
}

export function traceGame(
  gameId: string, usage: PositionUsage, fields: readonly string[],
  observations: Readonly<Record<string, Observation | undefined>>,
): SeasonGameTrace {
  return {
    gameId, usage: { status: usage.status, sources: "source" in usage ? [usage.source] : [] },
    fields: Object.fromEntries(fields.map((field) => [field, traceObservation(observations[field])])),
  };
}
