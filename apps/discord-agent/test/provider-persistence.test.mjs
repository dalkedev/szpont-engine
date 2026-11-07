import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../dist/engine.js";
import { Store, SCHEMA_VERSION } from "../dist/store.js";
import { threadStatus } from "../dist/status.js";
import { assemblePrompt, saveTranscript } from "../dist/workspace.js";

const thread = (n) => String(930000000000000000n + BigInt(n));
const id = (n) => String(940000000000000000n + BigInt(n));
const uuid = "01a12345-1234-7456-8456-123456789abc";
const claudeUuid = "01a12345-1234-7456-8456-123456789def";
const openSession = "ses_0123456789abcdefghijklmnop";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "szpont-providers-"));
  for (const name of [
    "workspace/agent/memory",
    "workspace/agent/conversations",
    "state",
    "artifacts",
    "codex",
    "claude",
    "opencode",
    "browser",
  ])
    await mkdir(join(root, name), { recursive: true });
  for (const name of ["SOUL", "USER", "MEMORY", "POLICY"])
    await writeFile(
      join(root, `workspace/agent/${name}.md`),
      "# Synthetic fixture",
    );
  const path = join(root, "state/agent.sqlite");
  const config = {
    token: "synthetic-test-token",
    guildId: "111111111111111111",
    ownerId: "222222222222222222",
    botId: "333333333333333333",
    parentId: "444444444444444444",
    workspace: join(root, "workspace"),
    stateDir: join(root, "state"),
    artifactsDir: join(root, "artifacts"),
    codexHome: join(root, "codex"),
    browserDir: join(root, "browser"),
    codexBin: "unused",
    timeoutMs: 1000,
  };
  let store = new Store(path),
    engine;
  t.after(async () => {
    engine?.stop();
    if (engine) await engine.kick();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    path,
    config,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new Store(path);
      return store;
    },
    engine(provider, dependencies) {
      const sent = [];
      engine = new Engine(
        { ...config, provider },
        store,
        {
          send: async (threadId, text) => {
            sent.push({ threadId, text });
          },
          typing: async () => {},
        },
        { persist: async () => {}, sync: async () => "clean", ...dependencies },
      );
      return { engine, sent };
    },
  };
}

for (const version of [1, 2])
  test(`schema ${version} migration labels legacy sessions, jobs and workflows as Codex`, async (t) => {
    const f = await fixture(t);
    f.store.enqueueWorkflow(id(1), thread(1), "Synthetic legacy goal", 60_000);
    f.store.setSession(thread(1), uuid);
    f.store.db.exec(`
      DROP TABLE goal_reviews; DROP TABLE goals; DROP TABLE job_images;
    DROP TRIGGER preserve_conversation_provider;
      DROP TRIGGER preserve_job_provider;
      ALTER TABLE conversations DROP COLUMN provider;
      ALTER TABLE jobs DROP COLUMN provider;
      PRAGMA user_version=2;
    `);
    if (version === 1)
      f.store.db.exec(
        `DROP TRIGGER record_job_acceptance; DROP TRIGGER preserve_job_acceptance; DROP TABLE job_acceptance; PRAGMA user_version=1;`,
      );
    f.reopen();
    assert.equal(
      f.store.db.prepare("PRAGMA user_version").get().user_version,
      SCHEMA_VERSION,
    );
    assert.equal(f.store.provider(thread(1)), "codex");
    assert.equal(f.store.get(id(1)).provider, "codex");
    assert.equal(f.store.session(thread(1)), uuid);
    assert.equal(f.store.workflow(id(1)).goal, "Synthetic legacy goal");
    assert.equal(f.store.get(id(1)).status, "queued");
    assert.deepEqual(f.store.db.prepare("PRAGMA foreign_key_check").all(), []);
  });

