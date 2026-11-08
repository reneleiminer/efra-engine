import { requirePilot } from "../pilot/signatures.ts";
import { inspectSourceFixture } from "../source-readiness/adapters.ts";
import type {
  FixtureIdentityResolver, SourceFixtureRequest, SourceFixtureTransport, SourceMapping, SourceRevisionHead,
} from "../source-readiness/adapters.ts";
import { qbUnits } from "./contracts.ts";
import type { ComparisonGroup, QbGameRevision, QbScheduledGame, QbStatRow } from "./contracts.ts";

interface StatisticalFixtureOptions {
  readonly group: ComparisonGroup;
  readonly game: QbScheduledGame;
  readonly mapping: SourceMapping;
  readonly transport: SourceFixtureTransport;
  readonly identities: FixtureIdentityResolver;
  readonly availableAt: string;
  readonly conventionVersion: string;
  readonly previous?: SourceRevisionHead;
}

async function normalize(request: SourceFixtureRequest, options: StatisticalFixtureOptions) {
  const { game, group, mapping, availableAt, conventionVersion, previous } = structuredClone({
    game: options.game, group: options.group, mapping: options.mapping, availableAt: options.availableAt,
    conventionVersion: options.conventionVersion, previous: options.previous,
  });
  const scope = structuredClone(request);
  requirePilot(scope.competition === group.competition && game.competitionId === group.competitionId
    && game.seasonId === group.seasonId && game.stage === group.stage, "Fixture is outside its competition or season phase");
  const inspected = await inspectSourceFixture(scope, mapping, options.transport, options.identities, previous);
  const unresolvedRecordIds: string[] = [];
  const rows: QbStatRow[] = [];
  for (const row of inspected.rows) {
    if (row.status === "UNRESOLVED_IDENTITY") {
      unresolvedRecordIds.push(row.recordKey);
      continue;
    }
    const { identity } = row;
    requirePilot(identity.competitionId === group.competitionId && identity.seasonId === group.seasonId
      && identity.gameId === game.gameId && identity.playedAt === game.playedAt
      && ((identity.teamId === game.homeTeamId && identity.opponentId === game.awayTeamId)
        || (identity.teamId === game.awayTeamId && identity.opponentId === game.homeTeamId)), "Fixture identity does not match the schedule");
    if (identity.position !== "QB") continue;
    requirePilot(game.candidates.some(({ playerId, teamId }) => playerId === identity.playerId && teamId === identity.teamId),
      "Fixture QB is not an expected candidate");
    const field = <K extends keyof typeof qbUnits>(name: K) => {
      const entry = row.fields[`passing.${name}`], unit = qbUnits[name];
      requirePilot(entry?.unit === unit && (!entry.mapping || entry.mapping.conventionVersion === conventionVersion),
        "Fixture passing definition or convention mismatch");
      return { ...entry.observation, unit };
    };
    rows.push({
      recordId: row.recordKey, playerId: identity.playerId, teamId: identity.teamId, reportedRole: row.participation.state,
      role: { status: "UNKNOWN" },
      fields: { attempts: field("attempts"), completions: field("completions"), yards: field("yards"),
        touchdowns: field("touchdowns"), interceptions: field("interceptions") },
    });
  }
  const revision: QbGameRevision = {
    gameId: game.gameId, id: inspected.revision.revisionId,
    ...(previous && !inspected.sameRevision && { supersedes: previous.revisionId }),
    availableAt, finality: inspected.finality, source: scope.provider,
    artifactSha256: inspected.revision.contentSha256, mappingVersion: mapping.version,
    conventionVersion, rows,
  };
  return { label: "SIMULATION" as const, revision, unresolvedRecordIds, head: inspected.revision,
    replay: inspected.sameRevision, importAllowed: false as const };
}

export function normalizeEpfrQbFixture(request: Extract<SourceFixtureRequest, { provider: "EPFR" }>, options: StatisticalFixtureOptions) {
  requirePilot(request.provider === "EPFR", "Expected EPFR synthetic fixture");
  return normalize(request, options);
}

export function normalizeStatsNScoreQbFixture(request: Extract<SourceFixtureRequest, { provider: "STATS_N_SCORE" }>, options: StatisticalFixtureOptions) {
  requirePilot(request.provider === "STATS_N_SCORE", "Expected Stats n Score synthetic fixture");
  return normalize(request, options);
}
