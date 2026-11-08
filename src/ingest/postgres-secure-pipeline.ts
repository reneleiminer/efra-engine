import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { SnapshotRequest, StageReview } from "./postgres-stage-store.ts";
import { PostgresApprovedSnapshotReader } from "./postgres-snapshot-reader.ts";

export const qbPassingProjection = "efra-qb-passing-v1";
export type AuthenticatedReview = Omit<StageReview, "reviewerId">;

export interface RatingReplayReference {
  readonly label: "SIMULATION";
  readonly rankingEligible: false;
  readonly snapshotId: string;
  readonly projectionVersion: typeof qbPassingProjection;
  readonly schemaVersion: string;
  readonly asOf: string;
  readonly observationIds: readonly string[];
  readonly engineCommit: string;
  readonly configurationSha256: string;
  readonly snapshotSha256: string;
}

/** Each instance uses one separately authenticated, least-privileged PostgreSQL login pool. */
export class PostgresSecurePipeline {
  readonly #pool: Pick<Pool, "query">;

  constructor(pool: Pick<Pool, "query">) {
    this.#pool = pool;
  }

  async review({ stageId, decision, reason }: AuthenticatedReview): Promise<"REVIEWED" | "ALREADY_REVIEWED" | "REVIEW_CONFLICT"> {
    return this.#call("SELECT efra_ingest.record_authenticated_review($1, $2, $3) AS result", [stageId, decision, reason]);
  }

  async release({ snapshotId, competitionId, seasonId, schemaVersion, asOf, stageIds }: SnapshotRequest):
    Promise<"CREATED" | "ALREADY_CREATED" | "SNAPSHOT_CONFLICT"> {
    return this.#call("SELECT efra_ingest.release_snapshot($1, $2, $3, $4, $5, $6::bigint[]) AS result",
      [snapshotId, competitionId, seasonId, schemaVersion, asOf, stageIds]);
  }

  async project(snapshotId: string, version: typeof qbPassingProjection): Promise<"PROJECTED" | "ALREADY_PROJECTED"> {
    return this.#call("SELECT efra_ingest.project_snapshot($1, $2) AS result", [snapshotId, version]);
  }

  async ratingReplayReference(snapshotId: string, engineCommit: string, configurationSha256: string): Promise<RatingReplayReference | null> {
    if (!/^[0-9a-f]{40}$/.test(engineCommit) || !/^[0-9a-f]{64}$/.test(configurationSha256)) {
      throw new Error("Rating replay requires an exact engine commit and configuration hash");
    }
    const { rows: [projection] } = await this.#pool.query<{
      snapshot_id: string; schema_version: string; cutoff: Date; observation_ids: string[];
    }>("SELECT * FROM efra_ingest.read_rating_projection($1, $2)", [snapshotId, qbPassingProjection]);
    if (!projection) return null;
    const snapshot = await new PostgresApprovedSnapshotReader(this.#pool).readSnapshot(snapshotId);
    if (!snapshot) throw new Error("Released projection is missing its frozen snapshot");
    const snapshotSha256 = createHash("sha256").update(JSON.stringify(snapshot, (_key, value: unknown) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left === right ? 0 : 1))
        : value,
    )).digest("hex");
    return {
      label: "SIMULATION", rankingEligible: false, snapshotId: projection.snapshot_id, projectionVersion: qbPassingProjection,
      schemaVersion: projection.schema_version, asOf: projection.cutoff.toISOString(), observationIds: projection.observation_ids,
      engineCommit, configurationSha256, snapshotSha256,
    };
  }

  async #call<T extends string>(sql: string, args: readonly unknown[]): Promise<T> {
    const { rows: [row] } = await this.#pool.query<{ result: T }>(sql, [...args]);
    if (!row) throw new Error("Expected database operation result");
    return row.result;
  }
}
