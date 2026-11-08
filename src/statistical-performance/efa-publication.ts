import type { Pool } from "pg";
import { timestamp } from "../contracts/time.ts";
import { canonicalSha256 } from "../ingest/determinism.ts";
import { bindPilotAction, executePilotAction } from "../pilot/sessions.ts";
import type { PilotActionAttestation, PilotActionBoundary, StatisticalPilotAction, StatisticalPilotActionPayload } from "../pilot/sessions.ts";
import { isDigest, isPilotId, isUuid, requirePilot } from "../pilot/signatures.ts";
import type { SignedPilotEnvelope } from "../pilot/signatures.ts";
import type { QbStatInput } from "./contracts.ts";
import { authenticateStatistical, loadStatisticalInput } from "./dataset.ts";
import { efaPublicationResource, reconcileEfaQbSeason } from "./efa-evidence.ts";
import type { EfaPilotContext, EfaPilotEvidence } from "./efa-evidence.ts";
import { exportStatisticalReadModel, statisticalReadVersion } from "./export.ts";
import type { StatisticalRelease } from "./export.ts";

export interface EfaPublicationBundle {
  readonly evidence: EfaPilotEvidence;
  readonly statistics: QbStatInput;
}

function verifyBundle(bundle: EfaPublicationBundle, context: EfaPilotContext) {
  const reconciled = reconcileEfaQbSeason(bundle.evidence, context);
  const loaded = loadStatisticalInput(bundle.statistics, context);
  requirePilot(reconciled.dataset && canonicalSha256(reconciled.dataset) === loaded.datasetSha256,
    "EFA dataset does not match the reconciled export");
  const excluded = new Set([...reconciled.evidencePeople, ...reconciled.accessPeople]);
  requirePilot(!excluded.has(loaded.reviewer) && !excluded.has(loaded.policyOwner),
    "EFA dataset and policy reviewers must be independent from the evidence and access attestations");
  const targetSha256 = canonicalSha256([efaPublicationResource, context.environment, loaded.datasetSha256,
    canonicalSha256(loaded.policy), reconciled.reconciliationSha256]);
  return { reconciled, loaded, targetSha256, excluded };
}

export function efaPublicationTarget(bundle: EfaPublicationBundle, context: EfaPilotContext) {
  return verifyBundle(bundle, context).targetSha256;
}

type ActionRequest =
  | { readonly action: "REVIEW_EFA_STATISTICS"; readonly bundle: EfaPublicationBundle }
  | { readonly action: "PUBLISH_EFA_STATISTICS"; readonly bundle: EfaPublicationBundle; readonly release: SignedPilotEnvelope<StatisticalRelease> }
  | { readonly action: "REVOKE_EFA_STATISTICS" };

const operations: Record<StatisticalPilotAction, string> = {
  REVIEW_EFA_STATISTICS: "REVIEW", PUBLISH_EFA_STATISTICS: "PUBLISH", REVOKE_EFA_STATISTICS: "REVOKE",
};
const withheld = { schema: statisticalReadVersion, status: "WITHHELD" } as const;

export class PostgresEfaPublicationWriter {
  readonly #db: Pick<Pool, "query">;
  constructor(db: Pick<Pool, "query">) { this.#db = db; }

  async headReceipt(environment: string) {
    requirePilot(isPilotId(environment), "Invalid EFA publication environment");
    const { rows: [head] } = await this.#db.query<{ id: string; action: "REVIEW" | "PUBLISH" | "REVOKE"; target: string }>(
      "SELECT * FROM efra_statistical.head_receipt($1)", [environment],
    );
    return head;
  }

