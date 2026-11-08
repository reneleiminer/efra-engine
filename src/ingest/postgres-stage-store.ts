import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { timestamp } from "../contracts/time.ts";
import type { ImportCandidate, ImportPlan, ImportStageStore } from "./contracts.ts";

type DryRun = Extract<ImportPlan, { status: "DRY_RUN" }>;

export interface StageReview {
  readonly stageId: string;
  readonly decision: "APPROVED" | "REJECTED";
  readonly reviewerId: string;
  readonly reason: string;
}

export interface SnapshotRequest {
  readonly snapshotId: string;
  readonly competitionId: string;
  readonly seasonId: string;
  readonly schemaVersion: string;
  readonly asOf: string;
  readonly stageIds: readonly string[];
}

export interface SnapshotGame {
  readonly stageId: string;
  readonly sourceRecordId: string;
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly supersedesSourceRevision: string | null;
  readonly payloadSha256: string;
  readonly mappingVersion: string;
  readonly batchKey: string;
  readonly retrievedAt: string;
  readonly reviewedAt: string;
  readonly reviewerId: string;
  readonly reviewReason: string;
  readonly game: ImportCandidate["game"];
}

export interface ApprovedImportSnapshot extends Omit<SnapshotRequest, "stageIds"> {
  readonly label: "SIMULATION";
  readonly origin: "SYNTHETIC";
  readonly games: readonly SnapshotGame[];
}

export class PostgresImportStageStore implements ImportStageStore {
  readonly #pool: Pick<Pool, "connect">;

  constructor(pool: Pick<Pool, "connect">) {
    this.#pool = pool;
  }

