import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../dist/store.js";
const thread = "920000000000000001",
  other = "920000000000000002";
const id = (n) => String(910000000000000000n + BigInt(n));
const candidate = (summary = "Changed one file") => ({
  outcome: "continue",
  summary,
  nextAction: "Verify the next change",
});
const done = {
  outcome: "completed",
  summary: "Verified complete",
  nextAction: "",
};
function fixture(t) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return store;
}
function block(store) {
  return store.db
    .prepare("SELECT blocked_reason FROM conversations WHERE thread_id=?")
    .get(thread).blocked_reason;
}
function rows(store) {
  return [
    "jobs",
    "workflows",
    "goals",
    "goal_reviews",
    "workflow_steps",
    "effects",
    "conversations",
  ].map((table) =>
    store.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all(),
  );
}

test("supervised intake is atomic, deduplicated and restricted to Codex threads", (t) => {
  const store = fixture(t);
  assert.equal(store.enqueueGoal(id(1), thread, "Fixed goal", 60000), true);
  assert.equal(store.enqueueGoal(id(1), thread, "Duplicate", 60000), false);
  assert.equal(store.latestGoal(thread).job_id, id(1));
  assert.equal(store.goal(id(1)).pending_output, null);
  store.enqueue(id(2), other, "Claude thread", null, "claude");
  assert.throws(
    () => store.enqueueGoal(id(3), other, "Rejected goal", 60000),
    /Codex/,
  );
  assert.equal(store.get(id(3)), undefined);
  assert.throws(
    () =>
      store.enqueueGoal(
        id(4),
        "920000000000000003",
        "Rejected goal",
        60000,
        "opencode",
      ),
    /Codex/,
  );
  assert.equal(store.provider("920000000000000003"), null);
  assert.throws(() => store.enqueueGoal(id(5), thread, "", 60000), /Invalid/);
});

test("candidate remains unaccepted and charges worker time before independent review", (t) => {
  const store = fixture(t);
  store.enqueueGoal(id(1), thread, "Fixed goal", 60000);
  store.claim();
  store.saveGoalWorker(id(1), candidate(), 1234);
  assert.equal(store.get(id(1)).status, "running");
  assert.equal(store.workflow(id(1)).elapsed_ms, 1234);
  assert.equal(store.workflow(id(1)).step_count, 0);
  assert.equal(store.get(id(1)).result, null);
  assert.equal(store.goal(id(1)).pending_output, JSON.stringify(candidate()));
  assert.throws(
    () => store.saveGoalWorker(id(1), candidate("Overwrite"), 1),
    /candidate/,
  );
  assert.throws(() => store.checkpoint(id(1), done, 1), /review/);
  assert.deepEqual(
    store.reviewGoal(id(1), candidate("Evidence checked"), true, 2000),
    { continued: true, status: "queued", reason: null },
  );
  assert.equal(store.workflow(id(1)).elapsed_ms, 3234);
  assert.equal(store.workflow(id(1)).step_count, 1);
  assert.equal(store.goal(id(1)).pending_output, null);
  assert.equal(
    JSON.parse(store.goal(id(1)).last_review).summary,
    "Evidence checked",
  );
  assert.equal(store.goalReviews(id(1)).length, 1);
  store.claim();
  store.saveGoalWorker(id(1), candidate("Second change"), 1000);
  assert.equal(store.reviewGoal(id(1), done, true, 1000).status, "succeeded");
});

test("three no-progress reviews block automatic execution even when repeated candidates claim progress", (t) => {
  const store = fixture(t);
  store.enqueueGoal(id(1), thread, "Fixed goal", 60000);
  for (let n = 0; n < 4; n++) {
    store.claim();
    store.saveGoalWorker(id(1), candidate(), 1);
    const result = store.reviewGoal(
      id(1),
      candidate("Reviewer claim " + n),
      true,
      1,
    );
    assert.equal(store.goal(id(1)).stalled_count, n);
    assert.equal(result.status, n === 3 ? "interrupted" : "queued");
  }
  assert.equal(store.workflow(id(1)).state, "blocked");
  assert.equal(block(store), "workflow_blocked");
  assert.equal(store.claim(), undefined);
  assert.equal(store.goalReviews(id(1)).at(-1).progress, false);
});

