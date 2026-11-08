import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { describePositionModel, PostgresApprovedSnapshotReader, PostgresImportIdentityResolver, PostgresImportStageStore } from "../src/index.ts";
import type { ImportCandidate, ImportManifest, ImportPlan, Observation, QbGame } from "../src/index.ts";
import { game, observed, season, source } from "./simulation-fixtures.ts";

const hostedUrl = process.env["EFRA_NEON_TEST_DATABASE_URL"];
const connectionString = hostedUrl ?? process.env["EFRA_TEST_DATABASE_URL"];
if (!connectionString) throw new Error("An isolated EFRA integration database is required");
const url = new URL(connectionString);
const branchId = process.env["EFRA_NEON_TEST_BRANCH_ID"];
const primaryBranchId = process.env["EFRA_NEON_PRIMARY_BRANCH_ID"];
if (hostedUrl) {
  if (url.protocol !== "postgresql:" || !url.hostname.endsWith(".neon.tech") || url.hostname.includes("-pooler")
    || url.pathname !== "/efra" || !branchId?.startsWith("br-") || !primaryBranchId?.startsWith("br-")
    || branchId === primaryBranchId || url.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("Hosted integration requires the verified direct endpoint of an isolated Neon test branch");
  }
} else if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.pathname !== "/efra_stage_test"
  || url.username !== "efra_test" || !url.port || url.search || url.hash) {
  throw new Error("Local integration requires a fresh loopback efra_stage_test database");
}

const connection = { connectionString, connectionTimeoutMillis: 15_000, max: 6 };
const admin = new Pool(connection);
const importer = new Pool({ ...connection, options: "-c role=efra_ingest_importer" });
const reviewer = new Pool({ ...connection, options: "-c role=efra_ingest_reviewer" });
const reader = new Pool({ ...connection, options: "-c role=efra_ingest_reader" });
const resolver = new PostgresImportIdentityResolver(importer);
const writer = new PostgresImportStageStore(importer);
const reviews = new PostgresImportStageStore(reviewer);
const snapshots = new PostgresApprovedSnapshotReader(reader);

before(async () => {
  const { rows: [target] } = await admin.query<{ branch: string | null; database: string; role: string; staging_absent: boolean; efra_present: boolean }>(
    `SELECT current_database() AS database, current_user AS role, current_setting('neon.branch_id', true) AS branch,
      to_regnamespace('efra_ingest') IS NULL AS staging_absent, to_regnamespace('efra') IS NOT NULL AS efra_present`,
  );
  assert.ok(target?.staging_absent, "Integration migrations require a fresh staging schema");
  if (hostedUrl) {
    assert.equal(target.branch, branchId);
    assert.equal(target.database, "efra");
    assert.equal(target.efra_present, true);
    const { rows: [empty] } = await admin.query<{ safe: boolean }>(
      `SELECT NOT EXISTS (SELECT FROM efra.players) AND NOT EXISTS (SELECT FROM efra.games)
        AND NOT EXISTS (SELECT FROM efra.player_appearances) AND NOT EXISTS (SELECT FROM efra.stat_observations) AS safe`,
    );
    assert.equal(empty?.safe, true, "Neon fixtures require empty player, game and observation tables");
  } else {
    assert.equal(target.database, "efra_stage_test");
    assert.equal(target.role, "efra_test");
    assert.equal(target.efra_present, false);
  }
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    if (!hostedUrl) await client.query(await readFile(new URL("fixtures/efra-schema.sql", import.meta.url), "utf8"));
    for (const file of ["001_ingest_staging.sql", "002_ingest_review_snapshots.sql", "003_ingest_identity_and_roles.sql"]) {
      await client.query(await readFile(new URL(`../db/migrations/${file}`, import.meta.url), "utf8"));
    }
    await client.query("GRANT efra_ingest_importer, efra_ingest_reviewer, efra_ingest_reader TO CURRENT_USER WITH SET TRUE");
    await client.query(await readFile(new URL("fixtures/efra-identity-simulation.sql", import.meta.url), "utf8"));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

after(async () => { await Promise.all([importer.end(), reviewer.end(), reader.end(), admin.end()]); });

const uuid = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;

function qb(revision: string, sourceRecordId = "sim-record", changes: Partial<QbGame> = {}): ImportCandidate {
  const original = { ...game, ...changes };
  const quality = { ...source, revisionId: revision };
  function retag<T extends Readonly<Record<string, Observation>>>(values: T): T {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [
      key, "source" in value ? { ...value, source: quality } : value,
    ])) as T;
  }
  return { sourceRecordId, game: {
    ...original, usage: { status: "PLAYED", source: quality },
    stats: { passing: retag(original.stats.passing), rushing: retag(original.stats.rushing), situation: retag(original.stats.situation) },
  } };
}

