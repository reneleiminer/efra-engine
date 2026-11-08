import { generateKeyPairSync, sign } from "node:crypto";
import {
  efaEvidenceVersion, qbPassingDefinitionVersion, qbUnits, reconcileEfaQbSeason, sha256Bytes, signPilot, statisticalVersion,
} from "../../src/index.ts";
import type {
  ComparisonGroup, EfaAccessGrant, EfaEvidenceFeed, EfaPilotContext, EfaPilotEvidence, PilotKeyPurpose, QbEligibilityPolicy,
  QbGameRevision, QbScheduledGame, QbStatDataset, QbStatRow, StatisticalRights,
} from "../../src/index.ts";
import { canonicalSha256 } from "../../src/ingest/determinism.ts";

export const environment = "sim-efa-pilot";
export const digest = "a".repeat(64);
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const utc = (day: string) => `2026-${day}T12:00:00.000Z`;
const pairs = new Map<PilotKeyPurpose, ReturnType<typeof newPair>>();
const newPair = () => generateKeyPairSync("ed25519");
export function signer(purpose: PilotKeyPurpose) {
  if (!pairs.has(purpose)) pairs.set(purpose, newPair());
  const pair = pairs.get(purpose)!;
  return { keyId: purpose, sign: async (message: Uint8Array) => sign(null, message, pair.privateKey) };
}
export const signed = <T>(purpose: PilotKeyPurpose, body: T) => signPilot(environment, purpose, body, signer(purpose));
export const context: EfaPilotContext = {
  environment,
  keys: { publicKey: (env, purpose, key) => env === environment && purpose === key ? pairs.get(purpose)?.publicKey : undefined },
  personForKey: (key) => `sim-${key}`, now: utc("11-01"),
};
export const licensed: EfaPilotContext = { ...context, licensedDataEnabled: true, isAccessGrantCurrent: () => true };
export const group: ComparisonGroup = { competition: "EFA", competitionId: id(1), seasonId: id(2), year: 2026,
  stage: "REGULAR_SEASON", version: "sim-group-1", startsAt: utc("05-01"), endsBefore: utc("08-01") };
export const game: QbScheduledGame = { gameId: id(20), competitionId: group.competitionId, seasonId: group.seasonId,
  stage: group.stage, playedAt: utc("06-01"), homeTeamId: id(10), awayTeamId: id(11),
  candidates: [{ playerId: id(100), teamId: id(10) }, { playerId: id(101), teamId: id(11) }] };
export function row(playerId: string, teamId: string, yards: number, played: boolean): QbStatRow {
  const make = <K extends keyof typeof qbUnits>(key: K, value: number) => ({
    unit: qbUnits[key], status: value === 0 ? "VERIFIED_ZERO" as const : "VERIFIED_VALUE" as const, evidenceSha256: digest, value,
  });
  return {
    playerId, teamId, recordId: playerId, role: { status: played ? "PLAYED_QB" : "DID_NOT_PLAY_QB", evidenceSha256: digest },
    fields: { attempts: make("attempts", played ? 10 : 0), completions: make("completions", played ? 5 : 0),
      yards: make("yards", yards), touchdowns: make("touchdowns", played ? 1 : 0), interceptions: make("interceptions", 0) },
  };
}
export const primary: QbGameRevision = {
  id: "sim-export-r1", gameId: game.gameId, finality: "FINAL", artifactSha256: "e".repeat(64), source: "EPFR",
  availableAt: utc("06-02"), mappingVersion: "sim-export-mapping", conventionVersion: "sim-definition",
  rows: [row(id(100), id(10), 50, true), row(id(101), id(11), 0, false)],
};
export const book: QbGameRevision = { ...primary, id: "sim-gamebook-r1", source: "EFA_OFFICIAL", artifactSha256: "b".repeat(64) };
export const base: QbStatDataset = {
  schema: statisticalVersion, passingDefinition: qbPassingDefinitionVersion, origin: "SYNTHETIC", group, asOf: utc("09-01"),
  version: "sim-efa-v1", manifest: { status: "COMPLETE", evidenceSha256: digest }, games: [game],
  teams: [10, 11].map((i) => ({ id: id(i), name: `SIM team ${i}` })),
  players: [100, 101].map((i) => ({ id: id(i), name: `SIM player ${i}` })), revisions: [],
};