test("a changed candidate with verified progress resets the consecutive stalled count", (t) => {
  const store = fixture(t);
  store.enqueueGoal(id(1), thread, "Fixed goal", 60000);
  for (const [text, progress, want] of [
    ["First", false, 1],
    ["Second", false, 2],
    ["Third", true, 0],
  ]) {
    store.claim();
    store.saveGoalWorker(id(1), candidate(text), 1);
    store.reviewGoal(id(1), candidate(text), progress, 1);
    assert.equal(store.goal(id(1)).stalled_count, want);
  }
});

test("owner pause at a safe boundary retains candidate and resumes same job without budget refund", (t) => {
  const store = fixture(t);
  store.enqueueGoal(id(1), thread, "Fixed goal", 60000);
  store.claim();
  assert.equal(store.requestGoalControl(id(1), other, "pause"), false);
  assert.equal(store.requestGoalControl(id(1), thread, "pause"), true);
  assert.equal(store.get(id(1)).status, "running");
  store.saveGoalWorker(id(1), candidate(), 1000);
  assert.equal(store.applyGoalControl(id(1)), true);
  assert.equal(store.workflow(id(1)).state, "paused");
  assert.equal(block(store), null);
  assert.equal(store.goal(id(1)).pending_output, JSON.stringify(candidate()));
  assert.equal(store.pendingNotification().id, id(1));
  assert.equal(store.resumeGoal(id(1), other), false);
  assert.equal(store.resumeGoal(id(1), thread), true);
  assert.equal(store.get(id(1)).status, "queued");
  assert.equal(store.workflow(id(1)).elapsed_ms, 1000);
  assert.equal(store.goal(id(1)).control, "active");
  store.claim();
  assert.equal(store.reviewGoal(id(1), done, true, 2000).status, "succeeded");
});

test("queued controls take effect immediately and stop produces a pending terminal notification", (t) => {
  const store = fixture(t);
  store.enqueueGoal(id(1), thread, "Fixed goal", 60000);
  assert.equal(store.requestGoalControl(id(1), thread, "pause"), true);
  assert.equal(store.get(id(1)).status, "interrupted");
  assert.equal(block(store), null);
  store.enqueue(id(2), thread, "Do not overtake");
  assert.equal(store.resumeGoal(id(1), thread), false);
  store.cancel(id(2), thread);
  assert.equal(store.resumeGoal(id(1), thread), true);
  assert.equal(store.requestGoalControl(id(1), thread, "stop"), true);
  assert.equal(store.get(id(1)).status, "cancelled");
  assert.equal(store.workflow(id(1)).state, "cancelled");
  assert.equal(store.pendingNotification().id, id(1));
  assert.equal(store.resumeGoal(id(1), thread), false);
});

test("exhausted worker budget pauses before review and cannot be resumed or recovered without new budget", (t) => {
  const store = fixture(t);
  store.enqueueGoal(id(1), thread, "Fixed goal", 60000);
  store.claim();
  store.saveGoalWorker(id(1), candidate(), 60000);
  assert.equal(store.applyGoalControl(id(1)), true);
  assert.equal(store.get(id(1)).error_code, "workflow_budget_exhausted");
  assert.equal(store.goal(id(1)).pending_output, JSON.stringify(candidate()));
  assert.equal(store.resumeGoal(id(1), thread), false);
  assert.throws(() => store.recover(id(1), thread, id(2)), /explicit/);
  store.recover(id(1), thread, id(2), {
    work: { goal: "Fixed goal", budgetMs: 60000, supervised: true },
  });
  assert.equal(store.goal(id(2)).pending_output, JSON.stringify(candidate()));
  assert.equal(store.workflow(id(2)).elapsed_ms, 0);
});

