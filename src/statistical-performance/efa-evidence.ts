import { timestamp } from "../contracts/time.ts";
import { canonicalSha256 } from "../ingest/determinism.ts";
import { isDigest, isUuid, requirePilot, sha256Bytes } from "../pilot/signatures.ts";
import type { SignedPilotEnvelope } from "../pilot/signatures.ts";
import { compareId } from "../season/scope.ts";
import { qbFields } from "./contracts.ts";
import type { ComparisonGroup, QbStatDataset, QbStatRow, StatisticalContext } from "./contracts.ts";
import { assessStatisticalRow, authenticateStatistical, validateStatisticalDataset } from "./dataset.ts";

export const efaEvidenceVersion = "efra-efa-qb-pilot-v1";
export const efaPublicationResource = "efa-2026-regular-season";
type FeedKind = "SCHEDULE" | "EXPORT" | "GAMEBOOK";
type Permit = "RECEIVE" | "STORE" | "RECONCILE" | "PUBLISH_DERIVED";

export interface EfaIdentityLink {
  readonly entity: "COMPETITION" | "SEASON" | "GAME" | "TEAM" | "PLAYER";
  readonly sourceId: string;
  readonly canonicalId: string;
  readonly evidenceSha256: string;
}

export interface EfaEvidenceFeed {
  readonly schema: typeof efaEvidenceVersion;
  readonly kind: FeedKind;
  readonly namespace: string;
  readonly identityVersion: string;
  readonly deliverySha256: string;
  readonly identityLinks: readonly EfaIdentityLink[];
  readonly recordLinks: readonly EfaRecordLink[];
  readonly dataset: QbStatDataset;
}

export interface EfaRecordLink {
  readonly gameId: string;
  readonly revisionId: string;
  readonly recordId: string;
  readonly sourceGameId: string;
  readonly sourcePlayerId: string;
  readonly sourceTeamId: string;
  readonly evidenceSha256: string;
}

export interface EfaAccessGrant {
  readonly schema: typeof efaEvidenceVersion;
  readonly writtenGrantSha256: string;
  readonly groupSha256: string;
  readonly deliverySha256: string;
  /** Present on the post-intake grant binding the normalized feed; the intake grant can precede normalization. */
  readonly feedSha256?: string;
  readonly kind: FeedKind;
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly permits: readonly Permit[];
}

export interface EfaPilotEvidence {
  readonly schedule: SignedPilotEnvelope<EfaEvidenceFeed>;
  readonly export: SignedPilotEnvelope<EfaEvidenceFeed>;
  readonly gamebooks: SignedPilotEnvelope<EfaEvidenceFeed>;
  readonly access?: readonly SignedPilotEnvelope<EfaAccessGrant>[];
}

export interface EfaPilotContext extends StatisticalContext {
  /** Server-owned snapshot of current written permissions, refreshed for every operation. No status means denied. */
  readonly isAccessGrantCurrent?: (grantSha256: string) => boolean;
}

export interface EfaQualityIssue {
  readonly code: "SCHEDULE_INCOMPLETE" | "MISSING_GAME" | "EXTRA_GAME" | "GAME_IDENTITY_MISMATCH" | "CANDIDATE_IDENTITY_MISMATCH"
    | "MISSING_REVISION" | "PROVISIONAL_REVISION" | "REUSED_ARTIFACT" | "SHARED_ARTIFACT" | "MISSING_PLAYER" | "UNVERIFIED_ROLE"
    | "ROLE_MISMATCH" | "UNVERIFIED_CORE" | "FIELD_MISMATCH" | "SEASON_NOT_FINAL";
  readonly feed?: "EXPORT" | "GAMEBOOK";
  readonly gameId?: string;
  readonly playerId?: string;
  readonly field?: typeof qbFields[number];
}

export function isEfaPilotGroup(group: ComparisonGroup) {
  return group.competition === "EFA" && group.year === 2026 && group.stage === "REGULAR_SEASON";
}

