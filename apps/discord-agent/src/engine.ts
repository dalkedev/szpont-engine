import { performance } from "node:perf_hooks";
import {
  authorized,
  redact,
  SNOWFLAKE,
  type Config,
  type Incoming,
  type ProviderId,
} from "./config.js";
import { assemblePrompt, saveTranscript, syncMemory } from "./workspace.js";
import {
  downloadImages,
  materializeImages,
  type SavedImage,
} from "./images.js";
import {
  runnerReady,
  runTurn,
  supportsImages,
  type RunnerOptions,
  type TurnResult,
} from "./runner.js";
import { Store, type Job } from "./store.js";
import { COMMAND_HELP, providerLabel, threadStatus } from "./status.js";
import { threadQueue } from "./queue.js";
import {
  parseGoalCommand,
  goalWorkerPrompt,
  goalReviewPrompt,
  validateGoalReview,
} from "./goals.js";
import {
  parseWorkCommand,
  parseRecoveryCommand,
  validateWorkOutcome,
  workflowPrompt,
} from "./workflow.js";
export interface Transport {
  send(threadId: string, text: string): Promise<void>;
  typing(threadId: string): Promise<void>;
}
export interface Dependencies {
  ready: (config: Config) => Promise<boolean>;
  run: (
    config: Config,
    prompt: string,
    session: string | null,
    onSession: (id: string) => void,
    signal: AbortSignal,
    options?: RunnerOptions,
  ) => Promise<TurnResult>;
  persist: (config: Config, store: Store, threadId: string) => Promise<void>;
  sync: (config: Config, id: string) => Promise<string>;
  fetchImage?: typeof fetch;
  now?: () => number;
  /** Process-local elapsed time, independent of wall-clock timestamps. */
  monotonicNow?: () => number;
}
const defaults: Dependencies = {
  ready: runnerReady,
  run: runTurn,
  persist: saveTranscript,
  sync: syncMemory,
};
const commandUsage = new Map([
  ["!status", "!status"],
  ["!queue", "!queue"],
  ["!help", "!help"],
  ["!cancel", "!cancel <task ID>"],
  ["!new-session", "!new-session"],
  ["!result", "!result [task ID]"],
]);
export class Engine {
  private busy = false;
  private intakePending = 0;
  private intakeAbort = new AbortController();
  private accepting: Promise<unknown> = Promise.resolve();
  private completion: Promise<void> | undefined;
  private stopping = false;
  private active: Job | undefined;
  private abort: AbortController | undefined;
  authReady = false;
  private providerReadiness = new Map<ProviderId, boolean>();
  constructor(
    readonly config: Config,
    readonly store: Store,
    private transport: Transport,
    private deps: Dependencies = defaults,
  ) {}
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  private monotonicNow(): number {
    return this.deps.monotonicNow?.() ?? performance.now();
  }
  private executionSpent(started: number): number {
    // Persist integer milliseconds; clock corrections must neither refund nor
    // exhaust a workflow's active process budget. Queue/maintenance wait is out.
    return Math.max(1, Math.ceil(this.monotonicNow() - started));
  }
  private providerFor(threadId: string): ProviderId {
    return this.store.provider(threadId) ?? this.config.provider ?? "codex";
  }
  private async refreshReadiness(): Promise<void> {
    const providers = new Set<ProviderId>([
      this.config.provider ?? "codex",
      ...this.store.queuedProviders(),
      ...this.store.conversationProviders(),
    ]);
    const readiness = new Map<ProviderId, boolean>();
    await Promise.all(
      [...providers].map(async (provider) => {
        const ready = await this.deps
          .ready({ ...this.config, provider })
          .catch(() => false);
        readiness.set(provider, ready);
      }),
    );
    this.providerReadiness = readiness;
    // Compatibility metadata represents only the configured default, never
    // a claim that every runner or every thread is authenticated.
    this.authReady =
      this.providerReadiness.get(this.config.provider ?? "codex") ?? false;
  }
  private eligibleProviders(): ProviderId[] {
    return [...this.providerReadiness]
      .filter(([, ready]) => ready)
      .map(([provider]) => provider);
  }
  async accept(message: Incoming): Promise<boolean> {
    if (this.stopping || !authorized(message, this.config)) return false;
    this.intakePending++;
    // Image download is asynchronous. Preserve intake order and bound concurrent
    // download memory to one authorized batch per engine.
    const pending = this.accepting.then(() => this.acceptAuthorized(message));
    this.accepting = pending.catch(() => {});
    try {
      return await pending;
    } finally {
      this.intakePending--;
    }
  }
  private async acceptAuthorized(message: Incoming): Promise<boolean> {
    if (this.stopping) return false;
    if (this.store.get(message.id)) return true;
    const text = message.content.trim(),
      thread = message.channelId;
    const hasImages = message.attachments > 0;
    if (hasImages && !supportsImages(this.providerFor(thread))) {
      if (this.store.controlOnce(message.id))
        await this.notice(
          thread,
          `${providerLabel(this.providerFor(thread))} image input is not supported by this adapter. No images were downloaded and nothing was queued. Use a Codex thread or send a text-only request.`,
        );
      return true;
    }
    if (hasImages && text.startsWith("!") && !/^!work(?:\s|$)/.test(text)) {
      if (this.store.controlOnce(message.id))
        await this.notice(
          thread,
          "Commands cannot include attachments. Nothing was queued; send the command alone or attach images to a normal message or !work goal.",
        );
      return true;
    }
    const images = async (): Promise<SavedImage[]> =>
      hasImages
        ? downloadImages(
            message.images!,
            thread,
            this.deps.fetchImage,
            this.intakeAbort.signal,
            this.config.parentId,
          )
        : [];
    if (/^!(?:goal|loop)(?:\s|$)/.test(text)) {
      if (!this.store.controlOnce(message.id)) return true;
      let changed = false;
      try {
        const request = parseGoalCommand(text)!;
        if (request.kind === "start") {
          if (this.providerFor(thread) !== "codex") {
            await this.notice(
              thread,
              "Supervised goals currently require a Codex-bound thread. Nothing was queued; this thread's runner was not changed.",
            );
            return true;
          }
          const goal = redact(request.goal, this.config.token);
          const blocker = this.store.blockingJob(thread);
          changed = blocker
            ? this.store.recover(blocker.id, thread, message.id, {
                work: { goal, budgetMs: request.budgetMs, supervised: true },
              })
            : this.store.enqueueGoal(
                message.id,
                thread,
                goal,
                request.budgetMs,
                this.config.provider ?? "codex",
              );
          await this.notice(
            thread,
            `Supervised goal queued: ${message.id}. Worker and fresh supervisor share ${Math.round(request.budgetMs / 60000)} minutes and at most 32 reviewed steps. Use !goal status, pause, resume or stop. Existing authorization applies throughout.`,
          );
        } else {
          const goal = request.id
            ? this.store.goal(request.id)
            : this.store.latestGoal(thread);
          const job = goal ? this.store.get(goal.job_id) : undefined;
          if (!goal || !job || job.thread_id !== thread) {
            await this.notice(
              thread,
              "No supervised goal found in this thread. Nothing changed.",
            );
            return true;
          }
          if (request.kind === "status") {
            await this.notice(thread, this.goalStatus(job.id));
          } else {
            changed =
              request.kind === "resume"
                ? this.store.resumeGoal(job.id, thread)
                : this.store.requestGoalControl(job.id, thread, request.kind);
            await this.notice(
              thread,
              changed
                ? request.kind === "resume"
                  ? `Goal ${job.id} resumed with its remaining budget.`
                  : `Goal ${job.id}: ${request.kind} saved. A running process will finish its current bounded phase first; !cancel ${job.id} interrupts immediately and requires reconciliation.`
                : "This goal cannot take that control in its current state. Use !goal status; exhausted budgets need a fresh explicit !goal budget, and uncertain turns need reconciliation.",
            );
          }
        }
      } catch {
        await this.notice(
          thread,
          "Cannot apply this goal command. Use !goal [30m|2h] <goal>, !goal status|pause|resume|stop [task ID], or !loop with the same syntax. Resume needs a safely paused goal, remaining budget and an otherwise idle thread. Nothing new was queued.",
        );
      } finally {
        if (changed) void this.kick();
      }
      return true;
    }
    if (/^!recover(?:\s|$)/.test(text)) {
      if (!this.store.controlOnce(message.id)) return true;
      let changed = false;
      try {
        const request = parseRecoveryCommand(text)!;
        const target = request.id ?? this.store.blockingJob(thread)?.id;
        if (!target) {
          await this.notice(
            thread,
            "No failed or interrupted task is blocking this thread. Use !status or !recover <task ID> [instruction]. Nothing was queued.",
          );
          return true;
        }
        changed = this.store.recover(target, thread, message.id, {
          note: redact(request.note, this.config.token),
        });
        await this.notice(
          thread,
          changed
            ? `Manual recovery queued for ${target}. The saved runner will inspect prior state and action receipts first, then follow your recovery instruction. Queued follow-ups were replaced.`
            : "This recovery request is already saved. Use !status for its state.",
        );
      } catch {
        await this.notice(
          thread,
          "Cannot recover this task. Use !recover [task ID] [instruction] for a failed or interrupted task in this thread with remaining budget. To authorize fresh work after an exhausted budget, use !work 30m <goal>; the saved session and reconciliation checks are retained. Nothing was queued.",
        );
      } finally {
        if (changed) void this.kick();
      }
      return true;
    }
    if (/^!work(?:\s|$)/.test(text)) {
      if (!this.store.controlOnce(message.id)) return true;
      let request;
      try {
        request = parseWorkCommand(text);
      } catch {
        await this.notice(
          thread,
          "Usage: !work 30m <goal> or !work 2h <goal>. Use a budget from 1 minute to 2 hours and a nonempty goal. Nothing was queued.",
        );
        return true;
      }
      if (request) {
        let inserted;
        try {
          const blocker = this.store.blockingJob(thread);
          const goal = redact(request.goal, this.config.token);
          const savedImages = await images();
          inserted = blocker
            ? this.store.recover(blocker.id, thread, message.id, {
                work: { goal, budgetMs: request.budgetMs },
                images: savedImages,
              })
            : this.store.enqueueWorkflow(
                message.id,
                thread,
                goal,
                request.budgetMs,
                32,
                this.config.provider ?? "codex",
                savedImages,
              );
        } catch {
          await this.notice(
            thread,
            "Cannot queue this work session. Check queue capacity and attachments: use up to 4 PNG, JPEG or WebP images, at most 8 MiB each and 20 MiB total. Nothing was queued.",
          );
          return true;
        }
        try {
          if (inserted)
            await this.notice(
              thread,
              `Work session queued: ${message.id}. Active execution budget: ${Math.round(request.budgetMs / 60_000)} min; at most 32 completed steps. Queue and maintenance wait do not use this budget.${this.store.get(message.id)?.recovery_of ? " This fresh budget continues the saved session after reconciling prior actions; queued follow-ups were replaced." : ""}`,
            );
        } finally {
          void this.kick();
        }
        return true;
      }
    }
    if (text.startsWith("!")) {
      const [command, id, ...extra] = text.split(/\s+/);
      const usage = commandUsage.get(command ?? "");
      if (usage) {
        if (!this.store.controlOnce(message.id)) return true;
        const requiresId = command === "!cancel";
        const acceptsId = requiresId || command === "!result";
        const validArguments =
          extra.length === 0 &&
          (acceptsId
            ? id
              ? SNOWFLAKE.test(id)
              : !requiresId
            : id === undefined);
        if (!validArguments) {
          await this.notice(
            thread,
            `Usage: ${usage}. Use !help for command syntax. No action was taken and nothing was queued.`,
          );
          return true;
        }
        let changed = false;
        try {
          if (command === "!queue") {
            await this.notice(
              thread,
              threadQueue(
                this.store,
                thread,
                this.providerReadiness.get(this.providerFor(thread)) ?? false,
                this.providerFor(thread),
              ),
            );
            return true;
          }
          if (command === "!status") {
            await this.notice(
              thread,
              threadStatus(
                this.store,
                thread,
                this.providerReadiness.get(this.providerFor(thread)) ?? false,
                this.providerFor(thread),
              ),
            );
            return true;
          }
          if (command === "!help") {
            await this.notice(thread, COMMAND_HELP);
            return true;
          }
          if (command === "!cancel") {
            if (
              id &&
              this.active?.id === id &&
              this.active.thread_id === thread &&
              this.store.get(id)?.status === "running"
            ) {
              this.abort?.abort();
              await this.notice(
                thread,
                "Stopping the current process. Actions already taken may require reconciliation.",
              );
            } else {
              changed = Boolean(id && this.store.cancel(id, thread));
              await this.notice(
                thread,
                changed
                  ? "Queued task cancelled."
                  : "No queued task found in this thread.",
              );
            }
            return true;
          }
          if (command === "!new-session") {
            this.store.resetSession(thread);
            changed = true;
            await this.notice(
              thread,
              `The next message starts a new ${providerLabel(this.providerFor(thread))} session. The thread keeps its runner binding. History is retained; queued messages were cancelled.`,
            );
            return true;
          }
          if (command === "!result") {
            const job = id ? this.store.get(id) : this.store.recent(thread)[0];
            await this.notice(
              thread,
              job && job.thread_id === thread
                ? `${job.id}: ${job.status}\n\n${job.result ?? "No saved response."}`
                : "Task not found.",
            );
            return true;
          }
        } catch {
          await this.notice(
            thread,
            "Cannot perform this operation. Use !status for task IDs and state; only interrupted or failed tasks in this thread with remaining workflow budget can be recovered. For a paused work session, start a new explicit !work budget.",
          );
          return true;
        } finally {
          if (changed) void this.kick();
        }
      }
      if (this.store.controlOnce(message.id))
        await this.notice(
          thread,
          "Unknown command. Use !help for command syntax. Nothing was queued.",
        );
      return true;
    }
    const prompt = redact(
      message.content.trim()
        ? message.content
        : "Please inspect the attached image(s).",
      this.config.token,
    );
    let inserted: boolean;
    try {
      inserted = this.store.enqueue(
        message.id,
        thread,
        prompt,
        null,
        this.config.provider ?? "codex",
        await images(),
      );
    } catch {
      await this.notice(
        thread,
        "Cannot queue this message. Check queue capacity and attachments: use up to 4 PNG, JPEG or WebP images, at most 8 MiB each and 20 MiB total. Nothing was queued.",
      );
      return true;
    }
    try {
      if (inserted)
        await this.notice(
          thread,
          `Queued: ${message.id}.${this.providerReadiness.get(this.providerFor(thread)) ? "" : ` ${this.providerFor(thread) === "opencode" ? "OpenCode local prerequisites are unverified" : `${providerLabel(this.providerFor(thread))} login is unverified`}; this message remains in the durable queue.`}${this.store.queue(thread).items.some((item) => item.reason === "blocked_thread") ? " This thread is blocked after an earlier task; this message cannot run yet. Use !queue for the blocker and recovery options." : " Use !queue to inspect waiting tasks."}`,
        );
    } finally {
      // Durable insertion is authoritative; failed notices/export cannot unqueue it.
      void this.kick();
    }
    return true;
  }
  private async send(thread: string, text: string): Promise<void> {
    await this.transport.send(thread, redact(text, this.config.token));
  }
  /** Progress notices are best effort, unlike final delivery receipts. */
  private async notice(thread: string, text: string): Promise<void> {
    try {
      await this.send(thread, text);
    } catch {
      console.log(
        JSON.stringify({ event: "progress_notice", status: "unavailable" }),
      );
    }
  }
  /** At most two due threads per pass; errors retry durably, never via a model. */
  private async maintain(): Promise<void> {
    for (const effect of this.store.pendingEffects(this.now(), 2)) {
      const { thread_id: thread, generation } = effect;
      if (effect.exported_generation < generation) {
        try {
          await this.deps.persist(this.config, this.store, thread);
          this.store.completeEffect(thread, generation, "transcript");
        } catch {
          this.store.failEffect(
            thread,
            generation,
            "transcript_export_failed",
            this.now(),
          );
          continue;
        }
      }
      try {
        const label = this.store.recent(thread)[0]?.id ?? thread;
        const result = await this.deps.sync(this.config, label);
        if (result === "blocked") {
          this.store.failEffect(
            thread,
            generation,
            "memory_sync_blocked",
            this.now(),
          );
        } else if (result === "clean" || result === "committed") {
          this.store.completeEffect(thread, generation, "memory");
        } else {
          this.store.failEffect(
            thread,
            generation,
            "memory_sync_failed",
            this.now(),
          );
        }
      } catch {
        this.store.failEffect(
          thread,
          generation,
          "memory_sync_failed",
          this.now(),
        );
      }
    }
  }
  async kick(): Promise<void> {
    if (this.busy) return this.completion;
    if (this.stopping) return;
    this.busy = true;
    let complete!: () => void;
    this.completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    try {
      // Auth/inference availability is independent of readable history and Git sync.
      await this.maintain();
      await this.notify();
      await this.refreshReadiness();
      let job: Job | undefined;
      while (
        !this.stopping &&
        (job = this.store.claim(this.eligibleProviders()))
      ) {
        this.active = job;
        this.abort = new AbortController();
        let typing: NodeJS.Timeout | undefined;
        let imageFiles:
          | Awaited<ReturnType<typeof materializeImages>>
          | undefined;
        let spent = 0;
        let started: number | undefined;
        let committed = false;
        try {
          await this.notice(job.thread_id, `Working on ${job.id}.`);
          const thread = job.thread_id;
          typing = setInterval(() => {
            void this.transport.typing(thread).catch(() => {});
          }, 8000);
          const runnerConfig = { ...this.config, provider: job.provider };
          let prompt = await assemblePrompt(runnerConfig, job);
          const workflow = this.store.workflow(job.id);
          const remaining = workflow
            ? workflow.budget_ms - workflow.elapsed_ms
            : this.config.timeoutMs;
          if (remaining <= 0) throw new Error("workflow budget invariant");
          if (workflow)
            prompt = workflowPrompt(prompt, {
              goal: workflow.goal,
              step: workflow.step_count + 1,
              remainingMs: remaining,
              stepBudgetMs: Math.max(
                1,
                Math.min(this.config.timeoutMs, remaining),
              ),
              lastSummary: workflow.last_summary,
              nextAction: workflow.next_action,
            });
          const savedImages = this.store.images(job.id);
          if (savedImages.length) {
            if (!supportsImages(job.provider))
              throw new Error("unsupported image input");
            imageFiles = await materializeImages(
              this.config.stateDir,
              savedImages,
            );
          }
          if (this.store.goal(job.id)) {
            await this.runGoal(
              job,
              runnerConfig,
              prompt,
              this.abort.signal,
              imageFiles?.paths,
            );
            committed = true;
          } else {
            started = this.monotonicNow();
            const result = await this.deps.run(
              workflow
                ? {
                    ...runnerConfig,
                    timeoutMs: Math.max(
                      1,
                      Math.min(this.config.timeoutMs, remaining),
                    ),
                  }
                : runnerConfig,
              prompt,
              this.store.session(job.thread_id),
              (id) => this.store.setSession(job!.thread_id, id, job!.provider),
              this.abort.signal,
              {
                ...(workflow ? { workflow: true } : {}),
                ...(imageFiles ? { images: imageFiles.paths } : {}),
              },
            );
            spent = this.executionSpent(started);
            started = undefined;
            if (result.ok && workflow) {
              let outcome;
              try {
                outcome = validateWorkOutcome(
                  redact(result.output, this.config.token),
                );
              } catch {
                this.store.finish(
                  job.id,
                  "interrupted",
                  "",
                  "invalid_workflow_output",
                  spent,
                );
                committed = true;
              }
              if (outcome) {
                const checkpoint = this.store.checkpoint(
                  job.id,
                  outcome,
                  spent,
                );
                committed = true;
                if (checkpoint.continued)
                  await this.notice(
                    job.thread_id,
                    `Work session ${job.id}: step ${workflow.step_count + 1} checkpoint saved. Continuing after other eligible threads.\n\n${outcome.summary}`,
                  );
              }
            } else {
              this.store.finish(
                job.id,
                result.ok
                  ? "succeeded"
                  : result.error === "task_timeout" ||
                      result.error === "owner_or_service_cancelled"
                    ? "interrupted"
                    : "failed",
                redact(result.output, this.config.token),
                result.error,
                spent,
              );
              committed = true;
            }
          }
        } catch {
          if (started !== undefined) spent = this.executionSpent(started);
          // A failure after committing a checkpoint/finish must not overwrite it.
          if (!committed && this.store.get(job.id)?.status === "running")
            this.store.finish(
              job.id,
              "interrupted",
              "",
              "engine_turn_interrupted",
              spent,
            );
        } finally {
          if (typing) clearInterval(typing);
          await imageFiles?.cleanup().catch(() => {
            console.log(
              JSON.stringify({ event: "image_cleanup", status: "failed" }),
            );
          });
          this.abort = undefined;
          this.active = undefined;
        }
        await this.maintain();
        await this.notify();
        await this.refreshReadiness();
      }
    } catch {
      console.log(JSON.stringify({ event: "engine_tick", status: "blocked" }));
    } finally {
      this.busy = false;
      this.completion = undefined;
      complete();
    }
  }
  private goalStatus(id: string): string {
    const goal = this.store.goal(id)!,
      workflow = this.store.workflow(id)!,
      job = this.store.get(id)!;
    return [
      `Supervised goal ${id}: ${workflow.state}; task ${job.status}; control ${goal.control}.`,
      `Phase: ${goal.pending_output ? "saved worker candidate awaiting supervisor review" : "main worker"}.`,
      `Reviewed steps: ${workflow.step_count}/${workflow.max_steps}; remaining shared budget: ${Math.max(0, Math.ceil((workflow.budget_ms - workflow.elapsed_ms) / 1000))} seconds; stalled reviews: ${goal.stalled_count}/3.`,
      ...(workflow.last_summary
        ? [`Last accepted review: ${workflow.last_summary}`]
        : []),
      ...(workflow.next_action ? [`Follow-up: ${workflow.next_action}`] : []),
      "Use !goal pause|resume|stop [task ID]. Pause/stop take effect at a successful phase boundary. !cancel interrupts immediately; stopping does not undo effects.",
    ].join("\n");
  }
  private async runGoal(
    job: Job,
    runnerConfig: Config,
    prompt: string,
    signal: AbortSignal,
    images?: readonly string[],
  ): Promise<void> {
    let started: number | undefined;
    const finishFailure = (
      output: string,
      error: string,
      elapsed: number,
    ): void => {
      this.store.finish(
        job.id,
        error === "task_timeout" || error === "owner_or_service_cancelled"
          ? "interrupted"
          : "failed",
        redact(output, this.config.token),
        error,
        elapsed,
      );
    };
    try {
      let goal = this.store.goal(job.id)!;
      let workflow = this.store.workflow(job.id)!;
      if (this.store.applyGoalControl(job.id)) return;
      if (!goal.pending_output) {
        const remaining = workflow.budget_ms - workflow.elapsed_ms;
        started = this.monotonicNow();
        const worker = await this.deps.run(
          {
            ...runnerConfig,
            timeoutMs: Math.max(1, Math.min(this.config.timeoutMs, remaining)),
          },
          goalWorkerPrompt(prompt),
          this.store.session(job.thread_id),
          (id) => this.store.setSession(job.thread_id, id, job.provider),
          signal,
          { workflow: true, ...(images?.length ? { images } : {}) },
        );
        const elapsed = this.executionSpent(started);
        started = undefined;
        if (!worker.ok || signal.aborted) {
          finishFailure(
            worker.output,
            signal.aborted
              ? "owner_or_service_cancelled"
              : (worker.error ?? "goal_worker_failed"),
            elapsed,
          );
          return;
        }
        let candidate;
        try {
          candidate = validateWorkOutcome(
            redact(worker.output, this.config.token),
          );
        } catch {
          this.store.finish(
            job.id,
            "interrupted",
            "",
            "invalid_workflow_output",
            elapsed,
          );
          return;
        }
        this.store.saveGoalWorker(job.id, candidate, elapsed);
      }
      if (this.store.applyGoalControl(job.id)) return;
      goal = this.store.goal(job.id)!;
      workflow = this.store.workflow(job.id)!;
      const remaining = workflow.budget_ms - workflow.elapsed_ms;
      const candidate = validateWorkOutcome(goal.pending_output!);
      await this.notice(
        job.thread_id,
        `Goal ${job.id}: worker candidate saved; independent supervisor is reviewing step ${workflow.step_count + 1}.`,
      );
      started = this.monotonicNow();
      const review = await this.deps.run(
        {
          ...runnerConfig,
          timeoutMs: Math.max(1, Math.min(this.config.timeoutMs, remaining)),
        },
        goalReviewPrompt({
          goal: workflow.goal,
          candidate,
          lastSummary: workflow.last_summary,
          nextAction: workflow.next_action,
          step: workflow.step_count + 1,
          remainingMs: Math.min(this.config.timeoutMs, remaining),
          ...(job.recovery_of ? { recoveryContext: job.prompt } : {}),
        }),
        null,
        () => {},
        signal,
        { supervisor: true },
      );
      const elapsed = this.executionSpent(started);
      started = undefined;
      if (!review.ok || signal.aborted) {
        finishFailure(
          review.output,
          signal.aborted
            ? "owner_or_service_cancelled"
            : (review.error ?? "goal_supervisor_failed"),
          elapsed,
        );
        return;
      }
      let outcome;
      try {
        outcome = validateGoalReview(redact(review.output, this.config.token));
      } catch {
        this.store.finish(
          job.id,
          "interrupted",
          "",
          "invalid_goal_review",
          elapsed,
        );
        return;
      }
      const { progress, ...checkpoint } = outcome;
      const result = this.store.reviewGoal(
        job.id,
        checkpoint,
        progress,
        elapsed,
      );
      if (result.continued)
        await this.notice(
          job.thread_id,
          `Goal ${job.id}: supervisor accepted step ${workflow.step_count + 1}; continuing after other eligible threads.\n\n${outcome.summary}`,
        );
    } catch {
      if (this.store.get(job.id)?.status === "running")
        this.store.finish(
          job.id,
          "interrupted",
          "",
          "goal_phase_interrupted",
          started === undefined ? 0 : this.executionSpent(started),
        );
    }
  }
  private async notify(): Promise<void> {
    let job: Job | undefined;
    while ((job = this.store.pendingNotification())) {
      this.store.notification(job.id, "sending");
      try {
        const workflow = this.store.workflow(job.id);
        const recovery =
          workflow &&
          (workflow.elapsed_ms >= workflow.budget_ms ||
            workflow.step_count >= workflow.max_steps)
            ? "This uncertain turn exhausted its work budget or step cap. Use !status and !result to inspect it. Authorize a fresh !work 30m <goal> to reconcile state and continue the saved session. History and prior spent budget are retained."
            : `Use !recover ${job.id} to reconcile state and continue.`;
        const supervised = this.store.goal(job.id);
        const text =
          supervised && job.status === "cancelled"
            ? `Goal ${job.id}: stopped. Saved history and any worker candidate are retained; stopping does not undo actions already taken.`
            : supervised && workflow?.state === "paused"
              ? `Goal ${job.id}: paused (${job.error_code ?? "budget ceiling"}). The goal is not marked complete. Use !goal status; !goal resume keeps remaining budget, or an explicit new !goal budget authorizes further work.\n\n${job.result ?? ""}`
              : workflow?.state === "paused"
                ? `Work session ${job.id}: paused after a verified checkpoint (${job.error_code ?? "budget exhausted"}). The overall goal is not marked complete. This thread is not blocked; a fresh explicit !work 30m <goal> budget can continue its saved session.\n\n${job.result ?? ""}`
                : job.status === "succeeded"
                  ? job.result || "Completed without a text response."
                  : `Task ${job.id}: ${job.status} (${job.error_code ?? "unknown"}). Partial actions may have occurred. No automatic retry. ${recovery}\n\n${job.result ?? ""}`;
        const goal = this.store.goal(job.id);
        await this.send(
          job.thread_id,
          goal && workflow?.next_action
            ? `${text}\n\nFollow-up: ${workflow.next_action}`
            : text,
        );
        this.store.notification(job.id, "sent");
      } catch {
        this.store.notification(job.id, "ambiguous");
      }
    }
  }
  stop(): void {
    this.stopping = true;
    this.intakeAbort.abort();
    this.abort?.abort();
  }
  isBusy(): boolean {
    return this.busy || this.intakePending > 0;
  }
}