function manifest(revision: string, changes: Partial<ImportManifest> = {}): ImportManifest {
  return {
    sourceId: source.sourceId, sourceRevision: revision, origin: "SYNTHETIC",
    competitionId: season.season.competitionId, seasonId: season.season.id, mappingVersion: "sim-uuid-map-v1",
    schemaVersion: season.snapshot.schemaVersion, payloadSha256: "a".repeat(64), retrievedAt: season.snapshot.availableAt, ...changes,
  };
}

function resolve(input: ImportManifest, candidates: readonly ImportCandidate[]): Promise<ImportPlan> {
  return resolver.plan(input, { ...input, permission: "SYNTHETIC_FIXTURE" }, candidates);
}

async function staged(revision: string) {
  const { rows } = await reviewer.query<{ id: string; position: string; teamId: string; playerId: string; game_id: string }>(
    `SELECT g.id::text, g.position, g.game_id, g.player_id AS "playerId", g.game->>'teamId' AS "teamId"
     FROM efra_ingest.staged_game AS g JOIN efra_ingest.import_batch AS b ON b.id = g.batch_id
     JOIN efra_ingest.source_revision AS r ON r.id = b.revision_id WHERE r.source_revision = $1
     ORDER BY g.game_id, g.position`, [revision],
  );
  return rows;
}

test("SIMULATION | full restricted-role import, quarantine, review, snapshot and read; transfers and multiple positions", async () => {
  const revision = "sim-neon-e2e";
  const first = qb(revision);
  const transfer = qb(revision, "sim-transfer", {
    gameId: "sim-game-transfer", teamId: "sim-team-c", opponentId: "sim-team-b", playedAt: "2025-01-12T00:00:00.000Z",
  });
  const receiving: ImportCandidate = { sourceRecordId: "sim-wr", game: {
    ...first.game, position: "WR", stats: {
      definitionVersion: describePositionModel("WR").definitionVersion,
      observations: Object.fromEntries(Object.entries({
        cleanTargets: observed(3), cleanReceivingYards: observed(32), receptions: observed(2), receivingFumbles: observed(0),
      }).map(([key, value]) => [key, "source" in value ? { ...value, source: { ...source, revisionId: revision } } : value])),
    },
  } };
  // Use a separate revision for bad core evidence so valid and invalid rows do not share a canonical game-position key.
  const badOnly = await resolve(manifest("sim-neon-bad-quality"), [qb("sim-neon-bad-quality", "sim-bad-values", { stats: {
    ...game.stats, passing: { ...game.stats.passing, completions: observed(15) },
  } })]);
  assert.equal(badOnly.status, "DRY_RUN");
  assert.equal(await writer.stage(badOnly), "STAGED");
  const wrongTeam = qb(revision, "sim-wrong-team", { teamId: "sim-team-b", opponentId: "sim-team-a" });
  const wrongSeason = qb(revision, "sim-wrong-season", { gameId: "sim-game-wrong-season" });
  const input = manifest(revision);
  const planned = await resolve(input, [first, transfer, receiving, wrongTeam, wrongSeason]);
  assert.equal(planned.status, "DRY_RUN");
  assert.equal(planned.manifest.competitionId, uuid("02"));
  assert.equal(planned.manifest.seasonId, uuid("03"));
  assert.deepEqual(planned.rows.filter(({ status }) => status === "QUARANTINE").map(({ issues }) => issues),
    [["UNRESOLVED_OR_INCONSISTENT_IDENTITY"], ["UNRESOLVED_OR_INCONSISTENT_IDENTITY"]]);
  const writes = await Promise.all(Array.from({ length: 4 }, () => writer.stage(planned)));
  assert.deepEqual(writes.sort(), ["ALREADY_STAGED", "ALREADY_STAGED", "ALREADY_STAGED", "STAGED"]);
  const { rows: [quarantined] } = await reviewer.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM efra_ingest.quarantine WHERE 'INVALID_EVIDENCE' = ANY(issues)",
  );
  assert.equal(quarantined?.n, 1);
  const games = await staged(revision);
  assert.deepEqual(games.map(({ game_id, position, teamId, playerId }) => [game_id, position, teamId, playerId]), [
    [uuid("08"), "QB", uuid("04"), uuid("07")], [uuid("08"), "WR", uuid("04"), uuid("07")],
    [uuid("09"), "QB", uuid("06"), uuid("07")],
  ]);
  const stageIds = games.map(({ id }) => id);
  const request = { snapshotId: "sim-neon-approved", competitionId: uuid("02"), seasonId: uuid("03"),
    schemaVersion: input.schemaVersion, asOf: new Date(Date.now() + 60_000).toISOString(), stageIds };
  await assert.rejects(reviews.createSnapshot(request), { code: "23514" });
  assert.equal(await snapshots.readSnapshot(request.snapshotId), null);
  for (const stageId of stageIds) {
    assert.equal(await reviews.recordReview({ stageId, reviewerId: "sim-reviewer", decision: "APPROVED", reason: "synthetic verification" }), "REVIEWED");
  }
  assert.equal(await reviews.createSnapshot(request), "CREATED");
  assert.equal(await reviews.createSnapshot({ ...request, stageIds: [...stageIds].reverse() }), "ALREADY_CREATED");
  const approved = await snapshots.readSnapshot(request.snapshotId);
  assert.equal(approved?.label, "SIMULATION");
  assert.deepEqual(approved?.games.map(({ stageId }) => stageId), stageIds);
  assert.deepEqual(await snapshots.readSnapshot(request.snapshotId), approved);
  await assert.rejects(reader.query("SELECT * FROM efra_ingest.staged_game"), { code: "42501" });
  await assert.rejects(reader.query("SELECT * FROM efra_ingest.quarantine"), { code: "42501" });
  await assert.rejects(reader.query("INSERT INTO efra_ingest.snapshot (id) VALUES ('forbidden')"), { code: "42501" });
  await assert.rejects(importer.query("SELECT * FROM efra.players"), { code: "42501" });
  await assert.rejects(importer.query("SELECT * FROM efra_ingest.review"), { code: "42501" });
  await assert.rejects(reviewer.query("INSERT INTO efra_ingest.quarantine (batch_id) VALUES (1)"), { code: "42501" });
});

