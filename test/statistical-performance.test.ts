import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  calculateStatisticalSeason, compareQbStatisticalReports, exportStatisticalReadModel, honorsCategories, normalizeEpfrQbFixture,
  normalizeStatsNScoreQbFixture, qbFields, qbPassingDefinitionVersion, qbUnits, reviewPassingHonors, signPilot,
  sourceAdapterVersion, statisticalReadVersion, statisticalVersion,
} from "../src/index.ts";
import type {
  ComparisonGroup, HonorsDecision, PassingHonorsCriteria, QbEligibilityPolicy, QbGameRevision,
  QbScheduledGame, QbStatDataset, QbStatRow, SourceFixtureExport, SourceFixtureRequest, SourceFixtureRow, SourceMapping,
  StatisticalContext, StatisticalRelease, StatisticalRights,
} from "../src/index.ts";
import { canonicalSha256 } from "../src/ingest/determinism.ts";

const sim = "sim-statistical-tests";
const digest = "d".repeat(64);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const utc = (day: string) => `2026-${day}T00:00:00.000Z`;
const purposes = ["STAT_DATA", "STAT_POLICY", "STAT_RIGHTS", "STAT_PUBLICATION", "STAT_HONORS_PROPOSAL", "STAT_HONORS_REVIEW"] as const;
const pairs = new Map(purposes.map((purpose) => [purpose, generateKeyPairSync("ed25519")]));
type Purpose = typeof purposes[number];
const keys: StatisticalContext["keys"] = {
  publicKey: (environment, purpose, keyId) => environment === sim && purpose === keyId ? pairs.get(purpose as Purpose)?.publicKey : undefined,
};
const context: StatisticalContext = { environment: sim, keys, personForKey: (key) => `sim-person-${key}`, now: utc("11-01") };
const signed = <T>(purpose: Purpose, body: T) => signPilot(sim, purpose, body, {
  keyId: purpose, sign: async (message) => sign(null, message, pairs.get(purpose)!.privateKey),
});
const group: ComparisonGroup = { version: "sim-2026-v1", competition: "EFA", competitionId: id(1), seasonId: id(2),
  year: 2026, stage: "REGULAR_SEASON", startsAt: utc("05-01"), endsBefore: utc("08-01") };
const g1: QbScheduledGame = { gameId: id(20), competitionId: group.competitionId, seasonId: group.seasonId, stage: group.stage,
  playedAt: utc("06-01"), homeTeamId: id(10), awayTeamId: id(11),
  candidates: [{ playerId: id(101), teamId: id(10) }, { playerId: id(102), teamId: id(11) }, { playerId: id(103), teamId: id(10) }] };
const g2: QbScheduledGame = { ...g1, gameId: id(21), playedAt: utc("06-08"), homeTeamId: id(12),
  candidates: [{ playerId: id(101), teamId: id(12) }] };
function row(n: number, team: number, values: readonly number[] = [10, 5, 55, 1, 0]): QbStatRow {
  const field = <K extends keyof typeof qbUnits>(name: K, value: number) =>
    ({ status: value === 0 ? "VERIFIED_ZERO" as const : "VERIFIED_VALUE" as const, value, evidenceSha256: digest, unit: qbUnits[name] });
  return { playerId: id(n), teamId: id(team), recordId: `sim-record-${n}`, role: { status: "PLAYED_QB", evidenceSha256: digest },
    fields: { attempts: field("attempts", values[0]!), completions: field("completions", values[1]!), yards: field("yards", values[2]!),
      touchdowns: field("touchdowns", values[3]!), interceptions: field("interceptions", values[4]!) } };
}
const r1: QbGameRevision = { id: "sim-r1", gameId: g1.gameId, availableAt: utc("06-02"), finality: "FINAL", source: "EPFR",
  artifactSha256: digest, mappingVersion: "sim-map", conventionVersion: "sim-source-convention",
  rows: [row(102, 11, [20, 10, 140, 3, 2]), row(103, 10, [20, 8, -5, 0, 1]), row(101, 10)] };
