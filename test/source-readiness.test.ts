import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assessFilmAnnotation, assessSourceCoverage, evidenceCoverageMatrix, filmLabContractVersion, inspectSourceFixture,
  positionMetricRegistry, sourceAdapterVersion, statsNScoreDocumentedOperations } from "../src/index.ts";
import type { AuditedSourceId, FilmAnnotation, FilmReview, FixtureIdentityResolver, SourceFixtureExport, SourceFixtureRequest,
  SourceFixtureRow, SourceMapping } from "../src/index.ts";
import { canonicalSha256 } from "../src/ingest/determinism.ts";

test("SOURCE READINESS | generated matrix covers every registry field, source, participation and path", async () => {
  const matrix = evidenceCoverageMatrix();
  const serialized = JSON.parse(await readFile(new URL("../docs/evidence-coverage-v1.json", import.meta.url), "utf8"));
  assert.deepEqual(serialized, matrix);
  assert.equal(matrix.positions.length, 24);
  assert.equal(matrix.metrics.length, 201);
  const registry = positionMetricRegistry();
  assert.equal(matrix.registryVersion, registry.version);
  for (const [index, field] of matrix.metrics.entries()) {
    const entry = registry.metrics[index]!;
    assert.deepEqual([field.position, field.field, field.unit, field.sourceCapability, field.tiers],
      [entry.position, entry.field, entry.unit, entry.sourceCapability, entry.tiers]);
    assert.ok(field.definition && field.requiredProof.length && field.missing.includes("WRITTEN_EFRA_RIGHTS"));
    assert.deepEqual(Object.keys(field.sources).sort(), Object.keys(matrix.sources).sort());
    for (const supplier of field.possibleSuppliers) assert.ok(Object.hasOwn(matrix.sources, supplier));
  }
  for (const { position, participation, paths } of matrix.positions) {
    assert.equal(participation.evidenceComplete, false);
    for (const source of Object.keys(matrix.sources) as AuditedSourceId[]) {
      const result = assessSourceCoverage(position, source);
      assert.equal(result.empiricalValidation, false);
      assert.equal(result.officialRatingEligible, false);
      assert.deepEqual(result.core.fullyEvidenced, []);
      assert.deepEqual(result.paths.map(({ id }) => id), paths.map(({ id }) => id));
      assert.ok(result.paths.every(({ status, missingParticipation }) => status === "BLOCKED" && missingParticipation));
    }
  }
});

test("SOURCE READINESS | UI, API documentation, historical samples and team proxies are distinct", () => {
  const matrix = evidenceCoverageMatrix();
  assert.equal(matrix.sources.GFL_STATS_N_SCORE.api, "DOCUMENTED_OPERATIONS_NOT_FIELD_CONTRACT");
  assert.equal(matrix.sources.GFL2_STATS_N_SCORE.apiResponse, "NOT_TESTED");
  assert.equal(matrix.sources.EPFR_EFA_PLAYER.api, "NO_PUBLIC_CONTRACT_VERIFIED");
  assert.ok(statsNScoreDocumentedOperations.includes("gamedatajson"));
  const epfr = assessSourceCoverage("QB", "EPFR_EFA_PLAYER");
  assert.equal(epfr.core.documentedCandidates.length, 5);
  assert.ok(epfr.core.gaps.some(({ field }) => field === "context.expectedTouchdowns"));
  assert.equal(assessSourceCoverage("QB", "EPFR_EFA_TEAM").core.documentedCandidates.length, 0);
  assert.ok(assessSourceCoverage("QB", "EPFR_EFA_TEAM").relatedContextFields.includes("passing.yards"));
  assert.equal(assessSourceCoverage("CB", "GFL_STATS_N_SCORE").supportingOnly, true);
  assert.ok(assessSourceCoverage("OT", "GFL2_STATS_N_SCORE").charting.coreFields.includes("edgePassBlockAssignments"));
  assert.ok(assessSourceCoverage("QB", "GFL2_ARCHIVE_GAMEBOOK").supplementaryCandidates.includes("advancedPassing.nonTouchdownFirstDowns"));
  assert.ok(!assessSourceCoverage("QB", "GFL2_STATS_N_SCORE").supplementaryCandidates.includes("advancedPassing.nonTouchdownFirstDowns"));
  assert.ok(assessSourceCoverage("P", "GFL2_ARCHIVE_GAMEBOOK").paths.find(({ id }) => id === "P_UNRETURNED_ONLY_V1")
    ?.verifyZero.includes("returnedPunts"));
  assert.ok(epfr.paths.find(({ id }) => id === "QB_RUSH_ONLY_SPECIAL")?.verifyZero.includes("passing.attempts"));
  assert.equal(assessSourceCoverage("K", "GFL_STATS_N_SCORE").core.documentedCandidates.length, 4);
  assert.ok(assessSourceCoverage("K", "GFL_STATS_N_SCORE").core.gaps.some(({ field }) => field === "expectedFieldGoalsByDistance"));
});

