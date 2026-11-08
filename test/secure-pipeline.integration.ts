import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import {
  applyIngestTestMigrations, describePositionModel, PostgresImportIdentityResolver, PostgresImportStageStore,
  PostgresSecurePipeline, qbPassingProjection,
} from "../src/index.ts";
import type { ImportCandidate, ImportManifest, ImportPlan, MigrationFile, MigrationTestTarget, Observation, SnapshotRequest } from "../src/index.ts";
import { game, season, source } from "./simulation-fixtures.ts";

const hosted = process.env["EFRA_NEON_TEST_DATABASE_URL"];
const connectionString = hosted ?? process.env["EFRA_TEST_DATABASE_URL"];
if (!connectionString) throw new Error("An isolated EFRA integration database is required");
const url = new URL(connectionString);
const branchId = process.env["EFRA_NEON_TEST_BRANCH_ID"];
const primaryBranchId = process.env["EFRA_NEON_PRIMARY_BRANCH_ID"];
const target: MigrationTestTarget = hosted
  ? { kind: "NEON_TEST", branchId: branchId ?? "", primaryBranchId: primaryBranchId ?? "" } : { kind: "LOCAL_TEST" };
if (hosted) {
  if (url.protocol !== "postgresql:" || !url.hostname.endsWith(".neon.tech") || url.hostname.includes("-pooler")
    || url.pathname !== "/efra" || !branchId || !primaryBranchId || branchId === primaryBranchId
    || url.searchParams.get("sslmode") !== "verify-full") throw new Error("Expected the isolated direct Neon endpoint");
} else if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.pathname !== "/efra_stage_test"
  || url.username !== "efra_test" || !url.port || url.search || url.hash) throw new Error("Expected the local test database");

const admin = new Pool({ connectionString, connectionTimeoutMillis: 15_000 });
const actors = {
  importer: { capability: "IMPORTER", group: "importer", active: true },
  reviewer: { capability: "REVIEWER", group: "reviewer", active: true },
  reviewer2: { capability: "REVIEWER", group: "reviewer", active: true },
  publisher: { capability: "PUBLISHER", group: "publisher", active: true },
  projector: { capability: "PROJECTOR", group: "projector", active: true },
  reader: { capability: "READER", group: "reader", active: true },
  disabled: { capability: "IMPORTER", group: "importer", active: false },
} as const;
type Actor = keyof typeof actors;
const pools = new Map<Actor, Pool>();
const actorPool = (actor: Actor) => {
  const pool = pools.get(actor);
  assert.ok(pool);
  return pool;
};
const service = (actor: Actor) => new PostgresSecurePipeline(actorPool(actor));
let migrations: readonly MigrationFile[] = [];