const r2: QbGameRevision = { ...r1, id: "sim-r2", gameId: g2.gameId, availableAt: utc("06-09"), rows: [row(101, 12, [20, 10, 90, 3, 1])] };
const dataset: QbStatDataset = { schema: statisticalVersion, passingDefinition: qbPassingDefinitionVersion, origin: "SYNTHETIC",
  version: "sim-dataset-1", asOf: utc("09-01"), group, manifest: { status: "COMPLETE", evidenceSha256: digest },
  games: [g2, g1], players: [103, 101, 102].map((n) => ({ id: id(n), name: `SIM QB ${n}` })),
  teams: [10, 11, 12].map((n) => ({ id: id(n), name: `SIM Team ${n}` })), revisions: [r2, r1] };
const policyFor = (body: QbStatDataset, overrides: Partial<QbEligibilityPolicy> = {}): QbEligibilityPolicy => ({
  schema: statisticalVersion, version: "sim-policy-1", groupSha256: canonicalSha256(body.group), minimumAttempts: 20,
  status: "PROVISIONAL", rationale: "Synthetic sample floor; no empirical claim.", completeness: "ALL_EXPECTED_GAMES", ...overrides,
});
const input = async (body: QbStatDataset = dataset, overrides?: Partial<QbEligibilityPolicy>) => ({
  dataset: await signed("STAT_DATA", body), policy: await signed("STAT_POLICY", policyFor(body, overrides)),
});
const rank = (analysis: ReturnType<typeof calculateStatisticalSeason>, metric: string) =>
  analysis.leaderboards.find((entry) => entry.metric === metric)!.entries.map(({ player, rank }) => [player.id, rank]);

test("SIMULATION | QB formulas use seasonal sums, exact stable ties, lower INT rate and the inclusive sample floor", async () => {
  const packet = await input();
  const output = calculateStatisticalSeason(packet, context);
  assert.equal(output.label, "SIMULATION");
  assert.equal(output.policy.status, "PROVISIONAL");
  const [a, b, c] = output.reports;
  assert.deepEqual(a!.raw, { attempts: 30, completions: 15, yards: 145, touchdowns: 4, interceptions: 1 });
  assert.deepEqual(a!.teams.map(({ id }) => id), [id(10), id(12)]);
  assert.deepEqual(a!.measures.completionPercentage, { numerator: 15, denominator: 30, value: 50, unit: "percent" });
  assert.equal(a!.measures.yardsPerAttempt?.value, 145 / 30);
  assert.equal(a!.measures.touchdownRate?.value, 4 / 30 * 100);
  assert.equal(a!.measures.interceptionRate?.value, 1 / 30 * 100);
  assert.equal(a!.measures.passingVolume?.value, 30);
  assert.equal(b!.eligibility, "ELIGIBLE");
  assert.equal(c!.measures.yardsPerAttempt?.value, -0.25);
  assert.deepEqual(rank(output, "completionPercentage"), [[id(101), 1], [id(102), 1], [id(103), 3]]);
  assert.deepEqual(rank(output, "interceptionRate"), [[id(101), 1], [id(103), 2], [id(102), 3]]);
  assert.deepEqual(rank(calculateStatisticalSeason(await input(dataset, { minimumAttempts: 21 }), context), "passingVolume"), [[id(101), 1]]);
  assert.deepEqual(calculateStatisticalSeason(packet, context), output);
});

