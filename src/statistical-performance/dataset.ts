import type { Observation, SourceQuality } from "../contracts/observations.ts";
import type { QbGame } from "../contracts/statistics.ts";
import { timestamp } from "../contracts/time.ts";
import { canonicalSha256 } from "../ingest/determinism.ts";
import { assessQbCore } from "../models/qb/core.ts";
import { isDigest, isUuid, requirePilot, verifyPilot } from "../pilot/signatures.ts";
import type { PilotKeyPurpose, SignedPilotEnvelope } from "../pilot/signatures.ts";
import { compareId } from "../season/scope.ts";
import { qbFields, qbPassingDefinitionVersion, qbUnits, statisticalVersion } from "./contracts.ts";
import type {
  QbStatDataset, QbStatInput, QbStatRow, QbGameRevision, QbScheduledGame, StatisticalContext, StatisticalObservation, StatisticalSource,
} from "./contracts.ts";

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 512;
const unique = <T>(items: readonly T[]): boolean => new Set(items).size === items.length;
const compareDate = (a: { availableAt: string }, b: { availableAt: string }) => compareId(a.availableAt, b.availableAt);
const missing = { status: "MISSING" } as const;

export function authenticateStatistical<T>(context: StatisticalContext, purpose: PilotKeyPurpose, envelope: SignedPilotEnvelope<T>) {
  const body = verifyPilot(context.environment, purpose, envelope, context.keys);
  const person = context.personForKey(envelope.keyId);
  requirePilot(text(person), "No active authenticated statistical reviewer");
  return { body, person };
}

function validSource(dataset: QbStatDataset, source: StatisticalSource) {
  return dataset.group.competition === "EFA" ? source === "EPFR" || source === "EFA_OFFICIAL" : source === "STATS_N_SCORE";
}

function validateObservation(field: StatisticalObservation, signedYards: boolean) {
  switch (field.status) {
    case "MISSING": case "NOT_APPLICABLE": case "CONFLICTED": return !("value" in field);
    case "REPORTED_ZERO": case "REPORTED_VALUE": case "VERIFIED_ZERO": case "VERIFIED_VALUE":
      return Number.isSafeInteger(field.value) && (signedYards || field.value >= 0)
        && (field.status.endsWith("_ZERO") === (field.value === 0))
        && (!field.status.startsWith("VERIFIED") || ("evidenceSha256" in field && isDigest(field.evidenceSha256)));
    default: return false;
  }
}

function validateRow(row: QbStatRow, game: QbScheduledGame) {
  requirePilot(text(row.recordId) && game.candidates.some((candidate) => candidate.playerId === row.playerId && candidate.teamId === row.teamId),
    "Statistical row is outside its scheduled player/team scope");
  requirePilot(row.role.status === "UNKNOWN" || ((row.role.status === "PLAYED_QB" || row.role.status === "DID_NOT_PLAY_QB")
    && isDigest(row.role.evidenceSha256)), "Invalid QB role evidence");
  requirePilot(qbFields.every((field) => row.fields[field]?.unit === qbUnits[field]
    && validateObservation(row.fields[field], field === "yards")), "Invalid statistical field value, unit or evidence");
  requirePilot(row.role.status !== "DID_NOT_PLAY_QB" || qbFields.every((field) => {
    const entry = row.fields[field];
    return entry.status !== "CONFLICTED" && (!("value" in entry) || entry.value === 0);
  }), "Non-participation conflicts with statistical fields");
}

