import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  chmod,
  writeFile,
  readFile,
  readdir,
  stat,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { authorized } from "../dist/config.js";
import { Engine } from "../dist/engine.js";
import { Store, SCHEMA_VERSION } from "../dist/store.js";
import { DiscordTransport } from "../dist/discord.js";
import { runTurn } from "../dist/runner.js";
import { runClaude } from "../dist/claude.js";
import { runOpenCode } from "../dist/opencode.js";
import { runCodex, codexArgs } from "../dist/codex.js";
import { saveTranscript } from "../dist/workspace.js";
import {
  downloadImages,
  imageDigest,
  materializeImages,
  cleanupStaleImages,
  validateImage,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
} from "../dist/images.js";

// Synthetic, public 1x1 PNG. Never use personal screenshots or Discord URLs here.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
  "base64",
);
const thread = "5555000000000000001";
const session = "01a12345-1234-7456-8456-123456789abc";
const id = (n) => String(5555000000000001000n + BigInt(n));
const saved = (data = png, mediaType = "image/png") => ({
  data,
  mediaType,
  sha256: imageDigest(data),
});
const attachment = (patch = {}) => ({
  id: id(100),
  url: `https://cdn.discordapp.com/attachments/${thread}/${id(100)}/synthetic.png?ex=synthetic`,
  size: png.length,
  contentType: "image/png",
  ...patch,
});
const message = (config, patch = {}) => ({
  id: id(1),
  guildId: config.guildId,
  authorId: config.ownerId,
  bot: false,
  webhook: false,
  channelId: thread,
  parentId: config.parentId,
  thread: true,
  content: "Inspect this synthetic image.",
  attachments: 1,
  images: [attachment()],
  ...patch,
});
const response = (bytes = png, headers = {}) =>
  new Response(bytes, {
    headers: { "content-type": "image/png", ...headers },
  });
async function fixture(t, provider = "codex", dependencies = {}) {
  const root = await mkdtemp(join(tmpdir(), "szpont-images-"));
  for (const name of [
    "workspace/agent/conversations",
    "workspace/agent/memory",
    "state",
    "artifacts",
    "codex",
    "browser",
  ])
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  await chmod(join(root, "state"), 0o700);
  const config = {
    token: "synthetic-test-token",
    guildId: "111111111111111111",
    ownerId: "222222222222222222",
    botId: "333333333333333333",
    parentId: "444444444444444444",
    provider,
    workspace: join(root, "workspace"),
    stateDir: join(root, "state"),
    artifactsDir: join(root, "artifacts"),
    codexHome: join(root, "codex"),
    browserDir: join(root, "browser"),
    codexBin: "unused-synthetic-cli",
    timeoutMs: 1000,
  };
  let store = new Store(join(config.stateDir, "agent.sqlite"));
  const sent = [],
    fetched = [];
  const deps = {
    ready: async () => false,
    persist: async () => {},
    sync: async () => "clean",
    run: async () => {
      throw new Error("No real model calls");
    },
    fetchImage: async (url, options) => {
      fetched.push({ url: String(url), options });
      return response();
    },
    ...dependencies,
  };
  const engine = new Engine(
    config,
    store,
    {
      send: async (_id, text) => {
        sent.push(text);
      },
      typing: async () => {},
    },
    deps,
  );
  t.after(async () => {
    engine.stop();
    await engine.kick();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    config,
    sent,
    fetched,
    engine,
    deps,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new Store(join(config.stateDir, "agent.sqlite"));
      return store;
    },
  };
}

test("Discord gateway preserves image metadata without fetching it", async (t) => {
  const f = await fixture(t);
  const transport = new DiscordTransport(f.config);
  t.after(() => transport.close());
  let incoming;
  transport.onMessage(async (value) => {
    incoming = value;
  });
  const image = attachment();
  transport.client.emit("messageCreate", {
    id: id(1),
    guildId: f.config.guildId,
    author: { id: f.config.ownerId, bot: false },
    channelId: thread,
    channel: { isThread: () => true, parentId: f.config.parentId },
    content: "",
    webhookId: null,
    attachments: new Map([[image.id, image]]),
  });
  assert.equal(incoming.attachments, 1);
  assert.deepEqual(incoming.images, [image]);
  assert.equal(incoming.content, "");
  assert.equal(f.fetched.length, 0);
});

