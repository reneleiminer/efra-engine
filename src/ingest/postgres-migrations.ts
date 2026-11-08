import { createHash } from "node:crypto";
import type { Pool } from "pg";

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

export type MigrationTestTarget =
  | { readonly kind: "LOCAL_TEST" }
  | { readonly kind: "NEON_TEST"; readonly branchId: string; readonly primaryBranchId: string };

/** Applies a verified ordered prefix, and rejects any unjournaled pre-existing staging installation. */
export async function applyIngestTestMigrations(
  pool: Pick<Pool, "connect">, target: MigrationTestTarget, files: readonly MigrationFile[],
): Promise<readonly string[]> {
  if (target.kind === "NEON_TEST" && (!/^br-[a-z0-9-]+$/.test(target.branchId)
    || !/^br-[a-z0-9-]+$/.test(target.primaryBranchId) || target.branchId === target.primaryBranchId)) {
    throw new Error("A distinct Neon test branch is required");
  }
  if (!files.length || files.some(({ name, sql }, i) => !/^\d{3}_[a-z0-9_]+\.sql$/.test(name)
    || Number(name.slice(0, 3)) !== i + 1 || !sql.trim())) {
    throw new Error("Expected consecutive, ordered migration files");
  }
  const migrations = files.map((file) => ({ ...file, hash: createHash("sha256").update(file.sql).digest("hex") }));
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const { rows: [database] } = await client.query<{ name: string; login: string; branch: string | null }>(
      "SELECT current_database() AS name, session_user AS login, nullif(current_setting('neon.branch_id', true), '') AS branch",
    );
    if (!database || (target.kind === "LOCAL_TEST"
      ? database.name !== "efra_stage_test" || database.login !== "efra_test" || database.branch !== null
      : database.name !== "efra" || database.branch !== target.branchId)) {
      throw new Error("Migration target is not the expected isolated test database");
    }
    await client.query("SELECT pg_advisory_xact_lock(716184, 0)");
    const { rows: [state] } = await client.query<{ journal: boolean; staging: boolean }>(
      `SELECT to_regclass('efra_migrations.journal') IS NOT NULL AS journal,
         to_regnamespace('efra_ingest') IS NOT NULL AS staging`,
    );
    if (!state || state.staging !== state.journal) throw new Error("Staging and migration journal do not match");
    if (!state.journal) {
      await client.query(`CREATE SCHEMA efra_migrations;
        REVOKE ALL ON SCHEMA efra_migrations FROM PUBLIC;
        CREATE TABLE efra_migrations.journal (
          version integer PRIMARY KEY CHECK (version > 0),
          name text NOT NULL UNIQUE,
          sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
          applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          applied_by name NOT NULL DEFAULT session_user
        );
        CREATE FUNCTION efra_migrations.reject_change() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog AS $$
        BEGIN RAISE EXCEPTION 'Migration journal is append-only' USING ERRCODE = '55000'; END;
        $$;
        CREATE TRIGGER immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON efra_migrations.journal
          FOR EACH STATEMENT EXECUTE FUNCTION efra_migrations.reject_change();`);
    }
    const { rows } = await client.query<{ version: number; name: string; sha256: string }>(
      "SELECT version, name, sha256 FROM efra_migrations.journal ORDER BY version",
    );
    for (const [index, entry] of rows.entries()) {
      const expected = migrations[index];
      if (!expected || entry.version !== index + 1 || entry.name !== expected.name || entry.sha256 !== expected.hash) {
        throw new Error(`Migration integrity mismatch at version ${entry.version}`);
      }
    }
    const applied = [];
    for (const [index, migration] of migrations.entries()) {
      if (index < rows.length) continue;
      await client.query(migration.sql);
      await client.query("INSERT INTO efra_migrations.journal (version, name, sha256) VALUES ($1, $2, $3)",
        [index + 1, migration.name, migration.hash]);
      applied.push(migration.name);
    }
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}