function validateDataset(dataset: QbStatDataset, now: number) {
  const { group } = dataset;
  const start = timestamp(group.startsAt), end = timestamp(group.endsBefore), asOf = timestamp(dataset.asOf);
  requirePilot(dataset.schema === statisticalVersion && dataset.passingDefinition === qbPassingDefinitionVersion && text(dataset.version) && text(group.version)
    && (dataset.origin === "SYNTHETIC" || dataset.origin === "REAL")
    && group.year === 2026 && ["EFA", "GFL", "GFL2"].includes(group.competition)
    && ["REGULAR_SEASON", "PLAYOFFS"].includes(group.stage) && isUuid(group.competitionId) && isUuid(group.seasonId)
    && start >= Date.UTC(2026, 0, 1) && end <= Date.UTC(2027, 0, 1) && start < end && start <= asOf && asOf <= now,
  "Invalid comparison group, dataset version or data cutoff");
  requirePilot(["COMPLETE", "INCOMPLETE"].includes(dataset.manifest.status) && isDigest(dataset.manifest.evidenceSha256),
    "Missing schedule and QB coverage evidence");
  for (const entries of [dataset.players, dataset.teams]) {
    requirePilot(unique(entries.map(({ id }) => id)) && entries.every(({ id, name }) => isUuid(id) && text(name)),
      "Invalid or duplicate named identities");
  }
  const teams = new Set(dataset.teams.map(({ id }) => id)), players = new Set(dataset.players.map(({ id }) => id));
  const games = new Map<string, QbScheduledGame>();
  const teamSlots = new Set<string>();
  const playerSlots = new Set<string>();
  for (const game of dataset.games) {
    const playedAt = timestamp(game.playedAt);
    requirePilot(isUuid(game.gameId) && !games.has(game.gameId) && playedAt >= start && playedAt < end
      && game.competitionId === group.competitionId && game.seasonId === group.seasonId && game.stage === group.stage
      && teams.has(game.homeTeamId) && teams.has(game.awayTeamId) && game.homeTeamId !== game.awayTeamId
      && unique(game.candidates.map(({ playerId }) => playerId))
      && game.candidates.every(({ playerId, teamId }) => players.has(playerId) && [game.homeTeamId, game.awayTeamId].includes(teamId)),
    "Duplicate game, invalid identity, schedule or team assignment");
    for (const [slots, ids] of [[teamSlots, [game.homeTeamId, game.awayTeamId]],
      [playerSlots, game.candidates.map(({ playerId }) => playerId)]] as const) for (const id of ids) {
      const slot = `${game.playedAt}/${id}`;
      requirePilot(!slots.has(slot), "Conflicting simultaneous game identity");
      slots.add(slot);
    }
    games.set(game.gameId, game);
  }
  const history = new Map<string, QbGameRevision[]>();
  for (const revision of [...dataset.revisions].sort(compareDate)) {
    const game = games.get(revision.gameId), available = timestamp(revision.availableAt);
    const chain = history.get(revision.gameId) ?? [];
    const previous = chain.at(-1);
    requirePilot(game && text(revision.id) && validSource(dataset, revision.source) && isDigest(revision.artifactSha256)
      && text(revision.mappingVersion) && text(revision.conventionVersion) && ["FINAL", "PROVISIONAL"].includes(revision.finality)
      && available >= timestamp(game.playedAt) && available <= asOf && revision.supersedes === previous?.id
      && (!previous || (revision.source === previous.source && available > timestamp(previous.availableAt)))
      && !chain.some(({ id }) => id === revision.id)
      && unique(revision.rows.map(({ playerId }) => playerId)) && unique(revision.rows.map(({ recordId }) => recordId)),
    "Invalid, conflicting or duplicate game revision");
    for (const row of revision.rows) validateRow(row, game);
    chain.push(revision);
    history.set(game.gameId, chain);
  }
  return { games, history };
}