test("owner, guild, forum thread and message checks happen before image fetch or persistence", async (t) => {
  const f = await fixture(t);
  assert.equal(authorized(message(f.config, { content: "" }), f.config), true);
  for (const patch of [
    { guildId: null },
    { guildId: id(9) },
    { authorId: id(9) },
    { bot: true },
    { webhook: true },
    { thread: false },
    { parentId: id(9) },
    { channelId: "invalid" },
    { id: "invalid" },
    { content: "a".repeat(8001) },
    { images: [] },
    { attachments: -1 },
    { attachments: 0 },
  ])
    assert.equal(
      await f.engine.accept(message(f.config, patch)),
      false,
      JSON.stringify(patch),
    );
  assert.equal(f.fetched.length, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM jobs").get().n, 0);
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM job_images").get().n,
    0,
  );
  assert.deepEqual(f.sent, []);
});

for (const provider of ["claude", "opencode"])
  test(`${provider} attachment intake and direct runner calls reject explicitly before network or process execution`, async (t) => {
    const f = await fixture(t, provider);
    await f.engine.accept(message(f.config));
    assert.equal(f.fetched.length, 0);
    assert.equal(f.store.get(id(1)), undefined);
    assert.match(f.sent[0], /image input is not supported/);
    const result = await runTurn(
      f.config,
      "Synthetic",
      null,
      () => {},
      undefined,
      { images: ["/synthetic.png"] },
    );
    assert.equal(result.error, "unsupported_image_input");
    assert.equal(result.ok, false);
    const direct = await (provider === "claude" ? runClaude : runOpenCode)(
      f.config,
      "Synthetic",
      null,
      () => {},
      undefined,
      { images: ["/synthetic.png"] },
    );
    assert.equal(direct.error, "unsupported_image_input");
    // Existing thread identity wins over a changed deployment default.
    f.config.provider = "codex";
    f.store.enqueue(id(3), thread, "Existing provider binding", null, provider);
    await f.engine.accept(message(f.config, { id: id(4) }));
    assert.equal(f.fetched.length, 0);
    assert.equal(f.store.get(id(4)), undefined);
  });

test("control commands never fetch or silently discard attached images", async (t) => {
  const f = await fixture(t);
  for (const [index, content] of [
    "!status",
    "!recover " + id(2),
    "!unknown",
    "!work invalid",
  ].entries())
    await f.engine.accept(message(f.config, { id: id(index + 1), content }));
  assert.equal(f.fetched.length, 0);
  assert.equal(f.store.get(id(1)), undefined);
  assert.ok(f.sent.every((text) => /Nothing was queued/.test(text)));
});

test("only complete bounded PNG, JPEG or WebP batches enter the download boundary", async () => {
  let fetched = 0;
  const fetchImage = async () => {
    fetched++;
    return response();
  };
  for (const images of [
    [],
    Array(5).fill(attachment()),
    [attachment({ size: 0 })],
    [attachment({ size: 1.5 })],
    [attachment({ size: MAX_IMAGE_BYTES + 1 })],
    [attachment({ contentType: "image/svg+xml" })],
    [attachment({ contentType: null })],
    [attachment({ contentType: "text/plain" })],
    Array(3).fill(attachment({ size: MAX_IMAGE_BYTES })),
  ])
    await assert.rejects(downloadImages(images, thread, fetchImage));
  assert.equal(fetched, 0);
  assert.equal(MAX_TOTAL_IMAGE_BYTES, 20 * 1024 * 1024);
});

