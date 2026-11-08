import type { Pool } from "pg";
import { canonicalSha256 } from "../ingest/determinism.ts";
import { PostgresPositionPipeline } from "../ingest/postgres-position-pipeline.ts";
import { compileCanonicalValidation, isSha256 } from "./canonical-bridge.ts";
import type { CanonicalMetricProof, CanonicalValidationDataset, CanonicalValidationRecipe } from "./canonical-bridge.ts";
import type { ScoreCandidate, SensitivityScenario, ValidationSample } from "./contracts.ts";
import { requireValid } from "./dataset.ts";
import { runSyntheticValidation } from "./study.ts";

type Database = Pick<Pool, "query">;
type ResearchPartition = "train" | "validation";

export interface PrivateValidationReport {
  readonly datasetSha256: string;
  readonly modelArtifactSha256: string;
  readonly engineArtifactSha256: string;
  readonly result: ReturnType<typeof runSyntheticValidation>;
  readonly bridgeExclusions: readonly { readonly partition: string; readonly id: string; readonly issues: readonly string[] }[];
}

export function privateValidationReport(dataset: CanonicalValidationDataset, result: PrivateValidationReport["result"]): PrivateValidationReport {
  return {
    datasetSha256: dataset.datasetSha256, engineArtifactSha256: dataset.engineArtifactSha256,
    modelArtifactSha256: dataset.modelArtifactSha256, result,
    bridgeExclusions: dataset.batches.flatMap(({ partition, payload }) => payload.flatMap(({ sample, issues }) =>
      issues.length ? [{ partition, id: sample.id, issues }] : [])),
  };
}

export async function executeSealedHoldout(
  db: Database, id: string, runId: string, engineDigest: string,
  compute: (dataset: CanonicalValidationDataset) => Promise<PrivateValidationReport> | PrivateValidationReport,
  pilot?: { readonly datasetSha256: string; readonly runManifestSha256: string },
) {
  const { rows: [claim] } = pilot
    ? await db.query<{ ticket: string }>("SELECT efra_validation.claim_pilot_evaluation($1,$2,$3,$4,$5) AS ticket",
      [id, runId, engineDigest, pilot.datasetSha256, pilot.runManifestSha256])
    : await db.query<{ ticket: string }>("SELECT efra_validation.claim_evaluation($1,$2,$3) AS ticket", [id, runId, engineDigest]);
  requireValid(claim, "Missing committed evaluation ticket");
  const { rows: [row] } = await db.query<{ payload: CanonicalValidationDataset }>(
    "SELECT efra_validation.read_evaluation($1) AS payload", [claim.ticket],
  );
  requireValid(row, "Missing evaluation payload");
  let report: PrivateValidationReport;
  try {
    const { datasetSha256, ...contents } = row.payload;
    requireValid(datasetSha256 === canonicalSha256(contents), "Sealed dataset digest mismatch");
    requireValid(contents.recipeSha256 === canonicalSha256(contents.recipe), "Sealed recipe digest mismatch");
    requireValid(contents.engineArtifactSha256 === engineDigest, "Worker artifact does not match the approved study");
    report = await compute(row.payload);
  } catch {
    await db.query("SELECT efra_validation.record_report($1,$2,NULL::jsonb)", [id, runId]);
    throw new Error("Sealed evaluation failed. See the private audit journal.");
  }
  await db.query("SELECT efra_validation.record_report($1,$2,$3::jsonb)", [id, runId, report]);
  return { label: "SIMULATION" as const, datasetSha256: report.datasetSha256, officialEligible: false as const };
}

export class PostgresValidationCustodian {
  readonly #db: Database;
  readonly #vault: Database;

  constructor(db: Database, vault: Database = db) {
    this.#db = db;
    this.#vault = vault;
  }