const kickoff = "2026-06-10T11:00:00.000Z";
const epfrRequest: SourceFixtureRequest = { version: sourceAdapterVersion, provider: "EPFR", competition: "EFA",
  operation: "SYNTHETIC_EXPORT", gameKey: "sim-game-1", seasonKey: "sim-season" };
const snsRequest: SourceFixtureRequest = { ...epfrRequest, provider: "STATS_N_SCORE", competition: "GFL2", operation: "gamedatajson" };
const player: SourceFixtureRow = {
  recordKey: "sim-row", playerKey: "sim-player", teamKey: "sim-home", opponentKey: "sim-away", position: "QB",
  participation: "REPORTED_PLAYED", fields: [
    { sourceField: "fixture-passes", unit: "attempts", state: "REPORTED", value: 0 },
    { sourceField: "fixture-completions", unit: "completions", state: "REPORTED", value: null },
    { sourceField: "fixture-yards", unit: "yards", state: "CONFLICTED" },
    { sourceField: "fixture-touchdowns", unit: "touchdowns", state: "NOT_APPLICABLE" },
  ],
};
const mapping = (request: SourceFixtureRequest): SourceMapping => ({
  version: "sim-map-1", provider: request.provider, competition: request.competition, sourceSchemaVersion: "fixture-schema-1",
  bindings: [
    { position: "QB", sourceField: "fixture-passes", field: "passing.attempts", unit: "attempts", conventionVersion: "sim-box-1" },
    { position: "QB", sourceField: "fixture-completions", field: "passing.completions", unit: "completions", conventionVersion: "sim-box-1" },
    { position: "QB", sourceField: "fixture-yards", field: "passing.yards", unit: "yards", conventionVersion: "sim-box-1" },
    { position: "QB", sourceField: "fixture-touchdowns", field: "passing.touchdowns", unit: "touchdowns", conventionVersion: "sim-box-1" },
  ],
});
const fixture = (request: SourceFixtureRequest, rows: readonly SourceFixtureRow[] = [player], id = "sim-rev1", supersedes?: string): SourceFixtureExport => ({
  version: sourceAdapterVersion, origin: "SYNTHETIC", permission: "SYNTHETIC_FIXTURE", request, rows,
  schemaVersion: "fixture-schema-1", playedAt: kickoff, finality: "FINAL",
  revision: { id, rowsSha256: canonicalSha256(rows), ...(supersedes && { supersedes }) },
});
const uuid = (suffix: string) => "00000000-0000-4000-8000-0000000000" + suffix;
const resolver: FixtureIdentityResolver = { resolve: async (scope, playedAt, row) => ({
  bindingSha256: canonicalSha256([scope, playedAt, row]), playedAt, position: row.position,
  competitionId: uuid(scope.competition === "EFA" ? "01" : "09"), seasonId: uuid("02"),
  gameId: uuid(scope.gameKey === "sim-game-1" ? "03" : "13"), playerId: uuid("04"),
  teamId: uuid(row.teamKey === "sim-home" ? "05" : "06"), opponentId: uuid(row.teamKey === "sim-home" ? "06" : "05"),
}) };