test("Discord CDN allowlist rejects SSRF, credentials, foreign attachment paths and redirect responses", async () => {
  let fetched = 0;
  const fetchImage = async (_url, options) => {
    fetched++;
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/private" },
    });
  };
  for (const url of [
    "http://cdn.discordapp.com/attachments/" +
      thread +
      "/" +
      id(100) +
      "/x.png",
    "https://127.0.0.1/x.png",
    "https://[::1]/x.png",
    "file:///private/image.png",
    "data:image/png;base64,AA==",
    "https://cdn.discordapp.com.evil.invalid/x.png",
    "https://cdn.discordapp.com@evil.invalid/x.png",
    `https://user:secret@cdn.discordapp.com/attachments/${thread}/${id(100)}/x.png`,
    `https://cdn.discordapp.com:444/attachments/${thread}/${id(100)}/x.png`,
    `https://cdn.discordapp.com/attachments/${id(999)}/${id(100)}/x.png`,
    `https://cdn.discordapp.com/attachments/${thread}/${id(999)}/x.png`,
    `https://cdn.discordapp.com/attachments/${thread}/${id(100)}/x.png#fragment`,
    `https://media.discordapp.net/external/arbitrary/https/localhost/x.png`,
  ])
    await assert.rejects(
      downloadImages([attachment(), attachment({ url })], thread, fetchImage),
    );
  assert.equal(fetched, 0, "entire batch is URL-validated before any request");
  await assert.rejects(downloadImages([attachment()], thread, fetchImage));
  assert.equal(fetched, 1, "redirect never becomes a second request");
});

test("forum-starter downloads allow only an explicit verified private parent in addition to the thread", async (t) => {
  const f = await fixture(t);
  let fetched = 0;
  const fetchImage = async () => {
    fetched++;
    return response();
  };
  const starter = attachment({
    url: `https://cdn.discordapp.com/attachments/${f.config.parentId}/${id(100)}/synthetic.png`,
  });
  // The reusable helper remains thread-only unless its caller supplies a parent.
  await assert.rejects(downloadImages([starter], thread, fetchImage));
  assert.equal(fetched, 0);
  const [image] = await downloadImages(
    [starter],
    thread,
    fetchImage,
    undefined,
    f.config.parentId,
  );
  assert.deepEqual(Buffer.from(image.data), png);
  assert.equal(fetched, 1);
  for (const [url, threadId, parentId] of [
    [
      `https://cdn.discordapp.com/attachments/${id(999)}/${id(100)}/synthetic.png`,
      thread,
      f.config.parentId,
    ],
    [starter.url, thread, id(999)],
    [attachment().url, thread, "invalid-parent"],
    [attachment().url, "invalid-thread", f.config.parentId],
    [
      `https://cdn.discordapp.com/attachments/${f.config.parentId}/${id(999)}/synthetic.png`,
      thread,
      f.config.parentId,
    ],
  ])
    await assert.rejects(
      downloadImages(
        [attachment({ url })],
        threadId,
        fetchImage,
        undefined,
        parentId,
      ),
    );
  assert.equal(
    fetched,
    1,
    "foreign or malformed scopes fail before another request",
  );
  await f.engine.accept(message(f.config, { images: [starter] }));
  await f.engine.kick();
  assert.equal(f.fetched.length, 1);
  assert.deepEqual(Buffer.from(f.store.images(id(1))[0].data), png);
  await f.engine.accept(
    message(f.config, { id: id(2), parentId: id(999), images: [starter] }),
  );
  assert.equal(
    f.fetched.length,
    1,
    "foreign message parent cannot authorize a staged CDN upload",
  );
  assert.equal(f.store.get(id(2)), undefined);
});

