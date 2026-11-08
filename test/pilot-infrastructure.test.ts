import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { alertForPilotFailure, bindPilotAction, establishPilotSession, FilePilotSecretBroker, PilotOperationError, PilotPersonRegistry,
  resumePilotRun, sha256Bytes } from "../src/index.ts";
import type { PilotOidcPolicy, PilotOidcPorts, PilotPersonPolicy, PilotSession, VerifiedPilotIdentityToken } from "../src/index.ts";

const now = 20_000;
const policy: PilotOidcPolicy = { environment: "sim-pilot", issuer: "https://issuer.example.test", clientId: "sim-admin",
  strongAuthenticationContexts: ["urn:test:strong"] };
const token: VerifiedPilotIdentityToken = {
  issuer: policy.issuer, subject: "external-person", audience: [policy.clientId], nonce: "nonce-1",
  issuedAt: now - 100, expiresAt: now + 60_000, authenticationAt: now - 200, authenticationContext: "urn:test:strong",
};
const callback = { state: "state-1", idToken: "synthetic-verified-token" };
function loginFixture(tokenValue = token, active = true) {
  let pending = true;
  const saved = new Map<string, PilotSession>();
  const ports: PilotOidcPorts = {
    verifyProviderToken: async (jwt, expected) => {
      assert.equal(jwt, callback.idToken);
      assert.equal(expected.issuer, policy.issuer);
      return tokenValue;
    },
    redeemLoginState: async (state) => {
      if (!pending || state !== callback.state) return undefined;
      pending = false;
      return { nonce: token.nonce };
    },
    lookupPerson: async (issuer, subject) => issuer === token.issuer && subject === token.subject
      ? { personId: "sim-human", active } : undefined,
    storeSession: async (hash, session) => { saved.set(hash, session); },
  };
  return { ports, saved };
}

test("SIMULATION | provider adapter maps a verified identity and uses one-time state and hashed session handles", async () => {
  const { ports, saved } = loginFixture();
  const login = await establishPilotSession(policy, ports, callback, () => now);
  assert.match(login.handle, /^[a-f0-9]{64}$/);
  assert.equal(saved.has(login.handle), false);
  const session = saved.get(sha256Bytes(Buffer.from(login.handle, "hex")));
  assert.equal(session?.personId, "sim-human");
  assert.equal(session?.strongAuthenticationAt, token.authenticationAt);
  await assert.rejects(establishPilotSession(policy, ports, callback, () => now), /state is unavailable/);
});

test("SIMULATION | OIDC boundary rejects mismatched issuer, audience, nonce, authentication context and inactive person", async () => {
  for (const amendment of [
    { issuer: "https://other.example.test" }, { audience: ["other"] }, { audience: [policy.clientId, "other"] },
    { authorizedParty: "other" }, { nonce: "other" }, { authenticationContext: "weak" },
    { authenticationAt: now + 1 }, { expiresAt: now },
  ]) {
    const fixture = loginFixture({ ...token, ...amendment });
    await assert.rejects(establishPilotSession(policy, fixture.ports, callback, () => now), /identity or authentication context/);
    assert.equal(fixture.saved.size, 0);
  }
  await assert.rejects(establishPilotSession(policy, loginFixture(token, false).ports, callback, () => now), /active pilot person/);
});

test("SIMULATION | individual grants reload by version and prevent identity and role impersonation", async () => {
  const person = { issuer: token.issuer, subject: token.subject, personId: "sim-human", active: true,
    role: "IMPORT_REVIEWER", resourceIds: ["123"] } as const;
  let current: PilotPersonPolicy = { environment: policy.environment, version: "sim-v1", people: [person] };
  const registry = new PilotPersonRegistry(policy.environment, async () => current);
  const session: PilotSession = { environment: policy.environment, issuer: token.issuer, subject: token.subject,
    personId: person.personId, issuedAt: token.authenticationAt, strongAuthenticationAt: token.authenticationAt, expiresAt: token.expiresAt };
  const review = bindPilotAction("REVIEW_IMPORT", "123", { decision: "APPROVED", reason: "synthetic fixture" });
  assert.deepEqual(await registry.lookupPerson(token.issuer, token.subject), { personId: person.personId, active: true });
  assert.equal(await registry.allows(session, review), true);
  assert.equal(await registry.allows({ ...session, personId: "another" }, review), false);
  assert.equal(await registry.allows(session, { ...review, resourceId: "124" }), false);
  assert.equal(await registry.allows(session, { ...review, action: "APPROVE_HOLDOUT" }), false);
  current = { ...current, version: "sim-v2", people: [{ ...person, active: false }] };
  assert.equal(await registry.allows(session, review), false);
  current = { ...current, version: "sim-v3", people: [person, person] };
  await assert.rejects(registry.lookupPerson(token.issuer, token.subject), /Invalid pilot person policy/);
});

test("SIMULATION | local secret broker reads atomic rotation and blocks cross-scope or traversal lookups", async () => {
  const base = resolve(tmpdir());
  const directory = await mkdtemp(join(base, "efra-pilot-lease-"));
  try {
    const reference = "worker-lease";
    const service = "holdout-worker";
    const environment = "sim-pilot";
    const broker = new FilePilotSecretBroker(directory);
    const writeLease = async (version: string) => {
      const temporary = join(directory, "lease.tmp");
      await writeFile(temporary, JSON.stringify({ service, environment, reference, version, login: "sim-worker",
        password: "synthetic-test-" + version, expiresAt: now + 60_000 }), { mode: 0o600 });
      await rename(temporary, join(directory, reference + ".json"));
    };
    await writeLease("one");
    assert.equal((await broker.issue(reference, service, environment)).version, "one");
    await writeLease("two");
    assert.equal((await broker.issue(reference, service, environment)).version, "two");
    await assert.rejects(broker.issue(reference, "ingest", environment), /lease scope/);
    await assert.rejects(broker.issue("../worker-lease", service, environment), /secret reference/);
  } finally {
    assert.equal(resolve(directory, ".."), base);
    await rm(directory, { recursive: true, force: true });
  }
});

test("SIMULATION | retry is bounded and integrity incidents emit only classified alerts", async () => {
  const pauses: number[] = [];
  const pause = async (milliseconds: number) => { pauses.push(milliseconds); };
  assert.equal(await resumePilotRun(async (attempt) => {
    if (attempt < 3) throw new PilotOperationError("TRANSIENT_STORAGE");
    return "simulation-receipt";
  }, pause), "simulation-receipt");
  assert.deepEqual(pauses, [250, 500]);
  let count = 0;
  await assert.rejects(resumePilotRun(async () => {
    count++;
    throw new PilotOperationError("TRANSIENT_STORAGE");
  }, pause), { failure: "TRANSIENT_STORAGE" });
  assert.equal(count, 3);
  count = 0;
  await assert.rejects(resumePilotRun(async () => {
    count++;
    throw new PilotOperationError("ACCESS_DENIED");
  }, pause), { failure: "ACCESS_DENIED" });
  assert.equal(count, 1);
  assert.deepEqual(alertForPilotFailure(new Error("private data")), { severity: "critical", code: "INTEGRITY_OR_EXECUTION" });
  assert.deepEqual(alertForPilotFailure(new PilotOperationError("TRANSIENT_STORAGE")),
    { severity: "warning", code: "TRANSIENT_STORAGE" });
});
