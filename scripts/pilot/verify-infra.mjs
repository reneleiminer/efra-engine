import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const project = "efra-pilot-" + randomBytes(6).toString("hex");
const composeArgs = ["compose", "-f", "infra/pilot/compose.yaml", "-p", project];
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const maxBuffer = 64 * 1024 * 1024;
const [option, directory, ...rest] = process.argv.slice(2);
if (rest.length || (option && option !== "--backup-dir" && option !== "--config-only")
  || (option === "--backup-dir" && !directory) || (option === "--config-only" && directory)) {
  throw new Error("Usage: npm run pilot:verify [-- --config-only | --backup-dir NEW_DIRECTORY]");
}
const output = option === "--backup-dir" ? resolve(directory) : null;
if (output) {
  const location = relative(root, output);
  if (!location || (!isAbsolute(location) && location !== ".." && !location.startsWith(".." + sep))) {
    throw new Error("Backup directory must be outside the repository");
  }
}

function invokeDocker(args, { input, stream = false } = {}) {
  return spawnSync("docker", args, { cwd: root, input, maxBuffer,
    stdio: stream ? "inherit" : [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
}
function docker(args, options) {
  const result = invokeDocker(args, options);
  if (result.error || result.status !== 0) throw new Error("Local Docker step failed: " + args.slice(0, 2).join(" "));
  return result.stdout;
}
const compose = (args, options) => docker([...composeArgs, ...args], options);
const profile = (args, options) => compose(["--profile", "restore", ...args], options);

function assertLocalDocker() {
  const active = docker(["context", "show"]).toString().trim();
  const [context] = JSON.parse(docker(["context", "inspect", active]).toString());
  for (const endpoint of [context.Endpoints.docker.Host, process.env.DOCKER_HOST].filter(Boolean)) {
    assert.match(endpoint, /^(?:unix|npipe):\/\//, "Only a local Docker socket may run the synthetic pilot");
  }
}

function checkConfiguration() {
  const config = JSON.parse(profile(["config", "--format", "json"]).toString());
  const { services, networks } = config;
  assert.deepEqual(Object.keys(networks).sort(), ["canonical", "vault"]);
  assert.ok(Object.values(networks).every((network) => network.internal === true && !network.external));
  for (const [name, service] of Object.entries(services)) {
    assert.ok(!service.ports?.length && !service.privileged, name + " exposes a host privilege");
    assert.ok(!service.volumes?.some(({ source }) => source?.includes("docker.sock")));
    if (name.startsWith("restore-") || name === "setup") assert.equal(service.network_mode, "none");
  }
  for (const [service, expected] of Object.entries({ worker: ["vault"], controller: ["canonical", "vault"],
    canonical: ["canonical"], vault: ["vault"] })) {
    assert.deepEqual(Object.keys(services[service].networks).sort(), expected);
  }
  const worker = services.worker;
  assert.equal(worker.user, "1000:1000");
  assert.equal(worker.read_only, true);
  assert.ok(worker.cap_drop.includes("ALL") && worker.security_opt.includes("no-new-privileges:true"));
  assert.deepEqual(worker.volumes.map(({ source, read_only }) => [source, Boolean(read_only)]),
    [["inbox", true], ["outbox", false], ["worker-trust", true], ["worker-keys", true], ["worker-leases", true]]);
  assert.equal(worker.pids_limit, 100);
  emit({ event: "PILOT_CONFIGURATION_VERIFIED", scope: "SYNTHETIC_ONLY" });
}

function postgres(service, tool, args, input) {
  try {
    return profile(["exec", "-T", service, tool, ...args], { input });
  } catch {
    throw new Error("Synthetic PostgreSQL check failed: " + service + "/" + tool);
  }
}
function sql(service, database, command) {
  return postgres(service, "psql", ["-XAtq", "-v", "ON_ERROR_STOP=1", "-U", "efra_test", "-d", database, "-c", command])
    .toString().trim();
}
const checkpointSql = `SELECT jsonb_build_object(
  'migrations', (SELECT jsonb_agg(jsonb_build_array(version,name,sha256) ORDER BY version) FROM efra_migrations.journal),
  'canonical', (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM efra.stat_observations o),
  'projections', (SELECT jsonb_agg(to_jsonb(p) ORDER BY snapshot_id) FROM efra_ingest.position_projection p),
  'data', (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM efra_validation.dataset d),
  'partition', (SELECT jsonb_agg(to_jsonb(p) ORDER BY evidence_key) FROM efra_validation.evidence_partition p),
  'datasetEvidence', (SELECT jsonb_agg(to_jsonb(e) ORDER BY dataset_id,evidence_key) FROM efra_validation.dataset_evidence e),
  'consumed', (SELECT jsonb_agg(to_jsonb(c) ORDER BY evidence_key) FROM efra_validation.consumed_holdout c),
  'approvals', (SELECT jsonb_agg(to_jsonb(a) ORDER BY dataset_id) FROM efra_validation.approval a),
  'evaluations', (SELECT jsonb_agg(to_jsonb(e) ORDER BY dataset_id) FROM efra_validation.evaluation e),
  'redemptions', (SELECT jsonb_agg(to_jsonb(r) ORDER BY ticket_id) FROM efra_validation.evaluation_redemption r),
  'runs', (SELECT jsonb_agg(to_jsonb(r) ORDER BY dataset_id) FROM efra_validation.pilot_run r),
  'reports', (SELECT jsonb_agg(to_jsonb(r) ORDER BY dataset_id) FROM efra_validation.report r),
  'audit', (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM efra_validation.audit a)
)::text`;
const rebind = `BEGIN;
 UPDATE efra_ingest.authenticated_principal p SET login_oid = r.oid
   FROM pg_catalog.pg_roles r WHERE p.login_role = r.rolname AND r.rolcanlogin;
 UPDATE efra_validation.principal p SET login_oid = r.oid
   FROM pg_catalog.pg_roles r WHERE p.login = r.rolname AND r.rolcanlogin;
 COMMIT;`;
const principalsSql = `SELECT NOT EXISTS (
 SELECT 1 FROM efra_ingest.authenticated_principal p LEFT JOIN pg_roles r
   ON r.rolname=p.login_role AND r.oid=p.login_oid AND r.rolcanlogin WHERE r.oid IS NULL
 UNION ALL
 SELECT 1 FROM efra_validation.principal p LEFT JOIN pg_roles r
   ON r.rolname=p.login AND r.oid=p.login_oid AND r.rolcanlogin WHERE r.oid IS NULL
)`;

function verifyResumeAndAlert() {
  const auditCount = () => sql("vault", "efra_pilot_vault", "SELECT count(*) FROM efra_validation.audit");
  const before = auditCount();
  compose(["run", "--rm", "--no-deps", "worker"], { stream: true });
  assert.equal(auditCount(), before, "Worker restart attempted to reconsume a completed job");
  const rejected = invokeDocker([...composeArgs, "run", "--rm", "--no-deps", "-e", "EFRA_PILOT_START_JOB=3",
    "-e", "EFRA_PILOT_JOB_COUNT=1", "worker"]);
  assert.equal(rejected.status, 1, "Tampered job did not fail closed");
  const events = rejected.stdout.toString().split("\n").filter((line) => line.startsWith("{")).map(JSON.parse);
  assert.deepEqual(events.filter(({ event }) => event === "PILOT_ALERT"),
    [{ event: "PILOT_ALERT", severity: "critical", code: "INTEGRITY_OR_EXECUTION" }]);
  assert.equal(events.filter(({ schema, outcome, failure }) =>
    schema === "efra-pilot-event-v1" && outcome === "failure" && failure === "INTEGRITY_OR_EXECUTION").length, 1);
  assert.equal(auditCount(), before, "Tampered job reached the holdout");
  emit({ event: "PILOT_RESTART_AND_ALERT_VERIFIED", scope: "SYNTHETIC_ONLY" });
}

async function restore(name) {
  const database = "efra_pilot_" + name;
  const destination = "restore-" + name;
  const checkpoint = sql(name, database, checkpointSql);
  const backup = postgres(name, "pg_dump", ["--format=custom", "--username=efra_test", "--dbname=" + database]);
  const roles = postgres(name, "pg_dumpall", ["--roles-only", "--no-role-passwords", "--quote-all-identifiers", "--username=efra_test"])
    .toString().split("\n").filter((line) => !/^(?:CREATE|ALTER) ROLE "efra_test"(?:\s|;)/.test(line)).join("\n");
  assert.ok(backup.length > 0 && !/PASSWORD\s+'/.test(roles));
  postgres(destination, "psql", ["-Xq", "-v", "ON_ERROR_STOP=1", "-U", "efra_test", "-d", database, "-f", "-"], Buffer.from(roles));
  postgres(destination, "pg_restore", ["--single-transaction", "--exit-on-error", "--username=efra_test", "--dbname=" + database], backup);
  sql(destination, database, rebind);
  assert.equal(sql(destination, database, principalsSql), "t");
  assert.equal(digest(Buffer.from(sql(destination, database, checkpointSql))), digest(Buffer.from(checkpoint)),
    "Restored checkpoint differs from source");
  if (name === "vault") {
    assert.equal(sql(destination, database,
      "SELECT EXISTS(SELECT FROM efra_validation.report) AND EXISTS(SELECT FROM efra_validation.consumed_holdout)"), "t");
  }
  const record = { event: "PILOT_BACKUP_RESTORE_VERIFIED", database: name, backupSha256: digest(backup),
    rolesSha256: digest(Buffer.from(roles)), checkpointSha256: digest(Buffer.from(checkpoint)) };
  if (output) {
    await writeFile(resolve(output, name + ".dump"), backup, { mode: 0o600, flag: "wx" });
    await writeFile(resolve(output, name + ".roles.sql"), roles, { mode: 0o600, flag: "wx" });
  }
  emit(record);
  return record;
}

assertLocalDocker();
checkConfiguration();
if (option !== "--config-only") {
  if (output) await mkdir(output, { mode: 0o700 });
  try {
    compose(["build", "controller", "worker"], { stream: true });
    compose(["run", "--rm", "setup"], { stream: true });
    compose(["up", "-d", "--wait", "canonical", "vault"], { stream: true });
    compose(["up", "-d", "worker"], { stream: true });
    try {
      compose(["run", "--rm", "--no-deps", "controller"], { stream: true });
    } finally {
      compose(["logs", "--no-color", "worker"], { stream: true });
    }
    verifyResumeAndAlert();
    profile(["up", "-d", "--wait", "restore-canonical", "restore-vault"], { stream: true });
    const verified = [await restore("canonical"), await restore("vault")];
    if (output) await writeFile(resolve(output, "verified.json"), JSON.stringify(verified, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  } finally {
    // This unique project owns only freshly-created synthetic containers, networks and volumes.
    profile(["down", "--volumes", "--remove-orphans"], { stream: true });
  }
}
