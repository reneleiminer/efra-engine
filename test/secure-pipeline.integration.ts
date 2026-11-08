import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import {
  applyIngestTestMigrations, describePositionModel, PostgresImportIdentityResolver, PostgresImportStageStore,
  PostgresPositionPipeline, PostgresSecurePipeline, PostgresValidationApprover, PostgresValidationCustodian,
  PostgresValidationResearcher, PostgresValidationWorker, positionMetricRegistry, positionMetricRegistryVersion, qbPassingProjection,
  createVerifiedPilotWorker, PostgresPilotApprover, serializePilotStudyArtifacts, sha256Bytes, signPilot, verifyPilotReport,
} from "../src/index.ts";
import type {
  CanonicalValidationRecipe, FieldPath, FieldPosition, FieldSeasonSimulation, ImportCandidate, ImportManifest, ImportPlan, MigrationFile,
  MigrationTestTarget, Observation, PilotEngineManifest, PilotEvent, PilotKeyPurpose, PilotKeyTrust, PilotRunManifest,
  PilotSigner, Position, PositionReplayRequest, QbGame, QbSeasonSimulation, SnapshotRequest,
} from "../src/index.ts";
import { positionComponents } from "../src/models/positions/catalog.ts";
import { canonicalSha256 } from "../src/ingest/determinism.ts";
import { gameObservations } from "../src/models/positions/metric-registry.ts";
import type { SourceCapability } from "../src/models/positions/data-requirements.ts";
import { advancedPolicy, game, policy, season, source } from "./simulation-fixtures.ts";

const compose = process.env["EFRA_PILOT_COMPOSE"] === "1";
const hosted = process.env["EFRA_NEON_TEST_DATABASE_URL"];
if (compose && hosted) throw new Error("Synthetic Compose cannot use a hosted database");
const composeCa = compose ? await readFile("/run/pilot-controller/ca.crt", "utf8") : undefined;
async function composeUrl(instance: "canonical" | "vault") {
  const endpoint = new URL(`postgresql://efra_test@${instance}:5432/efra_pilot_${instance}`);
  endpoint.password = (await readFile("/run/pilot-controller/" + instance + ".password", "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(endpoint.password)) throw new Error("Invalid generated test secret");
  return endpoint.toString();
}
function fixturePool(endpoint: string, max?: number) {
  return new Pool({ connectionString: endpoint, connectionTimeoutMillis: 15_000, max,
    ...(composeCa && { ssl: { ca: composeCa, rejectUnauthorized: true } }) });
}
const connectionString = compose ? await composeUrl("canonical") : hosted ?? process.env["EFRA_TEST_DATABASE_URL"];
if (!connectionString) throw new Error("An isolated EFRA integration database is required");
const url = new URL(connectionString);
const branchId = process.env["EFRA_NEON_TEST_BRANCH_ID"];
const primaryBranchId = process.env["EFRA_NEON_PRIMARY_BRANCH_ID"];
const target: MigrationTestTarget = compose ? { kind: "COMPOSE_TEST", instance: "canonical" } : hosted
  ? { kind: "NEON_TEST", branchId: branchId ?? "", primaryBranchId: primaryBranchId ?? "" } : { kind: "LOCAL_TEST" };
if (hosted) {
  if (url.protocol !== "postgresql:" || !url.hostname.endsWith(".neon.tech") || url.hostname.includes("-pooler")
    || url.pathname !== "/efra" || !branchId || !primaryBranchId || branchId === primaryBranchId
    || url.searchParams.get("sslmode") !== "verify-full") throw new Error("Expected the isolated direct Neon endpoint");
} else if (!compose && (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.pathname !== "/efra_stage_test"
  || url.username !== "efra_test" || !url.port || url.search || url.hash)) throw new Error("Expected the local test database");

const admin = fixturePool(connectionString);
const isolatedVaultUrl = compose ? await composeUrl("vault") : process.env["EFRA_PILOT_VAULT_DATABASE_URL"];
const vaultUrl = isolatedVaultUrl ? new URL(isolatedVaultUrl) : undefined;
if (vaultUrl && !compose && (hosted || vaultUrl.protocol !== "postgresql:" || vaultUrl.hostname !== "127.0.0.1"
  || vaultUrl.pathname !== "/efra_stage_test" || vaultUrl.username !== "efra_test" || !vaultUrl.port
  || vaultUrl.port === url.port || vaultUrl.search || vaultUrl.hash)) throw new Error("Expected a second local test PostgreSQL instance");
const vaultAdmin = vaultUrl ? fixturePool(vaultUrl.toString()) : undefined;
const actors = {
  importer: { capability: "IMPORTER", group: "importer", active: true },
  reviewer: { capability: "REVIEWER", group: "reviewer", active: true },
  reviewer2: { capability: "REVIEWER", group: "reviewer", active: true },
  publisher: { capability: "PUBLISHER", group: "publisher", active: true },
  projector: { capability: "PROJECTOR", group: "projector", active: true },
  attestor: { capability: "EVIDENCE_ATTESTOR", group: "evidence_attestor", active: true },
  reader: { capability: "READER", group: "reader", active: true },
  disabled: { capability: "IMPORTER", group: "importer", active: false },
} as const;
const validationActors = {
  custodian: "custodian", researcher: "researcher", researcher2: "researcher", approver: "approver", worker: "worker",
} as const;
type Actor = keyof typeof actors | keyof typeof validationActors;
const pools = new Map<Actor, Pool>();
const vaultPools = new Map<Actor, Pool>();
const actorPool = (actor: Actor) => {
  const pool = pools.get(actor);
  assert.ok(pool);
  return pool;
};
const service = (actor: Actor) => new PostgresSecurePipeline(actorPool(actor));
let migrations: readonly MigrationFile[] = [];
let vaultWorkerPassword: string | undefined;

async function configureValidationActors(client: PoolClient, endpoint: URL, destination: Map<Actor, Pool>, canonical: boolean) {
  for (const key of Object.keys(validationActors) as (keyof typeof validationActors)[]) {
    const group = validationActors[key];
    const login = canonical ? `efra_p13_${key}` : `efra_vault_p13_${key}`;
    const password = randomBytes(32).toString("hex");
    if (compose && !canonical && key === "worker") vaultWorkerPassword = password;
    await client.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
    await client.query(`GRANT efra_validation_${group} TO ${login} WITH INHERIT TRUE, SET FALSE`);
    await client.query(`INSERT INTO efra_validation.principal (login, login_oid, subject, capability)
      SELECT rolname, oid, $2, $3 FROM pg_catalog.pg_roles WHERE rolname = $1`, [login, `sim-validation-${key}`, group]);
    if (canonical && key === "custodian") {
      await client.query(`GRANT efra_ingest_reader TO ${login} WITH INHERIT TRUE, SET FALSE`);
      await client.query(`INSERT INTO efra_ingest.authenticated_principal (login_role, login_oid, subject_id, capability)
        SELECT rolname, oid, 'sim-validation-custodian', 'READER' FROM pg_catalog.pg_roles WHERE rolname = $1`, [login]);
    }
    const account = new URL(endpoint);
    account.username = login;
    account.password = password;
    destination.set(key, fixturePool(account.toString(), 4));
  }
}

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
    assert.equal(server.database, compose ? "efra_pilot_canonical" : "efra_stage_test");
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
      const { capability, group, active } = actors[key as keyof typeof actors];
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
      pools.set(key, fixturePool(account.toString(), 4));
    }
    await configureValidationActors(client, url, pools, true);
    await client.query("COMMIT");
    await approveConventions("sim-uuid-map-v1");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (vaultAdmin && vaultUrl) {
    const { rows: [server] } = await vaultAdmin.query<{ safe: boolean }>(
      "SELECT to_regnamespace('efra') IS NULL AND current_database() = $1 AND session_user = 'efra_test'"
      + " AND nullif(current_setting('neon.branch_id', true),'') IS NULL AS safe",
      [compose ? "efra_pilot_vault" : "efra_stage_test"],
    );
    assert.ok(server?.safe);
    if (compose) {
      const query = "SELECT system_identifier::text AS id FROM pg_control_system()";
      const canonicalCluster = await admin.query<{ id: string }>(query);
      const vaultCluster = await vaultAdmin.query<{ id: string }>(query);
      assert.ok(canonicalCluster.rows[0]?.id && vaultCluster.rows[0]?.id);
      assert.notEqual(canonicalCluster.rows[0]?.id, vaultCluster.rows[0]?.id);
    }
    await vaultAdmin.query(await readFile(new URL("fixtures/efra-schema.sql", import.meta.url), "utf8"));
    await applyIngestTestMigrations(vaultAdmin, compose ? { kind: "COMPOSE_TEST", instance: "vault" } : { kind: "LOCAL_TEST" }, migrations);
    const vaultClient = await vaultAdmin.connect();
    try { await configureValidationActors(vaultClient, vaultUrl, vaultPools, false); }
    finally { vaultClient.release(); }
  }
});
after(async () => { await Promise.all([admin.end(), vaultAdmin?.end(), ...[...pools.values(), ...vaultPools.values()].map((pool) => pool.end())]); });

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
        situation: { opportunities: obs(0), actualPointsAdded: obs(0), expectedPointsAdded: obs(0) },
        situationDefinitionVersion: "sim-sacks-1" },
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
    name: `${String(migrations.length + 1).padStart(3, "0")}_failed.sql`,
    sql: "CREATE TABLE efra_ingest.failed_probe (id int); SELECT 1 / 0;",
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
  await attestStages([id]);
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
  await attestStages([id]);
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
  await attestStages(ids);
  const released = await snapshot("sim-p10-unsupported", ids);
  assert.equal(await service("publisher").release(released), "CREATED");
  await assert.rejects(service("projector").project(released.snapshotId, qbPassingProjection), { code: "23514" });
  assert.equal(await service("reader").ratingReplayReference(released.snapshotId, "a".repeat(40), "b".repeat(64)), null);
  const { rows: [count] } = await admin.query<{ total: number }>("SELECT count(*)::int AS total FROM efra.stat_observations");
  assert.equal(count?.total, 10);
});