before(async () => {
  const { rows: [server] } = await admin.query<{ branch: string | null; database: string; login: string; fresh: boolean }>(
    `SELECT nullif(current_setting('neon.branch_id', true),'') AS branch,
      current_database() AS database, session_user AS login, to_regnamespace('efra_ingest') IS NULL AS fresh`,
  );
  assert.ok(server?.fresh);
  if (hosted) {
    assert.equal(server.branch, branchId);
    assert.equal(server.database, "efra");
    const { rows: [empty] } = await admin.query<{ safe: boolean }>(
      "SELECT NOT EXISTS (SELECT FROM efra.players) AND NOT EXISTS (SELECT FROM efra.stat_observations) AS safe",
    );
    assert.equal(empty?.safe, true);
  } else {
    assert.equal(server.branch, null);
    assert.equal(server.database, "efra_stage_test");
    assert.equal(server.login, "efra_test");
    await admin.query(await readFile(new URL("fixtures/efra-schema.sql", import.meta.url), "utf8"));
  }
  const dir = new URL("../db/migrations/", import.meta.url);
  const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  migrations = await Promise.all(names.map(async (name) => ({ name, sql: await readFile(new URL(name, dir), "utf8") })));
  assert.deepEqual(await applyIngestTestMigrations(admin, target, migrations), names);

  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(await readFile(new URL("fixtures/efra-identity-simulation.sql", import.meta.url), "utf8"));
    for (const key of Object.keys(actors) as Actor[]) {
      const { capability, group, active } = actors[key];
      const login = `efra_p10_${key}`;
      const password = randomBytes(32).toString("hex");
      // Identifiers are fixed fixture names; passwords are generated hexadecimal strings.
      await client.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
      await client.query(`GRANT efra_ingest_${group} TO ${login} WITH INHERIT TRUE, SET FALSE`);
      await client.query(`INSERT INTO efra_ingest.authenticated_principal (login_role, login_oid, subject_id, capability, active)
        SELECT rolname, oid, $2, $3, $4 FROM pg_catalog.pg_roles WHERE rolname = $1`,
        [login, `sim-subject-${key}`, capability, active]);
      const account = new URL(url);
      account.username = login;
      account.password = password;
      pools.set(key, new Pool({ connectionString: account.toString(), max: 4, connectionTimeoutMillis: 15_000 }));
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});
after(async () => { await Promise.all([admin.end(), ...[...pools.values()].map((pool) => pool.end())]); });

const uuid = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;
const writer = () => new PostgresImportStageStore(actorPool("importer"));

function fixture(revision: string, yards = 80, transfer = false): ImportCandidate {
  const evidenceSource = { ...source, revisionId: revision };
  const obs = (value: number): Observation => ({ status: value ? "OBSERVED" : "VERIFIED_ZERO", value, source: evidenceSource });
  return {
    sourceRecordId: "sim-a-qb",
    game: {
      ...game, usage: { status: "PLAYED", source: evidenceSource },
      ...(transfer ? { gameId: "sim-game-transfer", teamId: "sim-team-c", opponentId: "sim-team-b", playedAt: "2025-01-12T00:00:00.000Z" } : {}),
      stats: { passing: { attempts: obs(10), completions: obs(6), yards: obs(yards), touchdowns: obs(2), interceptions: obs(0) },
        rushing: { attempts: obs(0), yards: obs(0), touchdowns: obs(0), turnovers: obs(0) },
        situation: { opportunities: obs(0), actualPointsAdded: obs(0), expectedPointsAdded: obs(0) } },
    },
  };
}

function manifest(revision: string, predecessor?: string): ImportManifest {
  return {
    sourceId: source.sourceId, sourceRevision: revision, origin: "SYNTHETIC", competitionId: season.season.competitionId,
    seasonId: season.season.id, mappingVersion: "sim-uuid-map-v1", schemaVersion: season.snapshot.schemaVersion,
    payloadSha256: (predecessor ? "b" : "a").repeat(64), retrievedAt: season.snapshot.availableAt,
    ...(predecessor && { supersedesSourceRevision: predecessor }),
  };
}

async function resolve(input: ImportManifest, candidates: readonly ImportCandidate[], actor: Actor = "importer") {
  const plan = await new PostgresImportIdentityResolver(actorPool(actor)).plan(input, { ...input, permission: "SYNTHETIC_FIXTURE" }, candidates);
  assert.equal(plan.status, "DRY_RUN");
  return plan;
}

async function stageIds(revision: string): Promise<string[]> {
  const { rows } = await actorPool("reviewer").query<{ id: string }>(
    `SELECT g.id::text FROM efra_ingest.staged_game g JOIN efra_ingest.import_batch b ON b.id = g.batch_id
      JOIN efra_ingest.source_revision r ON r.id = b.revision_id WHERE r.source_revision = $1 ORDER BY g.id`, [revision],
  );
  return rows.map(({ id }) => id);
}

async function snapshot(snapshotId: string, stageIds: readonly string[]): Promise<SnapshotRequest> {
  await admin.query("SELECT pg_sleep(0.005)");
  const { rows: [clock] } = await admin.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  assert.ok(clock);
  return { snapshotId, stageIds, competitionId: uuid("02"), seasonId: uuid("03"),
    schemaVersion: season.snapshot.schemaVersion, asOf: clock.now.toISOString() };
}

const reviewRequest = (stageId: string) => ({ stageId, decision: "APPROVED", reason: "synthetic verification" } as const);

test("SIMULATION | migration journal verifies checksums, serializes replays and rolls back failed versions", async () => {
  assert.deepEqual(await Promise.all([applyIngestTestMigrations(admin, target, migrations), applyIngestTestMigrations(admin, target, migrations)]), [[], []]);
  const [first, ...rest] = migrations;
  assert.ok(first);
  await assert.rejects(applyIngestTestMigrations(admin, target, [{ ...first, sql: first.sql + "\n-- tampered" }, ...rest]), /integrity mismatch/);
  await assert.rejects(applyIngestTestMigrations(admin, target, migrations.slice(0, -1)), /integrity mismatch/);
  await assert.rejects(applyIngestTestMigrations(admin, target, [...migrations, {
    name: "006_failed.sql", sql: "CREATE TABLE efra_ingest.failed_probe (id int); SELECT 1 / 0;",
  }]), { code: "22012" });
  const { rows: [state] } = await admin.query<{ count: number; absent: boolean }>(
    "SELECT count(*)::int AS count, to_regclass('efra_ingest.failed_probe') IS NULL AS absent FROM efra_migrations.journal",
  );
  assert.deepEqual(state, { count: migrations.length, absent: true });
  await assert.rejects(admin.query("DELETE FROM efra_migrations.journal WHERE version = 1"), { code: "55000" });
});

test("SIMULATION | login attribution, separate publication and reproducible canonical projection", async () => {
  const revision = "sim-phase10-original";
  const candidate = fixture(revision);
  const input = manifest(revision);
  await assert.rejects(resolve(input, [candidate], "disabled"), { code: "42501" });
  const planned = await resolve(input, [candidate, { ...candidate, sourceRecordId: "sim-missing-alias",
    game: { ...candidate.game, playerId: "sim-nobody" } }]);
  assert.equal(await writer().stage(planned), "STAGED");
  assert.equal(await writer().stage(planned), "ALREADY_STAGED");
  const [id] = await stageIds(revision);
  assert.ok(id);
  const forged = { ...reviewRequest(id), reviewerId: "sim-forged-identity" };
  await assert.rejects(service("importer").review(forged), { code: "42501" });
  await assert.rejects(actorPool("reviewer").query("UPDATE efra_ingest.authenticated_principal SET subject_id = 'forged'"), { code: "42501" });
  await assert.rejects(actorPool("reviewer").query("SET SESSION AUTHORIZATION efra_p10_reviewer2"), { code: "42501" });
  const request = await snapshot("sim-p10-original", [id]);
  await assert.rejects(service("publisher").release(request), { code: "23514" });
  assert.equal(await service("reviewer").review(forged), "REVIEWED");
  assert.equal(await service("reviewer").review(reviewRequest(id)), "ALREADY_REVIEWED");
  assert.equal(await service("reviewer2").review(reviewRequest(id)), "REVIEW_CONFLICT");
  const { rows: [identity] } = await actorPool("reviewer").query("SELECT reviewer_id, reviewer_login FROM efra_ingest.review WHERE stage_id = $1", [id]);
  assert.deepEqual(identity, { reviewer_id: "sim-subject-reviewer", reviewer_login: "efra_p10_reviewer" });
  const released = await snapshot(request.snapshotId, [id]);
  await assert.rejects(service("reviewer").release(released), { code: "42501" });
  assert.equal(await service("publisher").release(released), "CREATED");
  assert.equal(await service("publisher").release(released), "ALREADY_CREATED");
  await assert.rejects(service("publisher").project(released.snapshotId, qbPassingProjection), { code: "42501" });
  assert.deepEqual((await Promise.all([service("projector").project(released.snapshotId, qbPassingProjection),
    service("projector").project(released.snapshotId, qbPassingProjection)])).sort(), ["ALREADY_PROJECTED", "PROJECTED"]);
  const replay = await service("reader").ratingReplayReference(released.snapshotId, "a".repeat(40), "b".repeat(64));
  assert.ok(replay);
  assert.equal(replay.label, "SIMULATION");
  assert.equal(replay.rankingEligible, false);
  assert.equal(replay.observationIds.length, 5);
  assert.deepEqual(await service("reader").ratingReplayReference(released.snapshotId, "a".repeat(40), "b".repeat(64)), replay);
  await assert.rejects(actorPool("reader").query("SELECT * FROM efra.stat_observations"), { code: "42501" });
  await assert.rejects(admin.query("UPDATE efra.stat_observations SET value = 999 WHERE id = $1", [replay.observationIds[0]]), { code: "55000" });
  await assert.rejects(admin.query(`INSERT INTO efra.stat_observations (
    import_batch_id, player_id, game_id, season_id, team_id, position_code, metric_code, value, exposure_unit, data_status)
    SELECT import_batch_id, player_id, game_id, season_id, team_id, position_code, metric_code, value, exposure_unit, data_status
    FROM efra.stat_observations WHERE id = $1`, [replay.observationIds[0]]), { code: "42501" });
});

test("SIMULATION | corrected observations supersede explicitly and overlapping snapshots reuse the same UUIDs", async () => {
  const original = await service("reader").ratingReplayReference("sim-p10-original", "a".repeat(40), "b".repeat(64));
  assert.ok(original);
  const predecessor = "sim-phase10-original";
  const revision = "sim-phase10-corrected";
  assert.equal(await writer().stage(await resolve(manifest(revision, predecessor), [fixture(revision, 91)])), "STAGED");
  const [id] = await stageIds(revision);
  assert.ok(id);
  assert.equal(await service("reviewer").review(reviewRequest(id)), "REVIEWED");
  const one = await snapshot("sim-p10-corrected", [id]);
  const two = { ...one, snapshotId: "sim-p10-overlap" };
  assert.equal(await service("publisher").release(one), "CREATED");
  assert.equal(await service("publisher").release(two), "CREATED");
  assert.deepEqual(await Promise.all([service("projector").project(one.snapshotId, qbPassingProjection),
    service("projector").project(two.snapshotId, qbPassingProjection)]), ["PROJECTED", "PROJECTED"]);
  const corrected = await service("reader").ratingReplayReference(one.snapshotId, "a".repeat(40), "b".repeat(64));
  const overlap = await service("reader").ratingReplayReference(two.snapshotId, "a".repeat(40), "b".repeat(64));
  assert.ok(corrected && overlap);
  assert.deepEqual(corrected.observationIds, overlap.observationIds);
  const { rows: [counts] } = await admin.query<{ total: number; successors: number; yards: number }>(
    `SELECT count(*)::int total, count(*) FILTER (WHERE supersedes_id IS NOT NULL)::int successors,
     max(value) FILTER (WHERE metric_code = 'passing_yards')::int yards FROM efra.stat_observations`,
  );
  assert.deepEqual(counts, { total: 10, successors: 5, yards: 91 });
  assert.deepEqual(await service("reader").ratingReplayReference(original.snapshotId, "a".repeat(40), "b".repeat(64)), original);
});

test("SIMULATION | UUID spoofing and an unsupported later row fail without partial canonical writes", async () => {
  const revision = "sim-phase10-mixed";
  const transfer = fixture(revision, 80, true);
  const first = fixture(revision);
  const sample = (value: number): Observation => ({
    status: value ? "OBSERVED" : "VERIFIED_ZERO", value, source: { ...source, revisionId: revision },
  });
  const wr: ImportCandidate = { sourceRecordId: "sim-z-wr", game: { ...first.game, position: "WR", stats: {
    definitionVersion: describePositionModel("WR").definitionVersion,
    observations: { cleanTargets: sample(2), cleanReceivingYards: sample(20), receptions: sample(2), receivingFumbles: sample(0) },
  } } };
  const planned = await resolve(manifest(revision), [transfer, wr]);
  const [row, ...rest] = planned.rows;
  assert.ok(row?.status === "STAGE");
  const spoof: Extract<ImportPlan, { status: "DRY_RUN" }> = { ...planned, rows: [
    { ...row, candidate: { ...row.candidate, game: { ...row.candidate.game, teamId: uuid("04") } } }, ...rest,
  ] };
  await assert.rejects(writer().stage(spoof), { code: "23514" });
  assert.deepEqual(await stageIds(revision), []);
  assert.equal(await writer().stage(planned), "STAGED");
  const ids = await stageIds(revision);
  for (const id of ids) assert.equal(await service("reviewer").review(reviewRequest(id)), "REVIEWED");
  const released = await snapshot("sim-p10-unsupported", ids);
  assert.equal(await service("publisher").release(released), "CREATED");
  await assert.rejects(service("projector").project(released.snapshotId, qbPassingProjection), { code: "23514" });
  assert.equal(await service("reader").ratingReplayReference(released.snapshotId, "a".repeat(40), "b".repeat(64)), null);
  const { rows: [count] } = await admin.query<{ total: number }>("SELECT count(*)::int AS total FROM efra.stat_observations");
  assert.equal(count?.total, 10);
});
