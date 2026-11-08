export type DataOrigin = "SYNTHETIC" | "REAL";

export interface SourceQuality {
  readonly sourceId: string;
  readonly revisionId: string;
  readonly conventionVersion: string;
  readonly origin: DataOrigin;
  readonly verification: "VERIFIED" | "UNVERIFIED";
  readonly officiality: "OFFICIAL_SOURCE" | "SECONDARY_SOURCE" | "SYNTHETIC";
}

export type Observation =
  | { readonly status: "OBSERVED" | "VERIFIED_ZERO"; readonly value: number; readonly source: SourceQuality }
  | { readonly status: "MISSING" | "NOT_APPLICABLE" }
  | { readonly status: "CONFLICTED" | "ESTIMATED_FOR_RESEARCH_ONLY"; readonly sources: readonly SourceQuality[] };

export type Evidence<T> =
  | { readonly status: "AVAILABLE"; readonly value: T }
  | { readonly status: "MISSING" | "NOT_APPLICABLE" | "UNUSABLE" | "INVALID" };

export function readObservation(
  observation: Observation,
  origin: DataOrigin,
  isValid: (value: number) => boolean,
): Evidence<number> {
  switch (observation.status) {
    case "MISSING":
    case "NOT_APPLICABLE":
      return { status: observation.status };
    case "CONFLICTED":
    case "ESTIMATED_FOR_RESEARCH_ONLY":
      return { status: "UNUSABLE" };
    case "OBSERVED":
    case "VERIFIED_ZERO": {
      const { source, value } = observation;
      if (!isVerifiedSource(source, origin)) return { status: "UNUSABLE" };
      if (!Number.isFinite(value) || !isValid(value) || (observation.status === "VERIFIED_ZERO") !== (value === 0)) {
        return { status: "INVALID" };
      }
      return { status: "AVAILABLE", value };
    }
  }
}

export function isVerifiedSource(source: SourceQuality, origin: DataOrigin): boolean {
  return source.verification === "VERIFIED" && source.origin === origin
    && (source.officiality === "SYNTHETIC") === (origin === "SYNTHETIC")
    && [source.sourceId, source.revisionId, source.conventionVersion].every((id) => id.trim().length > 0);
}

export function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