test("manual recovery retains uncertain candidate and history; fresh ordinary work drops supervision", (t) => {
  const store = fixture(t);
  store.enqueueGoal(id(1), thread, "Fixed goal", 120000);
  store.claim();
  store.saveGoalWorker(id(1), candidate(), 1000);
  store.finish(id(1), "interrupted", "Review timed out", "task_timeout", 2000);
  assert.equal(store.resumeGoal(id(1), thread), false);
  store.recover(id(1), thread, id(2));
  assert.equal(store.goal(id(2)).pending_output, JSON.stringify(candidate()));
  assert.equal(store.workflow(id(2)).elapsed_ms, 3000);
  store.claim();
  store.reviewGoal(
    id(2),
    { outcome: "blocked", summary: "Need decision", nextAction: "Which file?" },
    false,
    1000,
  );
  store.recover(id(1), thread, id(3));
  assert.equal(store.goalReviews(id(3)).length, 1);
  assert.equal(store.goal(id(3)).stalled_count, 1);
  store.claim();
  store.finish(id(3), "failed", "Failed", "turn_failed", 1);
  store.recover(id(1), thread, id(4), {
    work: { goal: "Ordinary fresh work", budgetMs: 60000 },
  });
  assert.equal(store.goal(id(4)), undefined);
});

test("fresh supervised goal changes discard old candidate while keeping reconciliation history", (t) => {
  const store = fixture(t);
  store.enqueueGoal(id(1), thread, "Original goal", 60000);
  store.claim();
  store.saveGoalWorker(id(1), candidate(), 1);
  store.finish(id(1), "failed", "Uncertain", "turn_failed", 1);
  store.recover(id(1), thread, id(2), {
    work: { goal: "Different goal", budgetMs: 60000, supervised: true },
  });
  assert.equal(store.goal(id(2)).pending_output, null);
  assert.match(store.get(id(2)).prompt, /Never blindly repeat/);
});

test("candidate and accepted review updates roll back atomically on effect failure", (t) => {
  const store = fixture(t);
  store.enqueueGoal(id(1), thread, "Goal", 60000);
  store.claim();
  store.db.exec(
    "CREATE TEMP TRIGGER reject_goal_effect BEFORE UPDATE ON effects BEGIN SELECT RAISE(ABORT,'injected effect failure'); END",
  );
  const before = rows(store);
  assert.throws(() => store.saveGoalWorker(id(1), candidate(), 12), /injected/);
  assert.deepEqual(rows(store), before);
  store.db.exec("DROP TRIGGER reject_goal_effect");
  store.saveGoalWorker(id(1), candidate(), 12);
  const saved = rows(store);
  store.db.exec(
    "CREATE TEMP TRIGGER reject_goal_effect BEFORE UPDATE ON effects BEGIN SELECT RAISE(ABORT,'injected effect failure'); END",
  );
  assert.throws(() => store.reviewGoal(id(1), done, true, 12), /injected/);
  assert.deepEqual(rows(store), saved);
});

test("invalid candidates, reviews and elapsed time cannot alter running ownership", (t) => {
  const store = fixture(t);
  store.enqueueGoal(id(1), thread, "Goal", 60000);
  store.claim();
  const before = rows(store);
  assert.throws(
    () => store.saveGoalWorker(id(1), { ...candidate(), extra: true }, 1),
    /Invalid/,
  );
  assert.throws(() => store.saveGoalWorker(id(1), candidate(), -1), /Invalid/);
  assert.deepEqual(rows(store), before);
  assert.throws(() => store.reviewGoal(id(1), done, true, 1), /candidate/);
  store.saveGoalWorker(id(1), candidate(), 1);
  const saved = rows(store);
  assert.throws(() => store.reviewGoal(id(1), done, "true", 1), /Invalid/);
  assert.deepEqual(rows(store), saved);
});

