import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { imageDigest } from "../apps/discord-agent/dist/images.js";
import { Store, SCHEMA_VERSION } from "../apps/discord-agent/dist/store.js";
import {
  MAX_SCHEMA_VERSION,
  parseSnapshotArguments,
  snapshotState,
} from "./state-snapshot.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts/state-snapshot.mjs");
const thread = "123456789012345678";
const job = "123456789012345679";
const session = "c3c9cfe5-9659-4d5a-a2c2-ec73b1b64056";
const marker = "synthetic-private-transcript-never-print";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "szpont-state-test-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    source: join(directory, "live.sqlite"),
    destination: join(directory, "snapshot.sqlite"),
  };
}

function legacy(path, version = 0) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE conversations(thread_id TEXT PRIMARY KEY,session_id TEXT UNIQUE,blocked_reason TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES conversations(thread_id),prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN('queued','running','succeeded','failed','interrupted','cancelled')),created_at INTEGER NOT NULL,
      started_at INTEGER,finished_at INTEGER,result TEXT,error_code TEXT,notification TEXT NOT NULL DEFAULT 'pending',recovery_of TEXT);
    CREATE INDEX job_status ON jobs(status,created_at);
    CREATE TABLE controls(message_id TEXT PRIMARY KEY);
    PRAGMA user_version=${version};
  `);
  db.prepare("INSERT INTO conversations VALUES(?,?,NULL,1)").run(
    thread,
    session,
  );
  db.prepare(
    "INSERT INTO jobs(id,thread_id,prompt,status,created_at,result,notification) VALUES(?,?,?,'succeeded',2,?,'sent')",
  ).run(job, thread, marker, "Synthetic completed result");
  return db;
}

async function noStaging(directory) {
  assert.equal(
    (await readdir(directory)).filter((name) =>
      name.startsWith(".szpont-snapshot-"),
    ).length,
    0,
  );
}

test("backs up legacy state without migrating and restores to a new path before upgrade", async (t) => {
  const f = await fixture(t);
  legacy(f.source).close();
  await chmod(f.source, 0o400);
  const before = await readFile(f.source);
  const report = await snapshotState({ operation: "backup", ...f });
  assert.equal(report.operation, "backup");
  assert.equal(report.schemaVersion, 0);
  assert.match(report.sha256, /^[a-f0-9]{64}$/);
  assert.ok(report.bytes > 0);
  assert.equal((await stat(f.destination)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(f.source), before);

  const restored = join(f.directory, "restored.sqlite");
  await snapshotState({
    operation: "restore",
    source: f.destination,
    destination: restored,
  });
  const store = new Store(restored);
  try {
    assert.equal(
      store.db.prepare("PRAGMA user_version").get().user_version,
      SCHEMA_VERSION,
    );
    assert.equal(
      store.db.prepare("SELECT session_id FROM conversations").get().session_id,
      session,
    );
    assert.equal(
      store.db.prepare("SELECT result FROM jobs").get().result,
      "Synthetic completed result",
    );
    assert.equal(
      store.db.prepare("SELECT notification FROM jobs").get().notification,
      "sent",
    );
    assert.equal(
      store.db.prepare("SELECT queued_at FROM jobs").get().queued_at,
      2,
    );
  } finally {
    store.db.close();
  }
  const snapshot = new DatabaseSync(f.destination, { readOnly: true });
  try {
    assert.equal(snapshot.prepare("PRAGMA user_version").get().user_version, 0);
  } finally {
    snapshot.close();
  }
  await noStaging(f.directory);
});

test("backs up current schema with pending effects and workflow checkpoints intact", async (t) => {
  const f = await fixture(t);
  const store = new Store(f.source);
  store.enqueueWorkflow(job, thread, "Synthetic bounded goal", 60_000);
  store.claim();
  store.checkpoint(
    job,
    {
      outcome: "continue",
      summary: "First verified step",
      nextAction: "Review result",
    },
    50,
  );
  const report = await snapshotState({ operation: "backup", ...f });
  assert.equal(report.schemaVersion, SCHEMA_VERSION);
  const restored = new Store(f.destination);
  try {
    assert.equal(restored.workflow(job).step_count, 1);
    assert.equal(restored.workflow(job).elapsed_ms, 50);
    assert.equal(restored.workflowSteps(job)[0].summary, "First verified step");
    assert.ok(
      restored.effect(thread).generation >
        restored.effect(thread).exported_generation,
    );
    assert.equal(
      restored.db.prepare("SELECT status FROM jobs").get().status,
      "queued",
    );
  } finally {
    restored.db.close();
    store.db.close();
  }
  await noStaging(f.directory);
});

test("includes committed WAL pages without checkpointing or copying the live main file", async (t) => {
  const f = await fixture(t);
  const db = legacy(f.source);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    db.prepare("UPDATE jobs SET result=?").run("Committed only in WAL");
    assert.ok((await stat(f.source + "-wal")).size > 0);
    const before = await readFile(f.source);
    await snapshotState({ operation: "backup", ...f });
    assert.deepEqual(await readFile(f.source), before);
    const snapshot = new DatabaseSync(f.destination, { readOnly: true });
    try {
      assert.equal(
        snapshot.prepare("SELECT result FROM jobs").get().result,
        "Committed only in WAL",
      );
      assert.equal(
        snapshot.prepare("PRAGMA journal_mode").get().journal_mode,
        "delete",
      );
    } finally {
      snapshot.close();
    }
    assert.equal(
      (await readdir(f.directory)).includes("snapshot.sqlite-wal"),
      false,
    );
  } finally {
    db.close();
  }
});

test("never overwrites an existing destination or restores over its source", async (t) => {
  const f = await fixture(t);
  legacy(f.source).close();
  await writeFile(f.destination, "Existing destination is preserved");
  for (const destination of [f.destination, f.source]) {
    await assert.rejects(
      snapshotState({ operation: "restore", source: f.source, destination }),
      /destination_exists/,
    );
  }
  assert.equal(
    await readFile(f.destination, "utf8"),
    "Existing destination is preserved",
  );
  await noStaging(f.directory);
});

test("concurrent snapshots publish one complete destination without replacing it", async (t) => {
  const f = await fixture(t);
  legacy(f.source).close();
  const results = await Promise.allSettled([
    snapshotState({ operation: "backup", ...f }),
    snapshotState({ operation: "backup", ...f }),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  const db = new DatabaseSync(f.destination, { readOnly: true });
  assert.equal(db.prepare("SELECT prompt FROM jobs").get().prompt, marker);
  db.close();
  await noStaging(f.directory);
});

test("rejects destination symlinks and preexisting SQLite sidecars", async (t) => {
  const f = await fixture(t);
  legacy(f.source).close();
  const target = join(f.directory, "do-not-touch");
  await writeFile(target, "Unchanged");
  await symlink(target, f.destination);
  await assert.rejects(
    snapshotState({ operation: "backup", ...f }),
    /destination_exists/,
  );
  await rm(f.destination);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    await writeFile(f.destination + suffix, "Unchanged");
    await assert.rejects(
      snapshotState({ operation: "backup", ...f }),
      /destination_exists/,
    );
    await rm(f.destination + suffix);
  }
  assert.equal(await readFile(target, "utf8"), "Unchanged");
  await noStaging(f.directory);
});

test("rejects source symlinks, hard links and a writable shared parent", async (t) => {
  const f = await fixture(t);
  legacy(f.source).close();
  const alias = join(f.directory, "alias.sqlite");
  await symlink(f.source, alias);
  await assert.rejects(
    snapshotState({
      operation: "backup",
      source: alias,
      destination: f.destination,
    }),
    /source_must_be_owned_regular_file/,
  );
  await rm(alias);
  await link(f.source, alias);
  await assert.rejects(
    snapshotState({ operation: "backup", ...f }),
    /source_must_be_owned_regular_file/,
  );
  await rm(alias);
  const shared = join(f.directory, "shared");
  await mkdir(shared, { mode: 0o755 });
  await assert.rejects(
    snapshotState({
      operation: "backup",
      source: f.source,
      destination: join(shared, "new.sqlite"),
    }),
    /parent_must_be_owned_and_private/,
  );
  await noStaging(f.directory);
});

test("rejects aliased source sidecars before opening SQLite", async (t) => {
  const f = await fixture(t);
  legacy(f.source).close();
  const target = join(f.directory, "sidecar-target");
  await writeFile(target, "Unchanged");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    await symlink(target, f.source + suffix);
    await assert.rejects(
      snapshotState({ operation: "backup", ...f }),
      /source_sidecar_must_be_owned_regular_file/,
    );
    await rm(f.source + suffix);
  }
  assert.equal(await readFile(target, "utf8"), "Unchanged");
  await noStaging(f.directory);
});

test("rejects direct and directory alias paths into the public source checkout", async (t) => {
  const f = await fixture(t);
  legacy(f.source).close();
  const publicAlias = join(f.directory, "public-alias");
  await symlink(root, publicAlias);
  for (const destination of [
    join(root, "must-not-exist.sqlite"),
    join(publicAlias, "must-not-exist.sqlite"),
  ]) {
    await assert.rejects(
      snapshotState({ operation: "backup", source: f.source, destination }),
      /public_checkout_forbidden/,
    );
  }
  await assert.rejects(
    snapshotState({
      operation: "backup",
      source: join(publicAlias, "README.md"),
      destination: f.destination,
    }),
    /public_checkout_forbidden/,
  );
  await noStaging(f.directory);
});

test("rejects future schemas without migrating or changing the source", async (t) => {
  const f = await fixture(t);
  legacy(f.source, MAX_SCHEMA_VERSION + 1).close();
  const before = await readFile(f.source);
  await assert.rejects(
    snapshotState({ operation: "backup", ...f }),
    /future_schema_unsupported/,
  );
  assert.deepEqual(await readFile(f.source), before);
  assert.equal((await readdir(f.directory)).includes("snapshot.sqlite"), false);
  await noStaging(f.directory);
});

test("invalid databases and foreign key violations leave no partial destination", async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, marker);
  await assert.rejects(
    snapshotState({ operation: "backup", ...f }),
    /snapshot_failed/,
  );
  await rm(f.source);
  const db = legacy(f.source);
  db.exec("PRAGMA foreign_keys=OFF; DELETE FROM conversations");
  db.close();
  await assert.rejects(
    snapshotState({ operation: "backup", ...f }),
    /database_integrity_failed/,
  );
  assert.equal((await readdir(f.directory)).includes("snapshot.sqlite"), false);
  await noStaging(f.directory);
});

test("requires explicit absolute paths and strict command arguments", async (t) => {
  const f = await fixture(t);
  assert.equal(parseSnapshotArguments(["--help"]), null);
  assert.deepEqual(
    parseSnapshotArguments([
      "restore",
      "--destination",
      f.destination,
      "--source",
      f.source,
    ]),
    {
      operation: "restore",
      source: f.source,
      destination: f.destination,
    },
  );
  for (const args of [
    [],
    ["backup"],
    ["backup", "--source", f.source, "--source", f.source],
    ["backup", "--source", f.source, "--force", f.destination],
  ])
    assert.throws(() => parseSnapshotArguments(args), /invalid_arguments/);
  await assert.rejects(
    snapshotState({
      operation: "backup",
      source: "relative.sqlite",
      destination: f.destination,
    }),
    /absolute_paths_required/,
  );
});

test("CLI needs no engine credentials and never prints source data or paths", async (t) => {
  const f = await fixture(t);
  legacy(f.source).close();
  const result = await execute(
    process.execPath,
    [script, "backup", "--source", f.source, "--destination", f.destination],
    {
      env: { PATH: process.env.PATH },
    },
  );
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.schemaVersion, 0);
  assert.equal(result.stdout.includes(marker), false);
  assert.equal(result.stdout.includes(f.directory), false);
  await assert.rejects(
    execute(process.execPath, [
      script,
      "restore",
      "--source",
      f.source,
      "--destination",
      f.destination,
    ]),
    (error) => {
      assert.match(error.stderr, /destination_exists/);
      assert.equal(error.stderr.includes(marker), false);
      assert.equal(error.stderr.includes(f.directory), false);
      return true;
    },
  );
});

test("schema 3 backup and restore preserve non-Codex binding, session identity and recovery metadata", async (t) => {
  const f = await fixture(t);
  const store = new Store(f.source);
  const openSession = "ses_0123456789abcdefghijklmnop";
  store.enqueue(job, thread, "Synthetic OpenCode job", null, "opencode");
  store.setSession(thread, openSession, "opencode");
  store.claim();
  store.finish(job, "failed", "Saved synthetic result", "synthetic_failure");
  store.close();
  await snapshotState({ operation: "backup", ...f });
  const restored = join(f.directory, "provider-restored.sqlite");
  await snapshotState({
    operation: "restore",
    source: f.destination,
    destination: restored,
  });
  const reopened = new Store(restored);
  try {
    assert.equal(reopened.provider(thread), "opencode");
    assert.equal(reopened.session(thread), openSession);
    assert.equal(reopened.get(job).provider, "opencode");
    assert.equal(reopened.get(job).result, "Saved synthetic result");
    assert.throws(() => reopened.setSession(thread, session, "codex"));
  } finally {
    reopened.close();
  }
});

test("schema 4 backup and restore preserve image bytes across interrupted-job recovery", async (t) => {
  const f = await fixture(t);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
    "base64",
  );
  const recovered = "123456789012345680";
  const image = { mediaType: "image/png", sha256: imageDigest(png), data: png };
  const store = new Store(f.source);
  try {
    store.enqueue(job, thread, "Synthetic image request", null, "codex", [
      image,
    ]);
    store.claim();
    store.setSession(thread, session);
    store.finish(job, "interrupted", "", "synthetic_interruption");
    store.recover(job, thread, recovered);
    const report = await snapshotState({ operation: "backup", ...f });
    assert.equal(report.schemaVersion, SCHEMA_VERSION);
    const restored = join(f.directory, "restored-images.sqlite");
    await snapshotState({
      operation: "restore",
      source: f.destination,
      destination: restored,
    });
    const reopened = new Store(restored);
    try {
      assert.equal(reopened.get(recovered).recovery_of, job);
      assert.equal(reopened.get(recovered).status, "queued");
      assert.equal(reopened.session(thread), session);
      for (const jobId of [job, recovered]) {
        const [copy] = reopened.images(jobId);
        assert.deepEqual(Buffer.from(copy.data), png);
        assert.equal(copy.sha256, image.sha256);
        assert.equal(copy.mediaType, "image/png");
      }
      assert.deepEqual(
        reopened.db.prepare("PRAGMA foreign_key_check").all(),
        [],
      );
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
  }
  await noStaging(f.directory);
});

test("schema 5 backup and restore retain a supervised candidate and control request", async (t) => {
  const f = await fixture(t);
  const store = new Store(f.source);
  const candidate = {
    outcome: "continue",
    summary: "Synthetic saved candidate",
    nextAction: "Review the evidence",
  };
  store.enqueueGoal(job, thread, "Synthetic supervised goal", 60000);
  store.claim();
  store.saveGoalWorker(job, candidate, 1000);
  store.requestGoalControl(job, thread, "pause");
  store.close();
  const report = await snapshotState({ operation: "backup", ...f });
  assert.equal(report.schemaVersion, 5);
  const reopened = new Store(f.destination);
  try {
    assert.equal(reopened.goal(job).pending_output, JSON.stringify(candidate));
    assert.equal(reopened.goal(job).control, "pause");
    assert.equal(reopened.workflow(job).elapsed_ms, 1000);
    assert.equal(reopened.get(job).status, "running");
  } finally {
    reopened.close();
  }
});