  async #readRelease(snapshotId: string) {
    const { rows: [evidence] } = await this.#db.query<{ projected_at: Date; available_at: Date; proofs: CanonicalMetricProof[] }>(
      "SELECT projected_at, available_at, proofs FROM efra_validation.canonical_proofs($1)", [snapshotId],
    );
    if (!evidence) return null;
    const release = await new PostgresPositionPipeline(this.#db).readRelease(snapshotId);
    if (!release) return null;
    return { release, projectedAt: evidence.projected_at.toISOString(), availableAt: evidence.available_at.toISOString(),
      proofs: evidence.proofs };
  }

  async observeRelease(snapshotId: string) {
    const { rows: [row] } = await this.#db.query<{ available_at: Date | null }>(
      "SELECT efra_validation.observe_release($1) AS available_at", [snapshotId],
    );
    return row?.available_at?.toISOString() ?? null;
  }

  async seal(id: string, researcherSubject: string, recipe: CanonicalValidationRecipe) {
    const dataset = await compileCanonicalValidation((snapshotId) => this.#readRelease(snapshotId), recipe);
    const { rows: [row] } = await this.#vault.query<{ status: "SEALED" | "ALREADY_SEALED" }>(
      "SELECT efra_validation.seal($1,$2,$3,$4::jsonb) AS status", [id, dataset.datasetSha256, researcherSubject, dataset],
    );
    requireValid(row, "Dataset sealing did not return a status");
    return { status: row.status, datasetSha256: dataset.datasetSha256 };
  }
}

export class PostgresValidationResearcher {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async requestDevelopment(id: string, partition: ResearchPartition) {
    const { rows: [row] } = await this.#db.query<{ ticket: string }>(
      "SELECT efra_validation.request_development($1,$2) AS ticket", [id, partition],
    );
    requireValid(row, "Missing development ticket");
    return row.ticket;
  }
}

export class PostgresValidationApprover {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async reviewManifest(id: string) {
    const { rows: [row] } = await this.#db.query<{ manifest: {
      readonly datasetSha256: string;
      readonly recipeSha256: string;
      readonly engineArtifactSha256: string;
      readonly modelArtifactSha256: string;
      readonly product: CanonicalValidationRecipe["header"]["product"];
      readonly plan: Omit<CanonicalValidationRecipe["header"]["plan"], "leagueContext"> & {
        readonly leagueContext?: { readonly referenceLeagueId: string; readonly version: string };
      };
      readonly candidates: readonly ScoreCandidate[] | null;
      readonly sensitivity: readonly SensitivityScenario[] | null;
      readonly probabilityFeature: string | null;
      readonly binEdges: readonly number[] | null;
    } }>("SELECT efra_validation.review_manifest($1) AS manifest", [id]);
    requireValid(row, "Missing study review manifest");
    return row.manifest;
  }

  async approve(id: string, datasetSha256: string, reason: string) {
    await this.#db.query("SELECT efra_validation.approve($1,$2,$3)", [id, datasetSha256, reason]);
  }

  async requestPrivateReport(id: string) {
    const { rows: [row] } = await this.#db.query<{ ticket: string }>(
      "SELECT efra_validation.request_report($1) AS ticket", [id],
    );
    requireValid(row, "Missing private report ticket");
    return row.ticket;
  }
}

/** Trusted worker uses a pool (autocommit), never a caller's transaction or interactive credentials. */
export class PostgresValidationWorker {
  readonly #db: Database;
  readonly #engineArtifactSha256: string;

  constructor(db: Database, engineArtifactSha256: string) {
    requireValid(isSha256(engineArtifactSha256), "Missing immutable worker artifact digest");
    this.#db = db;
    this.#engineArtifactSha256 = engineArtifactSha256;
  }

  async readDevelopment(ticket: string, recipientSubject: string) {
    const { rows: [row] } = await this.#db.query<{ payload: {
      readonly partition: ResearchPartition;
      readonly samples: readonly ValidationSample[];
    } }>("SELECT efra_validation.read_development($1,$2) AS payload", [ticket, recipientSubject]);
    requireValid(row, "Missing development data");
    return row.payload;
  }

  async readPrivateReport(ticket: string, recipientSubject: string) {
    const { rows: [row] } = await this.#db.query<{ report: PrivateValidationReport }>(
      "SELECT efra_validation.read_report($1,$2) AS report", [ticket, recipientSubject],
    );
    requireValid(row, "Missing private report");
    return row.report;
  }

  async evaluate(id: string, runId: string) {
    return executeSealedHoldout(this.#db, id, runId, this.#engineArtifactSha256,
      (dataset) => privateValidationReport(dataset, runSyntheticValidation(dataset.study)));
  }
}
