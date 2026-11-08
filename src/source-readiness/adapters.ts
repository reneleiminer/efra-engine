import { timestamp } from "../contracts/time.ts";
import type { Position } from "../contracts/statistics.ts";
import { canonicalSha256 } from "../ingest/determinism.ts";
import { positionMetricRegistry } from "../models/positions/metric-registry.ts";
import type { PositionMetric } from "../models/positions/metric-registry.ts";

export const sourceAdapterVersion = "efra-source-adapter-fixture-v1";
export const statsNScoreDocumentedOperations = [
  "teamlistjson", "gamelistjson", "stats-playerjson", "stats-teamjson", "stats-singleplayerjson", "gamedatajson", "gamestatsjson",
] as const;

type SourceScope =
  | { readonly provider: "EPFR"; readonly competition: "EFA"; readonly operation: "SYNTHETIC_EXPORT" }
  | { readonly provider: "STATS_N_SCORE"; readonly competition: "GFL" | "GFL2"; readonly operation: "gamedatajson" | "gamestatsjson" };

export type SourceFixtureRequest = SourceScope & {
  readonly version: typeof sourceAdapterVersion;
  readonly seasonKey: string;
  readonly gameKey: string;
};

/** Injection port for synthetic tests. The shape below is EFRA-owned and does not describe a vendor response. */
export interface SourceFixtureTransport {
  readFixture(request: SourceFixtureRequest): Promise<unknown>;
}

export interface SourceFieldBinding {
  readonly position: Position;
  readonly sourceField: string;
  readonly field: string;
  readonly unit: PositionMetric["unit"];
  readonly conventionVersion: string;
}
export interface SourceMapping {
  readonly version: string;
  readonly provider: SourceScope["provider"];
  readonly competition: SourceScope["competition"];
  readonly sourceSchemaVersion: string;
  readonly bindings: readonly SourceFieldBinding[];
}

export type SourceFixtureField =
  | { readonly sourceField: string; readonly unit: string; readonly value: number | null; readonly state: "REPORTED" }
  | { readonly sourceField: string; readonly unit: string; readonly state: "NOT_APPLICABLE" | "CONFLICTED" };
export interface SourceFixtureRow {
  readonly recordKey: string;
  readonly playerKey: string;
  readonly teamKey: string;
  readonly opponentKey: string;
  readonly position: Position;
  readonly participation: "REPORTED_PLAYED" | "REPORTED_DID_NOT_PLAY" | "UNKNOWN";
  readonly fields: readonly SourceFixtureField[];
}
export interface SourceFixtureExport {
  readonly version: typeof sourceAdapterVersion;
  readonly origin: "SYNTHETIC";
  readonly permission: "SYNTHETIC_FIXTURE";
  readonly request: SourceFixtureRequest;
  readonly schemaVersion: string;
  readonly revision: { readonly id: string; readonly supersedes?: string; readonly rowsSha256: string };
  readonly playedAt: string;
  readonly finality: "FINAL" | "PROVISIONAL";
  readonly rows: readonly SourceFixtureRow[];
}

export interface FixtureIdentityResolution {
  readonly bindingSha256: string;
  readonly competitionId: string;
  readonly seasonId: string;
  readonly gameId: string;
  readonly playerId: string;
  readonly teamId: string;
  readonly opponentId: string;
  readonly position: Position;
  readonly playedAt: string;
}
export interface FixtureIdentityResolver {
  /** Trusted namespace-scoped mapping. Match by provider IDs and game sides, never by name or jersey number alone. */
  resolve(request: SourceFixtureRequest, playedAt: string, row: Pick<SourceFixtureRow,
    "playerKey" | "teamKey" | "opponentKey" | "position">): Promise<FixtureIdentityResolution | null>;
}
export interface SourceRevisionHead {
  readonly scopeSha256: string;
  readonly revisionId: string;
  readonly contentSha256: string;
}
export type UnverifiedFixtureObservation =
  | { readonly status: "MISSING"; readonly reason: "NO_COLUMN" | "NULL" }
  | { readonly status: "NOT_APPLICABLE" | "CONFLICTED" }
  | { readonly status: "REPORTED_VALUE" | "REPORTED_ZERO"; readonly value: number };

const gameMetrics = Map.groupBy(positionMetricRegistry().metrics.filter(({ storage }) => storage === "GAME"), ({ position }) => position);
const isId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);
const isUuid = (value: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);

