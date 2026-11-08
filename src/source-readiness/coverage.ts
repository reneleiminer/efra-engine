import type { Position } from "../contracts/statistics.ts";
import { describePositionModel } from "../models/positions/catalog.ts";
import { describePositionDataRequirements } from "../models/positions/data-requirements.ts";
import type { SourceCapability } from "../models/positions/data-requirements.ts";
import { positionMetricRegistry } from "../models/positions/metric-registry.ts";
import type { PositionMetric } from "../models/positions/metric-registry.ts";
import { evidenceDocuments, fieldLeads, sourceCatalogueVersion, sourceProfiles } from "./catalogue.ts";
import type { AuditedSourceId } from "./catalogue.ts";
import { fieldDefinitions } from "./definitions.ts";

export const evidenceCoverageVersion = "efra-evidence-coverage-v1";
const registry = positionMetricRegistry();
const positions = [...new Set(registry.metrics.map(({ position }) => position))];
const sources = Object.keys(sourceProfiles) as AuditedSourceId[];

const proofRequirements = {
  BOX_SCORE_CANDIDATE: {
    granularity: "PLAYER_GAME_POSITION", proof: ["BOX_SCORE"],
    suppliers: ["EPFR_EFA_PLAYER", "EFA_OFFICIAL_STATS", "GFL_STATS_N_SCORE", "GFL2_STATS_N_SCORE", "GFL_ARCHIVE_GAMEBOOK", "GFL2_ARCHIVE_GAMEBOOK"],
    gaps: ["RECONCILED_FINAL_PLAYER_GAME_VALUES", "FIELD_CONVENTION"],
  },
  PLAY_BY_PLAY: {
    granularity: "PLAYER_PLAY_POSITION", proof: ["PLAY_BY_PLAY"],
    suppliers: ["EPFR_EFA_PLAYER", "GFL_STATS_N_SCORE", "GFL2_STATS_N_SCORE", "GFL2_ARCHIVE_GAMEBOOK"],
    gaps: ["PLAY_IDS_AND_VALIDITY", "EVENT_TO_ROLE_ATTRIBUTION", "FIELD_CONVENTION"],
  },
  ASSIGNMENT_CHARTING: {
    granularity: "PLAYER_SNAP_POSITION_ASSIGNMENT", proof: ["ASSIGNMENT_CHARTING"],
    suppliers: ["FILM_LAB_OR_TEAM_CHARTING"],
    gaps: ["SNAP_PARTICIPATION_AND_ROLE", "INDIVIDUAL_ASSIGNMENT_AND_OUTCOME", "REVIEWED_CHARTING_PROTOCOL"],
  },
  MODEL_REFERENCE: {
    granularity: "PLAYER_GAME_POSITION_VERSIONED_REFERENCE", proof: ["MODEL_REFERENCE"],
    suppliers: ["EFRA_MODEL_REFERENCE"],
    gaps: ["VERSIONED_REFERENCE", "EXACT_OPPORTUNITY_SET", "INDEPENDENT_EMPIRICAL_VALIDATION"],
  },
  PLAY_BY_PLAY_AND_MODEL: {
    granularity: "PLAYER_PLAY_POSITION_AND_VERSIONED_REFERENCE", proof: ["PLAY_BY_PLAY", "MODEL_REFERENCE"],
    suppliers: ["EPFR_EFA_PLAYER", "GFL_STATS_N_SCORE", "GFL2_STATS_N_SCORE", "GFL2_ARCHIVE_GAMEBOOK", "EFRA_MODEL_REFERENCE"],
    gaps: ["PLAY_IDS_AND_VALIDITY", "EVENT_TO_ROLE_ATTRIBUTION", "VERSIONED_REFERENCE", "EXACT_OPPORTUNITY_SET"],
  },
} as const satisfies Readonly<Record<SourceCapability, {
  granularity: string; proof: readonly string[]; suppliers: readonly AuditedSourceId[]; gaps: readonly string[];
}>>;

const universalGaps = ["WRITTEN_EFRA_RIGHTS", "CANONICAL_IDENTITY_LINK", "REVISION_AND_MISSING_ZERO_POLICY", "INDEPENDENT_ATTESTATION"] as const;
function fieldAvailability(metric: PositionMetric, source: AuditedSourceId) {
  const findings = fieldLeads[source].filter(({ fields }) => fields.includes(metric.field))
    .map(({ document, granularity, relation }) => ({ document, channel: evidenceDocuments[document].channel, granularity, relation }));
  const requirement = proofRequirements[metric.sourceCapability];
  const possibleSupplier = (requirement.suppliers as readonly AuditedSourceId[]).includes(source);
  const availability = findings.some(({ relation }) => relation === "LABEL_MATCH") ? "PUBLIC_FIELD_CANDIDATE"
    : findings.some(({ relation }) => relation === "DERIVATION_CANDIDATE") ? "PUBLIC_SAMPLE_DERIVATION_CANDIDATE"
      : findings.length ? "PUBLIC_CONTEXT_ONLY" : possibleSupplier ? "POSSIBLE_NOT_VERIFIED" : "NO_FIELD_EVIDENCE";
  return {
    availability, findings, possibleSupplier, rights: sourceProfiles[source].rights,
    apiField: "NOT_VERIFIED" as const, apiResponse: sourceProfiles[source].apiResponse,
    evidenceComplete: false, missing: [...universalGaps, ...requirement.gaps],
  };
}