export function loadStatisticalInput(input: QbStatInput, context: StatisticalContext) {
  const now = timestamp(context.now);
  requirePilot(Number.isFinite(now), "Invalid statistical service time");
  const { body: dataset, person: reviewer } = authenticateStatistical(context, "STAT_DATA", input.dataset);
  const { body: policy, person: policyOwner } = authenticateStatistical(context, "STAT_POLICY", input.policy);
  const datasetSha256 = canonicalSha256(dataset), groupSha256 = canonicalSha256(dataset.group);
  const scope = validateDataset(dataset, now);
  requirePilot(reviewer !== policyOwner && policy.schema === statisticalVersion && policy.groupSha256 === groupSha256
    && text(policy.version) && text(policy.rationale) && Number.isSafeInteger(policy.minimumAttempts) && policy.minimumAttempts > 0
    && ["PROVISIONAL", "APPROVED"].includes(policy.status) && policy.completeness === "ALL_EXPECTED_GAMES",
  "Invalid eligibility policy or non-independent policy approver");
  const grants = new Map<StatisticalSource, boolean>();
  const rightsPeople = new Set<string>();
  if (dataset.origin === "REAL") {
    requirePilot(context.licensedDataEnabled === true, "This statistical environment is synthetic-only");
    const sources = new Set(dataset.revisions.map(({ source }) => source));
    for (const envelope of input.rights ?? []) {
      const { body: grant, person } = authenticateStatistical(context, "STAT_RIGHTS", envelope);
      requirePilot(person !== reviewer && person !== policyOwner && grant.schema === statisticalVersion
        && text(grant.licenseId) && isDigest(grant.evidenceSha256) && grant.groupSha256 === groupSha256
        && grant.datasetSha256 === datasetSha256 && sources.has(grant.source) && !grants.has(grant.source)
        && timestamp(grant.validFrom) <= timestamp(dataset.asOf) && now < timestamp(grant.expiresAt)
        && ["IMPORT", "STORE", "DERIVE"].every((permission) => grant.permits.some((value) => value === permission)),
      "Invalid or expired statistical source rights");
      grants.set(grant.source, grant.permits.includes("PUBLISH"));
      rightsPeople.add(person);
    }
    requirePilot(sources.size > 0 && [...sources].every((source) => grants.has(source)), "Statistical source rights missing");
  }
  return { ...scope, dataset, policy, datasetSha256, groupSha256, reviewer, policyOwner, rightsPeople,
    publishRights: grants.size > 0 && [...grants.values()].every(Boolean) };
}

export function assessStatisticalRow(dataset: QbStatDataset, game: QbScheduledGame, revision: QbGameRevision, row: QbStatRow) {
  const source: SourceQuality = {
    sourceId: revision.source, revisionId: revision.id, conventionVersion: revision.conventionVersion,
    verification: "VERIFIED", origin: dataset.origin, officiality: dataset.origin === "SYNTHETIC" ? "SYNTHETIC" : "SECONDARY_SOURCE",
  };
  const convert = (field: StatisticalObservation): Observation => {
    switch (field.status) {
      case "VERIFIED_ZERO": return { status: "VERIFIED_ZERO", value: field.value, source };
      case "VERIFIED_VALUE": return { status: "OBSERVED", value: field.value, source };
      case "NOT_APPLICABLE": return { status: field.status };
      case "CONFLICTED": return { status: field.status, sources: [source] };
      default: return missing;
    }
  };
  const normalized: QbGame = {
    playerId: row.playerId, gameId: game.gameId, position: "QB", seasonId: dataset.group.seasonId, teamId: row.teamId,
    opponentId: game.homeTeamId === row.teamId ? game.awayTeamId : game.homeTeamId, playedAt: game.playedAt,
    usage: row.role.status === "UNKNOWN" ? { status: "UNKNOWN" } : {
      status: row.role.status === "PLAYED_QB" ? "PLAYED" : "DID_NOT_PLAY", source,
    },
    stats: {
      passing: { attempts: convert(row.fields.attempts), completions: convert(row.fields.completions), yards: convert(row.fields.yards),
        touchdowns: convert(row.fields.touchdowns), interceptions: convert(row.fields.interceptions) },
      rushing: { attempts: missing, yards: missing, touchdowns: missing, turnovers: missing },
      situation: { opportunities: missing, actualPointsAdded: missing, expectedPointsAdded: missing },
    },
  };
  return assessQbCore(normalized, dataset.origin);
}