test("HTTP MIME, declared length, actual streamed bytes and image signature must agree", async () => {
  for (const [image, makeResponse] of [
    [attachment(), () => response(png, { "content-type": "image/jpeg" })],
    [
      attachment(),
      () => response(png, { "content-length": String(png.length + 1) }),
    ],
    [attachment(), () => response(png, { "content-length": "invalid" })],
    [attachment(), () => response(png.subarray(0, -1))],
    [attachment(), () => response(Buffer.concat([png, Buffer.from([0])]))],
    [attachment({ size: 10 }), () => response(Buffer.from("not a PNG!"))],
    [attachment(), () => new Response(null, { status: 404 })],
  ])
    await assert.rejects(
      downloadImages([image], thread, async () => makeResponse()),
    );
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.alloc(100));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    downloadImages(
      [attachment({ size: 2 })],
      thread,
      async () =>
        new Response(stream, { headers: { "content-type": "image/png" } }),
    ),
  );
  assert.equal(cancelled, true);
});

test("image signatures reject MIME spoofing and excessive decoded dimensions", () => {
  validateImage(png, "image/png");
  assert.throws(() => validateImage(png, "image/jpeg"), /signature/);
  assert.throws(() => validateImage(png, "image/svg+xml"), /type/);
  const large = Buffer.from(png);
  large.writeUInt32BE(20000, 16);
  assert.throws(() => validateImage(large, "image/png"), /dimensions/);
  large.writeUInt32BE(10000, 16);
  large.writeUInt32BE(10000, 20);
  assert.throws(() => validateImage(large, "image/png"), /dimensions/);
  const animated = Buffer.from(png);
  animated.write("acTL", 37);
  assert.throws(() => validateImage(animated, "image/png"), /Animated/);
  const jpeg = Buffer.from("ffd8ffc00008080001000100ffd9", "hex");
  validateImage(jpeg, "image/jpeg");
  const webp = Buffer.alloc(30);
  webp.write("RIFF");
  webp.writeUInt32LE(22, 4);
  webp.write("WEBPVP8X", 8);
  webp.writeUInt32LE(10, 16);
  validateImage(webp, "image/webp");
  webp[20] = 2;
  assert.throws(() => validateImage(webp, "image/webp"), /signature/);
  webp[20] = 0;
  webp.writeUInt32LE(21, 4);
  assert.throws(() => validateImage(webp, "image/webp"), /signature/);
});

test("image-only intake persists bytes atomically and redelivery never downloads again", async (t) => {
  const f = await fixture(t);
  await f.engine.accept(message(f.config, { content: "" }));
  await f.engine.kick();
  assert.equal(f.store.get(id(1)).status, "queued");
  assert.equal(
    f.store.get(id(1)).prompt,
    "Please inspect the attached image(s).",
  );
  assert.deepEqual(Buffer.from(f.store.images(id(1))[0].data), png);
  assert.equal(f.store.images(id(1))[0].sha256, imageDigest(png));
  await f.engine.accept(message(f.config));
  assert.equal(f.fetched.length, 1);
  await saveTranscript(f.config, f.store, thread);
  const transcript = await readFile(
    join(f.config.workspace, `agent/conversations/${thread}.md`),
    "utf8",
  );
  assert.match(transcript, /1 image attachment/);
  assert.doesNotMatch(
    transcript,
    /discordapp|synthetic.png|base64|\.turn-images-/,
  );
});

test("image download failure never queues a partial batch or leaks URLs into notices", async (t) => {
  let count = 0;
  const f = await fixture(t, "codex", {
    fetchImage: async () => {
      if (++count === 2) throw new Error("private URL diagnostics");
      return response();
    },
  });
  await f.engine.accept(
    message(f.config, { attachments: 2, images: [attachment(), attachment()] }),
  );
  assert.equal(f.store.get(id(1)), undefined);
  assert.equal(f.store.imageCount(id(1)), 0);
  assert.match(f.sent[0], /Nothing was queued/);
  assert.doesNotMatch(f.sent[0], /private URL|discordapp/);
  assert.deepEqual(
    (await readdir(f.config.stateDir)).filter((name) =>
      name.startsWith(".turn-images-"),
    ),
    [],
  );
});

