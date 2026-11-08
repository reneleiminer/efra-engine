import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { authorizePilotAction, bindPilotAction, executePilotAction, pilotPublicKey, sha256Bytes, signPilot,
  validatePilotIsolation, withPilotConnection } from "../src/index.ts";
import type { AtomicPilotActionSink, PilotActionAudit, PilotActionBoundary, PilotActionCommand, PilotIsolation,
  PilotKeyTrust, PilotSecretProvider, PilotSession } from "../src/index.ts";
import { monitorPilot } from "../src/pilot/monitoring.ts";
import type { PilotEvent } from "../src/pilot/monitoring.ts";
import { verifyPilot } from "../src/pilot/signatures.ts";

const key = generateKeyPairSync("ed25519");
const signer = { keyId: "action-one", sign: async (message: Uint8Array) => sign(null, message, key.privateKey) };
const environment = "sim-pilot";
const handle = "a".repeat(64);
const payload = { decision: "APPROVED", reason: "SIMULATION provenance checked" };
const command = bindPilotAction("REVIEW_IMPORT", "123", payload);

function identityFixture() {
  let now = 10_000;
  let session: PilotSession | undefined = { issuer: "https://idp.example.test", subject: "sim-subject",
    personId: "sim-person", environment, issuedAt: now - 5_000, strongAuthenticationAt: now - 500, expiresAt: now + 120_000 };
  let granted = true;
  let trusted = true;
  const boundary: PilotActionBoundary = { environment, audience: "ingest-review", service: "review-broker",
    now: () => now, directory: {
      readSession: async (hash) => hash === sha256Bytes(Buffer.from(handle, "hex")) ? session : undefined,
      allows: async (_session, request) => granted && request.resourceId === command.resourceId,
    } };
  const trust: PilotKeyTrust = { publicKey: (scope, purpose, id) =>
    trusted && scope === environment && purpose === "ACTION" && id === signer.keyId ? key.publicKey : undefined };
  const audit: PilotActionAudit[] = [];
  const sink: AtomicPilotActionSink<string> = { commitOnce: async (event, executed) => {
    if (audit.some(({ nonce }) => nonce === event.nonce)) throw new Error("nonce already consumed");
    assert.deepEqual(executed, payload);
    audit.push(event);
    return event.human.personId;
  } };
  return { boundary, trust, audit, sink, revoke: () => { granted = false; },
    revokeKey: () => { trusted = false; }, logout: () => { session = undefined; },
    advance: (ms: number) => { now += ms; } };
}

