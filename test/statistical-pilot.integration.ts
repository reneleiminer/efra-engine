import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  applyEfaPublicationTestMigration, authorizePilotAction, bindPilotAction, calculateStatisticalSeason, efaPublicationResource,
  efaPublicationTarget, PostgresEfaPublicationReader, PostgresEfaPublicationWriter, statisticalReadVersion,
} from "../src/index.ts";
import type { EfaPilotContext, PilotActionBoundary, PilotSession, StatisticalPilotAction, StatisticalPilotActionPayload, StatisticalRelease } from "../src/index.ts";
import { canonicalSha256 } from "../src/ingest/determinism.ts";
import { sha256Bytes } from "../src/pilot/signatures.ts";
import { bundle, context, environment, evidence, group, licensed, signed, signer, utc } from "./fixtures/efa-statistical.ts";

const fixtureUrl = new URL(process.env.EFRA_TEST_DATABASE_URL ?? "postgresql://efra_test@127.0.0.1:1/efra_stage_test");
if (fixtureUrl.protocol !== "postgresql:" || fixtureUrl.hostname !== "127.0.0.1" || !fixtureUrl.port
  || fixtureUrl.username !== "efra_test" || fixtureUrl.pathname !== "/efra_stage_test" || fixtureUrl.search || fixtureUrl.hash) {
  throw new Error("EFA integration requires the dedicated local statistical PostgreSQL fixture");
}

const issuer = "https://sim-identity.invalid";
const subjects = { reviewer: "sim-STAT_DATA", publisher: "sim-STAT_PUBLICATION" } as const;
const handles = { reviewer: "a".repeat(64), publisher: "b".repeat(64) };
const revoked = new Set<string>();
const dbRole = (actor: keyof typeof subjects) => actor === "reviewer" ? "REVIEWER" : "PUBLISHER";
function boundary(): PilotActionBoundary {
  const now = Date.now();
  const sessions = new Map(Object.entries(handles).map(([role, handle]) => {
    const personId = subjects[role as keyof typeof subjects];
    const session: PilotSession = { issuer, subject: personId, personId, environment, issuedAt: now, strongAuthenticationAt: now, expiresAt: now + 300_000 };
    return [sha256Bytes(Buffer.from(handle, "hex")), session];
  }));
  return { environment, audience: "efa-statistical-service", service: "efa-pilot", directory: {
    readSession: async (key) => sessions.get(key),
    allows: async (session, command) => !revoked.has(session.personId) && command.resourceId === efaPublicationResource
      && (command.action === "REVIEW_EFA_STATISTICS" ? session.personId === subjects.reviewer : session.personId === subjects.publisher),
  } };
}
const payload = (targetSha256: string, expectedHead: string | null, releaseSha256?: string): StatisticalPilotActionPayload =>
  ({ targetSha256, expectedHead, reason: "Synthetic EFA review exercise.", ...(releaseSha256 && { releaseSha256 }) });
const authorization = (b: PilotActionBoundary, actor: keyof typeof subjects, action: StatisticalPilotAction, body: StatisticalPilotActionPayload) =>
  authorizePilotAction(b, handles[actor], bindPilotAction(action, efaPublicationResource, body), signer("ACTION"));
const prepared = async (source: Awaited<ReturnType<typeof evidence>>, config: EfaPilotContext) => {
  const data = await bundle(source, config);
  const analysis = calculateStatisticalSeason(data.statistics, config);
  const release = await signed<StatisticalRelease>("STAT_PUBLICATION", {
    schema: statisticalReadVersion, analysisSha256: analysis.analysisSha256, approvedAt: utc("09-20"),
    expiresAt: "2099-01-01T00:00:00.000Z", includeLeaderboards: true, reportPlayerIds: [],
  });
  return { data, release, target: efaPublicationTarget(data, config) };
};