export function evidenceCoverageMatrix() {
  return {
    version: evidenceCoverageVersion, registryVersion: registry.version, sourceCatalogueVersion, asOf: "2026-11-08",
    label: "SOURCE_READINESS_ONLY", realImportAllowed: false, empiricalValidation: false, officialRatingEligible: false,
    documents: evidenceDocuments, sources: sourceProfiles, defaultFieldAudit: { apiField: "NOT_VERIFIED", evidenceComplete: false },
    positions: positions.map((position) => {
      const requirements = describePositionDataRequirements(position);
      return {
        position, convention: requirements.convention, modelDefinitionVersion: requirements.definitionVersion,
        participation: { ...requirements.participation,
          definition: "Beleg des tatsächlichen Einsatzes oder Nicht-Einsatzes in genau dieser Rolle je Spieler und Spiel. Fehlende Zeilen bleiben unbekannt.",
          ...proofRequirements.ASSIGNMENT_CHARTING, evidenceComplete: false, missing: [...universalGaps, "EXACT_POSITION_PARTICIPATION_OR_DNP"],
        },
        paths: requirements.paths,
      };
    }),
    metrics: registry.metrics.map((metric) => {
      const definition = fieldDefinitions[metric.field];
      if (!definition) throw new Error("Missing coverage field definition for " + metric.code);
      const requirement = proofRequirements[metric.sourceCapability];
      return { ...metric, definition, requiredGranularity: requirement.granularity, requiredProof: requirement.proof,
        possibleSuppliers: requirement.suppliers, missing: [...universalGaps, ...requirement.gaps],
        sources: Object.fromEntries(sources.map((source) => {
          const { availability, findings } = fieldAvailability(metric, source);
          return [source, { availability, ...(findings.length && { findings }) }];
        })),
      };
    }),
  };
}

export function assessSourceCoverage(position: Position, source: AuditedSourceId) {
  if (!positions.includes(position) || !Object.hasOwn(sourceProfiles, source)) throw new Error("Unknown position or audited source");
  const requirements = describePositionDataRequirements(position);
  const metrics = registry.metrics.filter((metric) => metric.position === position);
  const assessed = new Map(metrics.map((metric) => [metric.field, fieldAvailability(metric, source)]));
  const core = metrics.filter(({ tiers }) => tiers.includes("CORE"));
  const candidate = (field: string) => {
    const status = assessed.get(field)?.availability;
    return status === "PUBLIC_FIELD_CANDIDATE" || status === "PUBLIC_SAMPLE_DERIVATION_CANDIDATE";
  };
  const candidateCore = core.filter(({ field }) => candidate(field)).map(({ field }) => field);
  const fullyEvidenced = (field: string) => assessed.get(field)?.evidenceComplete === true;
  const supplementary = metrics.filter(({ field, tiers }) => !tiers.includes("CORE") && candidate(field)).map(({ field }) => field);
  return {
    position, source, scope: sourceProfiles[source].scope, rights: sourceProfiles[source].rights,
    status: "INSUFFICIENT_VERIFIED_EVIDENCE" as const, empiricalValidation: false, officialRatingEligible: false,
    core: {
      documentedCandidates: candidateCore,
      fullyEvidenced: core.filter(({ field }) => fullyEvidenced(field)).map(({ field }) => field),
      gaps: core.filter(({ field }) => !fullyEvidenced(field))
        .map(({ field, sourceCapability }) => ({ field, sourceCapability, ...assessed.get(field)! })),
    },
    supplementaryCandidates: supplementary,
    relatedContextFields: metrics.filter(({ field }) => assessed.get(field)?.availability === "PUBLIC_CONTEXT_ONLY").map(({ field }) => field),
    supportingOnly: candidateCore.length === 0 && supplementary.length > 0,
    charting: {
      participationRequired: true,
      coreFields: core.filter(({ sourceCapability }) => sourceCapability === "ASSIGNMENT_CHARTING").map(({ field }) => field),
      additionalFields: metrics.filter(({ sourceCapability, tiers }) => sourceCapability === "ASSIGNMENT_CHARTING"
        && !tiers.includes("CORE")).map(({ field }) => field),
      alternatives: ["FILM_WITH_RIGHTS", "INDEPENDENTLY_ATTESTED_TEAM_ASSIGNMENTS"],
    },
    paths: requirements.paths.map((path) => {
      const fields = metrics.filter(({ field, tiers }) => path.requiredFields?.includes(field)
        || tiers.some((tier) => path.requiredTiers?.includes(tier)));
      const zero = path.id === "QB_RUSH_ONLY_SPECIAL" ? path.requiredFields : position !== "QB" && path.verifiedAbsentComponent
        ? describePositionModel(position).tiers.CORE.filter(({ id }) => id === path.verifiedAbsentComponent)
          .flatMap((entry) => [entry.denominator, entry.numerator, ...("expected" in entry ? [entry.expected] : [])]) : [];
      return {
        id: path.id, status: "BLOCKED" as const, missingParticipation: true, noDataOrRightsRelease: true,
        missingFields: fields.filter(({ field }) => !fullyEvidenced(field)).map(({ field }) => field),
        verifyZero: zero ?? [], extraRequirements: path.additionalRequirements ?? [],
      };
    }),
  };
}
