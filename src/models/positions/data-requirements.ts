import type { Position } from "../../contracts/statistics.ts";
import { describePositionModel, limitedFieldPaths } from "./catalog.ts";
import type { FieldPosition } from "./catalog.ts";
import type { ComponentDefinition, MetricTier } from "./metrics.ts";

export type SourceCapability = "BOX_SCORE_CANDIDATE" | "PLAY_BY_PLAY" | "ASSIGNMENT_CHARTING"
  | "MODEL_REFERENCE" | "PLAY_BY_PLAY_AND_MODEL";

interface FieldRequirement {
  readonly field: string;
  readonly role: "NUMERATOR" | "EXPOSURE" | "REFERENCE";
  readonly sourceCapability: SourceCapability;
  readonly attribution: "PLAYER_POSITION";
}

interface PositionRequirements {
  readonly definitionVersion: string;
  readonly convention: string;
  readonly participation: {
    readonly required: true;
    readonly sourceCapability: "ASSIGNMENT_CHARTING";
    readonly attribution: "PLAYER_POSITION";
  };
  readonly tiers: Readonly<Record<MetricTier, {
    readonly fields: readonly FieldRequirement[];
    readonly fallback: "NOT_RATED" | "EXPLICIT_SEPARATE_PATH_OR_NOT_RATED";
  }>>;
  readonly paths: readonly {
    readonly id: string;
    readonly requiredTiers?: readonly MetricTier[];
    readonly additionalRequirements?: readonly string[];
    readonly requiredFields?: readonly string[];
    readonly verifiedAbsentComponent?: string;
  }[];
}

const conventions = {
  RB: "Chart individual carries. Clean rushing yards and carries exclude fumbles. Attribute targets and pass-block assignments separately.",
  FB: "Grade individually assigned lead blocks and protections. Define short-yardage opportunities and conversions before charting.",
  WR: "Attribute targets individually. Clean targets exclude drops and fumbles. Define catchability and chart receiver run blocking.",
  TE: "Attribute clean targets, inline run blocks, pass blocks and off-ball assignments separately. Clean receiving excludes fumbles.",
  OT: "Grade individual edge protection and edge run blocks. Treat second-level assignments as a separate role. Team sacks are insufficient.",
  OG: "Grade individual interior protection and drive blocks. Partition pull assignments from drive blocks. Team totals are insufficient.",
  C: "Grade assigned center blocks and exchanges. Partition combo assignments from ordinary run blocking.",
  DT: "Attribute interior pressures, stops and open-field tackles. Chart double-team gap assignments as a distinct role.",
  NT: "Verify nose alignment and grade individual anchor and two-gap assignments separately. Team run defense cannot establish anchor wins.",
  EDGE: "Attribute pressures to edge rush snaps. Partition ordinary contain and bootleg assignments.",
  ILB: "Chart interior fits, target responsibility, pursuit tackles and blitz assignments as separately attributed actions.",
  MLB: "Chart middle fits, middle targets and untargeted crossing-route disruptions. Targeted coverage stays in the core component.",
  OLB: "Chart perimeter fits, flat targets, pursuit tackles and outside blitz snaps separately.",
  CB: "Chart coverage responsibility and eligible targets individually. Exclude turnover targets from yards allowed. Chart off-target wins separately.",
  FS: "Define deep targets and tackles by alignment and role. Attribute coverage penalties and off-target deep assignments individually.",
  SS: "Chart box fits, short-target responsibility, pursuit tackles and safety blitz snaps by actual alignment.",
  S: "Attribute coverage targets, run-support tackles, coverage penalties and untargeted zone assignments individually.",
  K: "Use official attempts and makes where definitions match. Sum distance-model probabilities on exactly the same field-goal attempts.",
  P: "Separate returned and unreturned completed punts. Record net field position versus a versioned expectation and chart operation failures separately.",
  KR: "Record individually attributed clean returns and fumbles. Return value uses a pre-play field-position expectation.",
  PR: "Record individually attributed clean returns, fumbles and separate fair-catch attempts. Chart let-go decisions independently.",
  LS: "Verify long-snap attribution. Grade punt and placekick accuracy separately and time only verified accurate punt snaps.",
  GUNNER: "Chart the assigned gunner role, release and coverage snaps individually. Attribute fair catches on eligible no-tackle plays.",
} as const satisfies Record<FieldPosition, string>;

const boxScoreCandidates = new Set([
  "carries", "receivingYards", "receptions", "interceptions", "fieldGoalsMade", "fieldGoalAttempts",
  "extraPointsMade", "extraPointAttempts", "kickReturns", "puntReturns",
]);
const playByPlay = new Set(["targets", "returnedPunts", "unreturnedPunts"]);
const modeledFromPlays = new Set([
  "returnedFieldPositionAboveExpected", "unreturnedFieldPositionAboveExpected",
  "kickReturnYardsAboveExpected", "puntReturnYardsAboveExpected",
]);

const participation = { required: true, sourceCapability: "ASSIGNMENT_CHARTING", attribution: "PLAYER_POSITION" } as const;
const explicitPath = "EXPLICIT_SEPARATE_PATH_OR_NOT_RATED" as const;

