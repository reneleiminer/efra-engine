import { randomUUID } from "node:crypto";
import { canonicalSha256 } from "../ingest/determinism.ts";
import { isDigest, isPilotId, isUuid, requirePilot, sha256Bytes, signPilot, verifyPilot } from "./signatures.ts";
import type { PilotKeyTrust, PilotSigner, SignedPilotEnvelope } from "./signatures.ts";

export type PilotAction = "REVIEW_IMPORT" | "APPROVE_HOLDOUT" | "REQUEST_PRIVATE_REPORT";
export type PilotActionPayload =
  | { readonly decision: "APPROVED" | "REJECTED"; readonly reason: string }
  | { readonly datasetSha256: string; readonly reason: string }
  | Readonly<Record<string, never>>;
export interface PilotActionCommand {
  readonly action: PilotAction;
  readonly resourceId: string;
  readonly payloadSha256: string;
}
export interface PilotSession {
  readonly issuer: string;
  readonly subject: string;
  readonly personId: string;
  readonly environment: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly strongAuthenticationAt: number;
}
export interface PilotSessionDirectory {
  /** Reads a server-created session by the hash of its opaque 256-bit handle. Revoked sessions are absent. */
  readSession(handleSha256: string): Promise<PilotSession | undefined>;
  /** Authoritative, current permission for the external identity, internal person, action and resource. */
  allows(session: PilotSession, command: PilotActionCommand): Promise<boolean>;
}
export interface PilotActionAttestation {
  readonly version: "efra-pilot-action-v1";
  readonly audience: string;
  readonly human: { readonly issuer: string; readonly subject: string; readonly personId: string };
  readonly sessionSha256: string;
  readonly command: PilotActionCommand;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
export interface PilotActionAudit extends PilotActionAttestation {
  readonly environment: string;
  readonly service: string;
  readonly signingKeyId: string;
}
export interface AtomicPilotActionSink<T> {
  /** Recheck current authorization and commit nonce, mutation and attributable audit in one transaction. */
  commitOnce(event: PilotActionAudit, payload: PilotActionPayload): Promise<T>;
}
export interface PilotActionBoundary {
  readonly environment: string;
  readonly audience: string;
  /** Must come from the trusted service configuration, never from the application request. */
  readonly service: string;
  readonly directory: PilotSessionDirectory;
  readonly now?: () => number;
}

const actions = ["REVIEW_IMPORT", "APPROVE_HOLDOUT", "REQUEST_PRIVATE_REPORT"] as const;
const maximumDelegationMs = 60_000;
const maximumFreshAuthenticationMs = 5 * 60_000;

function checkedCommand(command: PilotActionCommand): PilotActionCommand {
  const { action, resourceId, payloadSha256 } = command;
  requirePilot(Object.keys(command).length === 3 && actions.includes(action) && isPilotId(resourceId) && isDigest(payloadSha256),
    "Invalid pilot action");
  return { action, resourceId, payloadSha256 };
}

function checkedPayload(action: PilotAction, payload: unknown): PilotActionPayload {
  requirePilot(typeof payload === "object" && payload !== null && !Array.isArray(payload), "Invalid pilot action payload");
  const keys = Object.keys(payload);
  if (action === "REQUEST_PRIVATE_REPORT") {
    requirePilot(keys.length === 0, "Private report request has no payload");
    return {};
  }
  requirePilot(keys.length === 2 && Object.hasOwn(payload, "reason") && "reason" in payload
    && typeof payload.reason === "string" && payload.reason.trim().length > 0 && payload.reason.length <= 1_000, "Invalid pilot action reason");
  const { reason } = payload;
  if (action === "REVIEW_IMPORT") {
    requirePilot(Object.hasOwn(payload, "decision") && "decision" in payload
      && (payload.decision === "APPROVED" || payload.decision === "REJECTED"), "Invalid import review decision");
    return { decision: payload.decision, reason };
  }
  requirePilot(Object.hasOwn(payload, "datasetSha256") && "datasetSha256" in payload
    && isDigest(payload.datasetSha256), "Invalid holdout approval digest");
  return { datasetSha256: payload.datasetSha256, reason };
}

export function bindPilotAction(action: PilotAction, resourceId: string, payload: unknown): PilotActionCommand {
  return checkedCommand({ action, resourceId, payloadSha256: canonicalSha256(checkedPayload(action, payload)) });
}

async function liveSession(boundary: PilotActionBoundary, handleHash: string, command: PilotActionCommand) {
  const session = await boundary.directory.readSession(handleHash);
  const now = (boundary.now ?? Date.now)();
  requirePilot(session && session.environment === boundary.environment && session.issuer.startsWith("https://")
    && session.subject.trim() && isPilotId(session.personId) && Number.isSafeInteger(session.issuedAt)
    && Number.isSafeInteger(session.expiresAt) && Number.isSafeInteger(session.strongAuthenticationAt)
    && session.issuedAt <= session.strongAuthenticationAt && session.strongAuthenticationAt <= now
    && now - session.strongAuthenticationAt <= maximumFreshAuthenticationMs && session.expiresAt > now
    && await boundary.directory.allows(session, command), "Pilot session or scoped grant unavailable");
  return session;
}

export async function authorizePilotAction(
  boundary: PilotActionBoundary, opaqueSessionHandle: string, command: PilotActionCommand, signer: PilotSigner,
) {
  requirePilot(isPilotId(boundary.audience) && isPilotId(boundary.service)
    && /^[a-f0-9]{64}$/.test(opaqueSessionHandle), "Invalid pilot session handle");
  const checked = checkedCommand(command);
  const sessionSha256 = sha256Bytes(Buffer.from(opaqueSessionHandle, "hex"));
  const session = await liveSession(boundary, sessionSha256, checked);
  const issuedAt = (boundary.now ?? Date.now)();
  const expiresAt = Math.min(issuedAt + maximumDelegationMs, session.expiresAt,
    session.strongAuthenticationAt + maximumFreshAuthenticationMs);
  requirePilot(expiresAt > issuedAt, "Pilot authentication must be refreshed");
  const attestation: PilotActionAttestation = {
    version: "efra-pilot-action-v1", audience: boundary.audience,
    human: { issuer: session.issuer, subject: session.subject, personId: session.personId },
    sessionSha256, command: checked, nonce: randomUUID(), issuedAt, expiresAt,
  };
  return signPilot(boundary.environment, "ACTION", attestation, signer);
}

export async function executePilotAction<T>(
  boundary: PilotActionBoundary, command: PilotActionCommand, payload: unknown, attestation: SignedPilotEnvelope<PilotActionAttestation>,
  trust: PilotKeyTrust, sink: AtomicPilotActionSink<T>,
) {
  const checked = checkedCommand(command);
  const frozenPayload = checkedPayload(checked.action, payload);
  requirePilot(canonicalSha256(frozenPayload) === checked.payloadSha256, "Pilot action payload does not match request");
  const signed = structuredClone(attestation);
  const action = verifyPilot(boundary.environment, "ACTION", signed, trust);
  const currentTime = (boundary.now ?? Date.now)();
  requirePilot(action.version === "efra-pilot-action-v1" && action.audience === boundary.audience && isPilotId(boundary.service)
    && isDigest(action.sessionSha256) && isUuid(action.nonce) && Number.isSafeInteger(action.issuedAt)
    && Number.isSafeInteger(action.expiresAt) && action.issuedAt <= currentTime && currentTime < action.expiresAt
    && action.expiresAt - action.issuedAt <= maximumDelegationMs
    && canonicalSha256(action.command) === canonicalSha256(checked), "Pilot action attestation does not match request");
  const session = await liveSession(boundary, action.sessionSha256, checked);
  const now = (boundary.now ?? Date.now)();
  requirePilot(now < action.expiresAt && now < session.expiresAt && session.issuer === action.human.issuer
    && session.subject === action.human.subject && session.personId === action.human.personId, "Pilot identity or action expired");
  verifyPilot(boundary.environment, "ACTION", signed, trust);
  return sink.commitOnce({ ...action, environment: boundary.environment, service: boundary.service, signingKeyId: signed.keyId },
    frozenPayload);
}