test("asynchronous image admission preserves FIFO", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, "codex", {
    fetchImage: async () => {
      await gate;
      return response();
    },
  });
  const first = f.engine.accept(message(f.config));
  const second = f.engine.accept(
    message(f.config, {
      id: id(2),
      attachments: 0,
      images: [],
      content: "Later text",
    }),
  );
  assert.equal(f.engine.isBusy(), true);
  release();
  await Promise.all([first, second]);
  assert.equal(f.engine.isBusy(), false);
  assert.equal(f.store.claim().id, id(1));
  assert.equal(f.store.get(id(2)).status, "queued");
});

test("shutdown aborts the active download and skips pending intake without persisting partial work", async (t) => {
  let began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  const f = await fixture(t, "codex", {
    fetchImage: async (_url, { signal }) => {
      began();
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  const first = f.engine.accept(message(f.config));
  const second = f.engine.accept(message(f.config, { id: id(2) }));
  await started;
  assert.equal(f.engine.isBusy(), true);
  f.engine.stop();
  assert.equal(await f.engine.accept(message(f.config, { id: id(3) })), false);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results, [true, false]);
  assert.equal(f.engine.isBusy(), false);
  assert.equal(f.store.get(id(1)), undefined);
  assert.equal(f.store.get(id(2)), undefined);
  assert.equal(f.store.imageCount(id(1)), 0);
});

test("schema 3 upgrades to image storage without changing existing jobs or sessions", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(id(1), thread, "Preserved synthetic text");
  f.store.setSession(thread, session);
  const before = f.store.get(id(1));
  f.store.db.exec(
    "DROP TABLE goal_reviews; DROP TABLE goals; DROP TABLE job_images; PRAGMA user_version=3;",
  );
  f.reopen();
  assert.equal(
    f.store.db.prepare("PRAGMA user_version").get().user_version,
    SCHEMA_VERSION,
  );
  assert.deepEqual(f.store.get(id(1)), before);
  assert.equal(f.store.session(thread), session);
  assert.deepEqual(f.store.images(id(1)), []);
  assert.deepEqual(f.store.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("failed image migration leaves schema 3 data and version intact", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(id(1), thread, "Preserved migration failure");
  f.store.db.exec(
    "DROP TABLE goal_reviews; DROP TABLE goals; DROP TABLE job_images; PRAGMA user_version=3; CREATE TABLE job_images(collision TEXT);",
  );
  assert.throws(
    () => new Store(join(f.config.stateDir, "agent.sqlite")),
    /already exists/,
  );
  assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 3);
  assert.equal(f.store.get(id(1)).prompt, "Preserved migration failure");
});

test("queue reopen, startup interruption and manual recovery retain original image order and bytes", async (t) => {
  const f = await fixture(t);
  f.store.enqueue(id(1), thread, "Synthetic image task", null, "codex", [
    saved(),
    saved(),
  ]);
  f.store.claim();
  f.store.setSession(thread, session);
  f.reopen();
  assert.equal(f.store.recoverStartup(), 1);
  assert.equal(f.store.recover(id(1), thread, id(2)), true);
  assert.equal(f.store.images(id(2)).length, 2);
  for (const image of f.store.images(id(2)))
    assert.deepEqual(Buffer.from(image.data), png);
  assert.equal(f.store.session(thread), session);
  assert.equal(f.store.get(id(2)).recovery_of, id(1));
  assert.equal(f.store.claim().id, id(2));
  assert.deepEqual(f.store.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("invalid bytes or unsupported provider roll back both image and job admission", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () =>
      f.store.enqueue(id(1), thread, "Bad digest", null, "codex", [
        { ...saved(), sha256: "0".repeat(64) },
      ]),
    /digest/,
  );
  assert.throws(
    () =>
      f.store.enqueue(id(1), thread, "Wrong runner", null, "claude", [saved()]),
    /support/,
  );
  assert.equal(f.store.get(id(1)), undefined);
  assert.equal(f.store.provider(thread), null);
  assert.equal(f.store.imageCount(id(1)), 0);
});

for (const outcome of ["success", "failure", "throw", "cancel"])
  test(`temporary images are private during the ${outcome} turn and removed afterward`, async (t) => {
    let paths;
    const f = await fixture(t, "codex", {
      ready: async () => true,
      run: async (_config, prompt, _session, saveSession, signal, options) => {
        paths = options.images;
        assert.equal(paths.length, 1);
        assert.deepEqual(await readFile(paths[0]), png);
        assert.equal((await stat(paths[0])).mode & 0o777, 0o600);
        assert.equal((await stat(dirname(paths[0]))).mode & 0o777, 0o700);
        assert.match(prompt, /untrusted data/);
        saveSession(session);
        if (outcome === "throw") throw new Error("Synthetic process error");
        if (outcome === "cancel") {
          f.engine.stop();
          assert.equal(signal.aborted, true);
        }
        return {
          ok: outcome === "success",
          output: "Synthetic result",
          error:
            outcome === "cancel"
              ? "owner_or_service_cancelled"
              : outcome === "success"
                ? null
                : "synthetic_failure",
          sessionId: session,
        };
      },
    });
    f.store.enqueue(id(1), thread, "Synthetic caption", null, "codex", [
      saved(),
    ]);
    await f.engine.kick();
    assert.ok(paths);
    await assert.rejects(stat(paths[0]), { code: "ENOENT" });
    assert.deepEqual(
      (await readdir(f.config.stateDir)).filter((name) =>
        name.startsWith(".turn-images-"),
      ),
      [],
    );
    assert.equal(
      f.store.imageCount(id(1)),
      1,
      "durable evidence retained for recovery",
    );
    assert.equal(
      f.store.get(id(1)).status,
      outcome === "success"
        ? "succeeded"
        : outcome === "failure"
          ? "failed"
          : "interrupted",
    );
  });

test("workflow images survive continuation and native session resume without refetch", async (t) => {
  const seen = [];
  const f = await fixture(t, "codex", {
    ready: async () => true,
    run: async (_config, _prompt, resume, saveSession, _signal, options) => {
      seen.push({ resume, paths: options.images });
      assert.equal(options.workflow, true);
      assert.deepEqual(await readFile(options.images[0]), png);
      saveSession(session);
      return {
        ok: true,
        output: JSON.stringify({
          outcome: seen.length === 1 ? "continue" : "completed",
          summary: "Synthetic checkpoint",
          nextAction: seen.length === 1 ? "Complete review" : "",
        }),
        error: null,
        sessionId: session,
      };
    },
  });
  await f.engine.accept(
    message(f.config, { content: "!work 1m Inspect this image" }),
  );
  await f.engine.kick();
  assert.equal(f.fetched.length, 1);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].resume, null);
  assert.equal(seen[1].resume, session);
  assert.notDeepEqual(seen[0].paths, seen[1].paths);
  assert.equal(f.store.get(id(1)).status, "succeeded");
  assert.equal(f.store.workflow(id(1)).step_count, 2);
  for (const item of seen)
    await assert.rejects(stat(item.paths[0]), { code: "ENOENT" });
});

test("materialization refuses digest corruption and public state permissions without leftover files", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    materializeImages(f.config.stateDir, [
      { ...saved(), sha256: "0".repeat(64) },
    ]),
    /digest/,
  );
  await chmod(f.config.stateDir, 0o755);
  await assert.rejects(
    materializeImages(f.config.stateDir, [saved()]),
    /private/,
  );
  await chmod(f.config.stateDir, 0o700);
  assert.deepEqual(
    (await readdir(f.config.stateDir)).filter((name) =>
      name.startsWith(".turn-images-"),
    ),
    [],
  );
});