const registry = positionMetricRegistry();
const allPositions = [...new Set(registry.metrics.map(({ position }) => position))];
const phase11Revision = "sim-phase11-all-positions";
const allSnapshot = "sim-p11-all-positions";
const allGame = { gameId: "sim-game-all-positions", playedAt: "2025-01-14T00:00:00.000Z" };
const absent = { status: "MISSING" } as const;
const na = { status: "NOT_APPLICABLE" } as const;
const positionPipeline = (actor: Actor) => new PostgresPositionPipeline(actorPool(actor));

function positionObs(revision: string, value: number, conventionVersion = source.conventionVersion): Observation {
  return { status: value === 0 ? "VERIFIED_ZERO" : "OBSERVED", value, source: { ...source, revisionId: revision, conventionVersion } };
}

function fieldFixture(revision: string, position: FieldPosition, changes: Record<string, Observation> = {}): ImportCandidate {
  const fields = Object.fromEntries(registry.metrics.filter((metric) => metric.position === position && metric.storage === "GAME")
    .map((metric) => [metric.field, positionObs(revision,
      metric.roles.includes("NUMERATOR") ? metric.unit === "seconds" ? 2.4 : 4
        : metric.roles.includes("REFERENCE") ? 2.75 : 10)]));
  return { sourceRecordId: `sim-position-${position}`, game: {
    ...game, ...allGame, position, usage: { status: "PLAYED", source: { ...source, revisionId: revision } },
    stats: { definitionVersion: describePositionModel(position).definitionVersion, observations: { ...fields, ...changes } },
  } };
}

function qbPositionFixture(revision: string, zeroPassing = false): ImportCandidate {
  const current = fixture(revision).game;
  assert.equal(current.position, "QB");
  const value = (number: number) => positionObs(revision, number);
  const zeroCore = Object.fromEntries(Object.keys(current.stats.passing).map((key) => [key, value(0)])) as QbGame["stats"]["passing"];
  return { sourceRecordId: "sim-position-QB", game: {
    ...current, ...allGame, stats: {
      ...current.stats, passing: zeroPassing ? zeroCore : current.stats.passing,
      rushing: { attempts: value(4), yards: value(20), touchdowns: value(1), turnovers: value(0) },
      situation: { opportunities: value(3), actualPointsAdded: value(-0.4), expectedPointsAdded: value(0.6) },
      advancedPassing: { definitionVersion: "sim-first-down-1", nonTouchdownFirstDowns: value(zeroPassing ? 0 : 3) },
    },
  } };
}

async function releasePosition(input: ImportManifest, candidates: readonly ImportCandidate[], snapshotId: string) {
  const plan = await resolve(input, candidates);
  assert.ok(plan.rows.every(({ status }) => status === "STAGE"));
  assert.equal(await writer().stage(plan), "STAGED");
  const ids = await stageIds(input.sourceRevision);
  for (const id of ids) assert.equal(await service("reviewer").review(reviewRequest(id)), "REVIEWED");
  await attestStages(ids);
  assert.equal(await service("publisher").release(await snapshot(snapshotId, ids)), "CREATED");
}

function replayRequest<P extends Position>(position: P): PositionReplayRequest<P> {
  return {
    playerId: uuid("07"), position, season: { ...season.season, id: uuid("03"), competitionId: uuid("02"), leagueId: uuid("02") },
    stints: [{ id: "sim-p11-stint", teamId: uuid("04"), expectedGameIds: [uuid("12")] }],
    engineCommit: "a".repeat(40), configurationSha256: "b".repeat(64),
  };
}

function positionPolicy<P extends FieldPosition>(position: P, path: FieldPath = "POSITION_ADVANCED"): FieldSeasonSimulation<P> {
  const model = describePositionModel(position);
  const components = positionComponents(model.tiers, path);
  return {
    version: {
      ...policy.version, path, fieldPosition: position, featureDefinitionVersion: model.definitionVersion,
      comparisonScope: { basis: "LEAGUE", leagueId: uuid("02") },
    },
    components: Object.fromEntries(components.map(({ id }) => [
      id, { center: 0, scale: 1, weight: 1 / components.length },
    ])) as FieldSeasonSimulation<P>["components"],
    calibration: policy.calibration,
  };
}

const registryCapabilities = [...new Set(registry.metrics.map(({ sourceCapability }) => sourceCapability))];

async function attestCapability(mappingVersion: string, capability: SourceCapability, sourceId = uuid("01"), actor: Actor = "attestor") {
  await actorPool(actor).query("SELECT efra_ingest.attest_source_capability($1,$2,$3,$4,$5)",
    [sourceId, mappingVersion, season.snapshot.schemaVersion, capability, "1".repeat(64)]);
}

