import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, SCHEMA_VERSION } from "../dist/store.js";
const thread = "920000000000000001";
const session = "01a12345-1234-7456-8456-123456789abc";
const id = (n) => String(910000000000000000n + BigInt(n));
function pathFor(t) {
  const dir = mkdtempSync(join(tmpdir(), "szpont-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "queue.sqlite");
}
function legacy(path) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE conversations(thread_id TEXT PRIMARY KEY,session_id TEXT UNIQUE,blocked_reason TEXT,created_at INTEGER NOT NULL);
 CREATE TABLE jobs(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES conversations(thread_id),prompt TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('queued','running','succeeded','failed','interrupted','cancelled')),created_at INTEGER NOT NULL,
 started_at INTEGER,finished_at INTEGER,result TEXT,error_code TEXT,notification TEXT NOT NULL DEFAULT 'pending',recovery_of TEXT);
 CREATE INDEX job_status ON jobs(status,created_at);CREATE TABLE controls(message_id TEXT PRIMARY KEY);`);
  db.prepare("INSERT INTO conversations VALUES(?,?,?,?)").run(
    thread,
    session,
    "failed",
    10,
  );
  const statuses = [
    "queued",
    "running",
    "succeeded",
    "failed",
    "interrupted",
    "cancelled",
  ];
  for (let n = 1; n <= statuses.length; n++)
    db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      id(n),
      thread,
      `Synthetic old prompt ${n}`,
      statuses[n - 1],
      n * 100,
      n > 1 ? n * 100 + 10 : null,
      n > 2 ? n * 100 + 20 : null,
      n > 2 ? `Preserved result ${n}` : null,
      n > 3 ? "turn_failed" : null,
      n === 3 ? "sending" : "pending",
      n === 5 ? id(4) : null,
    );
  db.prepare("INSERT INTO controls VALUES(?)").run(id(100));
  return db;
}

test("fresh database receives current version and durable workflow/effect tables", (t) => {
  const path = pathFor(t),
    store = new Store(path);
  t.after(() => store.close());
  assert.equal(SCHEMA_VERSION, 5);
  assert.equal(
    store.db.prepare("PRAGMA user_version").get().user_version,
    SCHEMA_VERSION,
  );
  assert.equal(
    store.db.prepare("PRAGMA journal_mode").get().journal_mode,
    "wal",
  );
  assert.equal(store.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(
    store.db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  store.enqueueWorkflow(id(1), thread, "Synthetic fresh workflow", 60_000);
  assert.equal(store.workflow(id(1)).state, "active");
});

test("0.2 schema migration preserves every job, session, result and control without implicit recovery", (t) => {
  const path = pathFor(t),
    old = legacy(path);
  const jobs = old.prepare("SELECT * FROM jobs ORDER BY id").all();
  const conversations = old.prepare("SELECT * FROM conversations").all();
  old.close();
  const store = new Store(path);
  t.after(() => store.close());
  const upgraded = store.db.prepare("SELECT * FROM jobs ORDER BY id").all();
  assert.deepEqual(
    upgraded.map(({ queued_at, provider, ...job }) => job),
    jobs.map((job) => ({ ...job })),
  );
  assert.deepEqual(
    upgraded.map((job) => job.queued_at),
    jobs.map((job) => job.created_at),
  );
  assert.deepEqual(
    store.db
      .prepare("SELECT * FROM conversations")
      .all()
      .map(({ provider, ...conversation }) => conversation),
    conversations.map((conversation) => ({ ...conversation })),
  );
  assert.equal(store.controlOnce(id(100)), false);
  assert.equal(store.get(id(2)).status, "running");
  assert.equal(store.get(id(3)).notification, "sending");
  assert.equal(store.session(thread), session);
  assert.equal(store.provider(thread), "codex");
  assert.ok(upgraded.every((job) => job.provider === "codex"));
  assert.equal(store.pendingEffects()[0].generation, 1);
  assert.equal(store.workflow(id(1)), undefined);
  assert.equal(
    store.db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a failed schema upgrade rolls back added columns, tables and version together", (t) => {
  const path = pathFor(t),
    old = legacy(path);
  old.exec(`CREATE TRIGGER reject_upgrade_update BEFORE UPDATE ON jobs
  BEGIN SELECT RAISE(ABORT,'injected migration failure'); END`);
  const original = old.prepare("SELECT * FROM jobs ORDER BY id").all();
  old.close();
  assert.throws(() => new Store(path), /injected migration failure/);
  const verify = new DatabaseSync(path);
  t.after(() => verify.close());
  assert.equal(verify.prepare("PRAGMA user_version").get().user_version, 0);
  assert.equal(
    verify
      .prepare("PRAGMA table_info(jobs)")
      .all()
      .some((column) => column.name === "queued_at"),
    false,
  );
  assert.deepEqual(
    verify.prepare("SELECT * FROM jobs ORDER BY id").all(),
    original,
  );
  assert.equal(
    verify
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN('workflows','workflow_steps','effects')",
      )
      .all().length,
    0,
  );
});

test("future schema is rejected before changing data, schema or journal mode", (t) => {
  const path = pathFor(t),
    future = new DatabaseSync(path);
  future.exec(
    "PRAGMA journal_mode=DELETE; PRAGMA user_version=999; CREATE TABLE future_private_state(value TEXT);INSERT INTO future_private_state VALUES('synthetic sentinel')",
  );
  future.close();
  const bytes = readFileSync(path);
  assert.throws(
    () => new Store(path),
    /Unsupported database schema version 999/,
  );
  assert.deepEqual(readFileSync(path), bytes);
  const verify = new DatabaseSync(path);
  t.after(() => verify.close());
  assert.equal(
    verify.prepare("PRAGMA journal_mode").get().journal_mode,
    "delete",
  );
  assert.equal(verify.prepare("PRAGMA user_version").get().user_version, 999);
  assert.deepEqual(
    verify
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name),
    ["future_private_state"],
  );
});

test("reopening current schema does not dirty already synchronized effects", (t) => {
  const path = pathFor(t);
  let store = new Store(path);
  store.enqueue(id(1), thread, "Synthetic goal");
  const generation = store.effect(thread).generation;
  store.completeEffect(thread, generation, "transcript");
  store.completeEffect(thread, generation, "memory");
  const before = store.effect(thread);
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  assert.deepEqual(store.effect(thread), before);
  assert.deepEqual(store.pendingEffects(), []);
  assert.equal(
    store.db.prepare("PRAGMA user_version").get().user_version,
    SCHEMA_VERSION,
  );
});

test("schema 4 migration preserves existing work without treating it as supervised", (t) => {
  const path = pathFor(t);
  let store = new Store(path);
  store.enqueueWorkflow(id(1), thread, "Ordinary workflow", 60000);
  const before = store.get(id(1));
  store.db.exec(
    "DROP TABLE goal_reviews; DROP TABLE goals; PRAGMA user_version=4",
  );
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  assert.deepEqual(store.get(id(1)), before);
  assert.equal(store.goal(id(1)), undefined);
  assert.equal(
    store.enqueueGoal(id(2), thread, "New supervised goal", 60000),
    true,
  );
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("schema 5 rejects missing or malformed goal storage before changing journal mode", (t) => {
  for (const malformed of [false, true]) {
    const path = pathFor(t);
    const store = new Store(path);
    store.db.exec(
      "DROP TABLE goal_reviews; DROP TABLE goals; PRAGMA journal_mode=DELETE",
    );
    if (malformed)
      store.db.exec(
        "CREATE TABLE goals(job_id TEXT); CREATE TABLE goal_reviews(job_id TEXT)",
      );
    store.close();
    const bytes = readFileSync(path);
    assert.throws(() => new Store(path), /supervised goal storage is missing/);
    assert.deepEqual(readFileSync(path), bytes);
  }
});

test("failed goal migration rolls back goal tables and schema version", (t) => {
  const path = pathFor(t);
  const store = new Store(path);
  store.db.exec(
    "DROP TABLE goal_reviews; DROP TABLE goals; PRAGMA user_version=4; CREATE TABLE goal_reviews(collision TEXT)",
  );
  store.close();
  assert.throws(() => new Store(path), /already exists/);
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4);
  assert.equal(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name='goals'").get(),
    undefined,
  );
});

test("two processes waiting for the schema 4 migration both open the upgraded database", async (t) => {
  const path = pathFor(t);
  const store = new Store(path);
  store.enqueue(id(1), thread, "Retain concurrent migration work");
  store.db.exec(
    "DROP TABLE goal_reviews; DROP TABLE goals; PRAGMA user_version=4; BEGIN IMMEDIATE",
  );
  const module = new URL("../dist/store.js", import.meta.url).href;
  const run = () =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { Store } from ${JSON.stringify(module)}; const s=new Store(${JSON.stringify(path)}); if(s.get(${JSON.stringify(id(1))}).status!=="queued") process.exitCode=2; s.close();`,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let error = "";
      child.stderr.on("data", (chunk) => (error += chunk));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(error || `Child exit ${code}`)),
      );
    });
  const opening = [run(), run()];
  await new Promise((resolve) => setTimeout(resolve, 100));
  store.db.exec("COMMIT");
  store.close();
  await Promise.all(opening);
  const reopened = new Store(path);
  t.after(() => reopened.close());
  assert.equal(reopened.goal(id(1)), undefined);
  assert.equal(
    reopened.db.prepare("PRAGMA user_version").get().user_version,
    5,
  );
});
