import type { Pool } from "pg";
import type { ApprovedImportSnapshot } from "./postgres-stage-store.ts";

/** Read service for the database role that can access only the approved export view. */
export class PostgresApprovedSnapshotReader {
  readonly #pool: Pick<Pool, "query">;

  constructor(pool: Pick<Pool, "query">) {
    this.#pool = pool;
  }

  async readSnapshot(snapshotId: string): Promise<ApprovedImportSnapshot | null> {
    const { rows: [row] } = await this.#pool.query<Omit<ApprovedImportSnapshot, "label" | "origin" | "asOf"> & { asOf: Date }>(
      'SELECT * FROM efra_ingest.approved_snapshot_export WHERE "snapshotId" = $1', [snapshotId],
    );
    return row ? { ...row, asOf: row.asOf.toISOString(), origin: "SYNTHETIC", label: "SIMULATION" } : null;
  }
}