test("SIMULATION | both provider ports preserve missing, reported zero, conflict and not applicable", async () => {
  for (const request of [epfrRequest, snsRequest]) {
    const inspected = await inspectSourceFixture(request, mapping(request), {
      readFixture: async (asked) => { assert.deepEqual(asked, request); return fixture(request); },
    }, resolver);
    assert.equal(inspected.importAllowed, false);
    const row = inspected.rows[0]!;
    assert.equal(row.status, "UNVERIFIED_FIXTURE");
    assert.ok(row.status === "UNVERIFIED_FIXTURE");
    assert.equal(row.participation.verified, false);
    assert.deepEqual(row.fields["passing.attempts"]?.observation, { status: "REPORTED_ZERO", value: 0 });
    assert.deepEqual(row.fields["passing.completions"]?.observation, { status: "MISSING", reason: "NULL" });
    assert.deepEqual(row.fields["passing.interceptions"]?.observation, { status: "MISSING", reason: "NO_COLUMN" });
    assert.deepEqual(row.fields["passing.yards"]?.observation, { status: "CONFLICTED" });
    assert.deepEqual(row.fields["passing.touchdowns"]?.observation, { status: "NOT_APPLICABLE" });
  }
});

test("SIMULATION | fixtures reject real exports, incorrect units, duplicates, malformed mappings and bad canonical links", async () => {
  const request = snsRequest;
  const review = (payload: unknown, mapped = mapping(request), aliases = resolver) =>
    inspectSourceFixture(request, mapped, { readFixture: async () => payload }, aliases);
  await assert.rejects(review({ ...fixture(request), origin: "REAL" }), /non-synthetic/);
  await assert.rejects(review(fixture(request, [{ ...player,
    fields: [{ sourceField: "fixture-passes", state: "REPORTED", unit: "yards", value: 1 }] }])), /unit mismatch/);
  await assert.rejects(review(fixture(request, [{ ...player,
    fields: [{ sourceField: "fixture-passes", state: "REPORTED", unit: "attempts", value: -1 }] }])), /domain/);
  await assert.rejects(review(fixture(request, [player, { ...player, recordKey: "other-alias" }])), /canonical game or player position/);
  await assert.rejects(review(fixture(request, [player, { ...player, recordKey: "other-role", position: "WR",
    teamKey: "sim-away", opponentKey: "sim-home", fields: [] }])), /canonical game or player position/);
  await assert.rejects(review(fixture(request, [{ ...player, participation: "REPORTED_DID_NOT_PLAY",
    fields: [{ sourceField: "fixture-passes", state: "REPORTED", unit: "attempts", value: 1 }] }])), /contradicts/);
  await assert.rejects(review(fixture(request), { ...mapping(request),
    bindings: [...mapping(request).bindings, mapping(request).bindings[0]!] }), /field mapping/);
  assert.deepEqual((await review(fixture(request), mapping(request), {
    resolve: async () => null,
  })).rows, [{ recordKey: player.recordKey, status: "UNRESOLVED_IDENTITY" }]);
});

test("SIMULATION | fixture revisions are scoped, explicit and replayable across transfer and multi-position records", async () => {
  const run = (request: SourceFixtureRequest, data: SourceFixtureExport, head?: Awaited<ReturnType<typeof inspectSourceFixture>>["revision"]) =>
    inspectSourceFixture(request, mapping(request), { readFixture: async () => data }, resolver, head);
  const request = epfrRequest;
  const multi = fixture(request, [player, { ...player, recordKey: "sim-wr", position: "WR", fields: [] }]);
  const baseline = await run(request, multi);
  assert.equal(baseline.rows.length, 2);
  assert.equal((await run(request, multi, baseline.revision)).sameRevision, true);
  await assert.rejects(run(request, fixture(request), baseline.revision), /Conflicting/);
  const correction = await run(request, fixture(request, [player], "sim-rev2", "sim-rev1"), baseline.revision);
  assert.equal(correction.sameRevision, false);
  await assert.rejects(run(request, fixture(request, [player], "sim-rev3", "sim-rev1"), correction.revision), /unparented/);
  const transferred = { ...request, gameKey: "sim-game-2" };
  const transfer = await run(transferred, fixture(transferred, [{ ...player, teamKey: "sim-away", opponentKey: "sim-home" }]));
  assert.ok(transfer.rows[0]?.status === "UNVERIFIED_FIXTURE" && baseline.rows[0]?.status === "UNVERIFIED_FIXTURE");
  assert.equal(transfer.rows[0].identity.playerId, baseline.rows[0].identity.playerId);
  assert.notEqual(transfer.rows[0].identity.teamId, baseline.rows[0].identity.teamId);
  await assert.rejects(run(transferred, fixture(transferred), correction.revision), /Conflicting/);
});