test("SIMULATION | zero attempts, explicit DNP, unknown role, reported zero and missing game remain distinct", async () => {
  const zero = row(101, 10, [0, 0, 0, 0, 0]);
  const dnp = { ...row(102, 11, [0, 0, 0, 0, 0]), role: { status: "DID_NOT_PLAY_QB", evidenceSha256: digest } } as const;
  const reported = { ...row(103, 10), fields: { ...row(103, 10).fields, interceptions: { status: "REPORTED_ZERO", unit: "interceptions", value: 0 } } } as const;
  const base = { ...dataset, games: [g1], revisions: [{ ...r1, rows: [zero, dnp, reported] }] };
  const [a, b, c] = calculateStatisticalSeason(await input(base), context).reports;
  assert.equal(a!.raw?.attempts, 0);
  assert.equal(a!.measures.completionPercentage, null);
  assert.equal(a!.measures.passingVolume?.value, 0);
  assert.equal(a!.eligibility, "BELOW_MINIMUM_ATTEMPTS");
  assert.equal(b!.coverage.verifiedDidNotPlay, 1);
  assert.equal(b!.raw, null);
  assert.equal(c!.games[0]!.status, "MISSING_CORE");
  assert.equal(c!.raw, null);
  const detail = c!.games[0]!;
  assert.equal("fieldStatuses" in detail && detail.fieldStatuses.interceptions, "REPORTED_ZERO");
  const bad = calculateStatisticalSeason(await input({ ...base, games: [g1, g2], revisions: [{ ...r1,
    rows: [{ ...zero, role: { status: "UNKNOWN" } }] }] }), context);
  assert.deepEqual(bad.reports[0]!.games.map(({ status }) => status), ["UNVERIFIED_USAGE", "NO_GAME_REVISION"]);
  assert.equal(bad.reports[0]!.actualPosition, null);
  assert.equal(bad.reports[1]!.games[0]!.status, "MISSING_PLAYER_ROW");
});

test("SIMULATION | duplicate games and players, conflicting teams and mixed season phases fail closed", async () => {
  for (const bad of [{ ...dataset, games: [g1, g1] }, { ...dataset, games: [g1, { ...g1, gameId: id(30) }] },
    { ...dataset, games: [{ ...g1, stage: "PLAYOFFS" as const }] },
    { ...dataset, games: [{ ...g1, seasonId: id(99) }] },
    { ...dataset, revisions: [{ ...r1, rows: [...r1.rows, r1.rows[0]!] }] },
    { ...dataset, revisions: [{ ...r1, rows: [row(101, 11)] }] },
    { ...dataset, revisions: [{ ...r1, source: "STATS_N_SCORE" as const }] }]) {
    const packet = await input(bad);
    assert.throws(() => calculateStatisticalSeason(packet, context), /duplicate|team scope|simultaneous/i);
  }
});

test("SIMULATION | impossible counting, bad units, conflicts and unsafe aggregate ranges are detected", async () => {
  const malformed = { ...r1, rows: [row(101, 10, [10, 9, 1, 1, 2]), row(102, 11, [10, 0, 3, 0, 0]),
    { ...row(103, 10), fields: { ...row(103, 10).fields, interceptions: { status: "CONFLICTED", unit: "interceptions" } as const } }] };
  const bad = calculateStatisticalSeason(await input({ ...dataset, games: [g1], revisions: [malformed] }), context);
  assert.deepEqual(bad.reports.map(({ games }) => games[0]!.status), ["INVALID_CORE", "INVALID_CORE", "UNUSABLE_CORE"]);
  const badUnit = structuredClone(dataset);
  Reflect.set(badUnit.revisions[0]!.rows[0]!.fields.attempts, "unit", "yards");
  const packet = await input(badUnit);
  assert.throws(() => calculateStatisticalSeason(packet, context), /field value, unit or evidence/);
  const huge = Number.MAX_SAFE_INTEGER;
  const overflow = calculateStatisticalSeason(await input({ ...dataset, revisions: [
    { ...r1, rows: [row(101, 10, [huge, 1, 1, 0, 0])] }, { ...r2, rows: [row(101, 12, [1, 1, 1, 0, 0])] },
  ] }), context);
  assert.equal(overflow.reports[0]!.eligibility, "TOTAL_OUTSIDE_SAFE_RANGE");
  assert.equal(overflow.reports[0]!.raw, null);
});