  async stage(plan: DryRun): ReturnType<ImportStageStore["stage"]> {
    const { manifest, rows } = plan;
    if (plan.status !== "DRY_RUN" || plan.label !== "SIMULATION" || manifest.origin !== "SYNTHETIC") {
      throw new Error("PostgreSQL staging accepts synthetic dry runs only");
    }
    const revisionKey = [manifest.sourceId, manifest.competitionId, manifest.seasonId, manifest.sourceRevision];
    const predecessor = manifest.supersedesSourceRevision ?? null;
    const staged = [];
    const quarantine = [];
    for (const [index, row] of rows.entries()) {
      const decision = { source_record_id: row.sourceRecordId, issues: row.issues };
      if (row.status === "QUARANTINE") quarantine.push({ ...decision, decision_ordinal: index + 1 });
      else {
        const { game } = row.candidate;
        staged.push({ ...decision, game_id: game.gameId, player_id: game.playerId,
          position: game.position, status: row.status, game });
      }
    }
    const fingerprint = createHash("sha256").update(canonicalJson(rows)).digest("hex");
    const stagedJson = JSON.stringify(staged);
    const quarantineJson = JSON.stringify(quarantine);

    return this.#transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO efra_ingest.source_revision
           (source_id, competition_id, season_id, source_revision, origin, payload_sha256, supersedes_source_revision)
         VALUES ($1, $2, $3, $4, 'SYNTHETIC', $5, $6)
         ON CONFLICT (source_id, competition_id, season_id, source_revision) DO NOTHING
         RETURNING id::text`, [...revisionKey, manifest.payloadSha256, predecessor],
      );
      let revisionId = inserted.rows[0]?.id;
      if (!revisionId) {
        const { rows: [existing] } = await client.query<{ id: string; payload_sha256: string; supersedes_source_revision: string | null }>(
          `SELECT id::text, payload_sha256, supersedes_source_revision FROM efra_ingest.source_revision
           WHERE (source_id, competition_id, season_id, source_revision) = ($1, $2, $3, $4)`, revisionKey,
        );
        if (!existing) throw new Error("Source revision disappeared during staging");
        if (existing.payload_sha256 !== manifest.payloadSha256 || existing.supersedes_source_revision !== predecessor) {
          return "REVISION_CONFLICT";
        }
        revisionId = existing.id;
      }

      const batchKey = [revisionId, manifest.mappingVersion, manifest.schemaVersion];
      const batch = await client.query<{ id: string }>(
        `INSERT INTO efra_ingest.import_batch
           (revision_id, mapping_version, schema_version, batch_key, plan_sha256, retrieved_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (revision_id, mapping_version, schema_version) DO NOTHING
         RETURNING id::text`, [...batchKey, plan.batchKey, fingerprint, manifest.retrievedAt],
      );
      const batchId = batch.rows[0]?.id;
      if (!batchId) {
        const { rows: [existing] } = await client.query<{ plan_sha256: string; batch_key: string }>(
          `SELECT plan_sha256, batch_key FROM efra_ingest.import_batch
           WHERE (revision_id, mapping_version, schema_version) = ($1, $2, $3)`, batchKey,
        );
        if (!existing) throw new Error("Import batch disappeared during staging");
        return existing.plan_sha256 === fingerprint && existing.batch_key === plan.batchKey
          ? "ALREADY_STAGED" : "REVISION_CONFLICT";
      }

      await client.query(
        `INSERT INTO efra_ingest.staged_game
           (batch_id, source_record_id, game_id, player_id, position, status, issues, game)
         SELECT $1, source_record_id, game_id, player_id, position, status, issues, game
         FROM jsonb_to_recordset($2::jsonb) AS row(
           source_record_id text, game_id text, player_id text, position text, status text, issues text[], game jsonb)`,
        [batchId, stagedJson],
      );
      await client.query(
        `INSERT INTO efra_ingest.quarantine (batch_id, decision_ordinal, source_record_id, issues)
         SELECT $1, decision_ordinal, source_record_id, issues
         FROM jsonb_to_recordset($2::jsonb) AS row(decision_ordinal integer, source_record_id text, issues text[])`,
        [batchId, quarantineJson],
      );
      return "STAGED";
    });
  }

  async recordReview(review: StageReview): Promise<"REVIEWED" | "ALREADY_REVIEWED" | "REVIEW_CONFLICT"> {
    const { stageId, decision, reviewerId, reason } = review;
    return this.#transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO efra_ingest.review (stage_id, stage_status, decision, reviewer_id, reason)
         SELECT id, status, $2, $3, $4 FROM efra_ingest.staged_game WHERE id = $1
         ON CONFLICT (stage_id) DO NOTHING`, [stageId, decision, reviewerId, reason],
      );
      if (result.rowCount) return "REVIEWED";
      const { rows: [existing] } = await client.query<{ decision: string; reviewer_id: string; reason: string }>(
        "SELECT decision, reviewer_id, reason FROM efra_ingest.review WHERE stage_id = $1", [stageId],
      );
      if (!existing) throw new Error("Unknown staging row for review");
      return existing.decision === decision && existing.reviewer_id === reviewerId && existing.reason === reason
        ? "ALREADY_REVIEWED" : "REVIEW_CONFLICT";
    });
  }

  async createSnapshot(request: SnapshotRequest): Promise<"CREATED" | "ALREADY_CREATED" | "SNAPSHOT_CONFLICT"> {
    const { snapshotId, competitionId, seasonId, schemaVersion, asOf, stageIds } = request;
    if (!Number.isFinite(timestamp(asOf)) || stageIds.length === 0
      || stageIds.some((id) => !/^[1-9][0-9]*$/.test(id)) || new Set(stageIds).size !== stageIds.length) {
      throw new Error("Invalid snapshot cutoff or membership");
    }
    const header = [snapshotId, competitionId, seasonId, schemaVersion, asOf];
    return this.#transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO efra_ingest.snapshot (id, competition_id, season_id, schema_version, as_of)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`, header,
      );
      if (!inserted.rowCount) {
        const { rows: [existing] } = await client.query<{ matches: boolean }>(
          `SELECT (competition_id, season_id, schema_version, as_of) = ($2, $3, $4, $5)
                AND ARRAY(SELECT stage_id FROM efra_ingest.snapshot_game WHERE snapshot_id = $1 ORDER BY stage_id)
                  = ARRAY(SELECT unnest($6::bigint[]) ORDER BY 1) AS matches
           FROM efra_ingest.snapshot WHERE id = $1`, [...header, stageIds],
        );
        return existing?.matches ? "ALREADY_CREATED" : "SNAPSHOT_CONFLICT";
      }
      const membership = await client.query(
        `INSERT INTO efra_ingest.snapshot_game (snapshot_id, stage_id, game_id, player_id, position)
         SELECT $1, id, game_id, player_id, position FROM efra_ingest.staged_game
         WHERE id = ANY($2::bigint[]) ORDER BY id`, [snapshotId, stageIds],
      );
      if (membership.rowCount !== stageIds.length) throw new Error("Unknown staging row in snapshot membership");
      return "CREATED";
    });
  }

  async readSnapshot(snapshotId: string): Promise<ApprovedImportSnapshot | null> {
    const client = await this.#pool.connect();
    try {
      const { rows: [result] } = await client.query<Omit<ApprovedImportSnapshot, "label" | "origin" | "asOf"> & { asOf: Date }>(
        `SELECT s.id AS "snapshotId", s.competition_id AS "competitionId", s.season_id AS "seasonId",
                s.schema_version AS "schemaVersion", s.as_of AS "asOf",
                jsonb_agg(jsonb_build_object(
                  'stageId', g.id::text, 'sourceRecordId', g.source_record_id, 'sourceId', v.source_id,
                  'sourceRevision', v.source_revision, 'supersedesSourceRevision', v.supersedes_source_revision,
                  'payloadSha256', v.payload_sha256,
                  'mappingVersion', b.mapping_version, 'batchKey', b.batch_key,
                  'retrievedAt', to_char(b.retrieved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                  'reviewedAt', to_char(r.reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                  'reviewerId', r.reviewer_id, 'reviewReason', r.reason, 'game', g.game
                ) ORDER BY g.game_id COLLATE "C", g.player_id COLLATE "C", g.position COLLATE "C") AS games
         FROM efra_ingest.snapshot AS s
         JOIN efra_ingest.snapshot_game AS m ON m.snapshot_id = s.id
         JOIN efra_ingest.staged_game AS g ON g.id = m.stage_id
         JOIN efra_ingest.review AS r ON r.stage_id = g.id
         JOIN efra_ingest.import_batch AS b ON b.id = g.batch_id
         JOIN efra_ingest.source_revision AS v ON v.id = b.revision_id
         WHERE s.id = $1 GROUP BY s.id`, [snapshotId],
      );
      return result ? { ...result, asOf: result.asOf.toISOString(), label: "SIMULATION", origin: "SYNTHETIC" } : null;
    } finally {
      client.release();
    }
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left < right ? -1 : left === right ? 0 : 1));
  });
}
