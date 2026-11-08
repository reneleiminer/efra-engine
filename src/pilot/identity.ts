import { randomBytes } from "node:crypto";
import type { PilotActionCommand, PilotSession } from "./sessions.ts";
import { isPilotId, requirePilot, sha256Bytes } from "./signatures.ts";

export interface PilotOidcPolicy {
  readonly environment: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly strongAuthenticationContexts: readonly string[];
}
export interface VerifiedPilotIdentityToken {
  readonly issuer: string;
  readonly subject: string;
  readonly audience: readonly string[];
  readonly authorizedParty?: string;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly authenticationAt: number;
  readonly authenticationContext: string;
}
export interface PilotOidcPorts {
  /** The configured OIDC client exchanges the code using PKCE and verifies provider signature, alg and JWKS. */
  verifyProviderToken(idToken: string, policy: PilotOidcPolicy): Promise<VerifiedPilotIdentityToken>;
  /** A server-side login transaction validates/consumes state and returns the expected nonce exactly once. */
  redeemLoginState(state: string): Promise<{ readonly nonce: string } | undefined>;
  /** A separate authority maps the issuer/subject pair to an active internal person. */
  lookupPerson(issuer: string, subject: string): Promise<{ readonly personId: string; readonly active: boolean } | undefined>;
  storeSession(handleSha256: string, session: PilotSession): Promise<void>;
}

export interface PilotPersonPolicy {
  readonly environment: string;
  readonly version: string;
  readonly people: readonly {
    readonly issuer: string;
    readonly subject: string;
    readonly personId: string;
    readonly active: boolean;
    readonly role: "IMPORT_REVIEWER" | "HOLDOUT_APPROVER";
    readonly resourceIds: readonly string[];
  }[];
}

/** A workload-owned policy source, re-read on each decision so grants can be withdrawn. */
export class PilotPersonRegistry {
  readonly #environment: string;
  readonly #load: () => Promise<PilotPersonPolicy>;

  constructor(environment: string, load: () => Promise<PilotPersonPolicy>) {
    requirePilot(isPilotId(environment), "Invalid identity policy scope");
    this.#environment = environment;
    this.#load = load;
  }

  async #person(issuer: string, subject: string) {
    const policy = structuredClone(await this.#load());
    requirePilot(policy.environment === this.#environment && isPilotId(policy.version)
      && new Set(policy.people.map((person) => JSON.stringify([person.issuer, person.subject]))).size === policy.people.length
      && new Set(policy.people.map(({ personId }) => personId)).size === policy.people.length
      && policy.people.every((person) => person.issuer.startsWith("https://") && person.subject.trim() && isPilotId(person.personId)
        && typeof person.active === "boolean" && ["IMPORT_REVIEWER", "HOLDOUT_APPROVER"].includes(person.role)
        && person.resourceIds.every(isPilotId) && new Set(person.resourceIds).size === person.resourceIds.length),
    "Invalid pilot person policy");
    return policy.people.find((person) => person.issuer === issuer && person.subject === subject);
  }

  async lookupPerson(issuer: string, subject: string) {
    const person = await this.#person(issuer, subject);
    return person && { personId: person.personId, active: person.active };
  }

  async allows(session: PilotSession, command: PilotActionCommand) {
    const person = await this.#person(session.issuer, session.subject);
    const roles: Record<PilotActionCommand["action"], "IMPORT_REVIEWER" | "HOLDOUT_APPROVER"> = {
      REVIEW_IMPORT: "IMPORT_REVIEWER", APPROVE_HOLDOUT: "HOLDOUT_APPROVER", REQUEST_PRIVATE_REPORT: "HOLDOUT_APPROVER",
    };
    return session.environment === this.#environment && !!person?.active && person.personId === session.personId
      && person.role === roles[command.action] && person.resourceIds.includes(command.resourceId);
  }
}

/** Provider-independent callback boundary. The transport sets the returned handle as an HttpOnly cookie. */
export async function establishPilotSession(
  policy: PilotOidcPolicy, ports: PilotOidcPorts, callback: { readonly state: string; readonly idToken: string }, now = Date.now,
) {
  const issuer = new URL(policy.issuer);
  requirePilot(isPilotId(policy.environment) && issuer.protocol === "https:" && !issuer.username && !issuer.password
    && !issuer.search && !issuer.hash && !!policy.clientId.trim() && policy.strongAuthenticationContexts.length > 0,
  "Invalid trusted OIDC policy");
  requirePilot(typeof callback.state === "string" && callback.state.length > 0 && callback.state.length <= 512
    && typeof callback.idToken === "string" && callback.idToken.length > 0 && callback.idToken.length <= 16_384,
  "Invalid OIDC callback");
  const login = await ports.redeemLoginState(callback.state);
  requirePilot(login && login.nonce.length > 0, "OIDC login state is unavailable");
  const token = await ports.verifyProviderToken(callback.idToken, policy);
  const time = now();
  requirePilot(token.issuer === policy.issuer && typeof token.subject === "string" && token.subject.trim()
    && token.audience.includes(policy.clientId)
    && (token.audience.length === 1 && token.authorizedParty === undefined || token.authorizedParty === policy.clientId)
    && token.nonce === login.nonce && Number.isSafeInteger(token.issuedAt) && Number.isSafeInteger(token.expiresAt)
    && Number.isSafeInteger(token.authenticationAt) && token.authenticationAt <= token.issuedAt && token.issuedAt <= time
    && time - token.issuedAt <= 5 * 60_000 && time - token.authenticationAt <= 5 * 60_000 && token.expiresAt > time
    && policy.strongAuthenticationContexts.includes(token.authenticationContext), "OIDC identity or authentication context failed");
  const person = await ports.lookupPerson(token.issuer, token.subject);
  requirePilot(person?.active && isPilotId(person.personId), "No active pilot person mapping");
  const handle = randomBytes(32);
  const session: PilotSession = {
    environment: policy.environment, issuer: token.issuer, subject: token.subject, personId: person.personId,
    issuedAt: token.authenticationAt, strongAuthenticationAt: token.authenticationAt,
    expiresAt: Math.min(token.expiresAt, time + 15 * 60_000),
  };
  await ports.storeSession(sha256Bytes(handle), session);
  return { handle: handle.toString("hex"), expiresAt: session.expiresAt };
}
