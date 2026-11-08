import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { planImport, PostgresImportStageStore } from "../src/index.ts";
import type { ImportManifest, Observation, SnapshotRequest } from "../src/index.ts";
import { game, missing, observed, season, source } from "./simulation-fixtures.ts";

const connectionString = process.env["EFRA_TEST_DATABASE_URL"];
if (!connectionString) throw new Error("EFRA_TEST_DATABASE_URL must point to a fresh isolated test database");
const url = new URL(connectionString);
if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.pathname !== "/efra_stage_test"
  || url.username !== "efra_test" || !url.port || url.search || url.hash) {
  throw new Error("Integration migrations require the local efra_stage_test container");
}
const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5_000 });
const store = new PostgresImportStageStore(pool);

before(async () => {
  const { rows: [database] } = await pool.query<{ isolated: boolean }>(
    `SELECT current_database() = 'efra_stage_test' AND current_user = 'efra_test'
      AND to_regnamespace('efra_ingest') IS NULL AND to_regnamespace('efra') IS NULL AS isolated`,
  );
  assert.equal(database?.isolated, true, "Use a fresh isolated database for migrations");
  const directory = new URL("../db/migrations/", import.meta.url);
  const files = (await readdir(directory)).filter((file) => /^\d{3}_.+\.sql$/.test(file)).sort();
  assert.equal(files.length, 2);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const file of files) await client.query(await readFile(new URL(file, directory), "utf8"));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});
after(async () => pool.end());

function candidate(revision: string, options: { gameId?: string; yards?: Observation; record?: string } = {}) {
  const revisionSource = { ...source, revisionId: revision };
  function retag<T extends Readonly<Record<string, Observation>>>(values: T): T {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [
      key, "source" in value ? { ...value, source: revisionSource } : value,
    ])) as T;
  }
  const yards = options.yards ?? game.stats.passing.yards;
  return {
    sourceRecordId: options.record ?? "sim-record",
    game: {
      ...game, gameId: options.gameId ?? game.gameId, usage: { ...game.usage, source: revisionSource },
      stats: { passing: retag({ ...game.stats.passing, yards }), rushing: retag(game.stats.rushing), situation: retag(game.stats.situation) },
    },
  };
}

function plan(revision: string, candidates = [candidate(revision)], overrides: Partial<ImportManifest> = {}) {
  const manifest = {
    sourceId: source.sourceId, sourceRevision: revision, origin: "SYNTHETIC",
    competitionId: season.season.competitionId, seasonId: season.season.id,
    mappingVersion: "sim-pg-map", schemaVersion: season.snapshot.schemaVersion,
    payloadSha256: "a".repeat(64), retrievedAt: season.snapshot.availableAt, ...overrides,
  } as const;
  const result = planImport(manifest, { ...manifest, permission: "SYNTHETIC_FIXTURE" }, candidates);
  assert.equal(result.status, "DRY_RUN");
  return result;
}

