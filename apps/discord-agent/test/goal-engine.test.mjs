import { imageDigest } from "../dist/images.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { Engine } from "../dist/engine.js";
import { Store } from "../dist/store.js";
import { threadStatus } from "../dist/status.js";

const thread = "5555000000000000001",
  other = "5555000000000000002";
const id = (n) => String(5555000000000001000n + BigInt(n));
const sid = "01a12345-1234-7456-8456-123456789abc";
const sid2 = "01a12345-1234-7456-8456-123456789def";
const output = (
  outcome = "completed",
  summary = "Verified checkpoint",
  nextAction = "",
) => JSON.stringify({ outcome, summary, nextAction });
const success = (text = "Done", sessionId = sid) => ({
  ok: true,
  output: text,
  sessionId,
  error: null,
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "szpont-goal-engine-"));
  for (const name of [
    "workspace/agent/memory",
    "workspace/agent/conversations",
    "state",
    "artifacts",
    "codex",
    "browser",
  ])
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  for (const name of ["SOUL", "USER", "MEMORY", "POLICY"])
    await writeFile(
      join(root, `workspace/agent/${name}.md`),
      `# Synthetic ${name}`,
    );
  const config = {
    guildId: "111111111111111111",
    ownerId: "222222222222222222",
    botId: "333333333333333333",
    parentId: "444444444444444444",
    token: "synthetic-discord-secret",
    workspace: join(root, "workspace"),
    stateDir: join(root, "state"),
    artifactsDir: join(root, "artifacts"),
    codexHome: join(root, "codex"),
    browserDir: join(root, "browser"),
    codexBin: "fake",
    timeoutMs: 600_000,
  };
  const store = new Store(join(root, "state/queue.sqlite"));
  const sent = [],
    calls = [];
  const clock = { value: Date.now() + 100 };
  const deps = {
    ready: async () => true,
    run: async (c, prompt, session, save, signal, options) => {
      calls.push({ c, prompt, session, signal, options });
      if (!session) save(sid);
      clock.value += 10;
      return success(options?.workflow ? output() : "Done");
    },
    persist: async () => {},
    sync: async () => "clean",
    now: () => clock.value,
    monotonicNow: () => clock.value,
  };
  const transport = {
    send: async (channel, text) => sent.push({ channel, text }),
    typing: async () => {},
  };
  const engines = [];
  const make = (dependencies = deps, channel = transport) => {
    const engine = new Engine(config, store, channel, dependencies);
    engines.push(engine);
    return engine;
  };
  t.after(async () => {
    for (const engine of engines) engine.stop();
    for (const engine of engines) await drain(engine);
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const message = (n, content, channelId = thread) => ({
    id: id(n),
    guildId: config.guildId,
    authorId: config.ownerId,
    channelId,
    parentId: config.parentId,
    bot: false,
    webhook: false,
    thread: true,
    attachments: 0,
    content,
  });
  return {
    root,
    config,
    store,
    sent,
    calls,
    clock,
    deps,
    transport,
    make,
    message,
  };
}
async function withinDeadline(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function drain(engine) {
  // kick joins the current tick. Wait on its completion, not a count of event-loop
  // turns: filesystem work may stay pending through many immediate callbacks.
  await withinDeadline(
    engine.kick(),
    "fake engine did not settle within 10 seconds",
  );
  assert.equal(
    engine.isBusy(),
    false,
    "fake engine must settle without replay",
  );
}

const review = (
  outcome = "completed",
  summary = "Independent evidence checked",
  nextAction = "",
  progress = true,
) => JSON.stringify({ outcome, summary, nextAction, progress });

test("supervisor vetoes worker completion, resumes main session, and alone accepts completion", async (t) => {
  const f = await fixture(t);
  let workers = 0,
    reviewers = 0;
  f.deps.run = async (config, prompt, session, save, signal, options) => {
    f.calls.push({ config, prompt, session, options });
    f.clock.value += 10;
    if (options?.supervisor) {
      assert.equal(session, null);
      save(sid2);
      reviewers++;
      return success(
        review(
          reviewers === 1 ? "continue" : "completed",
          "Evidence checked",
          reviewers === 1 ? "Add missing test" : "",
        ),
        sid2,
      );
    }
    workers++;
    if (workers === 1) assert.equal(session, null);
    else assert.equal(session, sid);
    save(sid);
    return success(output("completed", "Worker claims completion"));
  };
  const e = f.make();
  await e.accept(f.message(1, "!goal 1m Finish synthetic work"));
  await drain(e);
  assert.equal(workers, 2);
  assert.equal(reviewers, 2);
  assert.equal(f.store.session(thread), sid);
  assert.equal(f.store.get(id(1)).status, "succeeded");
  assert.equal(f.store.workflow(id(1)).step_count, 2);
  assert.equal(f.store.workflow(id(1)).elapsed_ms, 40);
  assert.match(f.calls[2].prompt, /Add missing test/);
  await e.accept(f.message(1, "!goal 1m Finish synthetic work"));
  await drain(e);
  assert.equal(f.calls.length, 4);
});

test("review failure preserves candidate and requires explicit recovery without rerunning worker", async (t) => {
  const f = await fixture(t);
  let workers = 0,
    reviewers = 0;
  f.deps.run = async (c, p, s, save, signal, o) => {
    f.clock.value += 10;
    if (o?.supervisor) {
      reviewers++;
      if (reviewers === 2) assert.match(p, /Inspect evidence/);
      return reviewers === 1
        ? { ok: false, output: "", error: "task_timeout", sessionId: sid2 }
        : success(review(), sid2);
    }
    workers++;
    save(sid);
    return success(output());
  };
  const e = f.make();
  await e.accept(f.message(1, "!loop 1m Synthetic goal"));
  await drain(e);
  assert.equal(f.store.get(id(1)).status, "interrupted");
  assert.equal(workers, 1);
  await e.kick();
  assert.equal(reviewers, 1);
  await e.accept(f.message(2, `!recover ${id(1)} Inspect evidence`));
  await drain(e);
  assert.equal(workers, 1);
  assert.equal(reviewers, 2);
  assert.equal(f.store.get(id(2)).status, "succeeded");
});

for (const bad of ["not JSON", review("blocked", "Need input", "", false)]) {
  test(`invalid review stops before another worker: ${bad.slice(0, 12)}`, async (t) => {
    const f = await fixture(t);
    let workers = 0;
    f.deps.run = async (c, p, s, save, signal, o) => {
      f.clock.value += 10;
      if (o?.supervisor) return success(bad, sid2);
      workers++;
      save(sid);
      return success(output());
    };
    const e = f.make();
    await e.accept(f.message(1, "!goal Synthetic goal"));
    await drain(e);
    await e.kick();
    assert.equal(workers, 1);
    assert.equal(f.store.get(id(1)).status, "interrupted");
  });
}

test("three supervisor reviews without progress block and surface an owner follow-up", async (t) => {
  const f = await fixture(t);
  let workers = 0;
  f.deps.run = async (c, p, s, save, signal, o) => {
    f.clock.value += 10;
    if (o?.supervisor)
      return success(
        review(
          "continue",
          "No new evidence",
          "Inspect the missing prerequisite",
          false,
        ),
        sid2,
      );
    workers++;
    save(sid);
    return success(output("continue", `Attempt ${workers}`, "Inspect next"));
  };
  const e = f.make();
  await e.accept(f.message(1, "!goal Synthetic stalled task"));
  await drain(e);
  assert.equal(workers, 3);
  assert.equal(f.store.get(id(1)).status, "interrupted");
  assert.equal(f.store.workflow(id(1)).state, "blocked");
  assert.ok(f.sent.some((x) => /progress|stalled/i.test(x.text)));
});

test("pause at worker boundary saves candidate; resume reviews it before any new work", async (t) => {
  const f = await fixture(t);
  let entered, release;
  const started = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  let workers = 0,
    reviewers = 0;
  f.deps.run = async (c, p, s, save, signal, o) => {
    f.clock.value += 10;
    if (o?.supervisor) {
      reviewers++;
      return success(review(), sid2);
    }
    workers++;
    save(sid);
    entered();
    await gate;
    return success(output());
  };
  const e = f.make();
  await e.accept(f.message(1, "!goal Synthetic pause goal"));
  await withinDeadline(started, "worker did not start");
  await e.accept(f.message(2, "!goal pause"));
  release();
  await drain(e);
  assert.equal(workers, 1);
  assert.equal(reviewers, 0);
  assert.equal(f.store.workflow(id(1)).state, "paused");
  await e.accept(f.message(3, "!goal resume"));
  await drain(e);
  assert.equal(workers, 1);
  assert.equal(reviewers, 1);
  assert.equal(f.store.get(id(1)).status, "succeeded");
});

test("goal controls reject foreign IDs and unauthorized senders without model calls", async (t) => {
  const f = await fixture(t);
  f.deps.ready = async () => false;
  const e = f.make();
  await e.accept(f.message(1, "!goal Synthetic goal"));
  await drain(e);
  await e.accept(f.message(2, `!goal stop ${id(1)}`, other));
  assert.equal(f.store.get(id(1)).status, "queued");
  assert.equal(
    await e.accept({
      ...f.message(3, "!goal stop"),
      authorId: "999999999999999999",
    }),
    false,
  );
  await e.accept(f.message(4, "!goal stop"));
  await drain(e);
  assert.equal(f.store.get(id(1)).status, "cancelled");
  assert.equal(f.calls.length, 0);
});

test("non-Codex bound goal is rejected without switching provider or queuing work", async (t) => {
  const f = await fixture(t);
  f.config.provider = "claude";
  const e = f.make();
  await e.accept(f.message(1, "!goal Synthetic task"));
  await drain(e);
  assert.equal(f.store.get(id(1)), undefined);
  assert.equal(f.calls.length, 0);
  assert.ok(f.sent.some((x) => /Codex/.test(x.text)));
});

test("worker exhausting the shared budget pauses with candidate and never starts reviewer", async (t) => {
  const f = await fixture(t);
  let workers = 0,
    reviewers = 0;
  f.deps.run = async (c, p, s, save, signal, o) => {
    if (o?.supervisor) {
      reviewers++;
      return success(review(), sid2);
    }
    workers++;
    assert.equal(c.timeoutMs, 60000);
    f.clock.value += 60000;
    save(sid);
    return success(output());
  };
  const e = f.make();
  await e.accept(f.message(1, "!goal 1m Synthetic budget task"));
  await drain(e);
  assert.equal(workers, 1);
  assert.equal(reviewers, 0);
  assert.equal(f.store.workflow(id(1)).state, "paused");
  assert.ok(f.store.goal(id(1)).pending_output);
  assert.equal(f.store.workflow(id(1)).elapsed_ms, 60000);
  await e.accept(f.message(2, "!goal resume"));
  await drain(e);
  assert.equal(workers, 1);
});

test("review budget is remaining shared time and other threads run between reviewed pairs", async (t) => {
  const f = await fixture(t);
  const order = [];
  let workers = 0,
    reviewers = 0;
  f.deps.run = async (c, p, s, save, signal, o) => {
    if (o?.supervisor) {
      reviewers++;
      order.push("review");
      assert.equal(c.timeoutMs, reviewers === 1 ? 50000 : 30000);
      f.clock.value += 10000;
      return success(
        review(
          reviewers === 1 ? "continue" : "completed",
          `Reviewed ${reviewers}`,
          reviewers === 1 ? "Finish evidence" : "",
        ),
        sid2,
      );
    }
    if (o?.workflow) {
      workers++;
      order.push("worker");
      f.clock.value += 10000;
      save(sid);
      return success(output("continue", `Progress ${workers}`, "Do next"));
    }
    order.push("other");
    f.clock.value += 10000;
    save(sid2);
    return success("Other done", sid2);
  };
  f.deps.ready = async () => false;
  const e = f.make();
  await e.accept(f.message(1, "!goal 1m Synthetic fairness"));
  await drain(e);
  await e.accept(f.message(2, "Other task", other));
  await drain(e);
  f.deps.ready = async () => true;
  await drain(e);
  assert.deepEqual(order, ["worker", "review", "other", "worker", "review"]);
  assert.equal(f.store.workflow(id(1)).elapsed_ms, 40000);
});

test("stop during review is honored before another worker and never reports a continued goal", async (t) => {
  const f = await fixture(t);
  let entered, release;
  const started = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  let workers = 0;
  f.deps.run = async (c, p, s, save, signal, o) => {
    f.clock.value += 10;
    if (o?.supervisor) {
      entered();
      await gate;
      return success(
        review("continue", "Useful evidence", "Next useful step"),
        sid2,
      );
    }
    workers++;
    save(sid);
    return success(output());
  };
  const e = f.make();
  await e.accept(f.message(1, "!goal Synthetic stop"));
  await withinDeadline(started, "review not started");
  await e.accept(f.message(2, "!goal stop"));
  release();
  await drain(e);
  assert.equal(workers, 1);
  assert.equal(f.store.get(id(1)).status, "cancelled");
  assert.ok(f.sent.some((x) => /stopped/.test(x.text)));
  assert.ok(
    !f.sent.some((x) => /supervisor accepted.*continuing/.test(x.text)),
  );
});

test("immediate cancellation blocks automatic review and does not accept late worker success", async (t) => {
  const f = await fixture(t);
  let entered;
  const started = new Promise((r) => (entered = r));
  let reviewers = 0;
  f.deps.run = async (c, p, s, save, signal, o) => {
    if (o?.supervisor) {
      reviewers++;
      return success(review(), sid2);
    }
    save(sid);
    entered();
    await new Promise((r) =>
      signal.addEventListener("abort", r, { once: true }),
    );
    f.clock.value += 10;
    return success(output());
  };
  const e = f.make();
  await e.accept(f.message(1, "!goal Synthetic cancel"));
  await withinDeadline(started, "worker not started");
  await e.accept(f.message(2, `!cancel ${id(1)}`));
  await drain(e);
  await e.kick();
  assert.equal(reviewers, 0);
  assert.equal(f.store.get(id(1)).status, "interrupted");
  assert.equal(f.store.workflow(id(1)).state, "blocked");
});

test("fresh supervised recovery passes retained images to worker and keeps reviewer image-free", async (t) => {
  const f = await fixture(t);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
    "base64",
  );
  f.store.enqueue(
    id(1),
    thread,
    "Inspect the synthetic screenshot",
    null,
    "codex",
    [{ data: png, mediaType: "image/png", sha256: imageDigest(png) }],
  );
  f.store.claim();
  f.store.finish(id(1), "interrupted", "", "task_timeout", 1000);
  let workers = 0,
    reviewers = 0;
  f.deps.run = async (c, p, s, save, signal, o) => {
    f.clock.value += 10;
    if (o?.supervisor) {
      reviewers++;
      assert.equal(o.images, undefined);
      return success(review(), sid2);
    }
    workers++;
    assert.equal(o.images?.length, 1);
    assert.deepEqual(await readFile(o.images[0]), png);
    save(sid);
    return success(output());
  };
  const e = f.make();
  await e.accept(f.message(2, "!goal 1m Inspect the synthetic screenshot"));
  await drain(e);
  assert.equal(f.store.get(id(2)).status, "succeeded");
  assert.equal(workers, 1);
  assert.equal(reviewers, 1);
});