test("thread binding and job snapshots survive restart, changed defaults and session reset", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(id(1), thread(1), "First Claude task", null, "claude");
  f.store.setSession(thread(1), claudeUuid, "claude");
  f.store.enqueue(
    id(2),
    thread(1),
    "Changed default cannot reroute",
    null,
    "opencode",
  );
  f.store.enqueue(id(3), thread(2), "OpenCode task", null, "opencode");
  f.store.setSession(thread(2), openSession, "opencode");
  f.reopen();
  assert.equal(f.store.provider(thread(1)), "claude");
  assert.equal(f.store.session(thread(1)), claudeUuid);
  assert.equal(f.store.provider(thread(2)), "opencode");
  assert.equal(f.store.session(thread(2)), openSession);
  assert.deepEqual(
    [1, 2, 3].map((n) => f.store.get(id(n)).provider),
    ["claude", "claude", "opencode"],
  );
  f.store.resetSession(thread(1));
  assert.equal(f.store.provider(thread(1)), "claude");
  assert.equal(f.store.session(thread(1)), null);
  assert.equal(f.store.get(id(1)).status, "cancelled");
  f.store.enqueue(id(4), thread(1), "Still Claude", null, "codex");
  assert.equal(f.store.get(id(4)).provider, "claude");
  assert.throws(
    () =>
      f.store.db
        .prepare("UPDATE conversations SET provider='codex' WHERE thread_id=?")
        .run(thread(1)),
    /immutable/,
  );
  assert.throws(
    () =>
      f.store.db
        .prepare("UPDATE jobs SET provider='codex' WHERE id=?")
        .run(id(4)),
    /immutable/,
  );
});

test("session IDs and expected providers are checked before changing durable identity", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(id(1), thread(1), "Claude", null, "claude");
  f.store.enqueue(id(2), thread(2), "OpenCode", null, "opencode");
  assert.throws(() => f.store.setSession(thread(1), uuid, "codex"), /runner/);
  assert.throws(
    () => f.store.setSession(thread(1), openSession, "claude"),
    /session/,
  );
  assert.throws(
    () => f.store.setSession(thread(2), uuid, "opencode"),
    /session/,
  );
  assert.equal(f.store.session(thread(1)), null);
  assert.equal(f.store.session(thread(2)), null);
  f.store.setSession(thread(1), claudeUuid, "claude");
  f.store.setSession(thread(2), openSession, "opencode");
  assert.throws(
    () => f.store.setSession(thread(1), uuid, "claude"),
    /unexpectedly/,
  );
});

test("eligible claiming skips an unavailable provider without changing its queued job", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(id(1), thread(1), "Claude waits", null, "claude");
  f.store.enqueue(id(2), thread(2), "Codex ready", null, "codex");
  assert.equal(f.store.claim([]), undefined);
  assert.equal(f.store.claim(["codex"]).id, id(2));
  assert.equal(f.store.get(id(1)).status, "queued");
  assert.equal(f.store.provider(thread(1)), "claude");
  assert.equal(f.store.session(thread(1)), null);
});

test("provider authentication isolation runs ready work once and never falls back", async (t) => {
  const f = await fixture(t);
  const checked = [],
    runs = [];
  let claudeReady = false;
  f.store.enqueue(id(1), thread(1), "Claude waits", null, "claude");
  f.store.enqueue(id(2), thread(2), "Codex can run", null, "codex");
  const { engine } = f.engine("claude", {
    ready: async (config) => {
      checked.push(config.provider);
      return config.provider === "codex" || claudeReady;
    },
    run: async (config, _prompt, session, save) => {
      runs.push({ provider: config.provider, session });
      const sid = config.provider === "codex" ? uuid : claudeUuid;
      save(sid);
      return {
        ok: true,
        output: "Synthetic completion",
        error: null,
        sessionId: sid,
      };
    },
  });
  await engine.kick();
  assert.deepEqual(runs, [{ provider: "codex", session: null }]);
  assert.equal(f.store.get(id(1)).status, "queued");
  assert.equal(f.store.get(id(2)).status, "succeeded");
  assert.equal(engine.authReady, false);
  assert.ok(checked.includes("claude") && checked.includes("codex"));
  claudeReady = true;
  await engine.kick();
  assert.deepEqual(
    runs.map((run) => run.provider),
    ["codex", "claude"],
  );
  assert.equal(f.store.session(thread(1)), claudeUuid);
  assert.equal(f.store.get(id(1)).status, "succeeded");
  assert.equal(engine.authReady, true);
});