test("SIMULATION | PostgreSQL review, concurrent writes, licensed-claim release, correction and revocation", async (t) => {
  const admin = new Pool({ connectionString: fixtureUrl.toString(), connectionTimeoutMillis: 3000 });
  const clients: Pool[] = [admin];
  t.after(async () => { await Promise.all(clients.map((pool) => pool.end())); });
  assert.equal(await applyEfaPublicationTestMigration(admin), true);
  assert.equal(await applyEfaPublicationTestMigration(admin), false);
  const createPool = async (access: "reader" | "writer") => {
    const login = `efra_stat_fixture_${access}`, password = randomBytes(32).toString("hex");
    await admin.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
    await admin.query(`GRANT efra_statistical_${access} TO ${login} WITH INHERIT TRUE, SET FALSE`);
    const connection = new URL(fixtureUrl);
    connection.username = login;
    connection.password = password;
    const pool = new Pool({ connectionString: connection.toString(), connectionTimeoutMillis: 3000 });
    clients.push(pool);
    return pool;
  };
  const writerPool = await createPool("writer"), readerPool = await createPool("reader");
  const writer = new PostgresEfaPublicationWriter(writerPool), reader = new PostgresEfaPublicationReader(readerPool);
  await admin.query("INSERT INTO efra_statistical.scope(environment,competition_id,season_id) VALUES ($1,$2,$3)",
    [environment, group.competitionId, group.seasonId]);
  for (const actor of ["reviewer", "publisher"] as const) {
    await admin.query("INSERT INTO efra_statistical.grant(environment,person,issuer,subject,role) VALUES ($1,$2,$3,$2,$4)",
      [environment, subjects[actor], issuer, dbRole(actor)]);
  }
  await assert.rejects(readerPool.query("SELECT * FROM efra_statistical.event"), { code: "42501" });
  await assert.rejects(readerPool.query("SELECT * FROM efra_statistical.head_receipt($1)", [environment]), { code: "42501" });
  await assert.rejects(writerPool.query("SELECT * FROM efra_statistical.active_release($1)", [environment]), { code: "42501" });
  const b = boundary();
  const reviewAction = "REVIEW_EFA_STATISTICS", publishAction = "PUBLISH_EFA_STATISTICS", revokeAction = "REVOKE_EFA_STATISTICS";
  const sim = await prepared(await evidence(), context);
  const start = payload(sim.target, null);
  const simReview = { action: reviewAction, bundle: sim.data } as const;
  const [first, second] = await Promise.all([authorization(b, "reviewer", reviewAction, start), authorization(b, "reviewer", reviewAction, start)]);
  await assert.rejects(authorization(b, "publisher", reviewAction, start), /scoped grant/);
  revoked.add(subjects.reviewer);
  await assert.rejects(writer.commit(b, context, simReview, start, first), /scoped grant/);
  revoked.clear();
  const attempts = await Promise.allSettled([writer.commit(b, context, simReview, start, first), writer.commit(b, context, simReview, start, second)]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((result) => result.status === "rejected" && result.reason.code === "40001").length, 1);
  const simHead = (await writer.headReceipt(environment))!;
  assert.equal(simHead.action, "REVIEW");
  assert.equal((await reader.read(sim.data, sim.release, licensed)).status, "WITHHELD");
  const fake = payload(sim.target, simHead.id, canonicalSha256(sim.release));
  await assert.rejects(writer.commit(b, licensed, { action: publishAction, bundle: sim.data, release: sim.release }, fake,
    await authorization(b, "publisher", publishAction, fake)), /source rights/);
  await assert.rejects(writerPool.query("SELECT efra_statistical.commit_action($1,$2,$3,$4,$5,$6,$7,$6,$8,$9,$10,$11,$12,$13)",
    [environment, randomUUID(), "PUBLISH", simHead.id, sim.target, subjects.publisher, issuer, "a".repeat(64), "ACTION",
      "b".repeat(64), new Date(Date.now() + 60_000), "Synthetic role bypass exercise.",
      { groupSha256: canonicalSha256(group), releaseSha256: "b".repeat(64), expiresAt: sim.release.body.expiresAt }]), { code: "42501" });

  // These are synthetic values and ephemeral authorities exercising the licensed branch in the isolated test database.
  const original = await prepared(await evidence({ origin: "REAL" }), licensed);
  const initial = payload(original.target, simHead.id);
  const review = { action: reviewAction, bundle: original.data } as const;
  const initialAuth = await authorization(b, "reviewer", reviewAction, initial);
  await assert.rejects(writer.commit(b, licensed, review, initial, initialAuth), { code: "42501" });
  assert.equal((await writer.headReceipt(environment))?.id, simHead.id);
  await admin.query("UPDATE efra_statistical.scope SET licensed_enabled = true WHERE environment = $1", [environment]);
  const reviewed = await writer.commit(b, licensed, review, initial, initialAuth);
  const current = payload(original.target, reviewed, canonicalSha256(original.release));
  const publish = { action: publishAction, bundle: original.data, release: original.release } as const;
  const publishAuth = await authorization(b, "publisher", publishAction, current);
  const changedRelease = await signed<StatisticalRelease>("STAT_PUBLICATION", { ...original.release.body,
    reportPlayerIds: [original.data.statistics.dataset.body.players[0]!.id] });
  await assert.rejects(writer.commit(b, licensed, { ...publish, release: changedRelease }, current, publishAuth), /does not bind this release/);
  await admin.query("UPDATE efra_statistical.grant SET active = false WHERE environment=$1 AND person=$2", [environment, subjects.publisher]);
  await assert.rejects(writer.commit(b, licensed, publish, current, publishAuth), { code: "42501" });
  await admin.query("UPDATE efra_statistical.grant SET active = true WHERE environment=$1 AND person=$2", [environment, subjects.publisher]);
  const published = await writer.commit(b, licensed, publish, current, publishAuth);
  assert.equal((await reader.activeReceipt(environment))?.id, published);
  const output = await reader.read(original.data, original.release, licensed);
  assert.equal(output.status, "PUBLISHED");
  assert.equal(output.leaderboards.length, 5);
  assert.ok(output.honors.every((honor) => honor.recipient === null));
  assert.equal((await reader.read(original.data, original.release, { ...licensed, isAccessGrantCurrent: () => false })).status, "WITHHELD");
  assert.equal((await reader.read(original.data, original.release, { ...licensed, now: "2099-01-01T00:00:00.000Z" })).status, "WITHHELD");
  await admin.query("UPDATE efra_statistical.grant SET active = false WHERE environment=$1 AND person=$2", [environment, subjects.reviewer]);
  assert.equal((await reader.read(original.data, original.release, licensed)).status, "WITHHELD");
  await admin.query("UPDATE efra_statistical.grant SET active = true WHERE environment=$1 AND person=$2", [environment, subjects.reviewer]);

  const rewritten = await prepared(await evidence({ origin: "REAL", correction: "rewrite" }), licensed);
  const wrong = payload(rewritten.target, published);
  await assert.rejects(writer.commit(b, licensed, { action: reviewAction, bundle: rewritten.data }, wrong,
    await authorization(b, "reviewer", reviewAction, wrong)), { code: "23514" });
  assert.equal((await reader.activeReceipt(environment))?.id, published);
  const next = await prepared(await evidence({ origin: "REAL", correction: "append" }), licensed);
  const correction = payload(next.target, published);
  const corrected = await writer.commit(b, licensed, { action: reviewAction, bundle: next.data }, correction,
    await authorization(b, "reviewer", reviewAction, correction));
  assert.equal((await reader.read(original.data, original.release, licensed)).status, "WITHHELD");
  const releaseNext = payload(next.target, corrected, canonicalSha256(next.release));
  const newHead = await writer.commit(b, licensed, { action: publishAction, bundle: next.data, release: next.release }, releaseNext,
    await authorization(b, "publisher", publishAction, releaseNext));
  assert.equal((await reader.read(original.data, original.release, licensed)).status, "WITHHELD");
  assert.equal((await reader.read(next.data, next.release, licensed)).status, "PUBLISHED");
  const revoke = payload(canonicalSha256(next.release), newHead);
  await writer.commit(b, context, { action: revokeAction }, revoke, await authorization(b, "publisher", revokeAction, revoke));
  assert.equal((await reader.read(next.data, next.release, licensed)).status, "WITHHELD");
  await assert.rejects(admin.query("UPDATE efra_statistical.event SET reason = 'rewritten'"), { code: "55000" });
  const audit = await admin.query<{ action: string; actor: string }>("SELECT action,actor FROM efra_statistical.event ORDER BY seq");
  assert.deepEqual(audit.rows.map((record) => record.action), ["REVIEW", "REVIEW", "PUBLISH", "REVIEW", "PUBLISH", "REVOKE"]);
  assert.equal(audit.rows.at(-1)?.actor, subjects.publisher);
  const unavailable = new PostgresEfaPublicationReader({ query: () => { throw new Error("Database unavailable"); } } as unknown as Pool);
  assert.deepEqual(await unavailable.read(next.data, next.release, licensed), { schema: statisticalReadVersion, status: "WITHHELD" });
});
