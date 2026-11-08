import { createHash, createPublicKey, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { canonicalJson } from "../ingest/determinism.ts";

export type PilotKeyPurpose = "ENGINE" | "RUN" | "REPORT" | "ACTION"
  | "STAT_DATA" | "STAT_POLICY" | "STAT_RIGHTS" | "STAT_PUBLICATION" | "STAT_HONORS_PROPOSAL" | "STAT_HONORS_REVIEW";

export interface PilotKeyTrust {
  /** Lookup the current public key for this purpose and pilot environment. Revoked keys must be absent. */
  publicKey(environment: string, purpose: PilotKeyPurpose, keyId: string): KeyObject | undefined;
}

export interface PilotSigner {
  readonly keyId: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export interface PilotSignature {
  readonly keyId: string;
  readonly signature: string;
}

export type SignedPilotEnvelope<T> = PilotSignature & { readonly body: T };

export const sha256Bytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const isPilotId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

export function requirePilot(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function message(environment: string, purpose: PilotKeyPurpose, keyId: string, body: unknown) {
  requirePilot(isPilotId(environment) && isPilotId(keyId), "Invalid pilot key scope");
  return Buffer.from(canonicalJson(["efra-pilot-signature-v1", environment, purpose, keyId, body]), "utf8");
}

export async function signPilot<T>(environment: string, purpose: PilotKeyPurpose, body: T, signer: PilotSigner):
Promise<SignedPilotEnvelope<T>> {
  const frozen = structuredClone(body);
  const keyId = signer.keyId;
  const bytes = await signer.sign(message(environment, purpose, keyId, frozen));
  requirePilot(bytes.byteLength === 64, "Unexpected Ed25519 signature length");
  return { body: frozen, keyId, signature: Buffer.from(bytes).toString("base64url") };
}

export function verifyPilot<T>(environment: string, purpose: PilotKeyPurpose, envelope: SignedPilotEnvelope<T>, trust: PilotKeyTrust): T {
  requirePilot(typeof envelope?.signature === "string" && /^[A-Za-z0-9_-]{86}$/.test(envelope.signature)
    && isPilotId(envelope.keyId), "Invalid pilot signature encoding");
  const key = trust.publicKey(environment, purpose, envelope.keyId);
  const decoded = Buffer.from(envelope.signature, "base64url");
  requirePilot(decoded.toString("base64url") === envelope.signature && key?.type === "public" && key.asymmetricKeyType === "ed25519"
    && verify(null, message(environment, purpose, envelope.keyId, envelope.body), key, decoded),
  "Pilot signature verification failed");
  return structuredClone(envelope.body);
}

export function pilotPublicKey(pem: string): KeyObject {
  const key = createPublicKey(pem);
  requirePilot(key.asymmetricKeyType === "ed25519", "Expected Ed25519 public key");
  return key;
}
