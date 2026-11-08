import assert from "node:assert/strict";
import { test } from "node:test";
import { describePositionModel, planImport } from "../src/index.ts";
import type { ImportManifest, ImportSourcePolicy } from "../src/index.ts";
import { game, missing, observed, passing, season, source, zeroPass } from "./simulation-fixtures.ts";

const manifest = {
  sourceId: source.sourceId, sourceRevision: source.revisionId, origin: "SYNTHETIC",
  competitionId: season.season.competitionId, seasonId: season.season.id,
  mappingVersion: "sim-mapping-v1", schemaVersion: "sim-schema-v1",
  payloadSha256: "a".repeat(64), retrievedAt: season.snapshot.availableAt,
} as const satisfies ImportManifest;
const approved = {
  sourceId: manifest.sourceId, competitionId: manifest.competitionId, seasonId: manifest.seasonId,
  mappingVersion: manifest.mappingVersion, permission: "SYNTHETIC_FIXTURE",
} as const satisfies ImportSourcePolicy;
const candidate = { sourceRecordId: "sim-record", game };

test("SIMULATION | dry-run gates block real batches, pending rights and an unregistered mapping", () => {
  assert.deepEqual(planImport({ ...manifest, origin: "REAL" }, approved, [candidate]), {
    status: "BLOCKED", reason: "REAL_IMPORT_DISABLED",
  });
  assert.deepEqual(planImport(manifest, { ...approved, permission: "PENDING" }, [candidate]), {
    status: "BLOCKED", reason: "SOURCE_NOT_APPROVED",
  });
  assert.deepEqual(planImport({ ...manifest, mappingVersion: "sim-unregistered" }, approved, [candidate]), {
    status: "BLOCKED", reason: "SOURCE_NOT_APPROVED",
  });
  assert.deepEqual(planImport({ ...manifest, payloadSha256: "invalid" }, approved, [candidate]), {
    status: "BLOCKED", reason: "INVALID_MANIFEST",
  });
});

test("SIMULATION | zero remains verifiable evidence while a missing QB field stages as incomplete", () => {
  const result = planImport(manifest, approved, [
    { sourceRecordId: "sim-zero", game: zeroPass },
    { sourceRecordId: "sim-missing", game: { ...passing({ attempts: missing }), gameId: "sim-game-missing" } },
  ]);
  assert.equal(result.status, "DRY_RUN");
  assert.equal(result.label, "SIMULATION");
  assert.deepEqual(result.rows.map(({ status, issues }) => ({ status, issues })), [
    { status: "STAGE_INCOMPLETE", issues: ["CORE_INCOMPLETE"] }, { status: "STAGE", issues: [] },
  ]);
});

test("SIMULATION | duplicated game-position identities quarantine both rows and are order-independent", () => {
  const duplicate = { sourceRecordId: "sim-conflicting-record", game: passing({ completions: observed(9) }) };
  const result = planImport(manifest, approved, [candidate, duplicate]);
  assert.equal(result.status, "DRY_RUN");
  assert.equal(result.rows.length, 2);
  for (const row of result.rows) {
    assert.equal(row.status, "QUARANTINE");
    assert.ok(row.issues.includes("DUPLICATE_GAME_POSITION"));
  }
  assert.deepEqual(planImport(manifest, approved, [duplicate, candidate]), result);
  const replay = planImport({ ...manifest, retrievedAt: season.asOf }, approved, [candidate, duplicate]);
  assert.equal(replay.status, "DRY_RUN");
  assert.equal(replay.batchKey, result.batchKey);
});

test("SIMULATION | provenance, usage, time scope and impossible counts are checked independently", () => {
  const result = planImport(manifest, approved, [{ ...candidate, game: {
    ...passing({ completions: observed(15), yards: { status: "OBSERVED", value: 1, source: { ...source, revisionId: "sim-old" } } }),
    playedAt: season.asOf,
  } }]);
  assert.equal(result.status, "DRY_RUN");
  assert.deepEqual(result.rows[0], {
    sourceRecordId: candidate.sourceRecordId, status: "QUARANTINE",
    issues: ["INVALID_EVIDENCE", "INVALID_IDENTITY_OR_SCOPE", "SOURCE_MISMATCH"],
  });
  const unknown = planImport(manifest, approved, [{ ...candidate, game: { ...game, usage: { status: "UNKNOWN" } } }]);
  assert.equal(unknown.status, "DRY_RUN");
  assert.deepEqual(unknown.rows[0]?.issues, ["UNVERIFIED_USAGE"]);
});

test("SIMULATION | role-specific catalog blocks a positive count at zero exposure and preserves multi-position identity", () => {
  const cb = {
    ...game, position: "CB" as const, stats: {
      definitionVersion: describePositionModel("CB").definitionVersion,
      observations: { nonTurnoverCoverageTargets: observed(0), nonTurnoverYardsAllowed: observed(4),
        runSupportTackleAttempts: observed(1), runSupportMisses: observed(0) },
    },
  };
  const result = planImport(manifest, approved, [candidate, { sourceRecordId: "sim-cb", game: cb }]);
  assert.equal(result.status, "DRY_RUN");
  assert.deepEqual(result.rows[0]?.issues, ["INVALID_EVIDENCE"]);
  assert.equal(result.rows[1]?.status, "STAGE");
});