test("SIMULATION | linked corrections replace prior values, provisional heads never fall back, old cutoffs remain reproducible", async () => {
  const prior = await input();
  const correction = { ...r2, id: "sim-r2-correction", supersedes: r2.id, availableAt: utc("09-02"),
    rows: [row(101, 12, [20, 9, 120, 3, 1])] };
  const corrected: QbStatDataset = { ...dataset, version: "sim-dataset-2", asOf: utc("09-03"), revisions: [correction, r1, r2] };
  const next = await input(corrected);
  const output = calculateStatisticalSeason(next, context);
  assert.equal(output.reports[0]!.raw?.yards, 175);
  assert.deepEqual(output.reports[0]!.games[1]!.sources.map(({ id }) => id), [r2.id, correction.id]);
  assert.equal(calculateStatisticalSeason(prior, context).reports[0]!.raw?.yards, 145);
  const delta = compareQbStatisticalReports(prior, next, context, id(101));
  assert.equal(delta.previous?.yardsPerAttempt?.numerator, 145);
  assert.equal(delta.current?.yardsPerAttempt?.numerator, 175);
  const provisional = await input({ ...corrected, revisions: [r1, r2, { ...correction, finality: "PROVISIONAL" }] });
  assert.equal(calculateStatisticalSeason(provisional, context).reports[0]!.games[1]!.status, "PROVISIONAL_GAME");
  assert.equal(calculateStatisticalSeason(provisional, context).reports[0]!.raw, null);
  for (const bad of [{ ...correction, supersedes: r1.id }, { ...correction, availableAt: utc("09-04") },
    { ...correction, source: "EFA_OFFICIAL" as const }, { ...correction, id: r2.id }]) {
    const packet = await input({ ...corrected, revisions: [r1, r2, bad] });
    assert.throws(() => calculateStatisticalSeason(packet, context), /conflicting or duplicate game revision/);
  }
  const rewritten = await input({ ...corrected, revisions: [r1, { ...r2, artifactSha256: "a".repeat(64) }, correction] });
  assert.throws(() => compareQbStatisticalReports(prior, rewritten, context, id(101)), /rewrite/);
});

test("SIMULATION | comparison groups are isolated and policies/signatures cannot be rebound", async () => {
  const epfr = await input();
  for (const [competition, stage, source] of [["GFL", "REGULAR_SEASON", "STATS_N_SCORE"], ["GFL2", "REGULAR_SEASON", "STATS_N_SCORE"],
    ["EFA", "PLAYOFFS", "EFA_OFFICIAL"]] as const) {
    const g = { ...group, competition, stage, competitionId: id(3), version: `sim-${competition}-${stage}` };
    const packet = await input({ ...dataset, group: g, games: dataset.games.map((game) => ({ ...game, competitionId: g.competitionId, stage })),
      revisions: dataset.revisions.map((r) => ({ ...r, source })) });
    assert.equal(calculateStatisticalSeason(packet, context).group.stage, stage);
    assert.throws(() => calculateStatisticalSeason({ ...packet, policy: epfr.policy }, context), /eligibility policy/);
    assert.throws(() => compareQbStatisticalReports(epfr, packet, context, id(101)), /same group/);
  }
  assert.throws(() => calculateStatisticalSeason({ ...epfr, dataset: { ...epfr.dataset, body: { ...dataset, origin: "REAL" } } }, context),
    /signature verification/);
  assert.throws(() => calculateStatisticalSeason(epfr, { ...context, personForKey: () => "same-person" }), /non-independent/);
  assert.throws(() => calculateStatisticalSeason(epfr, { ...context, personForKey: () => undefined }), /active authenticated/);
  const incomplete = calculateStatisticalSeason(await input({ ...dataset, manifest: { ...dataset.manifest, status: "INCOMPLETE" } }), context);
  assert.equal(incomplete.quality.eligiblePlayers, 0);
});

