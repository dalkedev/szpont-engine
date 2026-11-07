import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexArgs, runCodex } from "../dist/codex.js";
import { runTurn } from "../dist/runner.js";

const session = "01a12345-1234-7456-8456-123456789abc";
const review = {
  outcome: "completed",
  summary: "Synthetic evidence checked",
  nextAction: "",
  progress: true,
};
async function fixture(t, behavior = "success") {
  const root = await mkdtemp(join(tmpdir(), "szpont-supervisor-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["workspace", "state", "artifacts", "codex", "browser"])
    await mkdir(join(root, name));
  const capture = join(root, "capture.json");
  const cli = join(root, "synthetic-codex.mjs");
  await writeFile(
    cli,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
let prompt = "";
process.stdin.on("data", data => { prompt += data; });
process.stdin.on("end", () => {
  const argv = process.argv.slice(2);
  const schemaIndex = argv.indexOf("--output-schema");
  const schema = schemaIndex < 0 ? null : JSON.parse(readFileSync(argv[schemaIndex + 1], "utf8"));
  writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv, prompt, schema }));
  console.log(JSON.stringify({ type: "thread.started", thread_id: ${JSON.stringify(session)} }));
  if (${JSON.stringify(behavior)} === "invalid-json") {
    console.log("not-json");
    return;
  }
  if (${JSON.stringify(behavior)} === "failure") {
    console.log(JSON.stringify({ type: "turn.failed" }));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(JSON.stringify(review))} } }));
  console.log(JSON.stringify({ type: "turn.completed" }));
});
`,
  );
  await chmod(cli, 0o700);
  return {
    capture,
    config: {
      token: "synthetic-test-token",
      provider: "codex",
      workspace: join(root, "workspace"),
      stateDir: join(root, "state"),
      artifactsDir: join(root, "artifacts"),
      codexHome: join(root, "codex"),
      browserDir: join(root, "browser"),
      codexBin: cli,
      claudeBin: cli,
      opencodeBin: cli,
      timeoutMs: 5000,
    },
  };
}

// Removing the read-only/schema supervisor branch must fail at the launched CLI boundary.
test("supervisor launches a fresh Codex session with the strict review schema and read-only filesystem", async (t) => {
  const f = await fixture(t);
  const observed = [];
  const result = await runTurn(
    f.config,
    "Review synthetic candidate",
    null,
    (id) => observed.push(id),
    undefined,
    { supervisor: true },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.output), review);
  assert.deepEqual(observed, [session]);
  const { argv, prompt, schema } = JSON.parse(
    await readFile(f.capture, "utf8"),
  );
  assert.equal(prompt, "Review synthetic candidate");
  assert.equal(argv.includes("resume"), false);
  assert.equal(argv.includes(session), false);
  assert.deepEqual(argv.slice(-1), ["-"]);
  assert.equal(argv[argv.indexOf("--sandbox") + 1], "read-only");
  assert.equal(argv.includes("--add-dir"), false);
  assert.equal(
    argv.some((value) =>
      value.includes("sandbox_workspace_write.network_access"),
    ),
    false,
  );
  assert.match(
    argv[argv.indexOf("--output-schema") + 1],
    /supervisor-output\.schema\.json$/,
  );
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "outcome",
    "summary",
    "nextAction",
    "progress",
  ]);
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "nextAction",
    "outcome",
    "progress",
    "summary",
  ]);
  assert.deepEqual(schema.properties.outcome.enum, [
    "continue",
    "completed",
    "blocked",
  ]);
  assert.equal(schema.properties.progress.type, "boolean");
  assert.equal(schema.properties.summary.minLength, 1);
  assert.equal(schema.properties.summary.maxLength, 4000);
  assert.equal(schema.properties.nextAction.maxLength, 4000);
});

// A validation regression must fail before the fake CLI creates its capture file.
for (const [name, resume, extra] of [
  ["resumed session", session, {}],
  ["empty non-null session", "", {}],
  ["image input", null, { images: ["/synthetic.png"] }],
  ["worker workflow mode", null, { workflow: true }],
])
  test(`supervisor rejects ${name} before spawning`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      runCodex(f.config, "Synthetic", resume, () => {}, undefined, {
        supervisor: true,
        ...extra,
      }),
      /supervisor/i,
    );
    await assert.rejects(readFile(f.capture), { code: "ENOENT" });
  });

// Dispatching another provider, or falling back to Codex, must create a capture and fail this test.
for (const provider of ["claude", "opencode"])
  test(`supervisor rejects ${provider} without dispatch or fallback`, async (t) => {
    const f = await fixture(t);
    const seen = [];
    const result = await runTurn(
      { ...f.config, provider },
      "Synthetic",
      null,
      (id) => seen.push(id),
      undefined,
      { supervisor: true },
    );
    assert.deepEqual(result, {
      ok: false,
      output: "",
      error: "unsupported_supervisor_provider",
      sessionId: null,
    });
    assert.deepEqual(seen, []);
    await assert.rejects(readFile(f.capture), { code: "ENOENT" });
  });

// Failed/malformed review subprocess events cannot become a successful review.
for (const [behavior, error] of [
  ["failure", "codex_turn_failed"],
  ["invalid-json", "invalid_codex_json"],
])
  test(`supervisor ${behavior} fails closed`, async (t) => {
    const f = await fixture(t, behavior);
    const result = await runTurn(
      f.config,
      "Synthetic",
      null,
      () => {},
      undefined,
      { supervisor: true },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, error);
    assert.equal(result.output, "");
  });

// Accidentally applying the read-only branch to worker turns breaks normal operation.
test("ordinary Codex launch arguments keep the writable worker contract", async (t) => {
  const f = await fixture(t);
  const prefix = [
    "--no-daemon",
    "-C",
    f.config.workspace,
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
    "--search",
    "-c",
    "sandbox_workspace_write.network_access=true",
    "--add-dir",
    f.config.artifactsDir,
    "--add-dir",
    f.config.browserDir,
    "exec",
  ];
  assert.deepEqual(codexArgs(f.config, null), [
    ...prefix,
    "--json",
    "--color",
    "never",
    "-",
  ]);
  assert.deepEqual(codexArgs(f.config, session), [
    ...prefix,
    "resume",
    "--json",
    session,
    "-",
  ]);
});