async function approveConventions(mappingVersion: string, wrongUnitFor?: string, sourceId = uuid("01"),
  capabilities: readonly SourceCapability[] = registryCapabilities) {
  for (const capability of capabilities) await attestCapability(mappingVersion, capability, sourceId);
  await admin.query(
    `INSERT INTO efra_ingest.metric_convention
      (source_id, mapping_version, schema_version, position, field, convention_version, feature_version, unit, approved_by)
     SELECT $1, $2, $3, position, field, $4,
       CASE WHEN field LIKE 'situation.%' THEN 'sim-sacks-1' WHEN field LIKE 'advancedPassing.%' THEN 'sim-first-down-1'
         ELSE definition_version END,
       CASE WHEN field = $5 THEN 'wrong_unit' ELSE unit END, 'sim-registry-reviewer'
     FROM efra_ingest.metric_registry WHERE storage = 'GAME' AND source_capability = ANY($6)`,
    [sourceId, mappingVersion, season.snapshot.schemaVersion, source.conventionVersion, wrongUnitFor ?? null, capabilities],
  );
}

function artifactsFor(game: ImportCandidate["game"], field: string, capability: SourceCapability) {
  const kinds = capability === "PLAY_BY_PLAY_AND_MODEL" ? ["MODEL_REFERENCE", "PLAY_BY_PLAY"]
    : [capability === "BOX_SCORE_CANDIDATE" ? "BOX_SCORE" : capability];
  return kinds.map((kind) => ({
    kind, field, gameId: game.gameId, playerId: game.playerId, position: game.position,
    reference: `sim-artifact-${kind}-${field}`, sha256: canonicalSha256([game.gameId, game.playerId, game.position, field, kind]),
  }));
}

async function attestStages(ids: readonly string[], except?: string) {
  const { rows } = await actorPool("attestor").query<{ id: string; game: ImportCandidate["game"] }>(
    "SELECT id::text, game FROM efra_ingest.staged_game WHERE id = ANY($1::bigint[])", [ids],
  );
  const operations = rows.flatMap(({ id, game }) => {
    const observations = gameObservations(game);
    return registry.metrics.flatMap(({ position, field, storage, sourceCapability }) => {
      const state = observations[field]?.status;
      return position !== game.position || storage !== "GAME" || field === except || (state !== "OBSERVED" && state !== "VERIFIED_ZERO")
        ? [] : [actorPool("attestor").query("SELECT efra_ingest.attest_position_metric($1,$2,$3::jsonb)",
          [id, field, JSON.stringify(artifactsFor(game, field, sourceCapability))])];
    });
  });
  await Promise.all(operations);
}

test("SIMULATION | SQL registry matches the 24 model contracts and all positions round-trip to reproducible ratings", async () => {
  assert.equal(allPositions.length, 24);
  const { rows: metrics } = await admin.query(`SELECT position, field, code, unit, domain, tiers, roles,
    source_capability AS "sourceCapability", storage, definition_version AS "definitionVersion"
    FROM efra_ingest.metric_registry ORDER BY position COLLATE "C", field COLLATE "C"`);
  assert.deepEqual(metrics, registry.metrics);
  const { rows: rules } = await admin.query(`SELECT position, upper_field AS upper, fields, kind FROM efra_ingest.metric_rule`);
  assert.equal(rules.length, registry.rules.length);
  for (const rule of registry.rules) assert.ok(rules.some((row) => row.position === rule.position && row.upper === rule.upper
    && row.kind === rule.kind && JSON.stringify(row.fields) === JSON.stringify(rule.fields)));
  await admin.query(`INSERT INTO efra.games (id, season_id, kickoff_at, home_team_id, away_team_id, status)
    VALUES ($1, $2, $3, $4, $5, 'final')`, [uuid("12"), uuid("03"), allGame.playedAt, uuid("04"), uuid("05")]);
  await admin.query(`INSERT INTO efra.external_ids (source_id, entity_type, entity_id, external_key) VALUES ($1, 'game', $2, $3)`,
    [uuid("01"), uuid("12"), allGame.gameId]);
  await admin.query(`INSERT INTO efra.player_appearances (game_id, player_id, team_id, position_code, snaps, exposure_quality)
    SELECT $1, $2, $3, p, 12, 'verified' FROM unnest($4::text[]) AS p`, [uuid("12"), uuid("07"), uuid("04"), allPositions]);

  await releasePosition(manifest(phase11Revision), allPositions.map((position) => position === "QB"
    ? qbPositionFixture(phase11Revision) : fieldFixture(phase11Revision, position)), allSnapshot);
  assert.deepEqual((await Promise.all([positionPipeline("projector").project(allSnapshot),
    positionPipeline("projector").project(allSnapshot)])).sort(), ["ALREADY_PROJECTED", "PROJECTED"]);
  const result = await positionPipeline("reader").readRelease(allSnapshot);
  assert.ok(result);
  assert.equal(result.snapshot.games.length, 24);
  assert.equal(result.facts.length, registry.metrics.filter(({ storage }) => storage === "GAME").length);
  assert.ok(result.facts.every(({ observationId }) => observationId !== null));
  const overlap = await snapshot("sim-p11-overlap", await stageIds(phase11Revision));
  assert.equal(await service("publisher").release(overlap), "CREATED");
  assert.equal(await positionPipeline("projector").project(overlap.snapshotId), "PROJECTED");
  assert.deepEqual((await positionPipeline("reader").readRelease(overlap.snapshotId))?.facts, result.facts);
  for (const position of allPositions) {
    const run = () => position === "QB"
      ? positionPipeline("reader").simulateQb(allSnapshot, replayRequest("QB"), advancedPolicy)
      : positionPipeline("reader").simulateField(allSnapshot, replayRequest(position), positionPolicy(position));
    const replay = await run();
    assert.equal(replay?.label, "SIMULATION", position);
    assert.equal(replay.rankingEligible, false);
    assert.equal(replay.rating.status, "PROVISIONAL", position);
    assert.deepEqual(await run(), replay, position);
  }
  const qb = await positionPipeline("reader").simulateQb(allSnapshot, {
    ...replayRequest("QB"), stints: [{ ...replayRequest("QB").stints[0]!, expectedGameIds: [uuid("12"), uuid("13")] }],
  }, advancedPolicy);
  assert.equal(qb?.rating.status, "NOT_RATED");
  assert.equal(qb.rating.reason, "INCOMPLETE_COVERAGE");
});