test("startup cleans abandoned private image directories and ignores unrelated files or directory aliases", async (t) => {
  const f = await fixture(t);
  const files = await materializeImages(f.config.stateDir, [saved()]);
  const unrelated = join(f.config.stateDir, ".turn-images-operator-notes");
  await mkdir(unrelated);
  await writeFile(join(unrelated, "keep"), "Synthetic operator data");
  const external = join(f.root, "external");
  await mkdir(external);
  await writeFile(join(external, "keep"), "Synthetic external data");
  await symlink(external, join(f.config.stateDir, ".turn-images-ABC123"));
  await cleanupStaleImages(f.config.stateDir);
  await assert.rejects(stat(files.paths[0]), { code: "ENOENT" });
  assert.equal(
    await readFile(join(unrelated, "keep"), "utf8"),
    "Synthetic operator data",
  );
  assert.equal(
    await readFile(join(external, "keep"), "utf8"),
    "Synthetic external data",
  );
});

test("Codex initial and resumed subprocesses receive actual local image inputs, not prompt text paths", async (t) => {
  const f = await fixture(t);
  const cli = join(f.root, "synthetic-codex.mjs");
  const capture = join(f.root, "capture.json");
  await writeFile(
    cli,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
let prompt = "";
process.stdin.on("data", data => { prompt += data; });
process.stdin.on("end", () => {
  const argv = process.argv.slice(2);
  const images = argv.flatMap((value, index) => value === "--image" ? [readFileSync(argv[index + 1]).toString("base64")] : []);
  writeFileSync(${JSON.stringify(capture)}, JSON.stringify({argv, images, prompt}));
  console.log(JSON.stringify({type:"thread.started",thread_id:${JSON.stringify(session)}}));
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Synthetic image reviewed"}}));
  console.log(JSON.stringify({type:"turn.completed"}));
});
`,
  );
  await chmod(cli, 0o700);
  const files = await materializeImages(f.config.stateDir, [saved(), saved()]);
  try {
    for (const resume of [null, session]) {
      const result = await runCodex(
        { ...f.config, codexBin: cli },
        "Synthetic owner caption",
        resume,
        () => {},
        undefined,
        { images: files.paths },
      );
      assert.equal(result.ok, true);
      const recorded = JSON.parse(await readFile(capture, "utf8"));
      assert.deepEqual(recorded.images, [
        png.toString("base64"),
        png.toString("base64"),
      ]);
      assert.equal(recorded.prompt, "Synthetic owner caption");
      assert.equal(recorded.argv.includes("resume"), resume !== null);
      assert.ok(
        recorded.argv.indexOf("--image") > recorded.argv.indexOf("exec"),
      );
      assert.deepEqual(
        recorded.argv.slice(-2),
        resume ? [session, "-"] : ["--", "-"],
      );
      assert.doesNotMatch(recorded.prompt, /\.turn-images-/);
    }
    assert.throws(
      () => codexArgs(f.config, null, { images: ["relative.png"] }),
      /paths/,
    );
    assert.throws(
      () => codexArgs(f.config, null, { images: ["/bad\nimage.png"] }),
      /paths/,
    );
    assert.throws(
      () =>
        codexArgs(f.config, null, { images: Array(5).fill(files.paths[0]) }),
      /paths/,
    );
  } finally {
    await files.cleanup();
  }
});

for (const replace of [false, true]) {
  test(`fresh recovery work ${replace ? "uses newly attached" : "preserves saved"} images atomically`, async (t) => {
    const f = await fixture(t);
    f.store.enqueueWorkflow(
      id(1),
      thread,
      "Original image goal",
      60_000,
      32,
      "codex",
      [saved(), saved()],
    );
    f.store.claim();
    f.store.setSession(thread, session);
    f.store.finish(id(1), "interrupted", "Uncertain", "task_timeout", 60_000);
    f.store.recover(id(1), thread, id(2), {
      work: { goal: "Reconcile then finish", budgetMs: 120_000 },
      images: replace ? [saved()] : [],
    });
    assert.equal(f.store.images(id(2)).length, replace ? 1 : 2);
    assert.deepEqual(Buffer.from(f.store.images(id(2))[0].data), png);
    assert.equal(f.store.session(thread), session);
    assert.equal(f.store.workflow(id(1)).elapsed_ms, 60_000);
    assert.equal(f.store.workflow(id(2)).elapsed_ms, 0);
    assert.deepEqual(f.store.db.prepare("PRAGMA foreign_key_check").all(), []);
  });
}
