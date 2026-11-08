import type { Pool } from "pg";
import { timestamp } from "../contracts/time.ts";
import { canonicalJson, canonicalSha256 } from "../ingest/determinism.ts";
import type { ValidationStudy } from "../validation/contracts.ts";
import { executeSealedHoldout, privateValidationReport } from "../validation/postgres-holdout.ts";
import type { PrivateValidationReport } from "../validation/postgres-holdout.ts";
import { monitorPilot } from "./monitoring.ts";
import type { PilotMonitor } from "./monitoring.ts";
import { isDigest, isPilotId, isUuid, requirePilot, sha256Bytes, signPilot, verifyPilot } from "./signatures.ts";
import type { PilotKeyTrust, PilotSigner, SignedPilotEnvelope } from "./signatures.ts";

export interface PilotEngineManifest {
  readonly version: "efra-pilot-engine-v1";
  readonly engineSha256: string;
  readonly sourceCommit: string;
  readonly protocolVersion: string;
}
export interface PilotRunManifest {
  readonly version: "efra-pilot-run-v1";
  readonly mode: "SYNTHETIC_ONLY";
  readonly datasetId: string;
  readonly runId: string;
  readonly datasetSha256: string;
  readonly engineSha256: string;
  readonly modelSha256: string;
  readonly configurationSha256: string;
  readonly reportKeyId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
interface PilotReportBinding {
  readonly version: "efra-pilot-report-v1";
  readonly runManifestSha256: string;
  readonly reportSha256: string;
}
export interface SignedPrivateValidationReport extends PrivateValidationReport {
  readonly pilot: SignedPilotEnvelope<PilotReportBinding>;
}

export function serializePilotStudyArtifacts(study: ValidationStudy) {
  const model = study.product === "CONFIDENCE"
    ? { modelVersion: study.plan.modelVersion, product: study.product, probabilityFeature: study.probabilityFeature, binEdges: study.binEdges }
    : { modelVersion: study.plan.modelVersion, product: study.product, candidates: study.candidates };
  const configuration = study.product === "CONFIDENCE" ? { plan: study.plan }
    : { plan: study.plan, sensitivity: study.sensitivity };
  return { model: Buffer.from(canonicalJson(model)), configuration: Buffer.from(canonicalJson(configuration)) };
}

function readRun(environment: string, signedRun: SignedPilotEnvelope<PilotRunManifest>, trust: PilotKeyTrust) {
  const run = verifyPilot(environment, "RUN", signedRun, trust);
  const lifetime = timestamp(run.expiresAt) - timestamp(run.issuedAt);
  requirePilot(run.version === "efra-pilot-run-v1" && run.mode === "SYNTHETIC_ONLY" && isPilotId(run.datasetId)
    && isUuid(run.runId) && isPilotId(run.reportKeyId) && lifetime > 0 && lifetime <= 86_400_000
    && [run.datasetSha256, run.engineSha256, run.modelSha256, run.configurationSha256].every(isDigest), "Invalid pilot run manifest");
  return run;
}

function requireCurrentRun(run: PilotRunManifest, now: number) {
  requirePilot(timestamp(run.issuedAt) <= now && now < timestamp(run.expiresAt), "Pilot run authorization is not current");
}

export class PostgresPilotApprover {
  readonly #environment: string;
  readonly #db: Pick<Pool, "query">;
  readonly #trust: PilotKeyTrust;
  readonly #now: () => number;

  constructor(environment: string, db: Pick<Pool, "query">, trust: PilotKeyTrust, now = Date.now) {
    this.#environment = environment;
    this.#db = db;
    this.#trust = trust;
    this.#now = now;
  }