test("SIMULATION | zero, missing and N/A remain distinct in corrected snapshots and limited paths", async () => {
  const revision = "sim-phase11-status";
  const zero = positionObs(revision, 0);
  const snapshotId = "sim-p11-special";
  await releasePosition(manifest(revision, phase11Revision), [
    fieldFixture(revision, "P", { returnedPunts: zero, returnedFieldPositionAboveExpected: na }),
    fieldFixture(revision, "LS", { placekickSnaps: zero, accuratePlacekickSnaps: na }),
    fieldFixture(revision, "RB", { passBlockFailures: absent, passBlockAssignments: absent }),
    fieldFixture(revision, "CB", { nonTurnoverCoverageTargets: zero, nonTurnoverYardsAllowed: na }),
    fieldFixture(revision, "KR", { cleanKickReturns: zero, kickReturnYardsAboveExpected: na, kickReturns: zero, kickReturnFumbles: na }),
    fieldFixture(revision, "K", { fieldGoalAttempts: zero, fieldGoalsMade: na, expectedFieldGoalsByDistance: na }),
    qbPositionFixture(revision, true),
  ], snapshotId);
  assert.equal(await positionPipeline("projector").project(snapshotId), "PROJECTED");
  const reader = positionPipeline("reader");
  const release = await reader.readRelease(snapshotId);
  assert.ok(release);
  const facts = new Map(release.facts.map((fact) => [fact.field, fact]));
  assert.equal(facts.get("returnedPunts")?.observation.status, "VERIFIED_ZERO");
  assert.ok(facts.get("returnedPunts")?.observationId);
  for (const [field, status] of [["returnedFieldPositionAboveExpected", "NOT_APPLICABLE"], ["passBlockFailures", "MISSING"]]) {
    assert.equal(facts.get(field!)?.observation.status, status);
    assert.equal(facts.get(field!)?.observationId, null);
  }
  assert.equal((await reader.simulateField(snapshotId, replayRequest("P"), positionPolicy("P", "P_UNRETURNED_ONLY_V1")))?.rating.status, "PROVISIONAL");
  assert.equal((await reader.simulateField(snapshotId, replayRequest("LS"), positionPolicy("LS", "LS_PUNT_SNAP_ONLY_V1")))?.rating.status, "PROVISIONAL");
  for (const position of ["CB", "RB", "KR", "K"] as const) {
    const result = await reader.simulateField(snapshotId, replayRequest(position), positionPolicy(position));
    assert.equal(result?.rating.status, "NOT_RATED");
  }
  const rushOnly = {
    version: { ...policy.version, path: "QB_RUSH_ONLY_SPECIAL", contextVersion: "sim-no-context" },
    components: { rushingContribution: { weight: 1, score: ({ yardsPerAttempt }) => yardsPerAttempt } },
    calibration: policy.calibration,
  } satisfies QbSeasonSimulation;
  assert.equal((await reader.simulateQb(snapshotId, replayRequest("QB"), rushOnly))?.rating.status, "PROVISIONAL");
  const recovery = "sim-phase11-recovery";
  await releasePosition(manifest(recovery, revision), [fieldFixture(recovery, "RB")], "sim-p11-recovery");
  assert.equal(await positionPipeline("projector").project("sim-p11-recovery"), "PROJECTED");
  const original = await reader.readRelease(allSnapshot);
  const restored = await reader.readRelease("sim-p11-recovery");
  const rbStageId = original?.snapshot.games.find(({ game }) => game.position === "RB")?.stageId;
  const first = original?.facts.find(({ field, stageId }) => field === "passBlockFailures" && stageId === rbStageId);
  const resumed = restored?.facts.find(({ field }) => field === "passBlockFailures");
  assert.ok(first?.observationId && resumed?.observationId);
  const { rows: [lineage] } = await admin.query("SELECT supersedes_id FROM efra.stat_observations WHERE id = $1", [resumed.observationId]);
  assert.equal(lineage?.supersedes_id, first.observationId);
});

test("SIMULATION | conflicts retain source evidence in quarantine, and unapproved units roll back projection", async () => {
  const revision = "sim-phase11-conflict";
  const conflicted = fieldFixture(revision, "CB", {
    nonTurnoverYardsAllowed: { status: "CONFLICTED", sources: [
      { ...source, revisionId: revision }, { ...source, revisionId: "sim-counter-evidence" },
    ] },
  });
  const plan = await resolve(manifest(revision), [conflicted]);
  assert.equal(plan.rows[0]?.status, "QUARANTINE");
  assert.equal(await writer().stage(plan), "STAGED");
  const { rows: [stored] } = await actorPool("reviewer").query(`SELECT qc.conflicts FROM efra_ingest.quarantine_conflict qc
    JOIN efra_ingest.import_batch b ON b.id = qc.batch_id JOIN efra_ingest.source_revision r ON r.id = b.revision_id
    WHERE r.source_revision = $1`, [revision]);
  assert.equal(stored?.conflicts[0].status, "CONFLICTED");
  assert.equal(stored?.conflicts[0].field, "nonTurnoverYardsAllowed");
  assert.equal(stored?.conflicts[0].sources.length, 2);
  assert.deepEqual(await stageIds(revision), []);
  const wrong = "sim-phase11-wrong-unit";
  const mappingVersion = "sim-unit-mismatch";
  await assert.rejects(approveConventions(mappingVersion, "fieldGoalAttempts"), /matching unit/);
  const wrongPlan = await resolve({ ...manifest(wrong, "sim-phase11-status"), mappingVersion }, [fieldFixture(wrong, "K")]);
  assert.equal(await writer().stage(wrongPlan), "STAGED");
  const [wrongId] = await stageIds(wrong);
  assert.ok(wrongId);
  await attestStages([wrongId]);
  assert.equal(await service("reviewer").review(reviewRequest(wrongId)), "REVIEWED");
  await assert.rejects(service("publisher").release(await snapshot("sim-p11-wrong-unit", [wrongId])), /independently attested evidence/);
  assert.equal(await positionPipeline("reader").readRelease("sim-p11-wrong-unit"), null);
});

test("SIMULATION | exact legacy QB observations can be reused, but the old path cannot fork the status-aware history", async () => {
  const prior = await service("reader").ratingReplayReference("sim-p10-original", "a".repeat(40), "b".repeat(64));
  assert.ok(prior);
  assert.equal(await positionPipeline("projector").project("sim-p10-original"), "PROJECTED");
  const projected = await positionPipeline("reader").readRelease("sim-p10-original");
  assert.ok(projected);
  assert.deepEqual(projected.facts.filter(({ field }) => field.startsWith("passing.")).map(({ observationId }) => observationId).sort(),
    prior.observationIds);
  const rev = "sim-phase11-legacy-fork";
  await releasePosition(manifest(rev, "sim-phase10-original"), [fixture(rev, 84)], "sim-p11-legacy-fork");
  await assert.rejects(service("projector").project("sim-p11-legacy-fork", qbPassingProjection), /status-aware/);
  await assert.rejects(positionPipeline("projector").project("sim-p11-legacy-fork"), /already superseded/);
});

test("SIMULATION | a competing registered synthetic source cannot duplicate a canonical metric", async () => {
  const otherSource = "sim-other-source";
  const otherId = uuid("14");
  await admin.query("INSERT INTO efra.data_sources (id, code, name, reuse_status) VALUES ($1, $2, 'Synthetic competing source', 'unverified')",
    [otherId, otherSource]);
  await admin.query("INSERT INTO efra_ingest.synthetic_source VALUES ($1)", [otherId]);
  await admin.query(`INSERT INTO efra.external_ids (source_id, entity_type, entity_id, external_key)
    SELECT $1, entity_type, entity_id, external_key FROM efra.external_ids WHERE source_id = $2`, [otherId, uuid("01")]);
  await admin.query(`INSERT INTO efra_ingest.season_alias (source_id, competition_id, external_key, season_id)
    SELECT $1, competition_id, external_key, season_id FROM efra_ingest.season_alias WHERE source_id = $2`, [otherId, uuid("01")]);
  await approveConventions("sim-uuid-map-v1", undefined, otherId);
  const revision = "sim-phase11-competing-source";
  const row = fieldFixture(revision, "K");
  const field = row.game;
  assert.ok(field.position !== "QB" && field.usage.status === "PLAYED");
  const retag = (quality: typeof field.usage.source) => ({ ...quality, sourceId: otherSource });
  await releasePosition({ ...manifest(revision), sourceId: otherSource }, [{ ...row, game: {
    ...field, usage: { status: "PLAYED", source: retag(field.usage.source) },
    stats: { ...field.stats, observations: Object.fromEntries(Object.entries(field.stats.observations).map(([key, value]) => [
      key, value && "source" in value ? { ...value, source: retag(value.source) } : value,
    ])) },
  } }], "sim-p11-competing-source");
  await assert.rejects(positionPipeline("projector").project("sim-p11-competing-source"), /requires reconciliation/);
  assert.equal(await positionPipeline("reader").readRelease("sim-p11-competing-source"), null);
});

