import { canonicalSha256 } from "../ingest/determinism.ts";
import type { PassingCore } from "../models/qb/core.ts";
import { requirePilot } from "../pilot/signatures.ts";
import { compareId } from "../season/scope.ts";
import { evidenceCoverageVersion } from "../source-readiness/coverage.ts";
import { qbFields, qbMetrics, statisticalVersion } from "./contracts.ts";
import type { QbMetric, QbStatInput, StatisticalContext } from "./contracts.ts";
import { assessStatisticalRow, loadStatisticalInput } from "./dataset.ts";

export interface Measure {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number;
  readonly unit: "percent" | "yards_per_attempt" | "attempts";
}

function qbMeasures(passing: PassingCore | null): Readonly<Record<QbMetric, Measure | null>> {
  const measure = (n: number, d: number, unit: Measure["unit"]): Measure => ({
    numerator: n, denominator: d, value: (n / d) * (unit === "percent" ? 100 : 1), unit,
  });
  const rate = (n: number, d: number, unit: Measure["unit"]) => d > 0 ? measure(n, d, unit) : null;
  return {
    completionPercentage: passing ? rate(passing.completions, passing.attempts, "percent") : null,
    yardsPerAttempt: passing ? rate(passing.yards, passing.attempts, "yards_per_attempt") : null,
    touchdownRate: passing ? rate(passing.touchdowns, passing.attempts, "percent") : null,
    interceptionRate: passing ? rate(passing.interceptions, passing.attempts, "percent") : null,
    passingVolume: passing ? measure(passing.attempts, 1, "attempts") : null,
  };
}

function compareMeasure(a: Measure, b: Measure): number {
  const delta = BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator);
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}

const byId = <T extends { id: string }>(a: T, b: T) => compareId(a.id, b.id);

export function calculateStatisticalSeason(input: QbStatInput, context: StatisticalContext) {
  const loaded = loadStatisticalInput(input, context);
  return evaluateStatisticalSeason(loaded);
}

