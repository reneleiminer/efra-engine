import assert from "node:assert/strict";
import test from "node:test";
import { authorizeEfaIntake, calculateStatisticalSeason, efaPublicationTarget, reconcileEfaQbSeason, verifyEfaDeliveryBytes } from "../src/index.ts";
import { canonicalSha256 } from "../src/ingest/determinism.ts";
import { book, bundle, context, delivery, evidence, feed, game, group, id, licensed, primary, row, signed, utc } from "./fixtures/efa-statistical.ts";

test("SIMULATION | independent EFA season evidence reconciles reproducibly and runs the five QB leaderboards", async () => {
  const input = await evidence();
  const result = reconcileEfaQbSeason(input, context);
  assert.equal(result.report.label, "SIMULATION");
  assert.deepEqual(result.report.issues, []);
  assert.equal(result.report.expectedGames, 1);
  assert.ok(result.dataset);
  assert.equal(result.dataset.manifest.evidenceSha256, result.reconciliationSha256);
  assert.equal(reconcileEfaQbSeason(input, context).reconciliationSha256, result.reconciliationSha256);
  const packet = await bundle(input);
  assert.match(efaPublicationTarget(packet, context), /^[a-f0-9]{64}$/);
  const season = calculateStatisticalSeason(packet.statistics, context);
  assert.deepEqual(season.leaderboards.map((leader) => leader.entries[0]?.measure.value), [50, 5, 10, 0, 10]);
  assert.equal(season.reports[1]?.coverage.verifiedDidNotPlay, 1);
});

test("SIMULATION | the independent schedule detects a game omitted by both deliveries", async () => {
  const missing = { ...game, gameId: id(21), playedAt: utc("06-08") };
  const input = await evidence({ transform: (entry) => entry.kind === "SCHEDULE"
    ? feed("SCHEDULE", { ...entry.dataset, games: [game, missing] }) : entry });
  const result = reconcileEfaQbSeason(input, context);
  assert.equal(result.dataset, null);
  assert.deepEqual(result.report.issues.filter((issue) => issue.gameId === missing.gameId), [
    { code: "MISSING_GAME", gameId: missing.gameId, feed: "EXPORT" },
    { code: "MISSING_GAME", gameId: missing.gameId, feed: "GAMEBOOK" },
  ]);
});

test("SIMULATION | the EFA report distinguishes numerical differences, unresolved roles, missing rows and conflicting canonical assignments", async () => {
  const changeBook = async (rows: typeof book.rows) => reconcileEfaQbSeason(await evidence({
    transform: (entry) => entry.kind === "GAMEBOOK" ? feed("GAMEBOOK", { ...entry.dataset, revisions: [{ ...book, rows }] }) : entry,
  }), context);
  assert.deepEqual((await changeBook([row(id(100), id(10), 55, true), book.rows[1]!])).report.issues,
    [{ code: "FIELD_MISMATCH", gameId: game.gameId, playerId: id(100), field: "yards" }]);
  assert.equal((await changeBook([{ ...book.rows[0]!, role: { status: "UNKNOWN" } }, book.rows[1]!])).report.issues[0]?.code,
    "UNVERIFIED_ROLE");
  assert.equal((await changeBook([book.rows[0]!])).report.issues[0]?.code, "MISSING_PLAYER");
  assert.equal((await changeBook([row(id(100), id(10), 0, false), book.rows[1]!])).report.issues[0]?.code, "ROLE_MISMATCH");
  const changedTeam = { ...game, candidates: [{ playerId: id(100), teamId: id(11) }, { playerId: id(101), teamId: id(11) }] };
  const differing = await evidence({ transform: (entry) => entry.kind === "GAMEBOOK" ? feed("GAMEBOOK", {
    ...entry.dataset, games: [changedTeam], revisions: [{ ...book, rows: [row(id(100), id(11), 50, true), book.rows[1]!] }],
  }) : entry });
  assert.ok(reconcileEfaQbSeason(differing, context).report.issues.some(({ code }) => code === "CANDIDATE_IDENTITY_MISMATCH"));
});