function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function safeRequest(request: SourceFixtureRequest): SourceFixtureRequest {
  const { version, provider, competition, operation, seasonKey, gameKey } = request;
  check(version === sourceAdapterVersion && isId(seasonKey) && isId(gameKey), "Invalid fixture scope");
  if (provider === "EPFR") {
    check(competition === "EFA" && operation === "SYNTHETIC_EXPORT", "EPFR has no verified live API contract");
    return { version, provider, competition, operation, seasonKey, gameKey };
  }
  check(provider === "STATS_N_SCORE" && (competition === "GFL" || competition === "GFL2")
    && (operation === "gamedatajson" || operation === "gamestatsjson"), "Unrecognized Stats n Score game operation");
  return { version, provider, competition, operation, seasonKey, gameKey };
}

function reported(raw: SourceFixtureField | undefined, metric: PositionMetric): UnverifiedFixtureObservation {
  if (!raw) return { status: "MISSING", reason: "NO_COLUMN" };
  check(raw.unit === metric.unit, "Fixture metric unit mismatch");
  if (raw.state === "NOT_APPLICABLE" || raw.state === "CONFLICTED") {
    check(!Object.hasOwn(raw, "value"), "Non-numeric fixture state carries a value");
    return { status: raw.state };
  }
  check(raw.state === "REPORTED", "Unknown fixture observation state");
  if (raw.value === null) return { status: "MISSING", reason: "NULL" };
  const value = raw.value;
  check(typeof value === "number" && Number.isFinite(value)
    && (metric.domain !== "COUNT" && metric.domain !== "SIGNED_INTEGER" || Number.isSafeInteger(value))
    && (metric.domain !== "COUNT" && metric.domain !== "NONNEGATIVE_DECIMAL" || value >= 0), "Fixture metric value outside registry domain");
  return { status: value === 0 ? "REPORTED_ZERO" : "REPORTED_VALUE", value };
}

