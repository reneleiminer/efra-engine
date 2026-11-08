import type { Position, SeasonStatistics } from "../contracts/statistics.ts";
import { timestamp } from "../contracts/time.ts";

export function validateSeasonScope<P extends Position, T>(input: SeasonStatistics<P, T>): "INVALID_SCOPE" | "INCOMPLETE_COVERAGE" | null {
  const { asOf, season, stints, playerId, position, snapshot } = input;
  const start = timestamp(season.startsAt);
  const end = timestamp(season.endsAt);
  const cutoff = timestamp(asOf);
  const available = timestamp(snapshot.availableAt);
  const ids = [season.id, season.leagueId, season.competitionId, playerId, snapshot.dataVersion, snapshot.schemaVersion];
  if (ids.some((id) => !id.trim()) || ![start, end, cutoff, available].every(Number.isFinite)
    || start > end || cutoff < start || available > cutoff) return "INVALID_SCOPE";

  const stintIds = new Set<string>();
  const seasonGameIds = new Set<string>();
  for (const stint of stints) {
    if (!stint.id.trim() || !stint.teamId.trim() || stintIds.has(stint.id)) return "INVALID_SCOPE";
    stintIds.add(stint.id);
    const pending = new Set(stint.expectedGameIds);
    if (pending.size !== stint.expectedGameIds.length) return "INVALID_SCOPE";
    for (const game of stint.games) {
      const played = timestamp(game.playedAt);
      if (!game.gameId.trim() || !game.opponentId.trim() || game.teamId === game.opponentId
        || game.playerId !== playerId || game.position !== position || game.seasonId !== season.id
        || game.teamId !== stint.teamId || seasonGameIds.has(game.gameId) || !Number.isFinite(played)
        || played < start || played > end || played > available || !pending.delete(game.gameId)) {
        return "INVALID_SCOPE";
      }
      seasonGameIds.add(game.gameId);
    }
    if (pending.size > 0) return "INCOMPLETE_COVERAGE";
  }
  return null;
}

export function compareId(left: string, right: string): number {
  if (left < right) return -1;
  return left === right ? 0 : 1;
}