test("reopen and startup preserve candidate but never replay unknown work", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "szpont-goals-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  let store = new Store(path);
  store.enqueueGoal(id(1), thread, "Goal", 60000);
  store.claim();
  store.saveGoalWorker(id(1), candidate(), 1000);
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  assert.equal(store.recoverStartup(), 1);
  assert.equal(store.goal(id(1)).pending_output, JSON.stringify(candidate()));
  assert.equal(store.workflow(id(1)).elapsed_ms, 60000);
  assert.equal(store.claim(), undefined);
  assert.equal(store.resumeGoal(id(1), thread), false);
  assert.throws(() => store.recover(id(1), thread, id(2)), /explicit/);
});

test("session reset cancels a paused goal so it cannot resume into the new session", (t) => {
  const store = fixture(t);
  store.enqueueGoal(id(1), thread, "Goal", 60000);
  store.requestGoalControl(id(1), thread, "pause");
  store.resetSession(thread);
  assert.equal(store.workflow(id(1)).state, "cancelled");
  assert.equal(store.goal(id(1)).control, "stop");
  assert.equal(store.resumeGoal(id(1), thread), false);
});

test("recovering an ordinary ancestor retains its latest supervised recovery allowance", (t) => {
  const store = fixture(t);
  store.enqueue(id(1), thread, "Original ordinary request");
  store.claim();
  store.finish(id(1), "failed", "Uncertain", "turn_failed");
  store.recover(id(1), thread, id(2), {
    work: { goal: "New fixed goal", budgetMs: 120000, supervised: true },
  });
  store.claim();
  store.saveGoalWorker(id(2), candidate(), 1000);
  store.finish(id(2), "failed", "Review failed", "turn_failed", 2000);
  store.recover(id(1), thread, id(3));
  assert.equal(store.workflow(id(3)).elapsed_ms, 3000);
  assert.equal(store.goal(id(3)).pending_output, JSON.stringify(candidate()));
});

for (const action of ["pause", "stop"])
  test(`a ${action} request during review is applied atomically before yielding`, (t) => {
    const store = fixture(t);
    store.enqueueGoal(id(1), thread, "Goal", 60000);
    store.claim();
    store.saveGoalWorker(id(1), candidate(), 1000);
    store.requestGoalControl(id(1), thread, action);
    assert.deepEqual(
      store.reviewGoal(id(1), candidate("Verified"), true, 500),
      {
        continued: false,
        status: action === "pause" ? "interrupted" : "cancelled",
        reason: action === "pause" ? "owner_paused_goal" : "owner_stopped_goal",
      },
    );
    assert.equal(store.workflow(id(1)).step_count, 1);
    assert.equal(store.workflow(id(1)).elapsed_ms, 1500);
    assert.equal(store.goalReviews(id(1)).length, 1);
    assert.equal(
      store.workflow(id(1)).state,
      action === "pause" ? "paused" : "cancelled",
    );
    assert.equal(store.claim(), undefined);
    assert.equal(block(store), null);
  });

test("terminal review takes precedence over stop while blocked review preserves reconciliation target", (t) => {
  const store = fixture(t);
  for (const [n, outcome] of [
    [1, done],
    [
      2,
      {
        outcome: "blocked",
        summary: "External result is ambiguous",
        nextAction: "Please reconcile the destination receipt.",
      },
    ],
  ]) {
    const task = id(n),
      channel = n === 1 ? thread : other;
    store.enqueueGoal(task, channel, "Goal", 60000);
    store.claim();
    store.saveGoalWorker(task, candidate(), 1000);
    store.requestGoalControl(task, channel, "stop");
    assert.equal(store.reviewGoal(task, outcome, true, 500).continued, false);
    assert.equal(store.get(task).status, n === 1 ? "succeeded" : "interrupted");
    assert.equal(store.workflow(task).state, n === 1 ? "completed" : "blocked");
    assert.equal(store.claim(), undefined);
    if (n === 2) assert.equal(store.blockingJob(channel).id, task);
  }
});
