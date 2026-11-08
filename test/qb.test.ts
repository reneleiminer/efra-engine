import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeSyntheticQbGame, assessQbCore } from "../src/index.ts";
import { game, missing, observed, passing, policy, source, zeroPass } from "./simulation-fixtures.ts";

test("SIMULATION | calculates five QB components with inspectable denominators", () => {
  const analyzed = analyzeSyntheticQbGame(game, policy.context);
  assert.equal(analyzed.label, "SIMULATION");
  assert.deepEqual(analyzed.components, {
    passingEfficiency: { status: "AVAILABLE", value: { completionRate: 0.6, yardsPerAttempt: 8 } },
    passingProduction: { status: "AVAILABLE", value: { expectedTouchdowns: 1, residualPerAttempt: 0.1 } },
    ballControl: { status: "AVAILABLE", value: { interceptionRate: 0.1 } },
    rushingContribution: {
      status: "AVAILABLE", value: { attempts: 4, yardsPerAttempt: 5, touchdownRate: 0.25, turnoverRate: 0 },
    },
    situationalImpact: { status: "AVAILABLE", value: { opportunities: 4, pointsAboveExpectationPerOpportunity: 0.5 } },
  });
});

test("SIMULATION | separates missing attempts, verified zeros, DNP, and unknown participation", () => {
  assert.deepEqual(assessQbCore(passing({ attempts: missing }), "SYNTHETIC"),
    { status: "UNAVAILABLE", reason: "MISSING_CORE" });
  const zero = analyzeSyntheticQbGame(zeroPass, policy.context);
  assert.equal(zero.core.status, "VERIFIED_ZERO_ATTEMPTS");
  assert.equal(zero.components.passingEfficiency.status, "NOT_APPLICABLE");
  assert.equal(zero.components.rushingContribution.status, "AVAILABLE");
  assert.deepEqual(assessQbCore({ ...zeroPass, usage: { status: "DID_NOT_PLAY", source } }, "SYNTHETIC"),
    { status: "DID_NOT_PLAY" });
  assert.deepEqual(assessQbCore({ ...game, usage: { status: "UNKNOWN" } }, "SYNTHETIC"),
    { status: "UNAVAILABLE", reason: "UNVERIFIED_USAGE" });
  assert.deepEqual(assessQbCore({ ...game, usage: { status: "DID_NOT_PLAY", source } }, "SYNTHETIC"),
    { status: "UNAVAILABLE", reason: "INVALID_CORE" });
});

test("SIMULATION | checks impossible counts, signed yards, conflicts and provenance", () => {
  for (const invalid of [
    passing({ completions: observed(11) }), passing({ interceptions: observed(5) }),
    passing({ touchdowns: observed(7) }), passing({ attempts: observed(1.5) }),
    passing({ yards: observed(Infinity) }), passing({ completions: observed(0) }),
    passing({ attempts: { status: "OBSERVED", value: 0, source } }),
    passing({ touchdowns: observed(-1) }),
  ]) {
    assert.deepEqual(assessQbCore(invalid, "SYNTHETIC"), { status: "UNAVAILABLE", reason: "INVALID_CORE" });
  }
  assert.equal(assessQbCore(passing({ yards: observed(-2) }), "SYNTHETIC").status, "PASSING");
  for (const unusable of [
    passing({ attempts: { status: "CONFLICTED", sources: [source] } }),
    passing({ yards: { status: "ESTIMATED_FOR_RESEARCH_ONLY", sources: [source] } }),
    passing({ yards: { status: "OBSERVED", value: 80, source: { ...source, verification: "UNVERIFIED" } } }),
    passing({ yards: { status: "OBSERVED", value: 80, source: { ...source, origin: "REAL" } } }),
  ]) {
    assert.deepEqual(assessQbCore(unusable, "SYNTHETIC"), { status: "UNAVAILABLE", reason: "UNUSABLE_CORE" });
  }
});

test("SIMULATION | preserves missing, zero and invalid optional denominators", () => {
  for (const [attempts, expected] of [[missing, "MISSING"], [observed(0), "INVALID"], [observed(-1), "INVALID"]] as const) {
    const input = { ...game, stats: { ...game.stats, rushing: { ...game.stats.rushing, attempts } } };
    assert.equal(analyzeSyntheticQbGame(input, policy.context).components.rushingContribution.status, expected);
  }
  const noOpportunity = {
    ...game,
    stats: {
      ...game.stats,
      rushing: { attempts: observed(0), yards: missing, touchdowns: missing, turnovers: missing },
      situation: { opportunities: observed(0), actualPointsAdded: missing, expectedPointsAdded: missing },
    },
  };
  const { components } = analyzeSyntheticQbGame(noOpportunity, policy.context);
  assert.equal(components.rushingContribution.status, "NOT_APPLICABLE");
  assert.equal(components.situationalImpact.status, "NOT_APPLICABLE");
  const invalid = {
    ...game, stats: { ...game.stats, situation: { ...game.stats.situation, expectedPointsAdded: observed(-Number.MAX_VALUE),
      actualPointsAdded: observed(Number.MAX_VALUE) } },
  };
  assert.equal(analyzeSyntheticQbGame(invalid, policy.context).components.situationalImpact.status, "INVALID");
});

test("SIMULATION | applies the context baseline once and preserves an absent or invalid baseline", () => {
  for (const [baseline, status] of [[null, "MISSING"], [11, "INVALID"], [NaN, "INVALID"]] as const) {
    let calls = 0;
    const { components } = analyzeSyntheticQbGame(game, {
      version: "sim-alternate-context", expectedTouchdowns(input) {
        calls++;
        assert.equal(input.opponentId, game.opponentId);
        assert.equal(input.yardsPerAttempt, 8);
        return baseline;
      },
    });
    assert.equal(calls, 1);
    assert.equal(components.passingProduction.status, status);
  }
});
