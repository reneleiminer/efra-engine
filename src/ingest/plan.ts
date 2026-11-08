import { isVerifiedSource, readObservation } from "../contracts/observations.ts";
import type { Observation, SourceQuality } from "../contracts/observations.ts";
import { timestamp } from "../contracts/time.ts";
import { describePositionModel } from "../models/positions/catalog.ts";
import { describePositionDataRequirements } from "../models/positions/data-requirements.ts";
import { readComponent } from "../models/positions/evidence.ts";
import { assessQbCore } from "../models/qb/core.ts";
import { compareId } from "../season/scope.ts";
import type { ImportCandidate, ImportManifest, ImportPlan, ImportQualityIssue, ImportRowDecision, ImportSourcePolicy } from "./contracts.ts";

export function planImport(
  manifest: ImportManifest,
  policy: ImportSourcePolicy,
  candidates: readonly ImportCandidate[],
): ImportPlan {
  if (manifest.origin !== "SYNTHETIC") return { status: "BLOCKED", reason: "REAL_IMPORT_DISABLED" };
  if (!/^[a-f0-9]{64}$/.test(manifest.payloadSha256) || !Number.isFinite(timestamp(manifest.retrievedAt))
    || (manifest.supersedesSourceRevision !== undefined
      && (!manifest.supersedesSourceRevision.trim() || manifest.supersedesSourceRevision === manifest.sourceRevision))
    || [manifest.sourceId, manifest.sourceRevision, manifest.competitionId, manifest.seasonId,
      manifest.mappingVersion, manifest.schemaVersion].some((id) => !id.trim())) {
    return { status: "BLOCKED", reason: "INVALID_MANIFEST" };
  }
  if (policy.permission !== "SYNTHETIC_FIXTURE" || policy.sourceId !== manifest.sourceId
    || policy.competitionId !== manifest.competitionId || policy.seasonId !== manifest.seasonId
    || policy.mappingVersion !== manifest.mappingVersion) {
    return { status: "BLOCKED", reason: "SOURCE_NOT_APPROVED" };
  }

  const countsByRecord = countBy(candidates, ({ sourceRecordId }) => sourceRecordId);
  const countsByGamePosition = countBy(candidates, gamePositionKey);
  const rows = candidates.map((candidate): ImportRowDecision => {
    const { sourceRecordId } = candidate;
    const issues = assessCandidate(candidate, manifest);
    if ((countsByRecord.get(sourceRecordId) ?? 0) > 1) issues.add("DUPLICATE_RECORD");
    if ((countsByGamePosition.get(gamePositionKey(candidate)) ?? 0) > 1) issues.add("DUPLICATE_GAME_POSITION");
    const ordered = [...issues].sort();
    if (ordered.some((issue) => issue !== "CORE_INCOMPLETE")) return { sourceRecordId, issues: ordered, status: "QUARANTINE" };
    return { sourceRecordId, issues: ordered, status: issues.size ? "STAGE_INCOMPLETE" : "STAGE", candidate };
  }).sort((left, right) => compareId(left.sourceRecordId, right.sourceRecordId)
    || compareId(left.issues.join(","), right.issues.join(",")));

  const batchKey = JSON.stringify([
    manifest.sourceId, manifest.competitionId, manifest.seasonId, manifest.sourceRevision,
    manifest.mappingVersion, manifest.schemaVersion, manifest.payloadSha256,
  ]);
  return { status: "DRY_RUN", label: "SIMULATION", manifest, batchKey, rows };
}

function assessCandidate({ sourceRecordId, game }: ImportCandidate, manifest: ImportManifest): Set<ImportQualityIssue> {
  const issues = new Set<ImportQualityIssue>();
  const playedAt = timestamp(game.playedAt);
  if ([sourceRecordId, game.gameId, game.playerId, game.teamId, game.opponentId].some((id) => !id.trim())
    || game.seasonId !== manifest.seasonId || game.teamId === game.opponentId
    || !Number.isFinite(playedAt) || playedAt > timestamp(manifest.retrievedAt)) {
    issues.add("INVALID_IDENTITY_OR_SCOPE");
  }
  const sourceMatches = (source: SourceQuality) =>
    source.sourceId === manifest.sourceId && source.revisionId === manifest.sourceRevision && source.origin === manifest.origin;
  if (game.usage.status === "UNKNOWN" || !isVerifiedSource(game.usage.source, manifest.origin)) {
    issues.add("UNVERIFIED_USAGE");
  } else if (!sourceMatches(game.usage.source)) {
    issues.add("SOURCE_MISMATCH");
  }

  let values: readonly (Observation | undefined)[];
  if (game.position === "QB") {
    const core = assessQbCore(game, manifest.origin);
    if (core.status === "UNAVAILABLE") {
      switch (core.reason) {
        case "MISSING_CORE": issues.add("CORE_INCOMPLETE"); break;
        case "UNUSABLE_CORE": issues.add("UNUSABLE_EVIDENCE"); break;
        case "INVALID_CORE": issues.add("INVALID_EVIDENCE"); break;
        case "UNVERIFIED_USAGE": issues.add("UNVERIFIED_USAGE"); break;
      }
    }
    values = [
      ...Object.values(game.stats.passing), ...Object.values(game.stats.rushing), ...Object.values(game.stats.situation),
      game.stats.advancedPassing?.nonTouchdownFirstDowns,
    ];
  } else {
    const { definitionVersion, tiers } = describePositionModel(game.position);
    if (game.stats.definitionVersion !== definitionVersion) issues.add("FEATURE_VERSION_MISMATCH");
    const requirements = describePositionDataRequirements(game.position);
    const fields = new Set(Object.values(requirements.tiers).flatMap(({ fields }) => fields.map(({ field }) => field)));
    const observations: Readonly<Record<string, Observation | undefined>> = game.stats.observations;
    if (Object.keys(observations).some((field) => !fields.has(field))) issues.add("UNEXPECTED_FIELD");
    if (game.usage.status === "PLAYED") {
      for (const [tier, definitions] of Object.entries(tiers)) {
        for (const definition of definitions) {
          const evidence = readComponent(definition, observations);
          if (evidence.status === "MISSING" && tier === "CORE") issues.add("CORE_INCOMPLETE");
          if (evidence.status === "INVALID") issues.add("INVALID_EVIDENCE");
          if (evidence.status === "UNUSABLE") issues.add("UNUSABLE_EVIDENCE");
        }
      }
    }
    values = Object.values(observations);
  }

  for (const observation of values) {
    if (!observation) continue;
    if ("source" in observation && !sourceMatches(observation.source)) issues.add("SOURCE_MISMATCH");
    const evidence = readObservation(observation, manifest.origin, Number.isFinite);
    if (evidence.status === "INVALID"
      || (game.usage.status === "DID_NOT_PLAY" && evidence.status === "AVAILABLE" && evidence.value !== 0)) {
      issues.add("INVALID_EVIDENCE");
    }
    if (evidence.status === "UNUSABLE") issues.add("UNUSABLE_EVIDENCE");
  }
  return issues;
}

function gamePositionKey({ game }: ImportCandidate): string {
  return JSON.stringify([game.gameId, game.playerId, game.position]);
}

function countBy(candidates: readonly ImportCandidate[], keyFor: (candidate: ImportCandidate) => string) {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = keyFor(candidate);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