test("SIMULATION | both Phase 16 fixture ports require canonical scope and never verify reported numbers", async () => {
  const epfr = { version: sourceAdapterVersion, provider: "EPFR", competition: "EFA", operation: "SYNTHETIC_EXPORT",
    gameKey: "sim-game", seasonKey: "sim-2026" } as const;
  const sns = { ...epfr, provider: "STATS_N_SCORE", competition: "GFL2", operation: "gamedatajson" } as const;
  for (const request of [epfr, sns] satisfies SourceFixtureRequest[]) {
    const rows: SourceFixtureRow[] = [{ position: "QB", recordKey: "sim-row", playerKey: "sim-player", teamKey: "sim-home",
      opponentKey: "sim-away", participation: "REPORTED_PLAYED", fields: [
        { sourceField: "sim-attempts", state: "REPORTED", unit: "attempts", value: 0 },
      ] }];
    const mapping: SourceMapping = { version: "sim-map", competition: request.competition, provider: request.provider,
      sourceSchemaVersion: "sim-vendor-schema", bindings: qbFields.map((name) => ({ position: "QB", sourceField: `sim-${name}`,
        field: `passing.${name}`, unit: qbUnits[name], conventionVersion: "sim-convention" })) };
    const fixture: SourceFixtureExport = { request, version: sourceAdapterVersion, origin: "SYNTHETIC", permission: "SYNTHETIC_FIXTURE",
      playedAt: g1.playedAt, finality: "FINAL", schemaVersion: mapping.sourceSchemaVersion, rows,
      revision: { id: "sim-provider-revision", rowsSha256: canonicalSha256(rows) } };
    const run = (game = g1) => {
      const options = { group: { ...group, competition: request.competition }, game, mapping, conventionVersion: "sim-convention",
        transport: { readFixture: async () => fixture }, availableAt: r1.availableAt,
        identities: { resolve: async (...args: [SourceFixtureRequest, string, Pick<SourceFixtureRow, "playerKey" | "teamKey" | "opponentKey" | "position">]) => ({
          bindingSha256: canonicalSha256(args), competitionId: group.competitionId, seasonId: group.seasonId, gameId: g1.gameId,
          playerId: id(101), teamId: id(10), opponentId: id(11), position: "QB" as const, playedAt: g1.playedAt,
        }) } };
      return request.provider === "EPFR" ? normalizeEpfrQbFixture(request, options) : normalizeStatsNScoreQbFixture(request, options);
    };
    const imported = await run();
    assert.equal(imported.importAllowed, false);
    assert.equal(imported.revision.rows[0]!.fields.attempts.status, "REPORTED_ZERO");
    assert.equal(imported.revision.rows[0]!.fields.yards.status, "MISSING");
    assert.equal(imported.revision.rows[0]!.role.status, "UNKNOWN");
    await assert.rejects(run({ ...g1, stage: "PLAYOFFS" }), /season phase/);
    await assert.rejects(run({ ...g1, gameId: id(97) }), /schedule/);
    const packet = await input({ ...dataset, group: { ...group, competition: request.competition }, games: [g1], revisions: [imported.revision] });
    assert.equal(calculateStatisticalSeason(packet, context).reports[0]!.games[0]!.status, "UNVERIFIED_USAGE");
  }
});

test("SIMULATION | synthetic provider export → normalized observations → explicit review → reproducible private leaderboard", async () => {
  const request = { version: sourceAdapterVersion, provider: "STATS_N_SCORE", competition: "GFL", operation: "gamestatsjson",
    gameKey: "sim-game", seasonKey: "sim-season" } as const;
  const sourceGroup = { ...group, competition: request.competition, version: "sim-gfl-2026" };
  const game = { ...g1, candidates: [g1.candidates[0]!] };
  const raw = [20, 10, 120, 2, 0];
  const rows: SourceFixtureRow[] = [{ position: "QB", recordKey: "sim-row", playerKey: "sim-player", teamKey: "sim-home",
    opponentKey: "sim-away", participation: "REPORTED_PLAYED", fields: qbFields.map((name, i) =>
      ({ sourceField: name, unit: qbUnits[name], state: "REPORTED", value: raw[i]! })) }];
  const mapping: SourceMapping = { version: "sim-map", competition: request.competition, provider: request.provider,
    sourceSchemaVersion: "sim-schema", bindings: qbFields.map((name) => ({ position: "QB", sourceField: name, field: `passing.${name}`,
      unit: qbUnits[name], conventionVersion: "sim-convention" })) };
  const fixture: SourceFixtureExport = { request, version: sourceAdapterVersion, origin: "SYNTHETIC", permission: "SYNTHETIC_FIXTURE",
    playedAt: game.playedAt, finality: "FINAL", schemaVersion: mapping.sourceSchemaVersion, rows,
    revision: { id: "sim-provider-revision", rowsSha256: canonicalSha256(rows) } };
  const normalized = await normalizeStatsNScoreQbFixture(request, { group: sourceGroup, game, mapping, conventionVersion: "sim-convention",
    transport: { readFixture: async () => fixture }, availableAt: r1.availableAt,
    identities: { resolve: async (...args) => ({ bindingSha256: canonicalSha256(args), competitionId: sourceGroup.competitionId,
      seasonId: sourceGroup.seasonId, gameId: game.gameId, playerId: id(101), teamId: game.homeTeamId, opponentId: game.awayTeamId,
      position: "QB", playedAt: game.playedAt }) } });
  const unreviewed = normalized.revision.rows[0]!;
  assert.equal(unreviewed.fields.interceptions.status, "REPORTED_ZERO");
  const reviewedFields = row(101, 10, raw).fields;
  for (const name of qbFields) {
    const original = unreviewed.fields[name];
    assert.ok("value" in original && "value" in reviewedFields[name] && original.value === reviewedFields[name].value);
  }
  const packet = await input({ ...dataset, group: sourceGroup, games: [game], revisions: [{ ...normalized.revision, rows: [
    { ...unreviewed, role: { status: "PLAYED_QB", evidenceSha256: digest }, fields: reviewedFields },
  ] }] });
  const result = calculateStatisticalSeason(packet, context);
  assert.equal(result.reports[0]!.measures.yardsPerAttempt?.value, 6);
  assert.deepEqual(rank(result, "passingVolume"), [[id(101), 1]]);
  assert.deepEqual(calculateStatisticalSeason(packet, context), result);
  assert.equal(exportStatisticalReadModel(packet, context).status, "WITHHELD");
});

