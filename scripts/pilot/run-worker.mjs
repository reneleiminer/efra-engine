import { createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { lookup } from "node:dns/promises";
import { constants } from "node:fs";
import { open, readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import pg from "pg";
import { createVerifiedPilotWorker, pilotPublicKey, sha256Bytes, withPilotConnection, PilotOperationError } from "../../dist/index.js";
import { FilePilotSecretBroker } from "../../dist/pilot/file-broker.js";
import { alertForPilotFailure, resumePilotRun } from "../../dist/pilot/operations.js";
import { pilotFailure } from "../../dist/pilot/monitoring.js";

const inbox = "/run/pilot-inbox";
const outbox = "/run/pilot-outbox";
const environment = "sim-pilot";
const target = (host, database, login, secretRef) => ({ host, port: 5432, database, login, secretRef });
const policy = {
  environment, mode: "SYNTHETIC_ONLY", canonical: "efra_pilot_canonical", vault: "efra_pilot_vault",
  targets: {
    ingest: target("canonical", "efra_pilot_canonical", "sim-ingest", "sim-ingest"),
    "canonical-custodian": target("canonical", "efra_pilot_canonical", "sim-reader", "sim-reader"),
    "vault-custodian": target("vault", "efra_pilot_vault", "sim-custodian", "sim-custodian"),
    "holdout-worker": target("vault", "efra_pilot_vault", "efra_vault_p13_worker", "worker-lease"),
  },
};
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
async function readJob(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > 512 * 1024) throw new Error("Invalid local job size");
    const bytes = await handle.readFile();
    return { job: JSON.parse(bytes.toString("utf8")), jobSha256: sha256Bytes(bytes) };
  } finally {
    await handle.close();
  }
}
async function waitForJob(file) {
  const expires = Date.now() + 180_000;
  for (;;) {
    try { return await readJob(file); }
    catch (error) {
      if (error.code !== "ENOENT" || Date.now() >= expires) throw new Error("Job unavailable");
    }
    await setTimeout(100);
  }
}

async function run(job) {
  if (job?.version !== "efra-local-pilot-job-v1" || job.run?.body?.mode !== "SYNTHETIC_ONLY") throw new Error("Invalid local job");
  const privateKey = createPrivateKey(await readFile("/run/pilot-keys/report.key"));
  const directory = JSON.parse(await readFile("/run/pilot-trust/public-keys.json", "utf8"));
  const keys = new Map(Object.entries(directory).map(([id, entry]) => [id, { purpose: entry.purpose, key: pilotPublicKey(entry.pem) }]));
  const reportKeyId = job.run.body.reportKeyId;
  const expectedKey = keys.get(reportKeyId);
  const localPublic = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  if (expectedKey?.purpose !== "REPORT" || !localPublic.equals(expectedKey.key.export({ type: "spki", format: "der" }))) {
    throw new Error("Invalid report key binding");
  }
  const ca = await readFile("/run/pilot-trust/ca.crt", "utf8");
  const engineBytes = await readFile(new URL("../../dist/pilot-engine.mjs", import.meta.url));
  const { datasetId, runId } = job.run.body;
  const provider = new FilePilotSecretBroker("/run/pilot-leases");
  return resumePilotRun(async () => withPilotConnection(policy, "holdout-worker", provider, async (options) => {
    const db = new pg.Pool({ ...options, ssl: { ...options.ssl, ca }, max: 2, connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000, application_name: "efra-synthetic-pilot" });
    db.on("error", () => emit({ event: "PILOT_ALERT", severity: "warning", code: "TRANSIENT_STORAGE" }));
    return { value: db, close: () => db.end() };
  }, async (db, leaseVersion) => {
    try {
      const { rows: [peer] } = await db.query(`SELECT current_database() AS db, session_user AS login,
        current_setting('efra.synthetic_pilot', true) AS instance,
        (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls`);
      if (peer?.db !== policy.vault || peer?.instance !== "vault" || !peer?.tls
        || peer.login !== policy.targets["holdout-worker"].login) throw new Error("Vault identity mismatch");
      const worker = await createVerifiedPilotWorker({
        environment, db, engineBytes, engineManifest: job.engine,
        trust: { publicKey: (scope, purpose, id) => {
          const entry = keys.get(id);
          return scope === environment && entry?.purpose === purpose ? entry.key : undefined;
        } },
        reportSigner: { keyId: reportKeyId, sign: async (message) => sign(null, message, privateKey) },
        monitor: { record: (event) => emit(event) },
      });
      const receipt = await worker.evaluate(datasetId, runId, job.run, {
        model: Buffer.from(job.model, "base64"), configuration: Buffer.from(job.configuration, "base64"),
      });
      return { ...receipt, runId, leaseVersion };
    } catch (error) {
      if (error instanceof PilotOperationError) throw error;
      throw new PilotOperationError(pilotFailure(error));
    }
  }));
}

try {
  if (process.getuid?.() !== 1000) throw new Error("Worker must be unprivileged");
  const importHost = await lookup("canonical").then(() => true, () => false);
  if (importHost) throw new Error("Worker can resolve the canonical network");
  const start = Number(process.env.EFRA_PILOT_START_JOB ?? "1");
  const count = Number(process.env.EFRA_PILOT_JOB_COUNT ?? "2");
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 1 || count < 1 || start + count > 33) {
    throw new Error("Invalid local queue bounds");
  }
  for (let sequence = start; sequence < start + count; sequence++) {
    const { job, jobSha256 } = await waitForJob(inbox + "/job-" + sequence + ".json");
    const base = outbox + "/receipt-" + sequence + ".json";
    const completed = await readFile(base, "utf8").then(JSON.parse, (error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (completed) {
      if (completed.jobSha256 !== jobSha256 || completed.runId !== job.run.body.runId || completed.datasetSha256 !== job.run.body.datasetSha256
        || completed.label !== "SIMULATION" || completed.officialEligible !== false) throw new Error("Receipt mismatch");
      continue;
    }
    const receipt = await run(job);
    const temporary = base + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify({ ...receipt, jobSha256 }), { mode: 0o600, flag: "wx" });
    await rename(temporary, base);
  }
} catch (error) {
  emit({ event: "PILOT_ALERT", ...alertForPilotFailure(error) });
  process.exitCode = 1;
}