  async register(signedRun: SignedPilotEnvelope<PilotRunManifest>) {
    const run = readRun(this.#environment, signedRun, this.#trust);
    requireCurrentRun(run, this.#now());
    const { rows: [row] } = await this.#db.query<{ status: "REGISTERED" | "ALREADY_REGISTERED" }>(
      "SELECT efra_validation.register_pilot_run($1,$2,$3,$4,$5) AS status",
      [run.datasetId, run.runId, run.datasetSha256, canonicalSha256(run), run.reportKeyId],
    );
    requirePilot(row, "Missing pilot run registration");
    return row.status;
  }
}

function validateResult(report: PrivateValidationReport) {
  const { reportSha256, ...metrics } = report.result;
  requirePilot(report.result.label === "SIMULATION" && report.result.officialEligible === false
    && report.result.empiricalValidation === false && reportSha256 === canonicalSha256(metrics), "Invalid simulation result digest");
}

export function verifyPilotReport(
  environment: string, stored: SignedPrivateValidationReport, expected: SignedPilotEnvelope<PilotRunManifest>, trust: PilotKeyTrust,
): SignedPrivateValidationReport {
  const run = readRun(environment, expected, trust);
  const { pilot, ...report } = stored;
  const binding = verifyPilot(environment, "REPORT", pilot, trust);
  requirePilot(binding.version === "efra-pilot-report-v1" && pilot.keyId === run.reportKeyId
    && binding.runManifestSha256 === canonicalSha256(run) && binding.reportSha256 === canonicalSha256(report)
    && report.datasetSha256 === run.datasetSha256 && report.engineArtifactSha256 === run.engineSha256
    && report.modelArtifactSha256 === run.modelSha256, "Pilot report does not match the authorized run");
  validateResult(report);
  return structuredClone(stored);
}

export async function createVerifiedPilotWorker(options: {
  readonly environment: string;
  readonly db: Pick<Pool, "query">;
  readonly engineBytes: Uint8Array;
  readonly engineManifest: SignedPilotEnvelope<PilotEngineManifest>;
  readonly trust: PilotKeyTrust;
  readonly reportSigner: PilotSigner;
  readonly monitor: PilotMonitor;
  readonly now?: () => number;
}) {
  const { environment, db, trust, reportSigner, monitor, now = Date.now } = options;
  const manifest = structuredClone(options.engineManifest);
  const bytes = Buffer.from(options.engineBytes);
  const engine = verifyPilot(environment, "ENGINE", manifest, trust);
  requirePilot(engine.version === "efra-pilot-engine-v1" && /^[a-f0-9]{40}$/.test(engine.sourceCommit)
    && isDigest(engine.engineSha256) && engine.engineSha256 === sha256Bytes(bytes)
    && engine.protocolVersion === "efra-synthetic-validation-v1", "Pilot build digest or protocol mismatch");
  // Import precisely the bytes that were checked. No second filesystem read or alternate entry point.
  const bundle = await import("data:text/javascript;base64," + bytes.toString("base64")) as {
    readonly evaluatePilotStudy: (study: ValidationStudy) => PrivateValidationReport["result"];
    readonly validationProtocolVersion: string;
  };
  requirePilot(typeof bundle.evaluatePilotStudy === "function" && bundle.validationProtocolVersion === engine.protocolVersion,
    "Verified pilot build has an incompatible entry point");

  return Object.freeze({
    readiness() {
      try {
        verifyPilot(environment, "ENGINE", manifest, trust);
        const key = trust.publicKey(environment, "REPORT", reportSigner.keyId);
        return { mode: "SYNTHETIC_ONLY" as const, ready: key?.type === "public" && key.asymmetricKeyType === "ed25519" };
      } catch {
        return { mode: "SYNTHETIC_ONLY" as const, ready: false };
      }
    },

    async readReport(ticket: string, recipient: string, expected: SignedPilotEnvelope<PilotRunManifest>) {
      const authorization = structuredClone(expected);
      return monitorPilot(monitor, "read-report", authorization?.body?.runId, async () => {
        const run = readRun(environment, authorization, trust);
        verifyPilot(environment, "ENGINE", manifest, trust);
        requirePilot(run.engineSha256 === engine.engineSha256, "Pilot report belongs to a different build");
        const { rows: [row] } = await db.query<{ report: SignedPrivateValidationReport }>(
          "SELECT efra_validation.read_pilot_report($1,$2,$3,$4,$5) AS report",
          [ticket, recipient, run.datasetId, run.runId, canonicalSha256(run)],
        );
        requirePilot(row, "Missing signed pilot report");
        return verifyPilotReport(environment, row.report, authorization, trust);
      });
    },

    async evaluate(id: string, runId: string, signedRun: SignedPilotEnvelope<PilotRunManifest>,
      artifacts: { readonly model: Uint8Array; readonly configuration: Uint8Array }) {
      return monitorPilot(monitor, "evaluate", runId, async () => {
        const authorization = structuredClone(signedRun);
        const checkRun = () => {
          const run = readRun(environment, authorization, trust);
          verifyPilot(environment, "ENGINE", manifest, trust);
          requireCurrentRun(run, now());
          requirePilot(run.datasetId === id && run.runId === runId && run.engineSha256 === engine.engineSha256
            && run.reportKeyId === reportSigner.keyId && trust.publicKey(environment, "REPORT", run.reportKeyId)?.asymmetricKeyType === "ed25519",
          "Pilot run does not match the worker or report key");
          return run;
        };
        const run = checkRun();
        requirePilot(run.modelSha256 === sha256Bytes(artifacts.model)
          && run.configurationSha256 === sha256Bytes(artifacts.configuration), "Pilot model or configuration digest mismatch");
        const binding = { datasetSha256: run.datasetSha256, runManifestSha256: canonicalSha256(run) };
        return executeSealedHoldout(db, id, runId, engine.engineSha256, async (dataset) => {
          checkRun();
          const actual = serializePilotStudyArtifacts(dataset.study);
          requirePilot(dataset.datasetSha256 === run.datasetSha256 && dataset.modelArtifactSha256 === run.modelSha256
            && sha256Bytes(actual.model) === run.modelSha256 && sha256Bytes(actual.configuration) === run.configurationSha256,
          "Sealed study does not match the signed artifacts");
          const result = bundle.evaluatePilotStudy(dataset.study);
          const report = privateValidationReport(dataset, result);
          validateResult(report);
          const pilot = await signPilot(environment, "REPORT", {
            version: "efra-pilot-report-v1" as const, runManifestSha256: binding.runManifestSha256, reportSha256: canonicalSha256(report),
          }, reportSigner);
          checkRun();
          return verifyPilotReport(environment, { ...report, pilot }, authorization, trust);
        }, binding);
      });
    },
  });
}