test("SIMULATION | aliases, roles, shared artifacts, corrected finality and phase boundaries fail closed", async () => {
  const alias = await evidence({ transform: (entry) => entry.kind === "EXPORT" ? { ...entry,
    identityLinks: [...entry.identityLinks, { ...entry.identityLinks[0]!, sourceId: "duplicate-identity" }] } : entry });
  assert.throws(() => reconcileEfaQbSeason(alias, context), /identity mapping/);
  const wrongRecord = await evidence({ transform: (entry) => entry.kind === "EXPORT" ? { ...entry, recordLinks: [
    { ...entry.recordLinks[0]!, sourcePlayerId: entry.recordLinks[1]!.sourcePlayerId }, entry.recordLinks[1]!,
  ] } : entry });
  assert.throws(() => reconcileEfaQbSeason(wrongRecord, context), /record conflicts/);
  const shared = await evidence({ transform: (entry) => entry.kind === "GAMEBOOK" ? { ...entry, dataset: { ...entry.dataset,
    revisions: [{ ...book, artifactSha256: primary.artifactSha256 }] } } : entry });
  assert.equal(reconcileEfaQbSeason(shared, context).report.issues[0]?.code, "SHARED_ARTIFACT");
  const corrected = await evidence({ correction: "append", transform: (entry) => entry.kind === "GAMEBOOK" ? { ...entry,
    dataset: { ...entry.dataset, revisions: [entry.dataset.revisions[0]!, { ...entry.dataset.revisions[1]!, finality: "PROVISIONAL" }] } } : entry });
  assert.equal(reconcileEfaQbSeason(corrected, context).report.issues[0]?.code, "PROVISIONAL_REVISION");
  const playoffs = await evidence({ transform: (entry) => ({ ...entry, dataset: { ...entry.dataset,
    group: { ...group, stage: "PLAYOFFS" } } }) });
  assert.throws(() => reconcileEfaQbSeason(playoffs, context), /regular season/);
  assert.throws(() => reconcileEfaQbSeason(shared, { ...context, personForKey: () => "same-person" }), /independent/);
});

test("SIMULATION | written access is required separately and exactly scoped before processing a licensed claim", async () => {
  const realClaim = await evidence({ origin: "REAL", publish: false });
  const grant = realClaim.access![0]!;
  const intake = { kind: grant.body.kind, deliverySha256: grant.body.deliverySha256, groupSha256: canonicalSha256(group) };
  const target = { ...intake, feedSha256: canonicalSha256(realClaim.schedule.body) };
  assert.throws(() => authorizeEfaIntake(context, grant, target), /synthetic-only/);
  assert.equal(authorizeEfaIntake(licensed, grant, target).publishDerived, false);
  assert.throws(() => authorizeEfaIntake({ ...licensed, isAccessGrantCurrent: () => false }, grant, target), /not currently authorized/);
  const expired = await signed("EFA_ACCESS", { ...grant.body, expiresAt: utc("10-01") });
  assert.throws(() => authorizeEfaIntake(licensed, expired, target), /expired/);
  assert.throws(() => authorizeEfaIntake(licensed, grant, { ...target, kind: "GAMEBOOK" }), /mismatched/);
  const { feedSha256: normalized, ...preflight } = grant.body;
  assert.equal(normalized, target.feedSha256);
  const beforeNormalization = await signed("EFA_ACCESS", preflight);
  assert.equal(verifyEfaDeliveryBytes(licensed, beforeNormalization, intake, delivery("SCHEDULE", "sim-efa-v1")).publishDerived, false);
  assert.throws(() => verifyEfaDeliveryBytes(licensed, beforeNormalization, intake, delivery("EXPORT", "sim-efa-v1")), /delivery bytes/);
  assert.throws(() => authorizeEfaIntake(licensed, beforeNormalization, target), /mismatched/);
  assert.throws(() => reconcileEfaQbSeason({ ...realClaim, access: [grant] }, licensed), /Separate written rights/);
  assert.equal(reconcileEfaQbSeason(realClaim, licensed).publishRights, false);
  const packet = await bundle(realClaim, licensed);
  const swapped = { ...packet, statistics: { ...packet.statistics, dataset: await signed("STAT_DATA", {
    ...packet.statistics.dataset.body, version: "sim-unreviewed-version",
  }) } };
  assert.throws(() => efaPublicationTarget(swapped, licensed), /rights|reconciled/);
});