test("SIMULATION | rounded display collisions do not create ties", async () => {
  const n = 4_000_000_000_000_000;
  const fixture = await input({ ...dataset, games: [g1], revisions: [{ ...r1, rows: [
    row(101, 10, [n + 1, n, 1, 0, 0]), row(102, 11, [n + 2, n + 1, 1, 0, 0]), row(103, 10),
  ] }] }, { minimumAttempts: 10 });
  const result = calculateStatisticalSeason(fixture, context);
  assert.equal(result.reports[0]!.measures.completionPercentage?.value, result.reports[1]!.measures.completionPercentage?.value);
  assert.deepEqual(rank(result, "completionPercentage"), [[id(102), 1], [id(101), 2], [id(103), 3]]);
});

test("SIMULATION | all five Honors are defined; a signed proposal, independent decision and withdrawal are auditable", async () => {
  assert.deepEqual(Object.keys(honorsCategories), ["PASSING_EFFICIENCY", "RUSHING_EFFICIENCY", "RECEIVING_PRODUCTION",
    "KICKING_ACCURACY", "RETURN_PERFORMANCE"]);
  const packet = await input(dataset, { status: "APPROVED" });
  const result = calculateStatisticalSeason(packet, context);
  const criteriaBody: PassingHonorsCriteria = { schema: statisticalVersion, version: "sim-honors-1", category: "PASSING_EFFICIENCY",
    metric: "yardsPerAttempt", groupSha256: result.groupSha256, policySha256: result.policySha256,
    minimumAttempts: 20, status: "APPROVED", evidenceSha256: digest, tieRule: "WITHHOLD_TIED_LEAD" };
  const criteria = await signed("STAT_POLICY", criteriaBody);
  const proposalBody: HonorsDecision = { schema: statisticalVersion, action: "PROPOSE", at: utc("09-02"), playerId: id(102),
    analysisSha256: result.analysisSha256, criteriaSha256: canonicalSha256(criteriaBody), rationale: "Synthetic review exercise.",
    evidenceSha256: digest };
  const proposal = await signed("STAT_HONORS_PROPOSAL", proposalBody);
  const approvalBody: HonorsDecision = { ...proposalBody, action: "APPROVE", at: utc("09-03"), previousSha256: canonicalSha256(proposal) };
  const approval = await signed("STAT_HONORS_REVIEW", approvalBody);
  const withdrawal = await signed("STAT_HONORS_REVIEW", { ...approvalBody, action: "WITHDRAW" as const, at: utc("09-04"),
    previousSha256: canonicalSha256(approval) });
  assert.equal(reviewPassingHonors(packet, context, { criteria, decisions: [] }).nominee, null);
  assert.equal(reviewPassingHonors(packet, context, { criteria, decisions: [proposal] }).state, "PROPOSED");
  assert.equal(reviewPassingHonors(packet, context, { criteria, decisions: [proposal, approval] }).state, "APPROVED");
  const cancelled = reviewPassingHonors(packet, context, { criteria, decisions: [proposal, approval, withdrawal] });
  assert.equal(cancelled.state, "WITHDRAWN");
  assert.equal(cancelled.headSha256, canonicalSha256(withdrawal));
  assert.throws(() => reviewPassingHonors(packet, context, { criteria, decisions: [approval] }), /history/);
  assert.throws(() => reviewPassingHonors(packet, { ...context, personForKey: (key) =>
    key.startsWith("STAT_HONORS") ? "sim-same-person" : context.personForKey(key) },
  { criteria, decisions: [proposal, approval] }), /not independent/);
  const provisional = await signed("STAT_POLICY", { ...criteriaBody, status: "PROVISIONAL" as const });
  const prop2 = await signed("STAT_HONORS_PROPOSAL", { ...proposalBody, criteriaSha256: canonicalSha256(provisional.body) });
  const approve2 = await signed("STAT_HONORS_REVIEW", { ...approvalBody, criteriaSha256: canonicalSha256(provisional.body),
    previousSha256: canonicalSha256(prop2) });
  assert.throws(() => reviewPassingHonors(packet, context, { criteria: provisional, decisions: [prop2, approve2] }), /not approved/);
  const tied = await input({ ...dataset, revisions: [{ ...r1, rows: [row(102, 11, [20, 10, 140, 3, 2]), ...r1.rows.slice(1)] },
    { ...r2, rows: [row(101, 12, [20, 10, 155, 3, 1])] }] }, { status: "APPROVED" });
  const tiedProposal = await signed("STAT_HONORS_PROPOSAL", { ...proposalBody,
    analysisSha256: calculateStatisticalSeason(tied, context).analysisSha256 });
  assert.throws(() => reviewPassingHonors(tied, context, { criteria, decisions: [tiedProposal] }), /selectable/);
});

