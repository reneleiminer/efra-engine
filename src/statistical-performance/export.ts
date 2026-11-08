import { timestamp } from "../contracts/time.ts";
import { canonicalSha256 } from "../ingest/determinism.ts";
import { requirePilot } from "../pilot/signatures.ts";
import type { SignedPilotEnvelope } from "../pilot/signatures.ts";
import { statisticalVersion } from "./contracts.ts";
import type { QbStatInput, StatisticalContext } from "./contracts.ts";
import { authenticateStatistical, loadStatisticalInput } from "./dataset.ts";
import { evaluatePassingHonors, honorsCategories } from "./honors.ts";
import type { HonorsFile } from "./honors.ts";
import { evaluateStatisticalSeason } from "./performance.ts";

export const statisticalReadVersion = "efra-statistical-read-v1";

export interface StatisticalRelease {
  readonly schema: typeof statisticalReadVersion;
  readonly analysisSha256: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly includeLeaderboards: boolean;
  readonly reportPlayerIds: readonly string[];
  readonly honorsHeadSha256?: string;
}

/** Server-owned port; the website's request cannot set it. Lookup must fail closed on outage/revocation. */
export interface StatisticalPublicationRegistry {
  activeReleaseSha256(groupSha256: string): string | undefined;
}

export function exportStatisticalReadModel(input: QbStatInput, context: StatisticalContext,
  registry?: StatisticalPublicationRegistry, release?: SignedPilotEnvelope<StatisticalRelease>, honors?: HonorsFile) {
  const loaded = loadStatisticalInput(input, context);
  const withheld = { schema: statisticalReadVersion, status: "WITHHELD" } as const;
  if (loaded.dataset.origin !== "REAL" || !registry || !release || !loaded.publishRights
    || loaded.policy.status !== "APPROVED" || loaded.dataset.manifest.status !== "COMPLETE"
    || timestamp(loaded.dataset.asOf) < timestamp(loaded.dataset.group.endsBefore)) return withheld;

  const analysis = evaluateStatisticalSeason(loaded);
  const { body, person } = authenticateStatistical(context, "STAT_PUBLICATION", release);
  const now = timestamp(context.now), approved = timestamp(body.approvedAt), expires = timestamp(body.expiresAt);
  requirePilot(body.schema === statisticalReadVersion && body.analysisSha256 === analysis.analysisSha256
    && typeof body.includeLeaderboards === "boolean" && new Set(body.reportPlayerIds).size === body.reportPlayerIds.length
    && approved >= timestamp(analysis.asOf) && approved <= now && now < expires
    && person !== loaded.reviewer && person !== loaded.policyOwner && !loaded.rightsPeople.has(person), "Invalid statistical release");
  if (registry.activeReleaseSha256(analysis.groupSha256) !== canonicalSha256(release)) return withheld;

  const { quality } = analysis;
  requirePilot(!body.includeLeaderboards || (quality.expectedGames > 0 && quality.finalGames === quality.expectedGames
    && quality.completeCandidates === quality.expectedCandidates), "Leaderboards require complete comparison-group evidence");
  const selectedReports = analysis.reports.filter(({ player }) => body.reportPlayerIds.includes(player.id));
  requirePilot(selectedReports.length === body.reportPlayerIds.length && selectedReports.every(({ raw, actualPosition }) =>
    raw !== null && actualPosition === "QB"), "Release includes a report without complete player evidence");

  const decision = honors && body.honorsHeadSha256 !== undefined
    ? evaluatePassingHonors(loaded, analysis, context, honors) : null;
  requirePilot(body.honorsHeadSha256 === undefined || (decision?.state === "APPROVED" && decision.headSha256 === body.honorsHeadSha256
    && !decision.participants.has(person) && decision.nominee && timestamp(decision.history.at(-1)!.decision.at) <= approved),
  "Release does not bind an independently approved Honors decision");

  const { version, competition, competitionId, seasonId, year, stage, startsAt, endsBefore } = analysis.group;
  const group = { version, competition, competitionId, seasonId, year, stage, startsAt, endsBefore };
  const data = { version: analysis.datasetVersion, passingDefinition: analysis.passingDefinition,
    evidenceCoverageVersion: analysis.evidenceCoverageVersion,
    datasetSha256: analysis.datasetSha256, asOf: analysis.asOf,
    analysisSha256: analysis.analysisSha256, policyVersion: analysis.policy.version, policySha256: analysis.policySha256,
    minimumAttempts: analysis.policy.minimumAttempts, completeness: analysis.policy.completeness, quality };
  const categories = Object.entries(honorsCategories).map(([id, category]) => {
    const published = id === "PASSING_EFFICIENCY" && decision?.state === "APPROVED";
    return { id, ...category, awardingBody: "EFRA" as const, officialLeagueAward: false as const,
      status: published ? "PUBLISHED" as const : "NOT_PUBLISHED" as const,
      minimumSample: published ? decision.criteria.minimumAttempts : null,
      criteriaVersion: published ? decision.criteria.version : null,
      recipient: published ? analysis.reports.find(({ player }) => player.id === decision.nominee)!.player : null };
  });
  const reports = selectedReports.map(({ player, teams, actualPosition, raw, measures, coverage, eligibility, games }) => ({
    player, teams, actualPosition, raw, measures, coverage, eligibility,
    games: games.map(({ gameId, teamId, playedAt, sources, status }) => ({ gameId, teamId, playedAt, sources, status })),
  }));
  return { schema: statisticalReadVersion, calculationSchema: statisticalVersion, status: "PUBLISHED",
    group, data, position: "QB", reports,
    leaderboards: body.includeLeaderboards ? analysis.leaderboards : [], honors: categories } as const;
}

export type StatisticalReadModel = ReturnType<typeof exportStatisticalReadModel>;