test("SIMULATION | action binds human, service, session, payload and a one-use nonce under concurrency", async () => {
  const { boundary, trust, audit, sink } = identityFixture();
  const signed = await authorizePilotAction(boundary, handle, command, signer);
  assert.equal(signed.body.human.personId, "sim-person");
  assert.notEqual(signed.body.sessionSha256, handle);
  const results = await Promise.allSettled([
    executePilotAction(boundary, command, payload, signed, trust, sink),
    executePilotAction(boundary, command, payload, signed, trust, sink),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.service, "review-broker");
  assert.equal(audit[0]!.command.payloadSha256, command.payloadSha256);
  assert.ok(!JSON.stringify(audit).includes(handle));
});

test("SIMULATION | request body cannot choose identity, target service, resource or actual payload", async () => {
  const { boundary, trust, sink } = identityFixture();
  const spoofed = { ...command, personId: "sim-forged" } as PilotActionCommand;
  assert.throws(() => bindPilotAction("REVIEW_IMPORT", "123", { ...payload, reviewerId: "sim-forged" }), /Invalid pilot action reason/);
  await assert.rejects(authorizePilotAction(boundary, handle, spoofed, signer), /Invalid pilot action/);
  await assert.rejects(authorizePilotAction(boundary, "b".repeat(64), command, signer), /session or scoped grant/);
  const signed = await authorizePilotAction(boundary, handle, command, signer);
  await assert.rejects(executePilotAction({ ...boundary, audience: "other-audience" }, command, payload, signed, trust, sink),
    /does not match/);
  await assert.rejects(executePilotAction(boundary, { ...command, resourceId: "124" }, payload, signed, trust, sink),
    /does not match/);
  await assert.rejects(executePilotAction(boundary, command, { ...payload, decision: "REJECTED" }, signed, trust, sink),
    /payload does not match/);
  await assert.rejects(executePilotAction(boundary, command, payload,
    { ...signed, body: { ...signed.body, human: { ...signed.body.human, personId: "forged" } } }, trust, sink), /signature verification/);
});

test("SIMULATION | session and permission revocations, signature rotation and expiration fail closed", async () => {
  for (const invalidate of ["revoke", "revokeKey", "logout", "expire"] as const) {
    const fixture = identityFixture();
    const { boundary, trust, sink, audit } = fixture;
    const signed = await authorizePilotAction(boundary, handle, command, signer);
    if (invalidate === "expire") fixture.advance(60_001);
    else fixture[invalidate]();
    await assert.rejects(executePilotAction(boundary, command, payload, signed, trust, sink));
    assert.deepEqual(audit, []);
  }
});

test("SIMULATION | Ed25519 signatures are purpose and environment scoped and encoding is canonical", async () => {
  const pem = key.publicKey.export({ format: "pem", type: "spki" }).toString();
  const trust: PilotKeyTrust = { publicKey: () => pilotPublicKey(pem) };
  const signed = await signPilot(environment, "ACTION", { a: 1 }, signer);
  assert.deepEqual(verifyPilot(environment, "ACTION", signed, trust), { a: 1 });
  assert.throws(() => verifyPilot("other-pilot", "ACTION", signed, trust), /signature verification/);
  assert.throws(() => verifyPilot(environment, "REPORT", signed, trust), /signature verification/);
  assert.throws(() => verifyPilot(environment, "ACTION", { ...signed, signature: signed.signature + "==" }, trust), /signature encoding/);
});

const isolation: PilotIsolation = {
  environment, mode: "SYNTHETIC_ONLY", canonical: "synthetic-canonical", vault: "synthetic-vault",
  targets: {
    ingest: { host: "canonical.example.test", port: 5432, database: "synthetic-canonical", login: "sim-importer", secretRef: "import-key" },
    "canonical-custodian": { host: "canonical.example.test", port: 5432, database: "synthetic-canonical", login: "sim-reader", secretRef: "reader-key" },
    "vault-custodian": { host: "vault.example.test", port: 5432, database: "synthetic-vault", login: "sim-sealer", secretRef: "sealer-key" },
    "holdout-worker": { host: "vault.example.test", port: 5432, database: "synthetic-vault", login: "sim-worker", secretRef: "worker-key" },
  },
};

test("SIMULATION | pilot configuration separates endpoints, identities and secret references", () => {
  assert.deepEqual(validatePilotIsolation(isolation), isolation);
  assert.throws(() => validatePilotIsolation({ ...isolation, vault: isolation.canonical }), /isolation/);
  for (const shared of ["login", "secretRef"] as const) {
    assert.throws(() => validatePilotIsolation({ ...isolation, targets: { ...isolation.targets,
      "holdout-worker": { ...isolation.targets["holdout-worker"], [shared]: isolation.targets.ingest[shared] },
    } }), /shared pilot credentials/);
  }
  assert.throws(() => validatePilotIsolation({ ...isolation, targets: { ...isolation.targets,
    "vault-custodian": { ...isolation.targets["vault-custodian"], host: isolation.targets.ingest.host },
    "holdout-worker": { ...isolation.targets["holdout-worker"], host: isolation.targets.ingest.host },
  } }), /separately provisioned/);
});

test("SIMULATION | secret rotation uses fresh verified-TLS leases and closes on success and failure", async () => {
  let revision = 0;
  let closed = 0;
  const provider: PilotSecretProvider = { issue: async (reference, service, environment) => ({
    reference, service, environment, version: "sim-v" + ++revision, login: "sim-worker", expiresAt: 90_000, password: "fixture-" + revision,
  }) };
  const now = () => 1_000;
  const connector: Parameters<typeof withPilotConnection<string, string>>[3] = async (options) => {
    assert.equal(options.user, "sim-worker");
    assert.equal(options.host, "vault.example.test");
    assert.equal(options.ssl.rejectUnauthorized, true);
    return { value: options.password, close: async () => { closed++; } };
  };
  const use = async (value: string, version: string) => {
    assert.equal(value, "fixture-" + revision);
    return version;
  };
  assert.equal(await withPilotConnection(isolation, "holdout-worker", provider, connector, use, now), "sim-v1");
  assert.equal(await withPilotConnection(isolation, "holdout-worker", provider, connector, use, now), "sim-v2");
  await assert.rejects(withPilotConnection(isolation, "holdout-worker", provider, connector, async () => {
    throw new Error("simulated execution failure");
  }, now), /execution failure/);
  assert.equal(closed, 3);
  await assert.rejects(withPilotConnection(isolation, "holdout-worker", provider, connector, use, () => 89_999), /Invalid pilot credential/);
  await assert.rejects(withPilotConnection(isolation, "holdout-worker",
    { issue: async () => { throw new Error("fixture credential text"); } }, connector, use, now), {
    message: "Pilot credential unavailable",
  });
});

test("SIMULATION | operational errors and sink outages are safe to report without private data or duplicate work", async () => {
  const events: PilotEvent[] = [];
  await assert.rejects(monitorPilot({ record: (e) => { events.push(e); } }, "evaluate", "untrusted-control-text", async () => {
    throw Object.assign(new Error("private database content"), { code: "40P01" });
  }), { failure: "TRANSIENT_STORAGE", message: "Pilot operation failed: TRANSIENT_STORAGE" });
  assert.deepEqual(events.map(({ outcome, runId, failure }) => ({ outcome, runId, failure })),
    [{ outcome: "failure", runId: null, failure: "TRANSIENT_STORAGE" }]);
  let actions = 0;
  assert.equal(await monitorPilot({ record: () => { throw new Error("simulated sink outage"); } }, "evaluate",
    "00000000-0000-4000-8000-000000000001", async () => ++actions), 1);
  assert.equal(actions, 1);
});
