import { perOpportunity, rate } from "./metrics.ts";
import type { PositionDefinition } from "./metrics.ts";

export const offense = {
  RB: {
    CORE: [perOpportunity("rushing", "cleanRushingYards", "cleanCarries"), rate("security", "rushingFumbles", "carries", -1)],
    SUPPORTING: [perOpportunity("receiving", "receivingYards", "targets")],
    ADVANCED: [rate("passProtection", "passBlockFailures", "passBlockAssignments", -1)],
  },
  FB: {
    CORE: [rate("leadBlocking", "leadBlockWins", "leadBlockAssignments"), rate("protection", "passBlockFailures", "passBlockAssignments", -1)],
    SUPPORTING: [rate("shortYardage", "shortRunConversions", "shortRunOpportunities")],
    ADVANCED: [perOpportunity("receiving", "receivingYards", "targets")],
  },
  WR: {
    CORE: [perOpportunity("receiving", "cleanReceivingYards", "cleanTargets"), rate("security", "receivingFumbles", "receptions", -1)],
    SUPPORTING: [rate("catchExecution", "drops", "catchableTargets", -1)],
    ADVANCED: [rate("runBlocking", "runBlockWins", "runBlockAssignments")],
  },
  TE: {
    CORE: [
      perOpportunity("receiving", "cleanReceivingYards", "cleanTargets"),
      rate("inlineBlocking", "runBlockWins", "runBlockAssignments"),
      rate("protection", "passBlockFailures", "passBlockAssignments", -1),
    ],
    SUPPORTING: [rate("security", "receivingFumbles", "receptions", -1)],
    ADVANCED: [rate("offBallBlocking", "offBallBlockWins", "offBallBlockAssignments")],
  },
  OT: {
    CORE: [rate("edgeProtection", "edgeProtectionLosses", "edgePassBlockAssignments", -1), rate("runEdge", "edgeRunBlockWins", "edgeRunBlockAssignments")],
    SUPPORTING: [rate("preSnapDiscipline", "preSnapPenalties", "eligibleSnaps", -1)],
    ADVANCED: [rate("secondLevel", "secondLevelBlockWins", "secondLevelAssignments")],
  },
  OG: {
    CORE: [rate("interiorProtection", "interiorProtectionLosses", "interiorPassBlockAssignments", -1), rate("driveBlocking", "driveBlockWins", "driveBlockAssignments")],
    SUPPORTING: [rate("preSnapDiscipline", "preSnapPenalties", "eligibleSnaps", -1)],
    ADVANCED: [rate("pullBlocking", "pullBlockWins", "pullBlockAssignments")],
  },
  C: {
    CORE: [
      rate("protection", "centerProtectionLosses", "centerPassBlockAssignments", -1),
      rate("interiorRunBlocking", "centerRunBlockWins", "centerRunBlockAssignments"),
    ],
    SUPPORTING: [rate("exchange", "exchangeErrors", "exchangeAttempts", -1)],
    ADVANCED: [rate("comboBlocking", "comboBlockWins", "comboBlockAssignments")],
  },
} as const satisfies Record<string, PositionDefinition>;
