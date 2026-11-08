import { setTimeout } from "node:timers/promises";
import { PilotOperationError } from "./monitoring.ts";

export interface PilotAlert {
  readonly severity: "critical" | "warning";
  readonly code: "INTEGRITY_OR_EXECUTION" | "ACCESS_DENIED" | "CONFLICT" | "TRANSIENT_STORAGE";
}
export function alertForPilotFailure(error: unknown): PilotAlert {
  if (!(error instanceof PilotOperationError)) return { severity: "critical", code: "INTEGRITY_OR_EXECUTION" };
  return { severity: error.failure === "TRANSIENT_STORAGE" ? "warning" : "critical", code: error.failure };
}

/** The callback closes over the same registered run. Only known transport/storage failures may repeat. */
export async function resumePilotRun<T>(
  attempt: (number: number) => Promise<T>,
  pause: (milliseconds: number) => Promise<unknown> = setTimeout,
): Promise<T> {
  for (let index = 1; ; index++) {
    try {
      return await attempt(index);
    } catch (error) {
      if (index === 3 || !(error instanceof PilotOperationError) || error.failure !== "TRANSIENT_STORAGE") throw error;
      await pause(index * 250);
    }
  }
}