export async function inspectSourceFixture(
  request: SourceFixtureRequest, mapping: SourceMapping, transport: SourceFixtureTransport,
  identity: FixtureIdentityResolver, previous?: SourceRevisionHead,
) {
  const scope = safeRequest(request);
  const pinnedMapping = structuredClone(mapping);
  const pinnedPrevious = structuredClone(previous);
  const fixture = structuredClone(await transport.readFixture(structuredClone(scope))) as SourceFixtureExport;
  check(fixture?.version === sourceAdapterVersion && fixture.origin === "SYNTHETIC" && fixture.permission === "SYNTHETIC_FIXTURE"
    && canonicalSha256(fixture.request) === canonicalSha256(scope) && Number.isFinite(timestamp(fixture.playedAt))
    && ["FINAL", "PROVISIONAL"].includes(fixture.finality) && Array.isArray(fixture.rows)
    && fixture.rows.length > 0 && canonicalSha256(fixture.rows) === fixture.revision?.rowsSha256
    && isId(fixture.revision?.id) && (fixture.revision.supersedes === undefined || isId(fixture.revision.supersedes))
    && fixture.revision.id !== fixture.revision.supersedes, "Invalid or non-synthetic fixture export");
  check(pinnedMapping.provider === scope.provider && pinnedMapping.competition === scope.competition
    && isId(pinnedMapping.version) && isId(pinnedMapping.sourceSchemaVersion) && pinnedMapping.sourceSchemaVersion === fixture.schemaVersion,
  "Unrecognized provider mapping version");

  const mappings = Map.groupBy(pinnedMapping.bindings, ({ position }) => position);
  for (const [position, bindings] of mappings) {
    check(new Set(bindings.map(({ field }) => field)).size === bindings.length
      && new Set(bindings.map(({ sourceField }) => sourceField)).size === bindings.length
      && bindings.every((binding) => isId(binding.sourceField) && isId(binding.conventionVersion)
        && gameMetrics.get(position)?.some(({ field, unit }) => field === binding.field && unit === binding.unit)),
    "Duplicate or incompatible field mapping");
  }
  const scopeSha256 = canonicalSha256([scope.provider, scope.competition, scope.seasonKey, scope.gameKey]);
  const revision = {
    scopeSha256, revisionId: fixture.revision.id,
    contentSha256: canonicalSha256({ scope, mapping: pinnedMapping, schemaVersion: fixture.schemaVersion, revision: fixture.revision,
      playedAt: fixture.playedAt, finality: fixture.finality }),
  };
  const sameRevision = pinnedPrevious?.revisionId === revision.revisionId;
  check(pinnedPrevious ? pinnedPrevious.scopeSha256 === scopeSha256 && (sameRevision
    ? pinnedPrevious.contentSha256 === revision.contentSha256 : fixture.revision.supersedes === pinnedPrevious.revisionId)
    : fixture.revision.supersedes === undefined, "Conflicting or unparented provider revision");

  const records = new Set<string>();
  const canonical = new Set<string>();
  const playerTeams = new Map<string, string>();
  const playerAliases = new Map<string, string>();
  const teamAliases = new Map<string, string>();
  const bind = (aliases: Map<string, string>, key: string, id: string) => {
    check(!aliases.has(key) || aliases.get(key) === id, "Conflicting provider identity within game");
    aliases.set(key, id);
  };
  let gameScope: string | undefined;
  const rows = [];
  for (const row of fixture.rows) {
    const metrics = gameMetrics.get(row.position);
    check(metrics && isId(row.recordKey) && !records.has(row.recordKey) && isId(row.playerKey) && isId(row.teamKey)
      && isId(row.opponentKey) && row.teamKey !== row.opponentKey && Array.isArray(row.fields)
      && ["REPORTED_PLAYED", "REPORTED_DID_NOT_PLAY", "UNKNOWN"].includes(row.participation), "Invalid or duplicate fixture row");
    records.add(row.recordKey);
    const input = { playerKey: row.playerKey, teamKey: row.teamKey, opponentKey: row.opponentKey, position: row.position };
    const resolved = structuredClone(await identity.resolve(structuredClone(scope), fixture.playedAt, structuredClone(input)));
    const identityValid = resolved && resolved.bindingSha256 === canonicalSha256([scope, fixture.playedAt, input])
      && resolved.playedAt === fixture.playedAt && resolved.position === row.position && resolved.teamId !== resolved.opponentId
      && [resolved.competitionId, resolved.seasonId, resolved.gameId, resolved.playerId, resolved.teamId, resolved.opponentId].every(isUuid);
    if (!identityValid) {
      rows.push({ recordKey: row.recordKey, status: "UNRESOLVED_IDENTITY" as const });
      continue;
    }
    bind(playerAliases, row.playerKey, resolved.playerId);
    bind(teamAliases, row.teamKey, resolved.teamId);
    bind(teamAliases, row.opponentKey, resolved.opponentId);
    const canonicalScope = canonicalSha256([resolved.competitionId, resolved.seasonId, resolved.gameId,
      [resolved.teamId, resolved.opponentId].sort()]);
    const canonicalKey = JSON.stringify([resolved.gameId, resolved.playerId, resolved.position]);
    const priorTeam = playerTeams.get(resolved.playerId);
    check((gameScope === undefined || canonicalScope === gameScope) && !canonical.has(canonicalKey)
      && (priorTeam === undefined || priorTeam === resolved.teamId), "Conflicting canonical game or player position");
    gameScope = canonicalScope;
    canonical.add(canonicalKey);
    playerTeams.set(resolved.playerId, resolved.teamId);

    const fields = new Map<string, SourceFixtureField>(row.fields.map((field: SourceFixtureField) => [field.sourceField, field]));
    const bindings = mappings.get(row.position) ?? [];
    check(fields.size === row.fields.length && [...fields.keys()].every((key) =>
      bindings.some((binding) => binding.sourceField === key)), "Unknown or duplicate raw field");
    check(row.participation !== "REPORTED_DID_NOT_PLAY" || [...fields.values()].every((field) =>
      field.state !== "REPORTED" || field.value === null || field.value === 0), "Reported non-participation contradicts the source values");
    const byField = new Map(bindings.map((binding) => [binding.field, binding]));
    rows.push({
      recordKey: row.recordKey, status: "UNVERIFIED_FIXTURE" as const, identity: resolved,
      participation: { state: row.participation, verified: false as const },
      fields: Object.fromEntries(metrics.map((metric) => {
        const binding = byField.get(metric.field);
        return [metric.field, { unit: metric.unit, mapping: binding ?? null,
          observation: reported(binding && fields.get(binding.sourceField), metric) }];
      })),
    });
  }
  return {
    label: "SIMULATION" as const, version: sourceAdapterVersion, request: scope, revision, sameRevision,
    finality: fixture.finality, importAllowed: false as const, rows,
  };
}
