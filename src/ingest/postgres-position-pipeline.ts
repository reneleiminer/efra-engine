import type { Pool } from "pg";
import type { LeagueStrengthEstimate } from "../context/league-strength.ts";
import type { Observation } from "../contracts/observations.ts";
import type { RatingResult } from "../contracts/rating.ts";
import type { CompetitionSeason, GameStatistics, Position, QbGame } from "../contracts/statistics.ts";
import type { FieldPosition, FieldStatistics } from "../models/positions/catalog.ts";
import { gameObservations, positionMetricRegistry, positionMetricRegistryVersion, positionProjectionVersion } from "../models/positions/metric-registry.ts";
import type { PositionMetric } from "../models/positions/metric-registry.ts";
import type { QbSeasonSimulation } from "../models/qb/scoring.ts";
import { calculateFieldSeasonPerformance } from "../season/field-performance.ts";
import type { FieldSeasonSimulation } from "../season/field-performance.ts";
import { calculateSeasonPerformance } from "../season/performance.ts";
import { compareId } from "../season/scope.ts";
import { canonicalJson, canonicalSha256 } from "./determinism.ts";
import { PostgresApprovedSnapshotReader } from "./postgres-snapshot-reader.ts";
import type { ApprovedImportSnapshot } from "./postgres-stage-store.ts";

export interface ProjectedPositionFact {
  readonly stageId: string;
  readonly field: string;
  readonly unit: PositionMetric["unit"];
  readonly observation: Exclude<Observation, { status: "CONFLICTED" | "ESTIMATED_FOR_RESEARCH_ONLY" }>;
  readonly observationId: string | null;
}

export interface PositionRelease {
  readonly snapshot: ApprovedImportSnapshot;
  readonly facts: readonly ProjectedPositionFact[];
  readonly registryVersion: typeof positionMetricRegistryVersion;
  readonly projectionVersion: typeof positionProjectionVersion;
}

export interface PositionReplayRequest<P extends Position> {
  readonly playerId: string;
  readonly position: P;
  readonly season: CompetitionSeason;
  readonly stints: readonly {
    readonly id: string;
    readonly teamId: string;
    readonly expectedGameIds: readonly string[];
  }[];
  readonly engineCommit: string;
  readonly configurationSha256: string;
}

export interface PositionSimulationReplay {
  readonly label: "SIMULATION";
  readonly rankingEligible: false;
  readonly snapshotId: string;
  readonly registryVersion: typeof positionMetricRegistryVersion;
  readonly projectionVersion: typeof positionProjectionVersion;
  readonly engineCommit: string;
  readonly configurationSha256: string;
  readonly inputSha256: string;
  readonly observationIds: readonly string[];
  readonly rating: RatingResult;
}

const metricsByPosition = Map.groupBy(positionMetricRegistry().metrics.filter(({ storage }) => storage === "GAME"), ({ position }) => position);

export class PostgresPositionPipeline {
  readonly #pool: Pick<Pool, "query">;

  constructor(pool: Pick<Pool, "query">) {
    this.#pool = pool;
  }

  async project(snapshotId: string): Promise<"PROJECTED" | "ALREADY_PROJECTED"> {
    const { rows: [result] } = await this.#pool.query<{ result: "PROJECTED" | "ALREADY_PROJECTED" }>(
      "SELECT efra_ingest.project_position_snapshot($1, $2) AS result", [snapshotId, positionProjectionVersion],
    );
    if (!result) throw new Error("Missing position projection result");
    return result.result;
  }

  async readRelease(snapshotId: string): Promise<PositionRelease | null> {
    const { rows: [projection] } = await this.#pool.query<{
      projection_version: string; registry_version: string; facts: ProjectedPositionFact[];
    }>("SELECT * FROM efra_ingest.read_position_projection($1)", [snapshotId]);
    if (!projection) return null;
    if (projection.projection_version !== positionProjectionVersion || projection.registry_version !== positionMetricRegistryVersion) {
      throw new Error("Incompatible position projection or metric registry");
    }
    const snapshot = await new PostgresApprovedSnapshotReader(this.#pool).readSnapshot(snapshotId);
    if (!snapshot || snapshot.origin !== "SYNTHETIC") throw new Error("Missing approved synthetic snapshot");
    verifyFacts(snapshot, projection.facts);
    return { snapshot, facts: projection.facts, registryVersion: positionMetricRegistryVersion, projectionVersion: positionProjectionVersion };
  }

  async simulateQb(snapshotId: string, request: PositionReplayRequest<"QB">, policy: QbSeasonSimulation,
    context?: LeagueStrengthEstimate): Promise<PositionSimulationReplay | null> {
    const release = await this.readRelease(snapshotId);
    if (!release) return null;
    const games = release.snapshot.games.flatMap(({ game }) =>
      game.position === "QB" && game.playerId === request.playerId ? [game satisfies QbGame] : []);
    const input = seasonInput(release.snapshot, request, games);
    return replay(release, request, input, calculateSeasonPerformance(input, policy, context), context);
  }

  async simulateField<P extends FieldPosition>(snapshotId: string, request: PositionReplayRequest<P>,
    policy: FieldSeasonSimulation<NoInfer<P>>, context?: LeagueStrengthEstimate): Promise<PositionSimulationReplay | null> {
    const release = await this.readRelease(snapshotId);
    if (!release) return null;
    const games = release.snapshot.games.flatMap(({ game }) =>
      game.position === request.position && game.playerId === request.playerId
        ? [game as GameStatistics<P, FieldStatistics<P>>] : []);
    const input = seasonInput(release.snapshot, request, games);
    return replay(release, request, input, calculateFieldSeasonPerformance(input, policy, context), context);
  }
}

