import { timestamp } from "../contracts/time.ts";
import { canonicalSha256 } from "../ingest/determinism.ts";
import { isDigest, requirePilot } from "../pilot/signatures.ts";
import type { SignedPilotEnvelope } from "../pilot/signatures.ts";
import { statisticalVersion } from "./contracts.ts";
import type { QbStatInput, StatisticalContext } from "./contracts.ts";
import { authenticateStatistical, loadStatisticalInput } from "./dataset.ts";
import { evaluateStatisticalSeason } from "./performance.ts";

export const honorsCategories = {
  PASSING_EFFICIENCY: { name: "Passing Efficiency", roles: ["QB"], metric: "Passing yards / attempts",
    sampleUnit: "attempts", evidence: "Final, verified QB game series; all five core fields and participation" },
  RUSHING_EFFICIENCY: { name: "Rushing Efficiency", roles: ["RB"], metric: "Rushing yards / carries",
    sampleUnit: "carries", evidence: "Verified carries and yards; consistent sack and kneel conventions" },
  RECEIVING_PRODUCTION: { name: "Receiving Production", roles: ["WR", "TE"], metric: "Total receiving yards per role group",
    sampleUnit: "receptions", evidence: "Verified receptions, yards and actual receiving role" },
  KICKING_ACCURACY: { name: "Kicking Accuracy", roles: ["K"], metric: "Made field goals / field goal attempts",
    sampleUnit: "field goal attempts", evidence: "Verified attempts and makes; exclude extra points; disclose distance mix" },
  RETURN_PERFORMANCE: { name: "Return Performance", roles: ["KR", "PR"], metric: "Return yards / returns per role group",
    sampleUnit: "returns", evidence: "Verified yards and returns; kick and punt return groups remain separate" },
} as const;

export interface PassingHonorsCriteria {
  readonly schema: typeof statisticalVersion;
  readonly version: string;
  readonly category: "PASSING_EFFICIENCY";
  readonly metric: "yardsPerAttempt";
  readonly groupSha256: string;
  readonly policySha256: string;
  readonly minimumAttempts: number;
  readonly status: "PROVISIONAL" | "APPROVED";
  readonly evidenceSha256: string;
  readonly tieRule: "WITHHOLD_TIED_LEAD";
}

export interface HonorsDecision {
  readonly schema: typeof statisticalVersion;
  readonly analysisSha256: string;
  readonly criteriaSha256: string;
  readonly previousSha256?: string;
  readonly playerId: string;
  readonly at: string;
  readonly action: "PROPOSE" | "APPROVE" | "REJECT" | "WITHDRAW";
  readonly rationale: string;
  readonly evidenceSha256: string;
}

export interface HonorsFile {
  readonly criteria: SignedPilotEnvelope<PassingHonorsCriteria>;
  readonly decisions: readonly SignedPilotEnvelope<HonorsDecision>[];
}

export function reviewPassingHonors(input: QbStatInput, context: StatisticalContext, file: HonorsFile) {
  const loaded = loadStatisticalInput(input, context);
  return evaluatePassingHonors(loaded, evaluateStatisticalSeason(loaded), context, file);
}

export function evaluatePassingHonors(loaded: ReturnType<typeof loadStatisticalInput>,
  analysis: ReturnType<typeof evaluateStatisticalSeason>, context: StatisticalContext, file: HonorsFile) {
  const { body: criteria, person: criteriaOwner } = authenticateStatistical(context, "STAT_POLICY", file.criteria);
  const criteriaSha256 = canonicalSha256(criteria);
  requirePilot(criteria.schema === statisticalVersion && criteria.category === "PASSING_EFFICIENCY"
    && criteria.metric === "yardsPerAttempt" && criteria.groupSha256 === analysis.groupSha256
    && criteria.policySha256 === analysis.policySha256 && criteria.tieRule === "WITHHOLD_TIED_LEAD"
    && ["PROVISIONAL", "APPROVED"].includes(criteria.status) && isDigest(criteria.evidenceSha256) && criteria.version.trim()
    && Number.isSafeInteger(criteria.minimumAttempts) && criteria.minimumAttempts >= analysis.policy.minimumAttempts
    && criteriaOwner !== loaded.reviewer, "Invalid or non-independent Honors criteria");
  const qualifying = analysis.leaderboards.find(({ metric }) => metric === "yardsPerAttempt")!.entries.filter(({ measure }) =>
    measure.denominator >= criteria.minimumAttempts);
  const [first, second] = qualifying;
  const eligibleLead = first && (!second || first.rank !== second.rank) ? first.player.id : undefined;
  let state: "PENDING" | "PROPOSED" | "APPROVED" | "REJECTED" | "WITHDRAWN" = "PENDING";
  let previousSha256: string | undefined;
  let previousTime = timestamp(analysis.asOf) - 1;
  let nominee: string | null = null;
  let proposer: string | undefined;
  const participants = new Set([criteriaOwner]);
  const history = file.decisions.map((envelope) => {
    const { body, person } = authenticateStatistical(context,
      envelope.body.action === "PROPOSE" ? "STAT_HONORS_PROPOSAL" : "STAT_HONORS_REVIEW", envelope);
    const at = timestamp(body.at);
    requirePilot(body.schema === statisticalVersion && body.analysisSha256 === analysis.analysisSha256
      && body.criteriaSha256 === criteriaSha256 && body.previousSha256 === previousSha256 && at > previousTime
      && at <= timestamp(context.now) && body.rationale.trim() && isDigest(body.evidenceSha256),
    "Invalid Honors decision evidence, chronology or history");
    if (body.action === "PROPOSE") {
      requirePilot((state === "PENDING" || state === "REJECTED" || state === "WITHDRAWN") && body.playerId === eligibleLead,
        "No independently selectable Honors candidate under the criteria");
      nominee = body.playerId;
      proposer = person;
      state = "PROPOSED";
    } else {
      requirePilot(person !== proposer && person !== criteriaOwner && person !== loaded.reviewer && person !== loaded.policyOwner
        && !loaded.rightsPeople.has(person) && body.playerId === nominee, "Honors reviewer is not independent or nominee differs");
      if (body.action === "APPROVE") {
        requirePilot(state === "PROPOSED" && criteria.status === "APPROVED" && analysis.policy.status === "APPROVED"
          && analysis.quality.schedule === "COMPLETE" && analysis.quality.finalGames === analysis.quality.expectedGames
          && analysis.quality.completeCandidates === analysis.quality.expectedCandidates
          && timestamp(analysis.asOf) >= timestamp(analysis.group.endsBefore), "Honors criteria or evidence are not approved and complete");
        state = "APPROVED";
      } else if (body.action === "REJECT") {
        requirePilot(state === "PROPOSED", "Only proposed Honors can be rejected");
        state = "REJECTED";
      } else {
        requirePilot(body.action === "WITHDRAW" && state === "APPROVED", "Only approved Honors can be withdrawn");
        state = "WITHDRAWN";
      }
    }
    participants.add(person);
    previousTime = at;
    previousSha256 = canonicalSha256(envelope);
    return { sha256: previousSha256, person, decision: body };
  });
  return { state: state as "PENDING" | "PROPOSED" | "APPROVED" | "REJECTED" | "WITHDRAWN", nominee: nominee as string | null,
    criteria, criteriaSha256, history, participants, headSha256: previousSha256 as string | undefined };
}