/** Internal shared evaluator. The public boundary always authenticates inputs itself. */
export function evaluateStatisticalSeason(loaded: ReturnType<typeof loadStatisticalInput>) {
  const { dataset, policy, history, groupSha256, datasetSha256 } = loaded;
  const teamNames = new Map(dataset.teams.map(({ id, name }) => [id, name]));
  const orderedGames = [...dataset.games].sort((a, b) => compareId(a.playedAt, b.playedAt) || compareId(a.gameId, b.gameId));
  const expected = new Map<string, { game: (typeof orderedGames)[number]; teamId: string }[]>();
  for (const game of orderedGames) for (const { playerId, teamId } of game.candidates) {
    const entries = expected.get(playerId) ?? [];
    entries.push({ game, teamId });
    expected.set(playerId, entries);
  }
  const reports = [...dataset.players].sort(byId).flatMap(({ id: playerId, name }) => {
    const appearances = expected.get(playerId);
    if (!appearances) return [];
    const aggregate: Record<keyof PassingCore, bigint> = { attempts: 0n, completions: 0n, yards: 0n, touchdowns: 0n, interceptions: 0n };
    const games = appearances.map(({ game, teamId }) => {
      const chain = history.get(game.gameId) ?? [];
      const sources = chain.map(({ id, supersedes, availableAt, finality, source, artifactSha256, mappingVersion, conventionVersion }) =>
        ({ id, ...(supersedes === undefined ? {} : { supersedes }), availableAt, finality, source, artifactSha256, mappingVersion, conventionVersion }));
      const latest = chain.at(-1);
      const row = latest?.rows.find((candidate) => candidate.playerId === playerId);
      const base = { gameId: game.gameId, teamId, playedAt: game.playedAt, sources };
      if (!latest) return { ...base, status: "NO_GAME_REVISION" as const };
      if (latest.finality !== "FINAL") return { ...base, status: "PROVISIONAL_GAME" as const };
      if (!row) return { ...base, status: "MISSING_PLAYER_ROW" as const };
      const fieldStatuses = Object.fromEntries(qbFields.map((field) => [field, row.fields[field].status]));
      const result = assessStatisticalRow(dataset, game, latest, row);
      if (result.status === "UNAVAILABLE") return {
        ...base, status: result.reason, fieldStatuses, roleVerified: row.role.status === "PLAYED_QB",
      };
      if (result.status !== "DID_NOT_PLAY") for (const field of qbFields) aggregate[field] += BigInt(result.stats[field]);
      return { ...base, status: result.status, fieldStatuses, roleVerified: result.status !== "DID_NOT_PLAY" };
    });
    const played = games.filter(({ status }) => status === "PASSING" || status === "VERIFIED_ZERO_ATTEMPTS").length;
    const verifiedDidNotPlay = games.filter(({ status }) => status === "DID_NOT_PLAY").length;
    const missing = games.length - played - verifiedDidNotPlay;
    const overflow = qbFields.some((field) => aggregate[field] > BigInt(Number.MAX_SAFE_INTEGER)
      || aggregate[field] < BigInt(Number.MIN_SAFE_INTEGER));
    const raw: PassingCore | null = played > 0 && missing === 0 && !overflow ? {
      attempts: Number(aggregate.attempts), completions: Number(aggregate.completions), yards: Number(aggregate.yards),
      touchdowns: Number(aggregate.touchdowns), interceptions: Number(aggregate.interceptions),
    } : null;
    const eligibility = dataset.manifest.status !== "COMPLETE" || missing > 0 ? "INCOMPLETE_COVERAGE"
      : overflow ? "TOTAL_OUTSIDE_SAFE_RANGE" : !raw ? "NO_VERIFIED_QB_APPEARANCE"
        : raw.attempts < policy.minimumAttempts ? "BELOW_MINIMUM_ATTEMPTS" : "ELIGIBLE";
    const teams = [...new Set(games.map(({ teamId }) => teamId))].map((id) => ({ id, name: teamNames.get(id)! }));
    return [{ player: { id: playerId, name }, teams, actualPosition: games.some((game) => "roleVerified" in game && game.roleVerified) ? "QB" as const : null,
      raw, measures: qbMeasures(raw), coverage: { expected: games.length, verifiedPlayed: played, verifiedDidNotPlay, missing },
      eligibility, games }];
  });
  const leaderboards = qbMetrics.map((metric) => {
    const direction = metric === "interceptionRate" ? "ASCENDING" : "DESCENDING";
    const rows = reports.flatMap(({ player, measures, eligibility }) => {
      const measure = measures[metric];
      return eligibility === "ELIGIBLE" && measure ? [{ player, measure }] : [];
    });
    rows.sort((a, b) => compareMeasure(a.measure, b.measure) * (direction === "ASCENDING" ? 1 : -1)
      || compareId(a.player.id, b.player.id));
    let rank = 0;
    return { metric, direction, entries: rows.map((row, index) => {
      if (index === 0 || compareMeasure(row.measure, rows[index - 1]!.measure) !== 0) rank = index + 1;
      return { rank, ...row };
    }) };
  });
  const quality = {
    schedule: dataset.manifest.status,
    expectedGames: orderedGames.length,
    finalGames: orderedGames.filter(({ gameId }) => history.get(gameId)?.at(-1)?.finality === "FINAL").length,
    expectedCandidates: reports.length,
    completeCandidates: reports.filter((report) => report.coverage.missing === 0 && report.eligibility !== "TOTAL_OUTSIDE_SAFE_RANGE").length,
    eligiblePlayers: reports.filter((report) => report.eligibility === "ELIGIBLE").length,
  };
  const result = { schema: statisticalVersion, label: dataset.origin === "SYNTHETIC" ? "SIMULATION" as const : "REVIEWED_INTERNAL" as const,
    position: "QB" as const, passingDefinition: dataset.passingDefinition, evidenceCoverageVersion,
    group: dataset.group, groupSha256, datasetSha256, datasetVersion: dataset.version, asOf: dataset.asOf,
    policy, policySha256: canonicalSha256(policy), quality, reports, leaderboards };
  return { ...result, analysisSha256: canonicalSha256(result) };
}

/** Historical revision comparison stays inside the same exact group and policy. */
export function compareQbStatisticalReports(previous: QbStatInput, current: QbStatInput, context: StatisticalContext, playerId: string) {
  const previousInput = loadStatisticalInput(previous, context), currentInput = loadStatisticalInput(current, context);
  const a = evaluateStatisticalSeason(previousInput), b = evaluateStatisticalSeason(currentInput);
  requirePilot(a.groupSha256 === b.groupSha256 && a.policySha256 === b.policySha256 && a.label === b.label && a.asOf < b.asOf,
    "Historical comparison requires the same group and policy with increasing cutoffs");
  for (const [gameId, revisions] of previousInput.history) {
    const next = currentInput.history.get(gameId) ?? [];
    requirePilot(revisions.every((revision, i) => next[i] && canonicalSha256(revision) === canonicalSha256(next[i])),
      "Historical comparison cannot rewrite a prior revision");
  }
  const find = (season: typeof a) => season.reports.find((report) => report.player.id === playerId);
  return { schema: statisticalVersion, groupSha256: a.groupSha256, previousAsOf: a.asOf, currentAsOf: b.asOf,
    previousDatasetSha256: a.datasetSha256, currentDatasetSha256: b.datasetSha256,
    previous: find(a)?.measures ?? null, current: find(b)?.measures ?? null };
}
