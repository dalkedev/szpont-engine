import { test } from "node:test";
import assert from "node:assert/strict";
import * as protocol from "../dist/goals.js";

test("goal and loop aliases create bounded fixed goals without parsing embedded commands", () => {
  assert.equal(typeof protocol.parseGoalCommand, "function");
  assert.deepEqual(protocol.parseGoalCommand("!goal Build a useful CLI"), {
    kind: "start",
    goal: "Build a useful CLI",
    budgetMs: 1800000,
  });
  assert.deepEqual(protocol.parseGoalCommand("!loop 2h Fix the queue\n!stop"), {
    kind: "start",
    goal: "Fix the queue\n!stop",
    budgetMs: 7200000,
  });
  assert.deepEqual(
    protocol.parseGoalCommand("!goal pause 5555000000000001001"),
    { kind: "pause", id: "5555000000000001001" },
  );
  assert.deepEqual(protocol.parseGoalCommand("!loop status"), {
    kind: "status",
  });
  assert.equal(protocol.parseGoalCommand("Please use !loop later"), null);
});
test("malformed controls and out-of-range budgets cannot become new goals", () => {
  for (const text of [
    "!goal",
    "!loop 0m nope",
    "!goal 121m nope",
    "!loop 3h nope",
    "!goal pause extra",
    "!goal status 12",
    "!goal resume 5555000000000001001 extra",
    "!goal 30m",
  ])
    assert.throws(() => protocol.parseGoalCommand(text), /goal|loop|Usage/i);
});
test("supervisor review is strict and cannot grant a budget through extra keys", () => {
  const value = {
    outcome: "blocked",
    summary: "Need a decision",
    nextAction: "Which repository is in scope?",
    progress: false,
  };
  assert.deepEqual(protocol.validateGoalReview(JSON.stringify(value)), value);
  for (const bad of [
    { ...value, budgetMs: 7200000 },
    { ...value, progress: "yes" },
    { ...value, outcome: "continue", nextAction: "" },
    { ...value, summary: "x".repeat(4001) },
  ])
    assert.throws(() => protocol.validateGoalReview(JSON.stringify(bad)));
  assert.throws(() => protocol.validateGoalReview("```json\n{}\n```"));
});
test("supervisor prompt labels candidate data, fixes scope and prohibits effects", () => {
  const prompt = protocol.goalReviewPrompt({
    goal: "Synthetic original goal",
    candidate: {
      outcome: "completed",
      summary: "Tests pass at commit abc",
      nextAction: "",
    },
    lastSummary: null,
    nextAction: null,
    step: 1,
    remainingMs: 1000,
  });
  assert.match(prompt, /Synthetic original goal/);
  assert.match(prompt, /untrusted|historical/i);
  assert.match(prompt, /Do not.*(?:write|publish)/i);
  assert.match(prompt, /evidence/i);
});
