import { binomialResidual, perOpportunity, rate } from "./metrics.ts";
import type { PositionDefinition } from "./metrics.ts";

export const specialTeams = {
  K: {
    CORE: [
      binomialResidual("fieldGoals", "fieldGoalsMade", "fieldGoalAttempts", "expectedFieldGoalsByDistance"),
      rate("extraPoints", "extraPointsMade", "extraPointAttempts"),
    ],
    SUPPORTING: [rate("kickoffPlacement", "kickoffsInTargetZone", "kickoffPlacementOpportunities")],
    ADVANCED: [rate("onsideExecution", "onsideTargetExecutions", "onsideAttempts")],
  },
  P: {
    CORE: [
      perOpportunity("returnedFieldPosition", "returnedFieldPositionAboveExpected", "returnedPunts"),
      perOpportunity("unreturnedFieldPosition", "unreturnedFieldPositionAboveExpected", "unreturnedPunts"),
    ],
    SUPPORTING: [rate("operation", "punterOperationFailures", "punterOperationOpportunities", -1)],
    ADVANCED: [rate("snapHandling", "cleanDifficultSnapHandles", "difficultPuntSnapOpportunities")],
  },
  KR: {
    CORE: [perOpportunity("kickReturnValue", "kickReturnYardsAboveExpected", "cleanKickReturns"), rate("kickReturnSecurity", "kickReturnFumbles", "kickReturns", -1)],
    SUPPORTING: [rate("kickReturnDiscipline", "returnerDeadBallPenalties", "kickReturnSnaps", -1)],
    ADVANCED: [rate("kickReturnDecisions", "correctNoReturnDecisions", "kickNoReturnDecisions")],
  },
  PR: {
    CORE: [perOpportunity("puntReturnValue", "puntReturnYardsAboveExpected", "cleanPuntReturns"), rate("puntReturnSecurity", "puntReturnFumbles", "puntReturns", -1)],
    SUPPORTING: [rate("fairCatchExecution", "fairCatchMuffs", "fairCatchAttempts", -1)],
    ADVANCED: [rate("puntReturnDecisions", "correctLetGoDecisions", "puntLetGoDecisions")],
  },
  LS: {
    CORE: [rate("puntSnapAccuracy", "accuratePuntSnaps", "puntSnaps"), rate("placekickSnapAccuracy", "accuratePlacekickSnaps", "placekickSnaps")],
    SUPPORTING: [perOpportunity("accurateSnapSpeed", "accuratePuntSnapTotalSeconds", "accuratePuntSnaps", -1, 0)],
    ADVANCED: [rate("snapperProtection", "snapperProtectionWins", "snapperProtectionAssignments")],
  },
  GUNNER: {
    CORE: [rate("release", "releaseWins", "releaseAssignments"), rate("openFieldFinish", "gunnerMisses", "gunnerTackleAttempts", -1)],
    SUPPORTING: [rate("coverageDiscipline", "coveragePenalties", "coverageSnaps", -1)],
    ADVANCED: [rate("returnPrevention", "gunnerForcedFairCatches", "eligibleNoTackleGunnerSnaps")],
  },
} as const satisfies Record<string, PositionDefinition>;