test("SIMULATION | a box-score source cannot approve or release individually charted fields", async () => {
  const mappingVersion = "sim-box-only";
  await approveConventions(mappingVersion, undefined, uuid("01"), ["BOX_SCORE_CANDIDATE"]);
  await assert.rejects(attestCapability(mappingVersion, "ASSIGNMENT_CHARTING", uuid("01"), "importer"), { code: "42501" });
  await assert.rejects(admin.query(`INSERT INTO efra_ingest.metric_convention
    (source_id,mapping_version,schema_version,position,field,convention_version,feature_version,unit,approved_by)
    VALUES ($1,$2,$3,'WR','runBlockWins',$4,$5,'count','self-declared')`,
  [uuid("01"), mappingVersion, season.snapshot.schemaVersion, source.conventionVersion, describePositionModel("WR").definitionVersion]),
  /attested registry capability/);
  const revision = "sim-p11-box-pretends-charting";
  const plan = await resolve({ ...manifest(revision), mappingVersion }, [fieldFixture(revision, "WR")]);
  assert.equal(await writer().stage(plan), "STAGED");
  const [id] = await stageIds(revision);
  assert.ok(id);
  const { rows: [row] } = await actorPool("attestor").query<{ game: ImportCandidate["game"] }>(
    "SELECT game FROM efra_ingest.staged_game WHERE id = $1", [id],
  );
  assert.ok(row);
  await assert.rejects(actorPool("attestor").query("SELECT efra_ingest.attest_position_metric($1,$2,$3::jsonb)",
    [id, "runBlockWins", JSON.stringify(artifactsFor(row.game, "runBlockWins", "ASSIGNMENT_CHARTING"))]), /Missing registry capability/);
  assert.equal(await service("reviewer").review(reviewRequest(id)), "REVIEWED");
  await assert.rejects(service("publisher").release(await snapshot("sim-p11-box-blocked", [id])), /independently attested evidence/);
  assert.equal(await positionPipeline("reader").readRelease("sim-p11-box-blocked"), null);
});

test("SIMULATION | a valid mapping still requires exact per-metric evidence before the release cutoff", async () => {
  const revision = "sim-p11-field-evidence";
  assert.equal(await writer().stage(await resolve(manifest(revision), [qbPositionFixture(revision)])), "STAGED");
  const [id] = await stageIds(revision);
  assert.ok(id);
  assert.equal(await service("reviewer").review(reviewRequest(id)), "REVIEWED");
  const field = "situation.actualPointsAdded";
  await attestStages([id], field);
  const early = await snapshot("sim-p11-evidence-cutoff", [id]);
  await assert.rejects(service("publisher").release(early), /independently attested evidence/);
  const { rows: [row] } = await actorPool("attestor").query<{ game: ImportCandidate["game"] }>(
    "SELECT game FROM efra_ingest.staged_game WHERE id = $1", [id],
  );
  assert.ok(row);
  const evidence = artifactsFor(row.game, field, "PLAY_BY_PLAY_AND_MODEL");
  const attest = (artifacts: unknown, actor: Actor = "attestor") => actorPool(actor).query(
    "SELECT efra_ingest.attest_position_metric($1,$2,$3::jsonb)", [id, field, JSON.stringify(artifacts)],
  );
  await assert.rejects(attest(evidence, "reviewer"), { code: "42501" });
  await assert.rejects(attest(evidence.slice(0, 1)), /does not satisfy registry capability/);
  await assert.rejects(attest(evidence.map((artifact) => ({ ...artifact, playerId: uuid("06") }))), /exact player/);
  await attest(evidence);
  await assert.rejects(service("publisher").release(early), /independently attested evidence/);
  assert.equal(await service("publisher").release(await snapshot(early.snapshotId, [id])), "CREATED");
});

async function holdoutFixture(gameIds: readonly string[], tag: string, engine: string, model: string) {
  const custodian = new PostgresValidationCustodian(actorPool("custodian"));
  const entries: CanonicalValidationRecipe["entries"][number][] = [];
  const cohort = {
    id: "sim-holdout-pop", version: "sim-holdout-ref-1", origin: "SYNTHETIC", position: "QB", leagueId: uuid("02"),
    seasonId: uuid("03"), competitionLevel: "SIMULATION", startsAt: "2025-01-01T00:00:00.000Z",
    endsAt: "2090-01-01T00:00:00.000Z", membershipLockedAt: "2025-01-01T00:00:00.000Z",
    memberPlayerIds: [uuid("07")],
  } as const;
  for (const [index, gameId] of gameIds.entries()) {
    const suffix = String(index);
    const snapshotId = tag + "-snapshot-" + suffix;
    const revision = tag + "-revision-" + suffix;
    const externalGame = tag + "-game-" + suffix;
    const candidate = fixture(revision, 80 + index * 20);
    await admin.query("INSERT INTO efra.games (id,season_id,kickoff_at,home_team_id,away_team_id,status) VALUES ($1,$2,$3,$4,$5,'final')",
      [gameId, uuid("03"), game.playedAt, uuid("04"), uuid("05")]);
    await admin.query("INSERT INTO efra.external_ids (source_id,entity_type,entity_id,external_key) VALUES ($1,'game',$2,$3)",
      [uuid("01"), gameId, externalGame]);
    await admin.query("INSERT INTO efra.player_appearances (game_id,player_id,team_id,position_code,snaps,exposure_quality) VALUES ($1,$2,$3,'QB',10,'verified')",
      [gameId, uuid("07"), uuid("04")]);
    await releasePosition(manifest(revision), [{ ...candidate, game: { ...candidate.game, gameId: externalGame } }], snapshotId);
    assert.equal(await positionPipeline("projector").project(snapshotId), "PROJECTED");
    const at = await custodian.observeRelease(snapshotId);
    assert.ok(at);
    assert.equal(await custodian.observeRelease(snapshotId), at);
    entries.push({ id: tag + "-sample-" + suffix, snapshotId, populationId: cohort.id, playerId: uuid("07"),
      stintId: tag + "-stint-" + suffix, clusterId: tag + "-cluster-" + suffix,
      predictedAt: at, expectedGames: [{ gameId, teamId: uuid("04") }],
      policyFields: { "context.expectedTouchdowns": {
        availableAt: at, evidenceIds: [tag + "-baseline-" + suffix],
        observation: { status: "OBSERVED", value: 1, source },
      } },
      features: { main: { kind: "CANONICAL_METRIC", field: "passing.yards", offset: 0, scale: 0.5 } },
      target: { eventAt: game.playedAt, availableAt: at, value: 40 + index * 10, evidenceIds: [tag + "-outcome-" + suffix],
        artifactSha256: canonicalSha256(["SIMULATION independent SPR target", tag, suffix]) },
    });
  }
  const [train, validation, holdout] = entries;
  const end = new Date(Date.parse(holdout!.predictedAt) + 100).toISOString();
  const recipe: CanonicalValidationRecipe = { engineArtifactSha256: engine, modelArtifactSha256: model, entries,
    header: { product: "SPR", candidates: [{ id: tag + "-model", weights: { main: 1 } }], sensitivity: [],
      populations: [cohort], plan: { origin: "SYNTHETIC", version: tag + "-plan", dataVersion: tag + "-data",
        modelVersion: tag + "-model", registryVersion: positionMetricRegistryVersion, position: "QB", pathId: "QB_STANDARD_CORE",
        windows: { train: { start: train!.predictedAt, end: validation!.predictedAt },
          validation: { start: validation!.predictedAt, end: holdout!.predictedAt }, test: { start: holdout!.predictedAt, end } },
        frozenAt: end, outcome: { kind: "SEASON_REFERENCE", definitionVersion: "sim-p13-spr-reference" },
        coverage: { minimumGames: 1, minimumExposure: { "passing.attempts": 1 } },
        minimumGroupSize: 1, minimumPartitionClusters: { train: 1, validation: 1, test: 1 }, playerDisjoint: false,
      },
    },
  };
  return { recipe, custodian, train, validation, holdout };
}

