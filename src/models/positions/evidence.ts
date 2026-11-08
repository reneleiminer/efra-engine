import { isCount, readObservation } from "../../contracts/observations.ts";
import type { Evidence, Observation } from "../../contracts/observations.ts";
import type { ComponentDefinition } from "./metrics.ts";

export interface ComponentSample {
  readonly value: number;
  readonly exposure: number;
}

export function readComponent(
  definition: ComponentDefinition,
  observations: Readonly<Record<string, Observation | undefined>>,
): Evidence<ComponentSample> {
  const missing = { status: "MISSING" } as const;
  const denominator = readObservation(observations[definition.denominator] ?? missing, "SYNTHETIC", isCount);
  if (denominator.status !== "AVAILABLE") return denominator.status === "NOT_APPLICABLE" ? missing : denominator;
  const exposure = denominator.value;
  const observed = readObservation(observations[definition.numerator] ?? missing, "SYNTHETIC",
    definition.kind === "PER_OPPORTUNITY"
      ? (value) => definition.minimum === undefined || value >= definition.minimum
      : (value) => isCount(value) && value <= exposure);
  const expected = definition.expected === undefined ? null
    : readObservation(observations[definition.expected] ?? missing, "SYNTHETIC", (value) => value >= 0 && value <= exposure);
  if (observed.status === "INVALID" || expected?.status === "INVALID") return { status: "INVALID" };
  if (observed.status === "UNUSABLE" || expected?.status === "UNUSABLE") return { status: "UNUSABLE" };
  if (exposure === 0) {
    return observed.status === "AVAILABLE" && observed.value !== 0
      ? { status: "INVALID" } : { status: "NOT_APPLICABLE" };
  }
  if (observed.status !== "AVAILABLE" || (expected && expected.status !== "AVAILABLE")) return missing;
  const value = definition.direction * (observed.value - (expected?.value ?? 0)) / exposure;
  return { status: "AVAILABLE", value: { value, exposure } };
}
