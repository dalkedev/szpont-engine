import { loginReady, runCodex } from "./codex.js";
import { claudeReady, runClaude } from "./claude.js";
import { opencodeReady, runOpenCode } from "./opencode.js";
import type { Config } from "./config.js";

export interface TurnResult {
  ok: boolean;
  output: string;
  error: string | null;
  sessionId: string | null;
}
export interface RunnerOptions {
  workflow?: boolean;
  supervisor?: boolean;
  images?: readonly string[];
}

export function supportsImages(provider: Config["provider"]): boolean {
  return (provider ?? "codex") === "codex";
}

// Dispatch only to the persisted provider. Errors never trigger another runner.
export function runnerReady(config: Config): Promise<boolean> {
  switch (config.provider ?? "codex") {
    case "codex":
      return loginReady(config);
    case "claude":
      return claudeReady(config);
    case "opencode":
      return opencodeReady(config);
  }
}
export function runTurn(
  config: Config,
  prompt: string,
  sessionId: string | null,
  onSession: (id: string) => void,
  signal?: AbortSignal,
  options: RunnerOptions = {},
): Promise<TurnResult> {
  if (options.supervisor && (config.provider ?? "codex") !== "codex")
    return Promise.resolve({
      ok: false,
      output: "",
      error: "unsupported_supervisor_provider",
      sessionId,
    });
  if (options.images?.length && !supportsImages(config.provider))
    return Promise.resolve({
      ok: false,
      output: "",
      error: "unsupported_image_input",
      sessionId,
    });
  switch (config.provider ?? "codex") {
    case "codex":
      return runCodex(config, prompt, sessionId, onSession, signal, options);
    case "claude":
      return runClaude(config, prompt, sessionId, onSession, signal, options);
    case "opencode":
      return runOpenCode(config, prompt, sessionId, onSession, signal, options);
  }
}
