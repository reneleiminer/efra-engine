import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { requirePilot, sha256Bytes } from "../pilot/signatures.ts";

/** Deliberately restricted to the isolated PostgreSQL integration-test database. */
export async function applyEfaPublicationTestMigration(db: Pick<Pool, "connect">) {
  const sql = await readFile(new URL("../../db/statistical/001_efa_publication.sql", import.meta.url));
  const sha256 = sha256Bytes(sql);
  const client = await db.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    const { rows: [identity] } = await client.query<{ safe: boolean }>(`
      SELECT current_database() = 'efra_stage_test' AND session_user = 'efra_test'
        AND nullif(current_setting('neon.branch_id', true), '') IS NULL AND to_regnamespace('efra') IS NULL
        AND to_regnamespace('efra_ingest') IS NULL AND to_regnamespace('efra_validation') IS NULL AS safe`);
    requirePilot(identity?.safe, "EFA migration requires a dedicated isolated statistical test database");
    await client.query("SELECT pg_advisory_xact_lock(716184, 18)");
    const { rows: [schema] } = await client.query<{ installed: boolean; journal: boolean }>(
      "SELECT to_regnamespace('efra_statistical') IS NOT NULL AS installed, to_regclass('efra_statistical.migration') IS NOT NULL AS journal",
    );
    requirePilot(schema && schema.installed === schema.journal, "Unjournaled EFA schema");
    if (schema.installed) {
      const { rows } = await client.query<{ version: number; sha256: string }>("SELECT version,sha256 FROM efra_statistical.migration");
      requirePilot(rows.length === 1 && rows[0]?.version === 1 && rows[0].sha256 === sha256, "EFA migration integrity mismatch");
    } else {
      await client.query(sql.toString("utf8"));
      await client.query(`CREATE TABLE efra_statistical.migration (version integer PRIMARY KEY, sha256 text NOT NULL);
        CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_statistical.migration
          FOR EACH STATEMENT EXECUTE FUNCTION efra_statistical.reject_mutation();`);
      await client.query("INSERT INTO efra_statistical.migration VALUES (1,$1)", [sha256]);
    }
    await client.query("COMMIT");
    return !schema.installed;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}