test("SIMULATION | canonical import to independent holdout, private review, and exact audited replay", async () => {
  const gameIds = [uuid("21"), uuid("22"), uuid("23")];
  const engine = canonicalSha256("SIMULATION phase 13 worker");
  const model = canonicalSha256("SIMULATION phase 13 model");
  const { recipe, custodian, train, validation, holdout } = await holdoutFixture(gameIds, "sim-p13", engine, model);
  const researcher = new PostgresValidationResearcher(actorPool("researcher"));
  const approver = new PostgresValidationApprover(actorPool("approver"));
  const worker = new PostgresValidationWorker(actorPool("worker"), engine);
  const dataset = "sim-p13-dataset";
  const researcherId = "sim-validation-researcher";
  const approverId = "sim-validation-approver";
  const run = uuid("31");
  const sealed = await custodian.seal(dataset, researcherId, recipe);
  assert.equal(sealed.status, "SEALED");
  assert.deepEqual(await custodian.seal(dataset, researcherId, recipe), { ...sealed, status: "ALREADY_SEALED" });
  await assert.rejects(actorPool("researcher").query("SELECT payload FROM efra_validation.dataset"), { code: "42501" });
  await assert.rejects(actorPool("researcher").query("SELECT * FROM efra_ingest.approved_snapshot_export"), { code: "42501" });
  await assert.rejects(actorPool("reader").query("SELECT * FROM efra_validation.canonical_proofs($1)", [holdout!.snapshotId]), { code: "42501" });
  await assert.rejects(actorPool("researcher").query("SELECT efra_validation.request_development($1,'test')", [dataset]), { code: "42501" });
  await assert.rejects(new PostgresValidationResearcher(actorPool("researcher2")).requestDevelopment(dataset, "train"), { code: "42501" });
  const revokedTicket = await researcher.requestDevelopment(dataset, "train");
  await admin.query("REVOKE efra_validation_researcher FROM efra_p13_researcher");
  try {
    await assert.rejects(worker.readDevelopment(revokedTicket, researcherId), { code: "42501" });
  } finally {
    await admin.query("GRANT efra_validation_researcher TO efra_p13_researcher WITH INHERIT TRUE, SET FALSE");
  }
  await admin.query("GRANT efra_ingest_reader TO efra_p13_researcher WITH INHERIT TRUE, SET FALSE");
  try {
    await admin.query(`INSERT INTO efra_ingest.authenticated_principal (login_role,login_oid,subject_id,capability)
      SELECT rolname,oid,'sim-dual-role-reader','READER' FROM pg_catalog.pg_roles WHERE rolname = 'efra_p13_researcher'`);
    await assert.rejects(researcher.requestDevelopment(dataset, "train"), { code: "42501" });
    await assert.rejects(positionPipeline("researcher").readRelease(holdout!.snapshotId), { code: "42501" });
  } finally {
    await admin.query("DELETE FROM efra_ingest.authenticated_principal WHERE login_role='efra_p13_researcher'");
    await admin.query("REVOKE efra_ingest_reader FROM efra_p13_researcher");
  }
  await assert.rejects(worker.evaluate(dataset, run), { code: "42501" });
  await assert.rejects(new PostgresValidationApprover(actorPool("custodian")).approve(dataset, sealed.datasetSha256, "SIMULATION"), { code: "42501" });
  await assert.rejects(approver.approve(dataset, sealed.datasetSha256, "SIMULATION before review"), { code: "42501" });
  await assert.rejects(approver.approve(dataset, "a".repeat(64), "SIMULATION"), { code: "42501" });
  const trainTicket = await researcher.requestDevelopment(dataset, "train");
  await assert.rejects(worker.readDevelopment(trainTicket, "sim-validation-researcher2"), { code: "42501" });
  const dev = await worker.readDevelopment(trainTicket, researcherId);
  assert.deepEqual(dev.samples.map(({ id }) => id), [train!.id]);
  assert.equal(dev.samples[0]!.fields["passing.interceptions"]?.observation.status, "VERIFIED_ZERO");
  assert.ok(!JSON.stringify(dev).includes(holdout!.id));
  await assert.rejects(worker.readDevelopment(trainTicket, researcherId), { code: "23505" });
  const validationTicket = await researcher.requestDevelopment(dataset, "validation");
  assert.deepEqual((await worker.readDevelopment(validationTicket, researcherId)).samples.map(({ id }) => id), [validation!.id]);
  const review = await approver.reviewManifest(dataset);
  assert.equal(review.datasetSha256, sealed.datasetSha256);
  assert.equal(review.product, "SPR");
  assert.ok(!JSON.stringify(review).includes(holdout!.id));
  await approver.approve(dataset, sealed.datasetSha256, "SIMULATION independent approval");
  await assert.rejects(new PostgresValidationWorker(actorPool("worker"), "c".repeat(64)).evaluate(dataset, run), { code: "42501" });
  const workerTransaction = await actorPool("worker").connect();
  try {
    await workerTransaction.query("BEGIN");
    const { rows: [pending] } = await workerTransaction.query<{ ticket: string }>(
      "SELECT efra_validation.claim_evaluation($1,$2,$3) AS ticket", [dataset, uuid("39"), engine],
    );
    await assert.rejects(workerTransaction.query("SELECT efra_validation.read_evaluation($1)", [pending!.ticket]), { code: "42501" });
  } finally {
    await workerTransaction.query("ROLLBACK");
    workerTransaction.release();
  }
  await actorPool("worker").query("SELECT efra_validation.claim_evaluation($1,$2,$3)", [dataset, run, engine]);
  await assert.rejects(actorPool("worker").query("SELECT efra_validation.record_report($1,$2,NULL::jsonb)",
    [dataset, run]), { code: "42501" });
  const both = await Promise.allSettled([worker.evaluate(dataset, run), worker.evaluate(dataset, uuid("32"))]);
  assert.equal(both.filter(({ status }) => status === "fulfilled").length, 1);
  const accepted = both[0]!.status === "fulfilled" ? run : uuid("32");
  assert.deepEqual(await worker.evaluate(dataset, accepted), { label: "SIMULATION", officialEligible: false,
    datasetSha256: sealed.datasetSha256 });
  const reportTicket = await approver.requestPrivateReport(dataset);
  await assert.rejects(worker.readPrivateReport(reportTicket, researcherId), { code: "42501" });
  const report = await worker.readPrivateReport(reportTicket, approverId);
  assert.equal(report.result.empiricalValidation, false);
  assert.equal(report.result.product, "SPR");
  assert.equal(report.result.test.count, 1);
  assert.deepEqual(await worker.readPrivateReport(await approver.requestPrivateReport(dataset), approverId), report);
  await assert.rejects(actorPool("researcher").query("SELECT efra_validation.request_report($1)", [dataset]), { code: "42501" });

  const copy = "sim-p13-copy";
  assert.equal((await custodian.seal(copy, researcherId, recipe)).status, "SEALED");
  await approver.reviewManifest(copy);
  await approver.approve(copy, sealed.datasetSha256, "SIMULATION duplicate holdout probe");
  await assert.rejects(worker.evaluate(copy, uuid("33")), { code: "23505" });
  const { rows: [stored] } = await admin.query<{ payload: { datasetSha256: string; batches: {
    partition: string; evidenceKeys: string[];
  }[] } }>("SELECT payload FROM efra_validation.dataset WHERE id=$1", [dataset]);
  const relocated = stored!.payload;
  const testKeys = relocated.batches.find(({ partition }) => partition === "test")!.evidenceKeys;
  relocated.batches.find(({ partition }) => partition === "train")!.evidenceKeys.push(testKeys.pop()!);
  await assert.rejects(actorPool("custodian").query("SELECT efra_validation.seal($1,$2,$3,$4::jsonb)",
    ["sim-p13-relocated", relocated.datasetSha256, researcherId, relocated]), { code: "23514" });
  const { rows: audit } = await admin.query<{ action: string; actor: string }>(
    "SELECT action,actor FROM efra_validation.audit WHERE resource=$1 ORDER BY id", [dataset],
  );
  assert.equal(audit.filter(({ action }) => action === "TEST_OPEN").length, 1);
  assert.equal(audit.filter(({ action }) => action === "TEST_REPLAY").length, 2);
  assert.equal(audit.filter(({ action }) => action === "TEST_READ").length, 2);
  assert.ok(audit.some(({ action, actor }) => action === "APPROVED" && actor === approverId));
  assert.ok(audit.some(({ action }) => action === "REPORT_READ"));
  await assert.rejects(admin.query("DELETE FROM efra_validation.audit"), { code: "55000" });
  await assert.rejects(actorPool("worker").query("DELETE FROM efra.stat_observations"), { code: "42501" });
  const { rows: [state] } = await admin.query<{ count: number; absent: boolean }>(
    "SELECT (SELECT count(*)::int FROM efra.stat_observations WHERE game_id=ANY($1::uuid[])) AS count,"
    + " NOT EXISTS (SELECT FROM efra_validation.evaluation WHERE dataset_id=$2) AS absent", [gameIds, copy],
  );
  assert.deepEqual(state, { count: 36, absent: true });
});