function field(field: string, role: FieldRequirement["role"], sourceCapability: SourceCapability): FieldRequirement {
  return { field, role, sourceCapability, attribution: "PLAYER_POSITION" };
}

function classified(fieldName: string, role: "NUMERATOR" | "EXPOSURE"): FieldRequirement {
  const capability = boxScoreCandidates.has(fieldName) ? "BOX_SCORE_CANDIDATE"
    : playByPlay.has(fieldName) ? "PLAY_BY_PLAY"
    : modeledFromPlays.has(fieldName) ? "PLAY_BY_PLAY_AND_MODEL" : "ASSIGNMENT_CHARTING";
  return field(fieldName, role, capability);
}

function fields(components: readonly ComponentDefinition[]) {
  return components.flatMap(({ numerator, denominator, expected }) => [
    classified(numerator, "NUMERATOR"), classified(denominator, "EXPOSURE"),
    ...(expected ? [field(expected, "REFERENCE", "MODEL_REFERENCE")] : []),
  ]);
}

const qb: PositionRequirements = {
  definitionVersion: "qb-path-versions",
  convention: "Attribute passing and eligible rushing to verified QB participation. First downs exclude touchdowns. Situational sacks exclude passing and rushing opportunities. Normalize sack and kneeldown treatment.",
  participation,
  tiers: {
    CORE: { fallback: "NOT_RATED", fields: [
      field("passing.attempts", "EXPOSURE", "BOX_SCORE_CANDIDATE"),
      ...["completions", "yards", "touchdowns", "interceptions"].map((key) => field(`passing.${key}`, "NUMERATOR", "BOX_SCORE_CANDIDATE")),
      field("context.expectedTouchdowns", "REFERENCE", "MODEL_REFERENCE"),
    ] },
    SUPPORTING: { fallback: explicitPath, fields: [
      field("rushing.attempts", "EXPOSURE", "ASSIGNMENT_CHARTING"),
      ...["yards", "touchdowns", "turnovers"].map((key) => field(`rushing.${key}`, "NUMERATOR", "ASSIGNMENT_CHARTING")),
    ] },
    ADVANCED: { fallback: explicitPath, fields: [
      field("advancedPassing.nonTouchdownFirstDowns", "NUMERATOR", "PLAY_BY_PLAY"),
      field("context.expectedNonTouchdownFirstDowns", "REFERENCE", "MODEL_REFERENCE"),
      field("situation.opportunities", "EXPOSURE", "ASSIGNMENT_CHARTING"),
      field("situation.actualPointsAdded", "NUMERATOR", "PLAY_BY_PLAY_AND_MODEL"),
      field("situation.expectedPointsAdded", "REFERENCE", "MODEL_REFERENCE"),
    ] },
  },
  paths: [
    { id: "QB_STANDARD_CORE", requiredTiers: ["CORE"] },
    { id: "QB_EXTENDED_PRODUCTION", requiredTiers: ["CORE"], requiredFields: [
      "advancedPassing.nonTouchdownFirstDowns", "context.expectedNonTouchdownFirstDowns",
    ] },
    { id: "QB_ADVANCED", requiredTiers: ["CORE", "SUPPORTING", "ADVANCED"] },
    { id: "QB_RUSH_ONLY_SPECIAL", requiredTiers: ["SUPPORTING"], requiredFields: [
      "passing.attempts", "passing.completions", "passing.yards", "passing.touchdowns", "passing.interceptions",
    ], additionalRequirements: ["VERIFIED_ZERO_PASSING_CORE", "POSITIVE_RUSHING_EXPOSURE"] },
  ],
};

export function describePositionDataRequirements(position: Position): PositionRequirements {
  if (position === "QB") return qb;
  const { definitionVersion, tiers } = describePositionModel(position);
  return {
    definitionVersion, convention: conventions[position], participation,
    tiers: {
      CORE: { fields: fields(tiers.CORE), fallback: "NOT_RATED" },
      SUPPORTING: { fields: fields(tiers.SUPPORTING), fallback: explicitPath },
      ADVANCED: { fields: fields(tiers.ADVANCED), fallback: explicitPath },
    },
    paths: [
      { id: "POSITION_CORE", requiredTiers: ["CORE"] },
      { id: "POSITION_SUPPORTING", requiredTiers: ["CORE", "SUPPORTING"] },
      { id: "POSITION_ADVANCED", requiredTiers: ["CORE", "SUPPORTING", "ADVANCED"] },
      ...Object.entries(limitedFieldPaths).flatMap(([id, path]) => path.position === position ? [{
        id, requiredTiers: ["CORE" as const], verifiedAbsentComponent: path.requiresAbsent,
        additionalRequirements: ["WITHIN_LEAGUE_ONLY", "EXPLICIT_SELECTION", "NO_CROSS_PATH_COMPARISON"],
      }] : []),
    ],
  };
}

export function positionDataAvailabilityMatrix() {
  return {
    version: "efra-position-data-requirements-v1",
    readiness: "REQUIREMENTS_ONLY_SOURCE_COVERAGE_UNVERIFIED",
    positions: {
      QB: qb,
      ...Object.fromEntries(Object.keys(conventions).map((key) => [key, describePositionDataRequirements(key as FieldPosition)])),
    },
  } as const;
}
