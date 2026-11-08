import type { Pool } from "pg";
import { compareImportDecisions } from "./determinism.ts";
import type { ImportCandidate, ImportManifest, ImportPlan, ImportRowDecision, ImportSourcePolicy } from "./contracts.ts";
import { candidateConflicts, planImport } from "./plan.ts";

interface IdentityResult {
  readonly ordinal: number;
  readonly gameId: string;
  readonly playerId: string;
  readonly teamId: string;
  readonly opponentId: string;
}

/** Resolves source-scoped aliases against the canonical EFRA schema before quality checks. */
export class PostgresImportIdentityResolver {
  readonly #pool: Pick<Pool, "query">;

  constructor(pool: Pick<Pool, "query">) {
    this.#pool = pool;
  }

  async plan(manifest: ImportManifest, policy: ImportSourcePolicy, candidates: readonly ImportCandidate[]): Promise<ImportPlan> {
    const preflight = planImport(manifest, policy, []);
    if (preflight.status === "BLOCKED") return preflight;

    const counts = new Map<string, number>();
    for (const { sourceRecordId } of candidates) counts.set(sourceRecordId, (counts.get(sourceRecordId) ?? 0) + 1);
    const valid = candidates.flatMap(({ sourceRecordId, game }, ordinal) =>
      game.seasonId !== manifest.seasonId || (counts.get(sourceRecordId) ?? 0) > 1 ? [] : [{
        ordinal, game_key: game.gameId, player_key: game.playerId, team_key: game.teamId,
        opponent_key: game.opponentId, position: game.position, usage: game.usage.status,
      }]);
    const { rows: [scope] } = await this.#pool.query<{ competition_id: string; season_id: string; resolved: IdentityResult[] }>(
      "SELECT * FROM efra_ingest.resolve_import_identities($1, $2, $3, $4::jsonb)",
      [manifest.sourceId, manifest.competitionId, manifest.seasonId, JSON.stringify(valid)],
    );
    if (!scope) return { status: "BLOCKED", reason: "UNRESOLVED_IMPORT_SCOPE" };
    const mapping = new Map(scope.resolved.map(({ ordinal, ...identity }) => [ordinal, identity]));
    const resolved: ImportCandidate[] = [];
    const quarantine: ImportRowDecision[] = [];
    for (const [ordinal, candidate] of candidates.entries()) {
      const identity = mapping.get(ordinal);
      if (identity) {
        resolved.push({ ...candidate, game: { ...candidate.game, ...identity, seasonId: scope.season_id } });
      } else {
        const { sourceRecordId } = candidate;
        const conflicts = candidateConflicts(candidate);
        quarantine.push({ sourceRecordId, status: "QUARANTINE", issues: [(counts.get(sourceRecordId) ?? 0) > 1
          ? "DUPLICATE_RECORD" : "UNRESOLVED_OR_INCONSISTENT_IDENTITY"], ...(conflicts.length && { conflicts }) });
      }
    }

    const canonicalScope = { competitionId: scope.competition_id, seasonId: scope.season_id };
    const plan = planImport({ ...manifest, ...canonicalScope }, { ...policy, ...canonicalScope }, resolved);
    if (plan.status === "BLOCKED") return plan;
    return { ...plan, rows: [...plan.rows, ...quarantine].sort(compareImportDecisions) };
  }
}