async function stageIds(revision: string) {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT g.id::text FROM efra_ingest.staged_game AS g
     JOIN efra_ingest.import_batch AS b ON b.id = g.batch_id
     JOIN efra_ingest.source_revision AS r ON r.id = b.revision_id
     WHERE r.source_revision = $1 ORDER BY g.game_id COLLATE "C"`, [revision],
  );
  return rows.map(({ id }) => id);
}

async function review(stageId: string) {
  return store.recordReview({ stageId, reviewerId: "sim-reviewer", decision: "APPROVED", reason: "synthetic fixture" });
}

function snapshot(snapshotId: string, stageIds: readonly string[], overrides: Partial<SnapshotRequest> = {}): SnapshotRequest {
  return {
    snapshotId, stageIds, competitionId: season.season.competitionId, seasonId: season.season.id,
    schemaVersion: season.snapshot.schemaVersion, asOf: new Date(Date.now() + 10_000).toISOString(), ...overrides,
  };
}

test("SIMULATION | concurrent PostgreSQL replays commit one batch and reject changed bytes or normalized rows", async () => {
  const revision = "sim-pg-concurrency";
  const draft = plan(revision);
  const writes = await Promise.all(Array.from({ length: 8 }, () => store.stage(draft)));
  assert.equal(writes.filter((value) => value === "STAGED").length, 1);
  assert.equal(writes.filter((value) => value === "ALREADY_STAGED").length, 7);
  assert.equal((await stageIds(revision)).length, 1);
  assert.equal(await store.stage(plan(revision, [candidate(revision)], {
    payloadSha256: "b".repeat(64), mappingVersion: "sim-other-map",
  })), "REVISION_CONFLICT");
  assert.equal(await store.stage(plan(revision, [candidate(revision, { yards: observed(100) })])), "REVISION_CONFLICT");
});

test("SIMULATION | competing checksums on a new revision have one winner", async () => {
  const revision = "sim-pg-conflict";
  const results = await Promise.all([
    store.stage(plan(revision)),
    store.stage(plan(revision, [candidate(revision)], { payloadSha256: "b".repeat(64) })),
  ]);
  assert.deepEqual(results.sort(), ["REVISION_CONFLICT", "STAGED"]);
  assert.equal((await stageIds(revision)).length, 1);
});

test("SIMULATION | quarantine keeps duplicate decisions separate and incomplete rows cannot be approved", async () => {
  const revision = "sim-pg-quarantine";
  const duplicate = candidate(revision);
  const incomplete = candidate(revision, { gameId: "sim-incomplete", record: "sim-incomplete", yards: missing });
  assert.equal(await store.stage(plan(revision, [duplicate, duplicate, incomplete])), "STAGED");
  const { rows } = await pool.query<{ issues: string[] }>(
    `SELECT q.issues FROM efra_ingest.quarantine AS q JOIN efra_ingest.import_batch AS b ON b.id = q.batch_id
     JOIN efra_ingest.source_revision AS r ON r.id = b.revision_id WHERE r.source_revision = $1
     ORDER BY q.decision_ordinal`, [revision],
  );
  assert.deepEqual(rows.map(({ issues }) => issues), Array.from({ length: 2 }, () => ["DUPLICATE_GAME_POSITION", "DUPLICATE_RECORD"]));
  const [id] = await stageIds(revision);
  assert.ok(id);
  await assert.rejects(review(id), { code: "23514" });
  assert.equal(await store.recordReview({ stageId: id, decision: "REJECTED", reviewerId: "sim-reviewer", reason: "core missing" }), "REVIEWED");
});

test("SIMULATION | a late database error rolls back revision, batch and staged rows and permits a clean retry", async () => {
  const revision = "sim-pg-rollback";
  const draft = plan(revision);
  await assert.rejects(store.stage({
    ...draft, rows: [...draft.rows, { sourceRecordId: "sim-invalid", status: "QUARANTINE", issues: [] }],
  }), { code: "23514" });
  const { rows: [count] } = await pool.query<{ revisions: number }>(
    "SELECT count(*)::int AS revisions FROM efra_ingest.source_revision WHERE source_revision = $1", [revision],
  );
  assert.equal(count?.revisions, 0);
  assert.deepEqual(await stageIds(revision), []);
  assert.equal(await store.stage(draft), "STAGED");
});

test("SIMULATION | storage rejects real manifests and real-tagged evidence in a staged payload", async () => {
  const revision = "sim-pg-real-gate";
  const draft = plan(revision);
  await assert.rejects(store.stage({ ...draft, manifest: { ...draft.manifest, origin: "REAL" } }), /synthetic dry runs only/);
  const [row] = draft.rows;
  assert.ok(row && row.status === "STAGE");
  const qb = row.candidate.game;
  assert.equal(qb.position, "QB");
  const altered = { ...qb, stats: { ...qb.stats, passing: {
    ...qb.stats.passing, yards: { status: "OBSERVED", value: 50, source: { ...source, origin: "REAL", officiality: "OFFICIAL_SOURCE" } },
  } } } as const;
  await assert.rejects(store.stage({ ...draft, rows: [{ ...row, candidate: { ...row.candidate, game: altered } }] }), { code: "23514" });
  assert.deepEqual(await stageIds(revision), []);
});

test("SIMULATION | corrected source data produces a new reviewed snapshot and preserves prior provenance", async () => {
  const firstRevision = "sim-pg-original";
  const nextRevision = "sim-pg-correction";
  assert.equal(await store.stage(plan(firstRevision, [candidate(firstRevision), candidate(firstRevision, {
    gameId: "sim-game-z", record: "sim-z",
  })])), "STAGED");
  const [first, second] = await stageIds(firstRevision);
  assert.ok(first && second);
  assert.deepEqual((await Promise.all([review(first), review(first)])).sort(), ["ALREADY_REVIEWED", "REVIEWED"]);
  assert.equal(await review(second), "REVIEWED");
  assert.equal(await store.recordReview({ stageId: first, decision: "REJECTED", reviewerId: "sim-reviewer", reason: "changed" }), "REVIEW_CONFLICT");

  const original = snapshot("sim-snapshot-original", [second, first]);
  const parallel = await Promise.all([store.createSnapshot(original), store.createSnapshot({ ...original, stageIds: [first, second] })]);
  assert.deepEqual(parallel.sort(), ["ALREADY_CREATED", "CREATED"]);
  const originalRead = await store.readSnapshot(original.snapshotId);
  assert.ok(originalRead);
  assert.equal(originalRead.label, "SIMULATION");
  assert.deepEqual(originalRead.games.map(({ stageId }) => stageId), [first, second]);
  assert.equal(originalRead.games[0]?.sourceRevision, firstRevision);

  assert.equal(await store.stage(plan(nextRevision, [candidate(nextRevision, { yards: observed(90) })], {
    payloadSha256: "c".repeat(64), supersedesSourceRevision: firstRevision,
  })), "STAGED");
  assert.equal(await store.stage(plan(nextRevision, [candidate(nextRevision, { yards: observed(90) })], {
    payloadSha256: "c".repeat(64),
  })), "REVISION_CONFLICT");
  const [corrected] = await stageIds(nextRevision);
  assert.ok(corrected);
  assert.equal(await review(corrected), "REVIEWED");
  assert.equal(await store.createSnapshot({ ...original, stageIds: [corrected, second] }), "SNAPSHOT_CONFLICT");
  const newVersion = snapshot("sim-snapshot-corrected", [corrected, second]);
  assert.equal(await store.createSnapshot(newVersion), "CREATED");
  const correctedRead = await store.readSnapshot(newVersion.snapshotId);
  assert.ok(correctedRead);
  assert.equal(correctedRead.games[0]?.supersedesSourceRevision, firstRevision);
  const qb = correctedRead.games[0]?.game;
  assert.equal(qb?.position, "QB");
  assert.equal(qb.stats.passing.yards.status, "OBSERVED");
  assert.equal(qb.stats.passing.yards.value, 90);
  assert.deepEqual(await store.readSnapshot(original.snapshotId), originalRead);
  await assert.rejects(pool.query("UPDATE efra_ingest.staged_game SET source_record_id = 'changed' WHERE id = $1", [first]), { code: "55000" });
  await assert.rejects(store.stage(plan("sim-pg-no-predecessor", undefined, {
    supersedesSourceRevision: "sim-unknown-revision",
  })), { code: "23503" });
});

test("SIMULATION | snapshots reject invalid scope, unreviewed evidence, post-cutoff review and late members", async () => {
  const revision = "sim-pg-snapshot-guards";
  assert.equal(await store.stage(plan(revision)), "STAGED");
  const [id] = await stageIds(revision);
  assert.ok(id);
  const requested = snapshot("sim-snapshot-guards", [id]);
  await assert.rejects(store.createSnapshot(requested), { code: "23514" });
  assert.equal(await store.readSnapshot(requested.snapshotId), null);
  assert.equal(await review(id), "REVIEWED");
  await assert.rejects(store.createSnapshot({ ...requested, seasonId: "sim-wrong-season" }), { code: "23514" });
  await assert.rejects(store.createSnapshot({ ...requested, asOf: season.asOf }), { code: "23514" });
  await assert.rejects(store.createSnapshot({ ...requested, stageIds: [id, "9223372036854775807"] }), /Unknown staging row/);
  assert.equal(await store.readSnapshot(requested.snapshotId), null);
  assert.equal(await store.createSnapshot(requested), "CREATED");
  await assert.rejects(pool.query(
    `INSERT INTO efra_ingest.snapshot_game (snapshot_id, stage_id, game_id, player_id, position)
     SELECT $1, id, game_id, player_id, position FROM efra_ingest.staged_game WHERE id = $2`, [requested.snapshotId, id],
  ), { code: "23514" });
});
