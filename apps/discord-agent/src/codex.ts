import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { MAX_IMAGES } from "./images.js";
import {
  childEnvironment,
  MAX_OUTPUT,
  SESSION_ID,
  redact,
  type Config,
} from "./config.js";
import type { TurnResult } from "./runner.js";
export type { TurnResult } from "./runner.js";
export interface CodexOptions {
  workflow?: boolean;
  supervisor?: boolean;
  images?: readonly string[];
}
const workflowSchema = fileURLToPath(
  new URL("../schemas/workflow-output.schema.json", import.meta.url),
);
const supervisorSchema = fileURLToPath(
  new URL("../schemas/supervisor-output.schema.json", import.meta.url),
);
export function codexArgs(
  config: Config,
  sessionId: string | null,
  options: CodexOptions = {},
): string[] {
  if (
    options.supervisor &&
    (sessionId !== null || options.workflow || options.images?.length)
  )
    throw new Error(
      "Supervisor requires a fresh session without workflow or images",
    );
  if (sessionId && !SESSION_ID.test(sessionId))
    throw new Error("Invalid resume session");
  const images = options.images ?? [];
  if (
    images.length > MAX_IMAGES ||
    images.some((path) => !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path))
  )
    throw new Error("Invalid image input paths");
  const imageFlags = images.flatMap((path) => ["--image", path]);
  const flags = [
    "--no-daemon",
    "-C",
    config.workspace,
    "--sandbox",
    options.supervisor ? "read-only" : "workspace-write",
    "--ask-for-approval",
    "never",
    "--search",
    ...(options.supervisor
      ? []
      : [
          "-c",
          "sandbox_workspace_write.network_access=true",
          "--add-dir",
          config.artifactsDir,
          "--add-dir",
          config.browserDir,
        ]),
    "exec",
  ];
  const schema = options.supervisor
    ? ["--output-schema", supervisorSchema]
    : options.workflow
      ? ["--output-schema", workflowSchema]
      : [];
  return sessionId
    ? [
        ...flags,
        "resume",
        "--json",
        ...schema,
        ...imageFlags,
        ...(images.length ? ["--"] : []),
        sessionId,
        "-",
      ]
    : [
        ...flags,
        "--json",
        "--color",
        "never",
        ...schema,
        ...imageFlags,
        ...(images.length ? ["--"] : []),
        "-",
      ];
}
function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null) return;
  try {
    if (child.pid && process.platform !== "win32")
      process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    /* Already stopped. */
  }
}
export async function loginReady(config: Config): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(config.codexBin, ["login", "status"], {
      cwd: config.workspace,
      env: childEnvironment(config),
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 10_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
export function runCodex(
  config: Config,
  prompt: string,
  sessionId: string | null,
  onSession: (id: string) => void,
  signal?: AbortSignal,
  options: CodexOptions = {},
): Promise<TurnResult> {
  if (Buffer.byteLength(prompt) > 65_536)
    throw new Error("Assembled prompt exceeds limit");
  return new Promise((resolve) => {
    const child = spawn(
      config.codexBin,
      codexArgs(config, sessionId, options),
      {
        cwd: config.workspace,
        env: childEnvironment(config),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    const decoder = new StringDecoder("utf8");
    let buffer = "",
      bytes = 0,
      stderrBytes = 0,
      output = "",
      observed = sessionId,
      error: string | null = null,
      completed = false,
      settled = false;
    let hardStop: NodeJS.Timeout | undefined;
    const stop = (code: string): void => {
      if (!error) error = code;
      terminate(child);
      hardStop ??= setTimeout(() => {
        try {
          if (child.pid && process.platform !== "win32")
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }, 3000);
    };
    const onAbort = (): void => stop("owner_or_service_cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop("task_timeout"), config.timeoutMs);
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardStop) clearTimeout(hardStop);
      signal?.removeEventListener("abort", onAbort);
      if (!observed && !error) error = "missing_session_id";
      resolve({
        ok: ok && !error && completed,
        output: redact(output.slice(0, MAX_OUTPUT), config.token),
        error: error ?? (ok && completed ? null : "codex_turn_failed"),
        sessionId: observed,
      });
    };
    const event = (line: string): void => {
      if (!line.trim()) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        stop("invalid_codex_json");
        return;
      }
      if (!value || typeof value !== "object") return;
      const e = value as Record<string, unknown>;
      if (e.type === "thread.started") {
        if (
          typeof e.thread_id !== "string" ||
          !SESSION_ID.test(e.thread_id) ||
          (sessionId && e.thread_id !== sessionId)
        ) {
          stop("session_identity_mismatch");
          return;
        }
        observed = e.thread_id;
        try {
          onSession(observed);
        } catch {
          stop("session_persistence_failed");
        }
      }
      if (e.type === "item.completed" && e.item && typeof e.item === "object") {
        const item = e.item as Record<string, unknown>;
        if (item.type === "agent_message" && typeof item.text === "string") {
          if (item.text.length > MAX_OUTPUT) {
            stop("agent_output_limit");
            return;
          }
          // Keep the latest agent message, not command output or hidden reasoning.
          output = item.text;
        }
      }
      if (e.type === "turn.completed") completed = true;
      // Graceful shutdown diagnostics cannot replace the guard that stopped
      // this process, especially timeout/cancellation used by recovery policy.
      if (!error && (e.type === "turn.failed" || e.type === "error"))
        error = "codex_turn_failed";
    };
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 8 * 1024 * 1024) {
        stop("event_stream_limit");
        return;
      }
      buffer += decoder.write(data);
      if (Buffer.byteLength(buffer) > 512 * 1024 && !buffer.includes("\n")) {
        stop("event_line_limit");
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        event(line);
      }
    });
    // Never persist or log stderr: CLI/auth/upstream diagnostics may contain secrets.
    child.stderr.on("data", (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes > 256 * 1024) stop("stderr_limit");
    });
    child.once("error", () => {
      error ??= "codex_process_unavailable";
      finish(false);
    });
    child.once("close", (code) => {
      buffer += decoder.end();
      if (buffer.trim()) event(buffer);
      finish(code === 0);
    });
    child.stdin.on("error", () => {
      /* close/error handlers resolve the turn. */
    });
    if (signal?.aborted) stop("owner_or_service_cancelled");
    else child.stdin.end(prompt);
  });
}
