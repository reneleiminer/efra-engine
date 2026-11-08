import { performance } from "node:perf_hooks";
import { isUuid } from "./signatures.ts";

export type PilotFailure = "ACCESS_DENIED" | "CONFLICT" | "TRANSIENT_STORAGE" | "INTEGRITY_OR_EXECUTION";
export interface PilotEvent {
  readonly schema: "efra-pilot-event-v1";
  readonly operation: "evaluate" | "read-report";
  readonly outcome: "success" | "failure";
  readonly runId: string | null;
  readonly durationMs: number;
  readonly failure?: PilotFailure;
}
export interface PilotMonitor {
  record(event: PilotEvent): void;
}
export function pilotFailure(error: unknown): PilotFailure {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  if (code === "42501") return "ACCESS_DENIED";
  if (code === "23505" || code === "23514") return "CONFLICT";
  if (typeof code === "string" && (/^08[0-9A-Z]{3}$/.test(code)
    || ["40001", "40P01", "57P01", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED"].includes(code))) return "TRANSIENT_STORAGE";
  return "INTEGRITY_OR_EXECUTION";
}
export class PilotOperationError extends Error {
  readonly failure: PilotFailure;
  constructor(failure: PilotFailure) {
    super("Pilot operation failed: " + failure);
    this.failure = failure;
  }
}
export async function monitorPilot<T>(monitor: PilotMonitor, operation: PilotEvent["operation"], runId: string, work: () => Promise<T>) {
  const started = performance.now();
  const record = (outcome: PilotEvent["outcome"], failure?: PilotFailure) => {
    try {
      monitor.record({ schema: "efra-pilot-event-v1", operation, outcome, runId: isUuid(runId) ? runId : null,
        durationMs: Math.max(0, Math.round(performance.now() - started)), ...(failure && { failure }) });
    } catch {
      // Operational telemetry must never retry or mask a committed action. Database audit remains mandatory.
    }
  };
  try {
    const result = await work();
    record("success");
    return result;
  } catch (error) {
    const failure = pilotFailure(error);
    record("failure", failure);
    throw new PilotOperationError(failure);
  }
}