  async commit(boundary: PilotActionBoundary, context: EfaPilotContext, request: ActionRequest,
    input: StatisticalPilotActionPayload, authorization: SignedPilotEnvelope<PilotActionAttestation>) {
    requirePilot(context.environment === boundary.environment, "EFA action environment mismatch");
    const frozen = structuredClone(request);
    const actionProof = structuredClone(authorization);
    const command = bindPilotAction(frozen.action, efaPublicationResource, input);
    return executePilotAction(boundary, command, input, actionProof, context.keys, {
      commitOnce: async (event, payload) => {
        requirePilot("targetSha256" in payload && typeof payload.targetSha256 === "string"
          && "expectedHead" in payload && "reason" in payload, "Invalid EFA authorization payload");
        let evidence: object = {};
        if (frozen.action !== "REVOKE_EFA_STATISTICS") {
          const { loaded, reconciled, excluded, targetSha256 } = verifyBundle(frozen.bundle, context);
          requirePilot(targetSha256 === payload.targetSha256, "EFA action does not bind this reviewed dataset");
          if (frozen.action === "REVIEW_EFA_STATISTICS") {
            requirePilot(event.human.personId === loaded.reviewer, "EFA dataset reviewer is not the authenticated session owner");
            evidence = {
              competitionId: loaded.dataset.group.competitionId, seasonId: loaded.dataset.group.seasonId,
              origin: loaded.dataset.origin, groupSha256: loaded.groupSha256, asOf: loaded.dataset.asOf,
              lineage: reconciled.revisionLineage,
            };
          } else {
            const { body, person } = authenticateStatistical(context, "STAT_PUBLICATION", frozen.release);
            const releaseSha256 = canonicalSha256(frozen.release);
            requirePilot(payload.releaseSha256 === releaseSha256, "EFA session action does not bind this release");
            requirePilot(event.human.personId === person && !excluded.has(person) && reconciled.publishRights
              && body.honorsHeadSha256 === undefined && body.includeLeaderboards === true && body.reportPlayerIds.length === 0,
            "EFA pilot requires an independent authenticated publisher, source rights and a QB leaderboard-only release");
            const view = exportStatisticalReadModel(frozen.bundle.statistics, context,
              { activeReleaseSha256: () => releaseSha256 }, frozen.release);
            requirePilot(view.status === "PUBLISHED", "EFA release has not passed publication checks");
            const expiresAt = [body.expiresAt, reconciled.accessExpiresAt!, ...frozen.bundle.statistics.rights!.map((grant) => grant.body.expiresAt)]
              .sort()[0]!;
            evidence = { groupSha256: loaded.groupSha256, releaseSha256, expiresAt };
          }
        }
        const { rows: [result] } = await this.#db.query<{ id: string }>(
          "SELECT efra_statistical.commit_action($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) AS id",
          [context.environment, event.nonce, operations[frozen.action], payload.expectedHead, payload.targetSha256,
            event.human.personId, event.human.issuer, event.human.subject, event.sessionSha256, event.signingKeyId,
            canonicalSha256(actionProof), new Date(event.expiresAt), payload.reason, JSON.stringify(evidence)],
        );
        requirePilot(result?.id === event.nonce, "EFA publication acknowledgement unavailable");
        return result.id;
      },
    });
  }
}

interface ActiveHead { readonly id: string; readonly group_sha: string; readonly target: string; readonly release_sha: string }

export class PostgresEfaPublicationReader {
  readonly #db: Pick<Pool, "query">;
  constructor(db: Pick<Pool, "query">) { this.#db = db; }

  async #active(environment: string) {
    requirePilot(isPilotId(environment), "Invalid EFA publication environment");
    const { rows: [head] } = await this.#db.query<ActiveHead>("SELECT * FROM efra_statistical.active_release($1)", [environment]);
    return head;
  }

  /** Exposes a lookup receipt for authorized operators. It includes no identities or source payload. */
  async activeReceipt(environment: string) {
    const head = await this.#active(environment);
    return head && { id: head.id, releaseSha256: head.release_sha };
  }

  async read(bundle: EfaPublicationBundle, release: SignedPilotEnvelope<StatisticalRelease>, context: EfaPilotContext) {
    try {
      if (context.licensedDataEnabled !== true) return withheld;
      const frozen = structuredClone({ bundle, release });
      const head = await this.#active(context.environment);
      if (!head || !isUuid(head.id) || !isDigest(head.release_sha)) return withheld;
      const { loaded, reconciled, targetSha256, excluded } = verifyBundle(frozen.bundle, context);
      if (loaded.dataset.origin !== "REAL" || !reconciled.publishRights || head.target !== targetSha256
        || head.group_sha !== loaded.groupSha256 || head.release_sha !== canonicalSha256(frozen.release)) return withheld;
      const { body, person } = authenticateStatistical(context, "STAT_PUBLICATION", frozen.release);
      if (excluded.has(person) || body.honorsHeadSha256 !== undefined || body.includeLeaderboards !== true || body.reportPlayerIds.length !== 0
        || timestamp(body.expiresAt) <= timestamp(context.now)) return withheld;
      const output = exportStatisticalReadModel(frozen.bundle.statistics, context,
        { activeReleaseSha256: () => head.release_sha }, frozen.release);
      const finalHead = await this.#active(context.environment);
      return finalHead?.id === head.id ? output : withheld;
    } catch {
      return withheld;
    }
  }
}