test("provider failure stays failed and manual recovery retains its runner", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(id(1), thread(1), "Claude failure", null, "claude");
  const runs = [];
  const { engine } = f.engine("codex", {
    ready: async () => true,
    run: async (config, _prompt, _session, save) => {
      runs.push(config.provider);
      save(claudeUuid);
      return {
        ok: false,
        output: "",
        error: "claude_turn_failed",
        sessionId: claudeUuid,
      };
    },
  });
  await engine.kick();
  await engine.kick();
  assert.deepEqual(runs, ["claude"]);
  assert.equal(f.store.get(id(1)).status, "failed");
  assert.equal(f.store.recover(id(1), thread(1), id(2)), true);
  assert.equal(f.store.get(id(2)).provider, "claude");
  assert.equal(f.store.session(thread(1)), claudeUuid);
});

test("provider labels are local to the selected thread and its readable workspace", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(id(1), thread(1), "Synthetic prompt", null, "opencode");
  f.store.enqueue(id(2), thread(2), "Unrelated secret prompt", null, "claude");
  const text = threadStatus(f.store, thread(1), false);
  assert.match(text, /OpenCode: local prerequisites unverified/);
  assert.match(text, /Remote authentication is untested/);
  const localReady = threadStatus(f.store, thread(1), true);
  assert.match(localReady, /local prerequisites and credential entry present/);
  assert.doesNotMatch(localReady, /OpenCode: authenticated/);
  assert.doesNotMatch(text, /Claude|Unrelated secret prompt/);
  const prompt = await assemblePrompt(f.config, f.store.get(id(1)));
  assert.match(prompt, /This thread uses OpenCode/);
  assert.doesNotMatch(prompt, /Unrelated secret prompt/);
  await saveTranscript(f.config, f.store, thread(1));
});

test("workflow intake binds the configured provider without changing legacy threads", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(id(1), thread(1), "Existing Codex thread");
  f.store.cancel(id(1), thread(1));
  const { engine } = f.engine("opencode", {
    ready: async () => false,
    run: async () => {
      throw new Error("No model should run");
    },
  });
  const message = (n, t) => ({
    id: id(n),
    guildId: f.config.guildId,
    authorId: f.config.ownerId,
    parentId: f.config.parentId,
    channelId: thread(t),
    bot: false,
    webhook: false,
    thread: true,
    attachments: 0,
    content: "!work 1m Synthetic goal",
  });
  await engine.accept(message(2, 1));
  await engine.accept(message(3, 2));
  await engine.kick();
  assert.equal(f.store.get(id(2)).provider, "codex");
  assert.equal(f.store.get(id(3)).provider, "opencode");
  assert.equal(f.store.workflow(id(2)).state, "active");
  assert.equal(f.store.workflow(id(3)).state, "active");
});

test("provider migration rolls back both added bindings and schema version on DDL failure", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(id(1), thread(1), "Preserved legacy task");
  f.store.db.exec(`
    DROP TABLE goal_reviews; DROP TABLE goals; DROP TABLE job_images;
    DROP TRIGGER preserve_conversation_provider;
    DROP TRIGGER preserve_job_provider;
    ALTER TABLE conversations DROP COLUMN provider;
    ALTER TABLE jobs DROP COLUMN provider;
    PRAGMA user_version=2;
    CREATE TRIGGER preserve_job_provider AFTER UPDATE ON jobs BEGIN SELECT 1; END;
  `);
  const before = f.store.db.prepare("SELECT * FROM jobs").all();
  assert.throws(() => new Store(f.path), /already exists/);
  assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 2);
  for (const table of ["conversations", "jobs"])
    assert.equal(
      f.store.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((column) => column.name === "provider"),
      false,
    );
  assert.deepEqual(f.store.db.prepare("SELECT * FROM jobs").all(), before);
});

test("readiness remains accurate for an idle conversation using a previous default provider", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(id(1), thread(1), "Synthetic old Codex conversation");
  f.store.claim();
  f.store.finish(id(1), "succeeded", "Synthetic complete");
  const probes = [];
  const { engine, sent } = f.engine("claude", {
    ready: async (config) => {
      probes.push(config.provider);
      return true;
    },
    run: async () => {
      throw new Error("No model call");
    },
  });
  await engine.kick();
  await engine.accept({
    id: id(2),
    guildId: f.config.guildId,
    authorId: f.config.ownerId,
    channelId: thread(1),
    parentId: f.config.parentId,
    thread: true,
    bot: false,
    webhook: false,
    content: "!status",
    attachments: 0,
  });
  assert.ok(probes.includes("codex"));
  assert.ok(probes.includes("claude"));
  assert.match(sent.at(-1).text, /Codex: authenticated/);
});