/** Preflight for an already agreed manifest digest; this module never retrieves the artifact. */
export function authorizeEfaIntake(context: EfaPilotContext, grant: SignedPilotEnvelope<EfaAccessGrant>,
  target: Pick<EfaAccessGrant, "groupSha256" | "deliverySha256" | "feedSha256" | "kind">) {
  requirePilot(context.licensedDataEnabled === true, "EFA environment is synthetic-only");
  const { body, person } = authenticateStatistical(context, "EFA_ACCESS", grant);
  const now = timestamp(context.now);
  requirePilot(body.schema === efaEvidenceVersion && ["SCHEDULE", "EXPORT", "GAMEBOOK"].includes(body.kind)
    && body.kind === target.kind && isDigest(body.writtenGrantSha256) && isDigest(body.groupSha256)
    && isDigest(body.deliverySha256) && body.deliverySha256 === target.deliverySha256 && body.groupSha256 === target.groupSha256
    && (body.feedSha256 === undefined || isDigest(body.feedSha256))
    && (target.feedSha256 === undefined || body.feedSha256 === target.feedSha256)
    && timestamp(body.validFrom) <= now && now < timestamp(body.expiresAt)
    && (["RECEIVE", "STORE", "RECONCILE"] as const).every((permission) => body.permits.includes(permission)),
  "Missing, expired or mismatched written EFA rights");
  requirePilot(context.isAccessGrantCurrent?.(canonicalSha256(grant)) === true, "EFA rights are not currently authorized");
  return { person, publishDerived: body.permits.includes("PUBLISH_DERIVED"), expiresAt: body.expiresAt };
}

/** Hash-check the received delivery bytes before parsing or archiving them. */
export function verifyEfaDeliveryBytes(context: EfaPilotContext, grant: SignedPilotEnvelope<EfaAccessGrant>,
  target: Pick<EfaAccessGrant, "groupSha256" | "deliverySha256" | "kind">, bytes: Uint8Array) {
  const permission = authorizeEfaIntake(context, grant, target);
  requirePilot(sha256Bytes(bytes) === target.deliverySha256, "EFA delivery bytes do not match the authorized manifest");
  return permission;
}

function identities(feed: EfaEvidenceFeed) {
  const { dataset } = feed;
  const required: Record<EfaIdentityLink["entity"], ReadonlySet<string>> = {
    COMPETITION: new Set([dataset.group.competitionId]), SEASON: new Set([dataset.group.seasonId]),
    GAME: new Set(dataset.games.map(({ gameId }) => gameId)), TEAM: new Set(dataset.teams.map(({ id }) => id)),
    PLAYER: new Set(dataset.players.map(({ id }) => id)),
  };
  const external = new Map<string, string>(), canonical = new Set<string>();
  for (const link of feed.identityLinks) {
    const a = JSON.stringify([link.entity, link.sourceId]), b = JSON.stringify([link.entity, link.canonicalId]);
    requirePilot(typeof link.sourceId === "string" && link.sourceId.trim() && link.sourceId.length <= 256
      && isUuid(link.canonicalId) && isDigest(link.evidenceSha256) && required[link.entity]?.has(link.canonicalId)
      && !external.has(a) && !canonical.has(b), "Conflicting EFA source identity mapping");
    external.set(a, link.canonicalId);
    canonical.add(b);
  }
  requirePilot(canonical.size === Object.values(required).reduce((sum, ids) => sum + ids.size, 0), "Incomplete EFA source identity mapping");
  const expectedRows = new Map(dataset.revisions.flatMap(({ gameId, id: revisionId, rows }) =>
    rows.map((row) => [JSON.stringify([gameId, revisionId, row.recordId]), row] as const)));
  const used = new Set<string>();
  const resolve = (entity: EfaIdentityLink["entity"], key: string) => external.get(JSON.stringify([entity, key]));
  for (const link of feed.recordLinks) {
    const key = JSON.stringify([link.gameId, link.revisionId, link.recordId]);
    const row = expectedRows.get(key);
    requirePilot(row && !used.has(key) && isDigest(link.evidenceSha256) && resolve("GAME", link.sourceGameId) === link.gameId
      && resolve("PLAYER", link.sourcePlayerId) === row.playerId && resolve("TEAM", link.sourceTeamId) === row.teamId,
    "EFA record conflicts with its source identity mapping");
    used.add(key);
  }
  requirePilot(used.size === expectedRows.size, "Missing EFA source record identity evidence");
}