test("SIMULATION | one provider identity cannot resolve to different players or teams within a game", async () => {
  const rows: SourceFixtureRow[] = [player, { ...player, recordKey: "sim-wr", position: "WR", fields: [] }];
  for (const change of [{ playerId: uuid("44") }, { teamId: uuid("06"), opponentId: uuid("05") }]) {
    await assert.rejects(inspectSourceFixture(epfrRequest, mapping(epfrRequest), {
      readFixture: async () => fixture(epfrRequest, rows),
    }, { resolve: async (...args) => {
      const result = await resolver.resolve(...args);
      return result && args[2].position === "WR" ? { ...result, ...change } : result;
    } }), /Conflicting provider identity/);
  }
});

test("SIMULATION | asynchronous fixture ports cannot change the inputs bound to the revision", async () => {
  const mutable = mapping(epfrRequest);
  const clean = await inspectSourceFixture(epfrRequest, mutable, { readFixture: async () => fixture(epfrRequest) }, resolver);
  const inspected = await inspectSourceFixture(epfrRequest, mutable, { readFixture: async (asked) => {
    Reflect.set(asked, "gameKey", "sim-other-game");
    Reflect.set(mutable.bindings[0]!, "field", "passing.interceptions");
    return fixture(epfrRequest);
  } }, { resolve: async (...args) => {
    const result = await resolver.resolve(...args);
    Reflect.set(args[2], "playerKey", "sim-other-player");
    return result;
  } });
  assert.deepEqual(inspected, clean);
});

const clipDigest = "b".repeat(64);
const annotation: FilmAnnotation = {
  version: filmLabContractVersion, origin: "SYNTHETIC", protocolVersion: "sim-protocol-1",
  annotationId: "sim-annotation", revision: 1, annotatorSubject: "sim-charting-a", submittedAt: "2026-06-11T12:00:00.000Z",
  snap: { competitionId: "sim-league", seasonId: "sim-season", gameId: "sim-game", playId: "sim-play", snapId: "sim-snap",
    sequence: 1, period: 1, clockRemainingMs: 120_000, playedAt: kickoff, phase: "SCRIMMAGE", validity: "COUNTED",
    down: 3, yardsToGo: 5, startFieldYard: 40, clips: [{ assetId: "sim-video", assetSha256: "a".repeat(64),
      clipSha256: clipDigest, rightsStatus: "SYNTHETIC_FIXTURE", rightsReference: "sim-fixture-rights", angle: "END_ZONE",
      startMs: 1000, endMs: 3000 }] },
  participation: { status: "IDENTIFIED", playerId: "sim-player", teamId: "sim-team", position: "OT", alignment: "left" },
  assignments: [{ assignmentId: "sim-block", family: "BLOCKING", role: "PASS_PROTECTION",
    opportunity: "ELIGIBLE", outcome: "SUCCESS", evidenceClipSha256: [clipDigest] }],
};
const trusted = { authenticatedAnnotatorSubject: annotation.annotatorSubject };
const accept = (input: FilmAnnotation, reviewer = "sim-charting-b") => {
  const review: FilmReview = { annotationSha256: canonicalSha256(input), reviewedAt: "2026-06-12T12:00:00.000Z",
    decision: "ACCEPTED", protocolVersion: input.protocolVersion, reviewReference: "sim-reviewed" };
  return { review, authenticatedReviewerSubject: reviewer };
};