test("SIMULATION | synthetic statistics never enter the public read contract even with an approved policy and release", async () => {
  const packet = await input(dataset, { status: "APPROVED" });
  const output = calculateStatisticalSeason(packet, context);
  const release = await signed<StatisticalRelease>("STAT_PUBLICATION", { schema: statisticalReadVersion, analysisSha256: output.analysisSha256,
    approvedAt: utc("09-05"), expiresAt: utc("11-02"), reportPlayerIds: [id(101)], includeLeaderboards: true });
  assert.deepEqual(exportStatisticalReadModel(packet, context, { activeReleaseSha256: () => canonicalSha256(release) }, release),
    { schema: statisticalReadVersion, status: "WITHHELD" });
});

test("SIMULATION | isolated in-memory release exercise verifies rights, current release pointer and selective publishing", async () => {
  // No real data or rights. Exercise the REAL claim with synthetic bytes and ephemeral, test-only authorities.
  const packet = await input({ ...dataset, origin: "REAL" }, { status: "APPROVED" });
  assert.throws(() => calculateStatisticalSeason(packet, context), /synthetic-only/);
  const licensed: StatisticalContext = { ...context, licensedDataEnabled: true };
  assert.throws(() => calculateStatisticalSeason(packet, licensed), /rights missing/);
  const grant: StatisticalRights = { schema: statisticalVersion, licenseId: "sim-license", evidenceSha256: digest, source: "EPFR",
    groupSha256: canonicalSha256(group), datasetSha256: canonicalSha256(packet.dataset.body), validFrom: utc("08-01"),
    expiresAt: utc("11-02"), permits: ["IMPORT", "STORE", "DERIVE", "PUBLISH"] };
  const authorization = await signed("STAT_RIGHTS", grant);
  const withRights = { ...packet, rights: [authorization] };
  const result = calculateStatisticalSeason(withRights, licensed);
  const releaseBody: StatisticalRelease = { schema: statisticalReadVersion, analysisSha256: result.analysisSha256, approvedAt: utc("09-05"),
    expiresAt: utc("11-02"), reportPlayerIds: [id(101)], includeLeaderboards: false };
  const release = await signed("STAT_PUBLICATION", releaseBody);
  const registry = { activeReleaseSha256: () => canonicalSha256(release) };
  const output = exportStatisticalReadModel(withRights, licensed, registry, release);
  assert.equal(output.status, "PUBLISHED");
  assert.deepEqual(output.reports.map(({ player }) => player.id), [id(101)]);
  assert.deepEqual(output.leaderboards, []);
  assert.ok(output.honors.every(({ status, officialLeagueAward, recipient }) => status === "NOT_PUBLISHED" && !officialLeagueAward && !recipient));
  assert.equal(exportStatisticalReadModel(withRights, licensed, { activeReleaseSha256: () => undefined }, release).status, "WITHHELD");
  const noPublish = await signed("STAT_RIGHTS", { ...grant, permits: ["IMPORT", "STORE", "DERIVE"] as const });
  assert.equal(exportStatisticalReadModel({ ...packet, rights: [noPublish] }, licensed, registry, release).status, "WITHHELD");
  const expired = await signed("STAT_RIGHTS", { ...grant, expiresAt: context.now });
  assert.throws(() => exportStatisticalReadModel({ ...packet, rights: [expired] }, licensed, registry, release), /expired/);
  const tampered = { ...release, body: { ...release.body, includeLeaderboards: true } };
  assert.throws(() => exportStatisticalReadModel(withRights, licensed, registry, tampered), /verification failed/);
  assert.throws(() => exportStatisticalReadModel(withRights, { ...licensed, personForKey: (key) =>
    key === "STAT_PUBLICATION" ? context.personForKey("STAT_DATA") : context.personForKey(key) }, registry, release), /Invalid statistical release/);
  const unknown = await signed("STAT_PUBLICATION", { ...releaseBody, reportPlayerIds: [id(999)] });
  assert.throws(() => exportStatisticalReadModel(withRights, licensed, { activeReleaseSha256: () => canonicalSha256(unknown) }, unknown),
    /without complete player evidence/);
  const leaders = await signed("STAT_PUBLICATION", { ...releaseBody, includeLeaderboards: true, reportPlayerIds: [] });
  const boards = exportStatisticalReadModel(withRights, licensed, { activeReleaseSha256: () => canonicalSha256(leaders) }, leaders);
  assert.equal(boards.status, "PUBLISHED");
  assert.equal(boards.leaderboards.length, 5);
  assert.deepEqual(boards.reports, []);
  const criteria = await signed<PassingHonorsCriteria>("STAT_POLICY", { schema: statisticalVersion, version: "sim-release-honors",
    category: "PASSING_EFFICIENCY", metric: "yardsPerAttempt", groupSha256: result.groupSha256, policySha256: result.policySha256,
    minimumAttempts: 20, status: "APPROVED", evidenceSha256: digest, tieRule: "WITHHOLD_TIED_LEAD" });
  const proposal = await signed<HonorsDecision>("STAT_HONORS_PROPOSAL", { schema: statisticalVersion, action: "PROPOSE",
    analysisSha256: result.analysisSha256, criteriaSha256: canonicalSha256(criteria.body), playerId: id(102), at: utc("09-02"),
    rationale: "Synthetic release exercise.", evidenceSha256: digest });
  const approval = await signed<HonorsDecision>("STAT_HONORS_REVIEW", { ...proposal.body, action: "APPROVE",
    at: utc("09-03"), previousSha256: canonicalSha256(proposal) });
  const honorsRelease = await signed("STAT_PUBLICATION", { ...releaseBody, honorsHeadSha256: canonicalSha256(approval) });
  const pointer = { activeReleaseSha256: () => canonicalSha256(honorsRelease) };
  assert.throws(() => exportStatisticalReadModel(withRights, licensed, pointer, honorsRelease, { criteria, decisions: [proposal] }),
    /independently approved Honors/);
  const award = exportStatisticalReadModel(withRights, licensed, pointer, honorsRelease, { criteria, decisions: [proposal, approval] });
  assert.equal(award.status, "PUBLISHED");
  assert.equal(award.honors.find(({ id }) => id === "PASSING_EFFICIENCY")!.recipient?.id, id(102));
  assert.equal(JSON.stringify(award).includes("sim-person"), false);
});