function verifyFacts(snapshot: ApprovedImportSnapshot, facts: readonly ProjectedPositionFact[]) {
  const byStage = Map.groupBy(facts, ({ stageId }) => stageId);
  if (byStage.size !== snapshot.games.length) throw new Error("Position projection does not cover the released games");
  for (const { stageId, game } of snapshot.games) {
    const metrics = metricsByPosition.get(game.position);
    const entries = byStage.get(stageId);
    const byField = new Map(entries?.map((fact) => [fact.field, fact]));
    if (!metrics || entries?.length !== metrics.length || byField.size !== metrics.length) {
      throw new Error("Position projection does not cover the required registry fields");
    }
    const raw = gameObservations(game);
    for (const metric of metrics) {
      const fact = byField.get(metric.field);
      const observation = raw[metric.field] ?? { status: "MISSING" };
      const numeric = observation.status === "OBSERVED" || observation.status === "VERIFIED_ZERO";
      if (!fact || fact.unit !== metric.unit || numeric !== (fact.observationId !== null)
        || canonicalJson(observation) !== canonicalJson(fact.observation)) {
        throw new Error("Frozen snapshot does not match its position projection");
      }
    }
  }
}

function seasonInput<P extends Position, T>(snapshot: ApprovedImportSnapshot, request: PositionReplayRequest<P>,
  games: readonly GameStatistics<P, T>[]) {
  if (request.season.id !== snapshot.seasonId || request.season.competitionId !== snapshot.competitionId
    || request.season.leagueId !== snapshot.competitionId || !/^[0-9a-f]{40}$/.test(request.engineCommit)
    || !/^[0-9a-f]{64}$/.test(request.configurationSha256)) {
    throw new Error("Replay requires the approved scope and exact engine and configuration identifiers");
  }
  const coverage = new Map<string, string>();
  for (const stint of request.stints) {
    for (const gameId of stint.expectedGameIds) {
      if (coverage.has(gameId)) throw new Error("Expected games must belong to exactly one stint");
      coverage.set(gameId, stint.teamId);
    }
  }
  if (games.some(({ gameId, teamId }) => coverage.get(gameId) !== teamId)) {
    throw new Error("The approved games do not match the requested stint coverage");
  }
  const byGame = new Map(games.map((game) => [game.gameId, game]));
  const stints = [...request.stints].sort((left, right) => compareId(left.id, right.id)).map((stint) => {
    const expectedGameIds = [...stint.expectedGameIds].sort(compareId);
    return { ...stint, expectedGameIds, games: expectedGameIds.flatMap((id) => {
      const game = byGame.get(id);
      return game ? [game] : [];
    }) };
  });
  return {
    playerId: request.playerId, position: request.position, season: request.season, asOf: snapshot.asOf, stints,
    snapshot: { origin: "SYNTHETIC", dataVersion: snapshot.snapshotId, schemaVersion: snapshot.schemaVersion, availableAt: snapshot.asOf },
  } as const;
}

function replay(release: PositionRelease, request: PositionReplayRequest<Position>, input: unknown, rating: RatingResult,
  context: LeagueStrengthEstimate | undefined): PositionSimulationReplay {
  const stageIds = new Set(release.snapshot.games.flatMap(({ stageId, game }) =>
    game.playerId === request.playerId && game.position === request.position ? [stageId] : []));
  const facts = release.facts.filter(({ stageId }) => stageIds.has(stageId));
  return {
    label: "SIMULATION", rankingEligible: false, snapshotId: release.snapshot.snapshotId,
    registryVersion: release.registryVersion, projectionVersion: release.projectionVersion,
    engineCommit: request.engineCommit, configurationSha256: request.configurationSha256,
    inputSha256: canonicalSha256({ input, facts, context }),
    observationIds: facts.flatMap(({ observationId }) => observationId ? [observationId] : []).sort(compareId), rating,
  };
}
