import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PilotDatabaseService, PilotSecretLease, PilotSecretProvider } from "./isolation.ts";
import { isPilotId, requirePilot } from "./signatures.ts";

/** Local pilot adapter for an atomically replaced, separately mounted workload lease file. */
export class FilePilotSecretBroker implements PilotSecretProvider {
  readonly #directory: string;
  constructor(directory: string) {
    this.#directory = resolve(directory);
  }

  async issue(reference: string, service: PilotDatabaseService, environment: string): Promise<PilotSecretLease> {
    requirePilot(isPilotId(reference), "Invalid pilot secret reference");
    const file = await open(join(this.#directory, reference + ".json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      requirePilot(stat.isFile() && stat.size > 0 && stat.size <= 8_192, "Invalid pilot lease file");
      const lease = JSON.parse(await file.readFile("utf8")) as PilotSecretLease;
      requirePilot(lease.reference === reference && lease.service === service && lease.environment === environment
        && isPilotId(lease.login) && isPilotId(lease.version) && Number.isSafeInteger(lease.expiresAt)
        && typeof lease.password === "string" && lease.password.length > 0, "Invalid pilot lease scope");
      return { ...lease };
    } finally {
      await file.close();
    }
  }
}