type Kind = EfaEvidenceFeed["kind"];
export const delivery = (kind: Kind, version: string) => Buffer.from(`SIM ONLY / ${kind} / ${version}`, "utf8");
export function feed(kind: Kind, dataset: QbStatDataset): EfaEvidenceFeed {
  const links = { COMPETITION: [dataset.group.competitionId], SEASON: [dataset.group.seasonId],
    GAME: dataset.games.map((entry) => entry.gameId), TEAM: dataset.teams.map((entry) => entry.id),
    PLAYER: dataset.players.map((entry) => entry.id) };
  const alias = (uuid: string) => `sim-${kind}-${uuid}`;
  return {
    schema: efaEvidenceVersion, kind, namespace: `sim-${kind}`, identityVersion: "sim-ids-1",
    deliverySha256: sha256Bytes(delivery(kind, dataset.version)), dataset,
    identityLinks: Object.entries(links).flatMap(([entity, ids]) => ids.map((uuid) =>
      ({ entity: entity as keyof typeof links, sourceId: alias(uuid), canonicalId: uuid, evidenceSha256: digest }))),
    recordLinks: dataset.revisions.flatMap(({ gameId, id: revisionId, rows }) => rows.map(({ recordId, playerId, teamId }) => ({
      gameId, revisionId, recordId, sourceGameId: alias(gameId), sourcePlayerId: alias(playerId), sourceTeamId: alias(teamId),
      evidenceSha256: digest,
    }))),
  };
}
export async function evidence(options: {
  origin?: QbStatDataset["origin"]; correction?: "append" | "rewrite";
  transform?: (feed: EfaEvidenceFeed) => EfaEvidenceFeed; publish?: boolean;
} = {}): Promise<EfaPilotEvidence> {
  const scope = { ...base, origin: options.origin ?? base.origin, ...(options.correction && {
    asOf: utc("09-10"), version: "sim-efa-v2", group: { ...group, version: "sim-group-2" },
  }) };
  const chain = (r: QbGameRevision) => options.correction === "append" ? [r, { ...r,
    id: r.id + "-2", supersedes: r.id, availableAt: utc("09-05"), artifactSha256: canonicalSha256(["sim-correction", r.id]),
    rows: [row(id(100), id(10), 60, true), r.rows[1]!] }]
    : options.correction === "rewrite" ? [{ ...r, rows: [row(id(100), id(10), 60, true), r.rows[1]!] }] : [r];
  const transform = options.transform ?? ((value) => value);
  const schedule = transform(feed("SCHEDULE", scope));
  const exported = transform(feed("EXPORT", { ...scope, revisions: chain(primary) }));
  const gamebooks = transform(feed("GAMEBOOK", { ...scope, revisions: chain(book) }));
  const access = scope.origin === "REAL" ? await Promise.all([schedule, exported, gamebooks].map((entry) =>
    signed<EfaAccessGrant>("EFA_ACCESS", {
      schema: efaEvidenceVersion, writtenGrantSha256: digest, kind: entry.kind, groupSha256: canonicalSha256(scope.group),
      deliverySha256: entry.deliverySha256, feedSha256: canonicalSha256(entry), validFrom: utc("05-01"), expiresAt: "2099-01-01T00:00:00.000Z",
      permits: options.publish === false ? ["RECEIVE", "STORE", "RECONCILE"] : ["RECEIVE", "STORE", "RECONCILE", "PUBLISH_DERIVED"],
    }))) : undefined;
  return { schedule: await signed("EFA_SCHEDULE", schedule), export: await signed("EFA_EXPORT", exported),
    gamebooks: await signed("EFA_GAMEBOOK", gamebooks), ...(access && { access }) };
}

export async function bundle(source: EfaPilotEvidence, statContext: EfaPilotContext = context) {
  const reconciled = reconcileEfaQbSeason(source, statContext);
  if (!reconciled.dataset) throw new Error("Test data did not reconcile");
  const body = reconciled.dataset;
  const policy = await signed<QbEligibilityPolicy>("STAT_POLICY", { schema: statisticalVersion, version: "sim-eligibility", status: "APPROVED",
    groupSha256: canonicalSha256(body.group), minimumAttempts: 10, rationale: "Synthetic floor for the scenario only.",
    completeness: "ALL_EXPECTED_GAMES" as const });
  const rights = body.origin === "REAL" ? [await signed<StatisticalRights>("STAT_RIGHTS", {
    schema: statisticalVersion, licenseId: "sim-written-license", evidenceSha256: digest, source: "EPFR",
    groupSha256: canonicalSha256(body.group), datasetSha256: canonicalSha256(body), validFrom: utc("05-01"),
    expiresAt: "2099-01-01T00:00:00.000Z", permits: ["IMPORT", "STORE", "DERIVE", "PUBLISH"],
  })] : undefined;
  return { evidence: source, statistics: { policy, dataset: await signed("STAT_DATA", body), ...(rights && { rights }) } };
}
