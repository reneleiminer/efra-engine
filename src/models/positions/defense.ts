import { perOpportunity, rate } from "./metrics.ts";
import type { PositionDefinition } from "./metrics.ts";

export const defense = {
  DT: {
    CORE: [rate("interiorPressure", "interiorPressures", "interiorPassRushSnaps"), rate("runStops", "interiorRunStops", "interiorRunDefenseSnaps")],
    SUPPORTING: [rate("openFieldTackling", "openFieldMisses", "openFieldTackleAttempts", -1)],
    ADVANCED: [rate("gapIntegrity", "doubleTeamGapWins", "doubleTeamGapAssignments")],
  },
  NT: {
    CORE: [rate("anchor", "anchorWins", "anchorAssignments"), rate("nosePressure", "nosePressures", "nosePassRushSnaps")],
    SUPPORTING: [rate("openFieldTackling", "openFieldMisses", "openFieldTackleAttempts", -1)],
    ADVANCED: [rate("twoGapControl", "twoGapWins", "twoGapAssignments")],
  },
  EDGE: {
    CORE: [rate("edgeRush", "edgePressures", "edgePassRushSnaps"), rate("edgeContain", "edgeContainWins", "edgeRunAssignments")],
    SUPPORTING: [rate("discipline", "preSnapPenalties", "eligibleSnaps", -1)],
    ADVANCED: [rate("bootlegContain", "bootlegContainWins", "bootlegAssignments")],
  },
  ILB: {
    CORE: [rate("interiorRunFits", "interiorFitWins", "interiorFitAssignments"), perOpportunity("coverage", "coverageYardsAllowed", "coverageTargets", -1)],
    SUPPORTING: [rate("pursuitTackling", "pursuitMisses", "pursuitTackleAttempts", -1)],
    ADVANCED: [rate("interiorBlitz", "blitzPressures", "interiorBlitzSnaps")],
  },
  MLB: {
    CORE: [rate("middleRunFits", "middleFitWins", "middleFitAssignments"), perOpportunity("middleCoverage", "middleYardsAllowed", "middleTargets", -1)],
    SUPPORTING: [rate("pursuitTackling", "pursuitMisses", "pursuitTackleAttempts", -1)],
    ADVANCED: [rate("crossingRouteCoverage", "offTargetCrossingRouteDisruptions", "offTargetCrossingRouteAssignments")],
  },
  OLB: {
    CORE: [rate("perimeterRunFits", "perimeterFitWins", "perimeterFitAssignments"), perOpportunity("flatCoverage", "flatYardsAllowed", "flatTargets", -1)],
    SUPPORTING: [rate("pursuitTackling", "pursuitMisses", "pursuitTackleAttempts", -1)],
    ADVANCED: [rate("outsideBlitz", "blitzPressures", "outsideBlitzSnaps")],
  },
  CB: {
    CORE: [perOpportunity("targetCoverage", "nonTurnoverYardsAllowed", "nonTurnoverCoverageTargets", -1), rate("runSupport", "runSupportMisses", "runSupportTackleAttempts", -1)],
    SUPPORTING: [rate("ballDisruption", "interceptions", "coverageTargets")],
    ADVANCED: [rate("offTargetCoverage", "offTargetCoverageWins", "offTargetCoverageAssignments")],
  },
  FS: {
    CORE: [perOpportunity("deepCoverage", "deepYardsAllowed", "deepTargets", -1), rate("lastLineTackling", "deepMisses", "deepTackleAttempts", -1)],
    SUPPORTING: [rate("discipline", "coveragePenalties", "coverageSnaps", -1)],
    ADVANCED: [rate("offTargetRange", "offTargetDeepWins", "offTargetDeepAssignments")],
  },
  SS: {
    CORE: [rate("boxRunSupport", "boxRunFitWins", "boxRunFitAssignments"), perOpportunity("shortCoverage", "shortYardsAllowed", "shortTargets", -1)],
    SUPPORTING: [rate("pursuitTackling", "pursuitMisses", "pursuitTackleAttempts", -1)],
    ADVANCED: [rate("blitz", "blitzPressures", "safetyBlitzSnaps")],
  },
  S: {
    CORE: [perOpportunity("coverage", "coverageYardsAllowed", "coverageTargets", -1), rate("runSupport", "runSupportMisses", "runSupportTackleAttempts", -1)],
    SUPPORTING: [rate("discipline", "coveragePenalties", "coverageSnaps", -1)],
    ADVANCED: [rate("untargetedZoneCoverage", "offTargetZoneWins", "offTargetZoneAssignments")],
  },
} as const satisfies Record<string, PositionDefinition>;