test("SIMULATION | alias collisions, competing revisions and rollback remain deterministic on the full schema", async () => {
  const revision = "sim-neon-conflict";
  const input = manifest(revision);
  const first = qb(revision);
  const alternative = qb(revision, "sim-alias-row", { gameId: "sim-game-alternate-alias" });
  const collision = await resolve(input, [first, alternative]);
  assert.equal(collision.status, "DRY_RUN");
  assert.deepEqual(collision.rows.map(({ issues }) => issues), [["DUPLICATE_GAME_POSITION"], ["DUPLICATE_GAME_POSITION"]]);
  const a = await resolve(input, [first]);
  const b = await resolve({ ...input, payloadSha256: "b".repeat(64) }, [first]);
  assert.equal(a.status, "DRY_RUN");
  assert.equal(b.status, "DRY_RUN");
  await assert.rejects(writer.stage({
    ...a, rows: [...a.rows, { sourceRecordId: "sim-invalid", status: "QUARANTINE", issues: [] }],
  }), { code: "23514" });
  assert.deepEqual(await staged(revision), []);
  const results = await Promise.all([writer.stage(a), writer.stage(b)]);
  assert.deepEqual(results.sort(), ["REVISION_CONFLICT", "STAGED"]);
  assert.equal((await staged(revision)).length, 1);

  await assert.rejects(importer.query(
    `INSERT INTO efra_ingest.quarantine (batch_id, decision_ordinal, source_record_id, issues)
     SELECT id, 99, 'sim-forged', ARRAY['INVALID_EVIDENCE'] FROM efra_ingest.import_batch WHERE batch_key = ANY($1)`,
    [[a.batchKey, b.batchKey]],
  ), { code: "23514" });
  assert.deepEqual(await resolve({ ...input, seasonId: "sim-unknown-season" }, [first]), {
    status: "BLOCKED", reason: "UNRESOLVED_IMPORT_SCOPE",
  });
});
