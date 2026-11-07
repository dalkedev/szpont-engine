import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, SCHEMA_VERSION } from "../dist/store.js";

const PRIVATE = false;
const previousVersion = PRIVATE ? 2 : 1;
const thread = "920000000000000001";
const other = "920000000000000002";
const blockedThread = "920000000000000003";
const id = (n) => String(910000000000000000n + BigInt(n));
const session = "01a12345-1234-7456-8456-123456789abc";
const more = {
  outcome: "continue",
  summary: "Verified checkpoint",
  nextAction: "Verify next change",
};
const done = {
  outcome: "completed",
  summary: "Verified completion",
  nextAction: "",
};
function pathFor(t) {
  const dir = mkdtempSync(join(tmpdir(), "szpont-fifo-clock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "queue.sqlite");
}
function fixture(t, path = ":memory:") {
  const store = new Store(path);
  t.after(() => store.close());
  return store;
}
function acceptance(store) {
  return store.db
    .prepare("SELECT * FROM job_acceptance ORDER BY sequence")
    .all();
}
function legacy(
  path,
  privateVariant = PRIVATE,
  version = privateVariant ? 2 : 1,
) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=DELETE;
    CREATE TABLE conversations(thread_id TEXT PRIMARY KEY,session_id TEXT UNIQUE,blocked_reason TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES conversations(thread_id),prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN('queued','running','succeeded','failed','interrupted','cancelled')),created_at INTEGER NOT NULL,
      started_at INTEGER,finished_at INTEGER,result TEXT,error_code TEXT,notification TEXT NOT NULL DEFAULT 'pending',recovery_of TEXT,
      queued_at INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX job_status ON jobs(status,created_at);
    CREATE INDEX job_fair_queue ON jobs(status,queued_at,id);
    CREATE TABLE controls(message_id TEXT PRIMARY KEY);
    CREATE TABLE workflows(job_id TEXT PRIMARY KEY REFERENCES jobs(id),goal TEXT NOT NULL,budget_ms INTEGER NOT NULL,
      elapsed_ms INTEGER NOT NULL DEFAULT 0,max_steps INTEGER NOT NULL,step_count INTEGER NOT NULL DEFAULT 0,
      last_summary TEXT,next_action TEXT,state TEXT NOT NULL);
    CREATE TABLE workflow_steps(job_id TEXT NOT NULL REFERENCES workflows(job_id),step INTEGER NOT NULL,
      outcome TEXT NOT NULL,summary TEXT NOT NULL,next_action TEXT NOT NULL,elapsed_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL,PRIMARY KEY(job_id,step));
    CREATE TABLE effects(thread_id TEXT PRIMARY KEY REFERENCES conversations(thread_id),generation INTEGER NOT NULL,
      exported_generation INTEGER NOT NULL DEFAULT 0,synced_generation INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,last_error TEXT);
    PRAGMA user_version=${version};
  `);
  if (privateVariant)
    db.exec(`
    ALTER TABLE jobs ADD COLUMN source TEXT NOT NULL DEFAULT 'discord' CHECK(source IN('discord','schedule'));
    ALTER TABLE jobs ADD COLUMN lane TEXT NOT NULL DEFAULT 'general' CHECK(lane IN('general','editorial'));
    CREATE TABLE weekly_slots(slot_key TEXT PRIMARY KEY,language TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,thread_id TEXT,message_id TEXT);
    CREATE TABLE publications(publication_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),content_hash TEXT NOT NULL,
      status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,message_id TEXT,url TEXT);
    CREATE INDEX job_lane_queue ON jobs(lane,status,queued_at,id);
    CREATE UNIQUE INDEX one_running_per_lane ON jobs(lane) WHERE status='running';
    CREATE UNIQUE INDEX one_running_per_thread ON jobs(thread_id) WHERE status='running';
    CREATE TABLE turn_workspaces(job_id TEXT PRIMARY KEY REFERENCES jobs(id),thread_id TEXT NOT NULL REFERENCES conversations(thread_id));
    CREATE TABLE memory_merges(job_id TEXT PRIMARY KEY REFERENCES jobs(id),thread_id TEXT NOT NULL REFERENCES conversations(thread_id),status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0);
  `);
  db.prepare("INSERT INTO conversations VALUES(?,?,NULL,1)").run(
    thread,
    session,
  );
  db.prepare("INSERT INTO conversations VALUES(?,NULL,NULL,1)").run(other);
  db.prepare("INSERT INTO conversations VALUES(?,NULL,'failed',1)").run(
    blockedThread,
  );
  const insert = db.prepare(
    "INSERT INTO jobs(id,thread_id,prompt,status,created_at,queued_at,result,error_code,notification,recovery_of) VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  // Physical insert order and fair-queue order differ from the legacy FIFO contract.
  insert.run(
    id(3),
    thread,
    "Pending followup",
    "queued",
    3000,
    3000,
    null,
    null,
    "pending",
    null,
  );
  insert.run(
    id(1),
    thread,
    "Continued workflow",
    "queued",
    2000,
    9000,
    "Verified checkpoint",
    null,
    "pending",
    null,
  );
  insert.run(
    id(2),
    other,
    "Independent thread",
    "queued",
    2500,
    2500,
    null,
    null,
    "pending",
    null,
  );
  insert.run(
    id(4),
    blockedThread,
    "Uncertain earlier action",
    "interrupted",
    4000,
    4000,
    "Preserved partial result",
    "task_timeout",
    "ambiguous",
    null,
  );
  insert.run(
    id(5),
    blockedThread,
    "Recorded manual recovery",
    "failed",
    5000,
    5000,
    "Preserved recovery result",
    "turn_failed",
    "sent",
    id(4),
  );
  db.prepare(
    "INSERT INTO workflows VALUES(?,?,60000,1234,32,1,?,?,'active')",
  ).run(id(1), "Original fixed goal", more.summary, more.nextAction);
  db.prepare(
    "INSERT INTO workflow_steps VALUES(?,1,'continue',?,?,1234,2001)",
  ).run(id(1), more.summary, more.nextAction);
  db.prepare("INSERT INTO effects VALUES(?,7,7,7,0,0,NULL)").run(thread);
  db.prepare(
    "INSERT INTO effects VALUES(?,3,2,1,2,6000,'memory_sync_failed')",
  ).run(blockedThread);
  db.prepare("INSERT INTO controls VALUES(?)").run(id(99));
  if (privateVariant) {
    db.prepare(
      "UPDATE jobs SET source='schedule',lane='editorial' WHERE id=?",
    ).run(id(4));
    db.prepare(
      "INSERT INTO weekly_slots VALUES('synthetic-slot','en','queued',1,?,?)",
    ).run(other, id(2));
    db.prepare(
      "INSERT INTO publications VALUES('synthetic-publication',?,'synthetic-hash','verified',1,2,?,'https://example.invalid/receipt')",
    ).run(id(4), id(100));
    db.prepare("INSERT INTO turn_workspaces VALUES(?,?)").run(
      id(4),
      blockedThread,
    );
    db.prepare("INSERT INTO memory_merges VALUES(?,?,'conflict',1,5000)").run(
      id(4),
      blockedThread,
    );
  }
  return db;
}
function snapshot(db) {
  return Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => [
        name,
        db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all(),
      ]),
  );
}

test("accepted instructions retain FIFO through backward clock changes and reversed message IDs", (t) => {
  let now = 2000;
  t.mock.method(Date, "now", () => now);
  const store = fixture(t);
  store.enqueue(id(9), thread, "Accepted first");
  now = 1000;
  store.enqueue(id(1), thread, "Accepted second");
  store.enqueue(id(2), thread, "Accepted third at the same wall time");
  assert.ok(store.get(id(9)).queued_at < store.get(id(1)).queued_at);
  for (const expected of [9, 1, 2]) {
    assert.equal(store.claim().id, id(expected));
    store.finish(id(expected), "succeeded", "Verified");
  }
  assert.equal(store.claim(), undefined);
  assert.deepEqual(
    acceptance(store).map((row) => row.job_id),
    [id(9), id(1), id(2)],
  );
});

test("continued workflow preserves immutable FIFO while yielding to other threads", (t) => {
  let now = 2000;
  t.mock.method(Date, "now", () => now);
  const store = fixture(t);
  store.enqueueWorkflow(id(9), thread, "Original fixed goal", 60000);
  store.setSession(thread, session);
  assert.equal(store.claim().id, id(9));
  now = 1000;
  store.enqueue(id(1), thread, "Followup after the complete workflow");
  store.enqueue(id(2), other, "Independent work");
  const original = acceptance(store);
  assert.equal(store.checkpoint(id(9), more, 1234).continued, true);
  assert.ok(store.get(id(9)).queued_at > store.get(id(2)).queued_at);
  assert.equal(store.claim().id, id(2));
  store.finish(id(2), "succeeded", "Independent work verified");
  assert.equal(store.claim().id, id(9));
  store.checkpoint(id(9), done, 1000);
  assert.equal(store.claim().id, id(1));
  assert.deepEqual(acceptance(store), original);
  assert.equal(store.session(thread), session);
  assert.equal(store.workflow(id(9)).elapsed_ms, 2234);
});

test("recovery preserves charged work and creates a new acceptance without replaying followups", (t) => {
  let now = 2000;
  t.mock.method(Date, "now", () => now);
  const store = fixture(t);
  store.enqueueWorkflow(id(9), thread, "Original fixed goal", 60000);
  store.setSession(thread, session);
  store.claim();
  store.checkpoint(id(9), more, 1234);
  store.claim();
  store.finish(
    id(9),
    "interrupted",
    "Uncertain partial actions",
    "task_timeout",
    1000,
  );
  now = 1000;
  store.enqueue(id(2), thread, "Superseded queued followup");
  const original = acceptance(store)[0];
  assert.equal(store.recover(id(9), thread, id(1)), true);
  store.enqueue(id(3), thread, "Later followup must wait");
  assert.equal(store.get(id(2)).status, "cancelled");
  assert.equal(store.claim().id, id(1));
  assert.equal(store.get(id(1)).recovery_of, id(9));
  assert.equal(store.workflow(id(1)).elapsed_ms, 2234);
  assert.equal(store.workflowSteps(id(1)).length, 1);
  assert.equal(store.session(thread), session);
  assert.deepEqual(acceptance(store)[0], original);
  assert.match(store.get(id(1)).prompt, /Never blindly repeat a publication/);
  store.checkpoint(id(1), done, 1);
  assert.equal(store.claim().id, id(3));
});

test("schema migration preserves durable state and the prior FIFO ordering contract", (t) => {
  const path = pathFor(t);
  const old = legacy(path);
  const before = snapshot(old);
  old.close();
  let store = new Store(path);
  assert.equal(
    store.db.prepare("PRAGMA user_version").get().user_version,
    SCHEMA_VERSION,
  );
  const after = snapshot(store.db);
  delete after.job_acceptance;
  assert.deepEqual(after.job_images, []);
  delete after.job_images;
  assert.deepEqual(after.goals, []);
  assert.deepEqual(after.goal_reviews, []);
  delete after.goals;
  delete after.goal_reviews;
  for (const table of ["conversations", "jobs"]) {
    assert.ok(after[table].every((row) => row.provider === "codex"));
    for (const row of after[table]) delete row.provider;
  }
  assert.deepEqual(after, before);
  assert.deepEqual(
    acceptance(store).map((row) => row.job_id),
    [1, 2, 3, 4, 5].map(id),
  );
  const initial = acceptance(store);
  store.close();
  store = fixture(t, path);
  assert.deepEqual(acceptance(store), initial);
  assert.equal(store.session(thread), session);
  assert.equal(store.controlOnce(id(99)), false);
  assert.equal(store.claim().id, id(2));
  store.finish(id(2), "succeeded", "Independent work verified");
  assert.equal(store.claim().id, id(1));
  store.checkpoint(id(1), done, 1);
  assert.equal(store.claim().id, id(3));
  assert.equal(store.get(id(4)).error_code, "task_timeout");
  assert.equal(store.get(id(4)).notification, "ambiguous");
  assert.equal(store.get(id(5)).recovery_of, id(4));
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(
    store.db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
});

test("acceptance migration rolls back its ledger, triggers and version together", (t) => {
  const path = pathFor(t);
  const old = legacy(path);
  old.exec(
    "CREATE TRIGGER record_job_acceptance AFTER INSERT ON controls BEGIN SELECT 1; END",
  );
  const before = snapshot(old);
  old.close();
  assert.throws(
    () => new Store(path),
    /trigger record_job_acceptance already exists/,
  );
  const verify = new DatabaseSync(path);
  assert.equal(
    verify.prepare("PRAGMA user_version").get().user_version,
    previousVersion,
  );
  assert.deepEqual(snapshot(verify), before);
  assert.equal(
    verify
      .prepare("SELECT 1 FROM sqlite_master WHERE name='job_acceptance'")
      .get(),
    undefined,
  );
  assert.equal(
    verify
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name='preserve_job_acceptance'",
      )
      .get(),
    undefined,
  );
  verify.exec("DROP TRIGGER record_job_acceptance");
  verify.close();
  const store = fixture(t, path);
  assert.equal(acceptance(store).length, 5);
});

test("another database variant is rejected before any database or version mutation", async (t) => {
  for (const version of PRIVATE ? [2] : [2, 3])
    await t.test(`foreign schema ${version}`, (t) => {
      const path = pathFor(t);
      const old = legacy(path, !PRIVATE, version);
      if (PRIVATE)
        old.exec(
          "CREATE TABLE job_acceptance(sequence INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id))",
        );
      old.close();
      const bytes = readFileSync(path);
      assert.throws(
        () => new Store(path),
        /Unsupported database (variant|schema version)/,
      );
      assert.deepEqual(readFileSync(path), bytes);
      const verify = new DatabaseSync(path);
      t.after(() => verify.close());
      assert.equal(
        verify.prepare("PRAGMA user_version").get().user_version,
        version,
      );
      assert.equal(
        verify.prepare("PRAGMA journal_mode").get().journal_mode,
        "delete",
      );
    });
});

test("duplicate and failed intake cannot leave an acceptance without its job", (t) => {
  const store = fixture(t);
  store.enqueue(id(9), thread, "Accepted goal");
  const before = acceptance(store);
  assert.equal(store.enqueue(id(9), thread, "Duplicate"), false);
  assert.deepEqual(acceptance(store), before);
  store.db.exec(
    "CREATE TEMP TRIGGER reject_workflow BEFORE INSERT ON workflows BEGIN SELECT RAISE(ABORT,'injected intake failure'); END",
  );
  assert.throws(
    () => store.enqueueWorkflow(id(1), thread, "Failed transaction", 60000),
    /injected intake failure/,
  );
  assert.equal(store.get(id(1)), undefined);
  assert.deepEqual(acceptance(store), before);
  store.db.exec("DROP TRIGGER reject_workflow");
  store.enqueue(id(2), thread, "Healthy next intake");
  assert.equal(acceptance(store).length, 2);
  assert.throws(
    () =>
      store.db
        .prepare("UPDATE job_acceptance SET sequence=100 WHERE job_id=?")
        .run(id(9)),
    /immutable/,
  );
});

test("separate connections and direct legacy inserts share one durable acceptance ledger", (t) => {
  let now = 2000;
  t.mock.method(Date, "now", () => now);
  const path = pathFor(t);
  const first = fixture(t, path);
  const second = fixture(t, path);
  first.enqueue(id(9), thread, "First connection");
  now = 1000;
  second.enqueue(id(1), thread, "Second connection");
  second.db
    .prepare(
      "INSERT INTO jobs(id,thread_id,prompt,status,created_at,queued_at) VALUES(?,?,?,'queued',1,1)",
    )
    .run(id(2), thread, "Legacy direct adapter");
  assert.deepEqual(
    acceptance(first).map((row) => row.job_id),
    [id(9), id(1), id(2)],
  );
  for (const expected of [9, 1, 2]) {
    assert.equal(second.claim().id, id(expected));
    first.finish(id(expected), "succeeded", "Verified");
  }
});