test("SIMULATION | pilot locks the measured bundle and signed report across a committed-response outage", async () => {
  const pilotPool = (actor: Actor) => vaultPools.get(actor) ?? actorPool(actor);
  const environment = "sim-pilot";
  const keys = new Map<PilotKeyPurpose, { readonly publicKey: KeyObject; readonly privateKey: KeyObject }>();
  const purposes = ["ENGINE", "RUN", "REPORT"] as const;
  for (const purpose of purposes) keys.set(purpose, generateKeyPairSync("ed25519"));
  const trust: PilotKeyTrust = { publicKey: (scope, purpose, id) =>
    scope === environment && id === purpose ? keys.get(purpose)?.publicKey : undefined };
  const signer = (purpose: typeof purposes[number]): PilotSigner => {
    const key = keys.get(purpose)!;
    return { keyId: purpose, sign: async (message) => sign(null, message, key.privateKey) };
  };
  const events: PilotEvent[] = [];
  const monitor = { record: (event: PilotEvent) => { events.push(event); } };
  const engineBytes = await readFile(new URL("../dist/pilot-engine.mjs", import.meta.url));
  const engine = sha256Bytes(engineBytes);
  const engineBody: PilotEngineManifest = { version: "efra-pilot-engine-v1", sourceCommit: "c".repeat(40),
    engineSha256: engine, protocolVersion: "efra-synthetic-validation-v1" };
  const engineManifest = await signPilot(environment, "ENGINE", engineBody, signer("ENGINE"));
  const base = await holdoutFixture([uuid("41"), uuid("42"), uuid("43")], "sim-p14", engine, "a".repeat(64));
  const artifacts = serializePilotStudyArtifacts({ ...base.recipe.header, samples: [] });
  const modelSha256 = sha256Bytes(artifacts.model);
  const dataset = "sim-p14-dataset";
  const runId = uuid("44");
  const custody = new PostgresValidationCustodian(actorPool("custodian"), pilotPool("custodian"));
  const { datasetSha256 } = await custody.seal(dataset, "sim-validation-researcher", { ...base.recipe, modelArtifactSha256: modelSha256 });
  if (vaultAdmin) {
    const { rows: [vaultState] } = await vaultAdmin.query<{ canonicalEmpty: boolean }>(
      'SELECT NOT EXISTS(SELECT FROM efra.stat_observations) AS "canonicalEmpty"',
    );
    const { rows: [canonicalState] } = await admin.query<{ absent: boolean }>(
      "SELECT NOT EXISTS(SELECT FROM efra_validation.dataset WHERE id=$1) AS absent", [dataset],
    );
    assert.ok(vaultState?.canonicalEmpty && canonicalState?.absent);
  }
  const now = Date.now();
  const body: PilotRunManifest = {
    version: "efra-pilot-run-v1", mode: "SYNTHETIC_ONLY", datasetId: dataset, runId, datasetSha256,
    engineSha256: engine, modelSha256, configurationSha256: sha256Bytes(artifacts.configuration), reportKeyId: "REPORT",
    issuedAt: new Date(now - 10).toISOString(), expiresAt: new Date(now + 300_000).toISOString(),
  };
  const authorization = await signPilot(environment, "RUN", body, signer("RUN"));
  const db = pilotPool("worker");
  const options = { environment, db, engineBytes, engineManifest, trust, reportSigner: signer("REPORT"), monitor, now: () => now };
  await assert.rejects(createVerifiedPilotWorker({ ...options, engineBytes: Buffer.concat([engineBytes, Buffer.from("// changed")]) }),
    /build digest/);
  const worker = await createVerifiedPilotWorker(options);
  assert.deepEqual(worker.readiness(), { mode: "SYNTHETIC_ONLY", ready: true });
  const approver = new PostgresValidationApprover(pilotPool("approver"));
  const pilotApprover = new PostgresPilotApprover(environment, pilotPool("approver"), trust, () => now);
  await assert.rejects(pilotApprover.register(authorization), { code: "42501" });
  await approver.reviewManifest(dataset);
  await approver.approve(dataset, datasetSha256, "SIMULATION pilot approval");
  await assert.rejects(worker.evaluate(dataset, runId, authorization, artifacts), { failure: "ACCESS_DENIED" });
  assert.equal(await pilotApprover.register(authorization), "REGISTERED");
  assert.equal(await pilotApprover.register(authorization), "ALREADY_REGISTERED");
  await assert.rejects(new PostgresValidationWorker(db, engine).evaluate(dataset, runId), { code: "42501" });
  await assert.rejects(db.query("SELECT efra_validation.claim_evaluation_internal($1,$2,$3)", [dataset, runId, engine]), { code: "42501" });
  const otherRun = await signPilot(environment, "RUN", { ...body, runId: uuid("45") }, signer("RUN"));
  await assert.rejects(pilotApprover.register(otherRun), { code: "23514" });
  await assert.rejects(worker.evaluate(dataset, otherRun.body.runId, otherRun, artifacts), { failure: "ACCESS_DENIED" });
  await assert.rejects(worker.evaluate(dataset, runId, authorization, { ...artifacts, model: Buffer.from("changed") }),
    { failure: "INTEGRITY_OR_EXECUTION" });
  await assert.rejects(worker.evaluate(dataset, runId, authorization, { ...artifacts, configuration: Buffer.from("changed") }),
    { failure: "INTEGRITY_OR_EXECUTION" });
  await assert.rejects(worker.evaluate(dataset, runId, { ...authorization, body: { ...body, reportKeyId: "forged" } }, artifacts),
    { failure: "INTEGRITY_OR_EXECUTION" });

  const { rows: [testClaim] } = await db.query<{ ticket: string }>(
    "SELECT efra_validation.claim_pilot_evaluation($1,$2,$3,$4,$5) AS ticket",
    [dataset, runId, engine, datasetSha256, canonicalSha256(body)],
  );
  await db.query("SELECT efra_validation.read_evaluation($1)", [testClaim!.ticket]);
  const unsigned = { datasetSha256, modelArtifactSha256: modelSha256, engineArtifactSha256: engine,
    result: { label: "SIMULATION", officialEligible: false, empiricalValidation: false } };
  await assert.rejects(db.query("SELECT efra_validation.record_report($1,$2,$3::jsonb)", [dataset, runId, unsigned]), { code: "23514" });

  const writeJobFile = async (directory: "inbox" | "keys" | "leases" | "trust", name: string, value: string) => {
    const path = "/run/pilot-" + directory + "/" + name;
    await writeFile(path + ".tmp", value, { mode: 0o600, flag: "wx" });
    await rename(path + ".tmp", path);
  };
  const publicKeys = Object.fromEntries(purposes.map((purpose) => [purpose, {
    purpose, pem: keys.get(purpose)!.publicKey.export({ format: "pem", type: "spki" }).toString(),
  }]));
  const executeContainer = async (sequence: number, password: string, signedRun = authorization) => {
    const version = "lease-" + sequence;
    await writeJobFile("leases", "worker-lease.json", JSON.stringify({ reference: "worker-lease", service: "holdout-worker",
      environment, version, login: "efra_vault_p13_worker", password, expiresAt: Date.now() + 300_000 }));
    const job = JSON.stringify({
      version: "efra-local-pilot-job-v1", engine: engineManifest, run: signedRun,
      model: artifacts.model.toString("base64"), configuration: artifacts.configuration.toString("base64"),
    });
    await writeJobFile("inbox", "job-" + sequence + ".json", job);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const receipt = JSON.parse(await readFile("/run/pilot-outbox/receipt-" + sequence + ".json", "utf8"));
        assert.deepEqual(receipt, { label: "SIMULATION", officialEligible: false, datasetSha256, runId, leaseVersion: version,
          jobSha256: sha256Bytes(Buffer.from(job)) });
        return;
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
        await delay(100);
      }
    }
    throw new Error("Isolated worker did not return its verified receipt");
  };
  if (compose) {
    assert.ok(vaultWorkerPassword && vaultUrl && vaultAdmin && composeCa);
    const insecure = new Pool({ connectionString: vaultUrl.toString(), ssl: false, connectionTimeoutMillis: 5_000 });
    try { await assert.rejects(insecure.query("SELECT 1"), { code: "28000" }); }
    finally { await insecure.end(); }
    await writeJobFile("trust", "ca.crt", composeCa);
    await writeJobFile("trust", "public-keys.json", JSON.stringify(publicKeys));
    await writeJobFile("keys", "report.key", keys.get("REPORT")!.privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    await executeContainer(1, vaultWorkerPassword);
  }

  let lost = false;
  const interrupted = { query: async (sql: string, values: unknown[]) => {
    const result = await db.query(sql, values);
    if (!lost && sql.includes("record_report") && values.length === 3) {
      lost = true;
      throw Object.assign(new Error("private test fixture string"), { code: "ECONNRESET" });
    }
    return result;
  } } as unknown as Pick<Pool, "query">;
  const faultyWorker = await createVerifiedPilotWorker({ ...options, db: interrupted });
  await assert.rejects(faultyWorker.evaluate(dataset, runId, authorization, artifacts), { failure: "TRANSIENT_STORAGE" });
  assert.ok(lost);
  const concurrency = compose ? 12 : 2;
  const receipts = await Promise.all(Array.from({ length: concurrency }, () => worker.evaluate(dataset, runId, authorization, artifacts)));
  assert.deepEqual(receipts, Array(concurrency).fill({ label: "SIMULATION", officialEligible: false, datasetSha256 }));
  const ticket = await approver.requestPrivateReport(dataset);
  const recipient = "sim-validation-approver";
  await assert.rejects(new PostgresValidationWorker(db, engine).readPrivateReport(ticket, recipient), { code: "42501" });
  await assert.rejects(db.query("SELECT efra_validation.read_report_internal($1,$2)", [ticket, recipient]), { code: "42501" });
  await assert.rejects(worker.readReport(ticket, recipient, otherRun), { failure: "ACCESS_DENIED" });
  const report = await worker.readReport(ticket, recipient, authorization);
  assert.equal(report.result.empiricalValidation, false);
  assert.equal(report.result.test.count, 1);
  assert.throws(() => verifyPilotReport(environment, { ...report, bridgeExclusions: [{ id: "changed", partition: "test", issues: [] }] },
    authorization, trust), /does not match/);
  assert.throws(() => verifyPilotReport(environment, report, otherRun, trust), /does not match/);
  if (compose) {
    assert.ok(vaultWorkerPassword && vaultUrl && vaultAdmin);
    const rotated = randomBytes(32).toString("hex");
    await vaultAdmin.query(`ALTER ROLE efra_vault_p13_worker PASSWORD '${rotated}'`);
    const oldEndpoint = new URL(vaultUrl);
    oldEndpoint.username = "efra_vault_p13_worker";
    oldEndpoint.password = vaultWorkerPassword;
    const obsolete = fixturePool(oldEndpoint.toString());
    try { await assert.rejects(obsolete.query("SELECT 1"), { code: "28P01" }); }
    finally { await obsolete.end(); }
    const next = generateKeyPairSync("ed25519");
    const nextAuthorization = await signPilot(environment, "RUN", body, {
      keyId: "RUN-next", sign: async (message) => sign(null, message, next.privateKey),
    });
    await writeJobFile("trust", "public-keys.json", JSON.stringify({
      ENGINE: publicKeys.ENGINE, REPORT: publicKeys.REPORT,
      "RUN-next": { purpose: "RUN", pem: next.publicKey.export({ format: "pem", type: "spki" }).toString() },
    }));
    await executeContainer(2, rotated, nextAuthorization);
    const tampered = JSON.stringify({ version: "efra-local-pilot-job-v1", engine: engineManifest,
      run: { ...nextAuthorization, body: { ...body, configurationSha256: "0".repeat(64) } },
      model: artifacts.model.toString("base64"), configuration: artifacts.configuration.toString("base64") });
    await writeJobFile("inbox", "job-3.json", tampered);
    await writeJobFile("inbox", "job-4.json", tampered);
  }
  keys.delete("RUN");
  await assert.rejects(worker.evaluate(dataset, runId, authorization, artifacts), { failure: "INTEGRITY_OR_EXECUTION" });
  keys.delete("REPORT");
  assert.deepEqual(worker.readiness(), { mode: "SYNTHETIC_ONLY", ready: false });
  assert.ok(events.some((event) => event.failure === "TRANSIENT_STORAGE" && event.runId === runId));
  assert.ok(!JSON.stringify(events).includes("private test fixture string"));
});
