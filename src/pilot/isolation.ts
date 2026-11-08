import { isPilotId, requirePilot } from "./signatures.ts";

export type PilotDatabaseService = "ingest" | "canonical-custodian" | "vault-custodian" | "holdout-worker";
export interface PilotDatabaseTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly login: string;
  readonly secretRef: string;
}
export interface PilotIsolation {
  readonly environment: string;
  readonly mode: "SYNTHETIC_ONLY";
  readonly canonical: string;
  readonly vault: string;
  readonly targets: Readonly<Record<PilotDatabaseService, PilotDatabaseTarget>>;
}
export interface PilotSecretLease {
  readonly service: PilotDatabaseService;
  readonly environment: string;
  readonly reference: string;
  readonly version: string;
  readonly login: string;
  readonly expiresAt: number;
  readonly password: string;
}
export interface PilotSecretProvider {
  /** Trusted broker checks workload identity and returns the current lease or rejects access. */
  issue(reference: string, service: PilotDatabaseService, environment: string): Promise<PilotSecretLease>;
}
export interface PilotConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly ssl: { readonly rejectUnauthorized: true };
}
const services = ["ingest", "canonical-custodian", "vault-custodian", "holdout-worker"] as const;
const minimumLeaseMs = 30_000;
const maximumLeaseMs = 15 * 60_000;

export function validatePilotIsolation(config: PilotIsolation) {
  const safe = structuredClone(config);
  requirePilot(safe.mode === "SYNTHETIC_ONLY" && isPilotId(safe.environment) && isPilotId(safe.canonical) && isPilotId(safe.vault)
    && safe.canonical !== safe.vault && Object.keys(safe.targets).length === services.length, "Invalid pilot isolation policy");
  const targets = services.map((service) => safe.targets[service]);
  requirePilot(targets.every((target) => target && /^[a-z0-9][a-z0-9.-]{0,252}$/.test(target.host)
    && Number.isSafeInteger(target.port) && target.port > 0 && target.port <= 65535 && isPilotId(target.database)
    && isPilotId(target.login) && isPilotId(target.secretRef))
    && new Set(targets.map(({ login }) => login)).size === targets.length
    && new Set(targets.map(({ secretRef }) => secretRef)).size === targets.length, "Invalid or shared pilot credentials");
  const { ingest, "canonical-custodian": reader, "vault-custodian": writer, "holdout-worker": worker } = safe.targets;
  requirePilot(ingest.database === safe.canonical && reader.database === safe.canonical
    && writer.database === safe.vault && worker.database === safe.vault
    && ingest.host === reader.host && ingest.port === reader.port && worker.host === writer.host && worker.port === writer.port
    && (worker.host !== ingest.host || worker.port !== ingest.port), "Pilot vault must use a separately provisioned endpoint");
  return safe;
}

/** Obtains a fresh lease per operation. Provision a server-side deadline for already connected sessions. */
export async function withPilotConnection<T, R>(
  policy: PilotIsolation, service: PilotDatabaseService, provider: PilotSecretProvider,
  connect: (options: PilotConnectionOptions) => Promise<{ close(): Promise<void>; value: T }>,
  work: (connection: T, leaseVersion: string, deadline: number) => Promise<R>,
  now: () => number = Date.now,
) {
  const config = validatePilotIsolation(policy);
  requirePilot(services.includes(service), "Service has no pilot database access");
  const target = config.targets[service];
  let lease: PilotSecretLease;
  try {
    lease = await provider.issue(target.secretRef, service, config.environment);
  } catch {
    throw new Error("Pilot credential unavailable");
  }
  const lifetime = lease.expiresAt - now();
  requirePilot(lease.service === service && lease.environment === config.environment && lease.reference === target.secretRef
    && lease.login === target.login && isPilotId(lease.version) && typeof lease.password === "string" && lease.password.length > 0
    && Number.isFinite(lifetime) && lifetime >= minimumLeaseMs && lifetime <= maximumLeaseMs, "Invalid pilot credential lease");
  let connection: Awaited<ReturnType<typeof connect>>;
  try {
    connection = await connect({ host: target.host, port: target.port, database: target.database, user: target.login,
      password: lease.password, ssl: { rejectUnauthorized: true } });
  } catch {
    throw new Error("Pilot database connection failed");
  }
  try {
    requirePilot(lease.expiresAt > now(), "Pilot credential expired before use");
    return await work(connection.value, lease.version, lease.expiresAt);
  } finally {
    // A close error must not turn a committed operation into an automatic retry.
    try { await connection.close(); } catch { /* driver/network monitoring owns drain failures */ }
  }
}
