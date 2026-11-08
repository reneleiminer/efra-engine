import { readObservation } from "../contracts/observations.ts";
import type { DataOrigin, Observation } from "../contracts/observations.ts";
import type { Position } from "../contracts/statistics.ts";
import type { ModelVersion } from "../contracts/rating.ts";
import { timestamp } from "../contracts/time.ts";

export interface LeagueContextRequest {
  readonly origin: DataOrigin;
  readonly position: Position;
  readonly leagueId: string;
  readonly referenceLeagueId: string;
  readonly version: string;
  readonly asOf: string;
}

export interface LeagueBridge {
  readonly id: string;
  readonly kind: "TRANSFER" | "INTERLEAGUE";
  readonly position: Position;
  readonly leagueId: string;
  readonly referenceLeagueId: string;
  readonly observedAt: string;
  readonly availableAt: string;
  /** Positive means the first league's competition is more difficult. */
  readonly difficultyDifference: Observation;
  readonly simulationVariance: number;
}

export type LeagueStrengthEstimate =
  | { readonly status: "UNAVAILABLE" }
  | (Omit<LeagueContextRequest, "origin"> & {
      readonly status: "AVAILABLE";
      readonly origin: "SYNTHETIC";
      readonly label: "SIMULATION";
      readonly adjustment: number;
      readonly simulationVariance: number;
      readonly evidenceIds: readonly string[];
    });

export function estimateSyntheticLeagueStrength(
  request: LeagueContextRequest,
  bridges: readonly LeagueBridge[],
): LeagueStrengthEstimate {
  const { origin, position, leagueId, referenceLeagueId, version, asOf } = request;
  const unavailable = { status: "UNAVAILABLE" } as const;
  const cutoff = timestamp(asOf);
  if (origin !== "SYNTHETIC" || !Number.isFinite(cutoff)
    || [leagueId, referenceLeagueId, version].some((value) => !value.trim())) return unavailable;
  const base = { ...request, origin: "SYNTHETIC", label: "SIMULATION", status: "AVAILABLE" } as const;
  if (leagueId === referenceLeagueId) return { ...base, adjustment: 0, simulationVariance: 0, evidenceIds: [] };
  const evidence = [];
  const ids = new Set<string>();
  for (const bridge of bridges) {
    if (bridge.position !== position) continue;
    const direct = bridge.leagueId === leagueId && bridge.referenceLeagueId === referenceLeagueId;
    const reverse = bridge.leagueId === referenceLeagueId && bridge.referenceLeagueId === leagueId;
    if (!direct && !reverse) continue;
    const observed = timestamp(bridge.observedAt);
    const available = timestamp(bridge.availableAt);
    if (!Number.isFinite(observed) || !Number.isFinite(available) || observed > available) return unavailable;
    if (available > cutoff) continue;
    const delta = readObservation(bridge.difficultyDifference, origin, Number.isFinite);
    const precision = 1 / bridge.simulationVariance;
    if (!bridge.id.trim() || ids.has(bridge.id) || delta.status !== "AVAILABLE"
      || !Number.isFinite(precision) || precision <= 0) return unavailable;
    ids.add(bridge.id);
    evidence.push({ id: bridge.id, delta: direct ? delta.value : -delta.value, precision });
  }
  evidence.sort((left, right) => left.id < right.id ? -1 : 1);
  const precision = evidence.reduce((sum, bridge) => sum + bridge.precision, 0);
  if (precision <= 0 || !Number.isFinite(precision)) return unavailable;
  const adjustment = evidence.reduce((sum, bridge) => sum + bridge.delta * (bridge.precision / precision), 0);
  const simulationVariance = 1 / precision;
  if (!Number.isFinite(adjustment) || !Number.isFinite(simulationVariance)) return unavailable;
  return { ...base, adjustment, simulationVariance, evidenceIds: evidence.map(({ id }) => id) };
}

export function resolveLeagueAdjustment(
  leagueId: string, position: Position, asOf: string, version: ModelVersion,
  scale: number | undefined, context: LeagueStrengthEstimate | undefined,
) {
  const { comparisonScope, contextVersion } = version;
  if (!comparisonScope || comparisonScope.basis === "LEAGUE") {
    return (!comparisonScope || comparisonScope.leagueId === leagueId) && context === undefined && scale === undefined
      ? { value: 0, evidenceIds: [] } : null;
  }
  if (comparisonScope.basis !== "BRIDGE_REFERENCE" || context?.status !== "AVAILABLE"
    || context.origin !== "SYNTHETIC" || context.label !== "SIMULATION" || context.position !== position
    || context.leagueId !== leagueId || context.referenceLeagueId !== comparisonScope.leagueId
    || context.version !== contextVersion || context.asOf !== asOf || !Number.isFinite(context.adjustment)
    || !Number.isFinite(context.simulationVariance) || context.simulationVariance < 0
    || new Set(context.evidenceIds).size !== context.evidenceIds.length || context.evidenceIds.some((id) => !id.trim())
    || (context.leagueId !== context.referenceLeagueId && (context.evidenceIds.length === 0 || context.simulationVariance === 0))
    || (context.leagueId === context.referenceLeagueId
      && (context.adjustment !== 0 || context.simulationVariance !== 0 || context.evidenceIds.length !== 0))
    || scale === undefined || !Number.isFinite(scale) || scale <= 0) return null;
  const value = scale * context.adjustment;
  return Number.isFinite(value) ? { value, evidenceIds: context.evidenceIds } : null;
}