export function reconcileEfaQbSeason(evidence: EfaPilotEvidence, context: EfaPilotContext) {
  const schedule = authenticateStatistical(context, "EFA_SCHEDULE", evidence.schedule);
  const primary = authenticateStatistical(context, "EFA_EXPORT", evidence.export);
  const books = authenticateStatistical(context, "EFA_GAMEBOOK", evidence.gamebooks);
  const all = [schedule, primary, books] as const;
  const { group, asOf, origin } = schedule.body.dataset;
  const groupSha256 = canonicalSha256(group);
  const scopes = ["SCHEDULE", "EXPORT", "GAMEBOOK"] as const;
  const people = new Set(all.map(({ person }) => person));
  requirePilot(people.size === all.length && isEfaPilotGroup(group)
    && primary.body.namespace !== books.body.namespace, "EFA evidence must cover one regular season and have independent attestations");
  const accessPeople = new Set<string>();
  const access = new Map<FeedKind, ReturnType<typeof authorizeEfaIntake>>();
  if (origin === "REAL") {
    requirePilot(evidence.access?.length === scopes.length, "Separate written rights required for each EFA evidence feed");
    for (const grant of evidence.access) {
      const kind = grant.body.kind;
      const index = scopes.indexOf(kind);
      requirePilot(index >= 0 && !access.has(kind), "Duplicate or unknown EFA rights scope");
      const body = all[index]!.body;
      const permission = authorizeEfaIntake(context, grant, { groupSha256, kind, deliverySha256: body.deliverySha256,
        feedSha256: canonicalSha256(body) });
      requirePilot(!people.has(permission.person), "EFA rights approver must be independent");
      accessPeople.add(permission.person);
      access.set(kind, permission);
    }
  }
  const now = timestamp(context.now);
  const validated = all.map(({ body }, index) => {
    requirePilot(body.schema === efaEvidenceVersion && body.kind === scopes[index] && body.namespace.trim() && isDigest(body.deliverySha256)
      && body.identityVersion.trim() && canonicalSha256(body.dataset.group) === groupSha256
      && body.dataset.asOf === asOf && body.dataset.origin === origin, "EFA feeds do not share the same frozen season scope");
    requirePilot(index === 0 ? body.dataset.revisions.length === 0
      : index === 1 ? body.dataset.revisions.every(({ source }) => source === "EPFR" || source === "EFA_OFFICIAL")
        : body.dataset.revisions.every(({ source }) => source === "EFA_OFFICIAL"), "Unexpected EFA evidence source");
    const valid = validateStatisticalDataset(body.dataset, now);
    identities(body);
    return valid;
  });
  const [official, provider, gamebooks] = [validated[0]!, validated[1]!, validated[2]!];
  const issues: EfaQualityIssue[] = [];
  const issue = (code: EfaQualityIssue["code"], detail: Omit<EfaQualityIssue, "code"> = {}) => issues.push({ code, ...detail });
  if (schedule.body.dataset.manifest.status !== "COMPLETE" || official.games.size === 0
    || [...official.games.values()].some(({ candidates, homeTeamId, awayTeamId }) =>
      ![homeTeamId, awayTeamId].every((team) => candidates.some(({ teamId }) => teamId === team)))) issue("SCHEDULE_INCOMPLETE");
  if (timestamp(asOf) < timestamp(group.endsBefore)) issue("SEASON_NOT_FINAL");
  const feedPairs = [[provider, primary.body.dataset, "EXPORT"], [gamebooks, books.body.dataset, "GAMEBOOK"]] as const;
  for (const [feed, , kind] of feedPairs) for (const gameId of feed.games.keys()) {
    if (!official.games.has(gameId)) issue("EXTRA_GAME", { feed: kind, gameId });
  }
  for (const game of official.games.values()) {
    const { gameId, playedAt, homeTeamId, awayTeamId, candidates } = game;
    const heads = feedPairs.map(([feed, , kind]) => {
      const actual = feed.games.get(gameId);
      const details = { feed: kind, gameId };
      if (!actual) { issue("MISSING_GAME", details); return undefined; }
      if (actual.playedAt !== playedAt || actual.homeTeamId !== homeTeamId || actual.awayTeamId !== awayTeamId) issue("GAME_IDENTITY_MISMATCH", details);
      const roster = (rows: typeof candidates) => [...rows].sort((a, b) => compareId(a.playerId, b.playerId));
      if (canonicalSha256(roster(actual.candidates)) !== canonicalSha256(roster(candidates))) issue("CANDIDATE_IDENTITY_MISMATCH", details);
      const chain = feed.history.get(gameId) ?? [];
      const head = chain.at(-1);
      if (new Set(chain.map(({ artifactSha256 }) => artifactSha256)).size !== chain.length) issue("REUSED_ARTIFACT", details);
      if (!head) { issue("MISSING_REVISION", details); return undefined; }
      if (head.finality !== "FINAL") { issue("PROVISIONAL_REVISION", details); return undefined; }
      return head;
    });
    const [a, b] = heads;
    if (!a || !b) continue;
    if (a.artifactSha256 === b.artifactSha256) issue("SHARED_ARTIFACT", { gameId });
    for (const { playerId, teamId } of candidates) {
      const details = { gameId, playerId };
      const locate = (rows: readonly QbStatRow[]) => rows.find((row) => row.playerId === playerId && row.teamId === teamId);
      const left = locate(a.rows), right = locate(b.rows);
      if (!left || !right) {
        if (!left) issue("MISSING_PLAYER", { ...details, feed: "EXPORT" });
        if (!right) issue("MISSING_PLAYER", { ...details, feed: "GAMEBOOK" });
        continue;
      }
      if (left.role.status === "UNKNOWN" || right.role.status === "UNKNOWN") { issue("UNVERIFIED_ROLE", details); continue; }
      if (left.role.status !== right.role.status) { issue("ROLE_MISMATCH", details); continue; }
      const x = assessStatisticalRow(primary.body.dataset, game, a, left);
      const y = assessStatisticalRow(books.body.dataset, game, b, right);
      if (x.status === "UNAVAILABLE") issue("UNVERIFIED_CORE", { ...details, feed: "EXPORT" });
      if (y.status === "UNAVAILABLE") issue("UNVERIFIED_CORE", { ...details, feed: "GAMEBOOK" });
      if ("stats" in x && "stats" in y) for (const field of qbFields) {
        if (x.stats[field] !== y.stats[field]) issue("FIELD_MISMATCH", { ...details, field });
      }
    }
  }
  issues.sort((a, b) => compareId(JSON.stringify(a), JSON.stringify(b)));
  const report = {
    schema: efaEvidenceVersion, label: origin === "SYNTHETIC" ? "SIMULATION" as const : "REVIEWED_INTERNAL" as const,
    groupSha256, asOf, expectedGames: official.games.size,
    feeds: all.map(({ body }) => ({ kind: body.kind, sha256: canonicalSha256(body), deliverySha256: body.deliverySha256,
      identityVersion: body.identityVersion })),
    issues,
  };
  const reconciliationSha256 = canonicalSha256(report);
  const dataset: QbStatDataset | null = issues.length ? null : { ...primary.body.dataset,
    manifest: { status: "COMPLETE", evidenceSha256: reconciliationSha256 } };
  const revisionLineage = Object.fromEntries([...provider.history].map(([game, revisions]) => [`EXPORT/${game}`, revisions.map(canonicalSha256)])
    .concat([...gamebooks.history].map(([game, revisions]) => [`GAMEBOOK/${game}`, revisions.map(canonicalSha256)]),
      all.flatMap(({ body }) => body.identityLinks.map(({ entity, canonicalId, sourceId }) =>
        [`IDENTITY/${body.kind}/${entity}/${canonicalId}`, [canonicalSha256([body.namespace, sourceId])]]))));
  return { report, reconciliationSha256, dataset, revisionLineage, evidencePeople: people, accessPeople,
    publishRights: access.size === scopes.length && [...access.values()].every(({ publishDerived }) => publishDerived),
    accessExpiresAt: [...access.values()].map(({ expiresAt }) => expiresAt).sort()[0] };
}