test("SIMULATION | Film Lab binds an independent review to exact clips, role and revision without releasing data", () => {
  assert.equal(assessFilmAnnotation(annotation, trusted).status, "NEEDS_REVIEW");
  const result = assessFilmAnnotation(annotation, { ...trusted, independentReview: accept(annotation) });
  assert.equal(result.status, "SYNTHETIC_REVIEW_ACCEPTED");
  assert.equal(result.eligibleForCanonicalImport, false);
  assert.throws(() => assessFilmAnnotation(annotation, { ...trusted, independentReview: accept(annotation, annotation.annotatorSubject) }),
    /non-independent/);
  const revised: FilmAnnotation = { ...annotation, revision: 2, previousRevisionSha256: result.annotationSha256,
    correctionReason: "synthetic correction", submittedAt: "2026-06-12T11:00:00.000Z" };
  assert.equal(assessFilmAnnotation(revised, { ...trusted, previous: annotation, independentReview: accept(revised) }).status,
    "SYNTHETIC_REVIEW_ACCEPTED");
  assert.throws(() => assessFilmAnnotation(revised, { ...trusted, previous: annotation, independentReview: accept(annotation) }), /review/);
  assert.throws(() => assessFilmAnnotation({ ...revised, snap: { ...revised.snap, gameId: "other" } }, { ...trusted, previous: annotation }),
    /correction chain/);
});

test("SIMULATION | Film Lab refuses counted outcomes on ambiguous roles, no-plays and unlicensed clips", () => {
  const unclear: FilmAnnotation = { ...annotation, participation: { status: "UNRESOLVED", reason: "OFF_CAMERA" }, assignments: [] };
  assert.equal(assessFilmAnnotation(unclear, { ...trusted, independentReview: accept(unclear) }).status, "UNRESOLVED");
  assert.throws(() => assessFilmAnnotation({ ...unclear, assignments: annotation.assignments }, trusted), /ambiguous/);
  assert.throws(() => assessFilmAnnotation({ ...annotation, snap: { ...annotation.snap, validity: "NO_PLAY" } }, trusted), /ineligible/i);
  const noPlay: FilmAnnotation = { ...annotation, assignments: [], snap: { ...annotation.snap, validity: "NO_PLAY" } };
  assert.equal(assessFilmAnnotation(noPlay, trusted).status, "NOT_COUNTED");
  assert.throws(() => assessFilmAnnotation({ ...annotation, snap: { ...annotation.snap,
    clips: annotation.snap.clips.map((clip) => ({ ...clip, rightsStatus: "NOT_CLEARED" })) } }, trusted), /unauthorized/);
  assert.throws(() => assessFilmAnnotation({ ...annotation, assignments: [
    { ...annotation.assignments[0]!, evidenceClipSha256: ["0".repeat(64)] },
  ] }, trusted), /clip binding/);
});

test("SIMULATION | Film Lab distinguishes an unknown target or pressure from no opportunity", () => {
  const coverage: FilmAnnotation = { ...annotation, assignments: [{ assignmentId: "sim-coverage", family: "COVERAGE", role: "ZONE",
    opportunity: "UNRESOLVED", outcome: null, targeted: null, yardsAllowed: null, evidenceClipSha256: [clipDigest] }] };
  assert.equal(assessFilmAnnotation(coverage, trusted).status, "UNRESOLVED");
  const notApplicable: FilmAnnotation = { ...annotation, assignments: [{ assignmentId: "sim-rush", family: "PASS_RUSH", role: "EDGE",
    opportunity: "NOT_APPLICABLE", outcome: null, pressure: null, evidenceClipSha256: [clipDigest] }] };
  assert.equal(assessFilmAnnotation(notApplicable, trusted).status, "NEEDS_REVIEW");
});
