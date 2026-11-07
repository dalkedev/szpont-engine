import type { JobStatus, Store } from "./store.js";
import type { ProviderId } from "./config.js";

export const providerLabel = (provider: ProviderId): string =>
  ({ codex: "Codex", claude: "Claude Code", opencode: "OpenCode" })[provider];

interface ConversationState {
  blocked_reason: string | null;
  has_session: number;
}
interface Counts {
  queued: number;
  running: number;
  recovering: number;
}
interface RecentTask {
  id: string;
  status: JobStatus;
  notification: string;
}

export const COMMAND_HELP = [
  "Send a normal message to queue a task in this thread.",
  "!status — show this thread's queue, worker, work-session and maintenance state.",
  "!queue — list this thread's queued/running task IDs in accepted order and explain why each task is waiting; no model call.",
  "!work 30m <goal> or !work 2h <goal> — run checkpointed steps with 1–120 minutes of active execution, at most 32 completed steps. Other threads get turns between steps.",
  "!goal [30m|2h] <goal> / !loop [30m|2h] <goal> — continue under a fresh Codex supervisor; default 30 minutes shared execution, at most 32 reviewed steps.",
  "!goal status|pause|resume|stop [task ID] — inspect or control this thread's supervised goal. Pause/stop wait for a successful phase boundary; resume keeps the remaining budget.",
  "!result [task ID] — read the saved response (latest task by default).",
  "!cancel <task ID> — cancel a queued task or stop this thread's active process.",
  "!recover [task ID] [instruction] — inspect prior actions and continue a failed or interrupted task; the current thread's blocking task is selected when the ID is omitted. Replaces queued follow-ups in this thread.",
  "!new-session — clear this thread's session and cancel its queued tasks; its runner binding and history are retained.",
  "!help — show these commands.",
  "A verified work-session checkpoint can pause at its budget or step cap without blocking this thread. An explicit !work budget in a blocked thread first reconciles prior actions and continues its saved session. Interrupted or uncertain turns are never retried automatically.",
  "One worker runs tasks across all threads. A queued task is not running yet. Stopping a process does not undo actions already taken.",
].join("\n");

/** Current-thread metadata only; bounded checkpoints are already token-redacted. */
export function threadStatus(
  store: Store,
  threadId: string,
  authReady: boolean,
  provider: ProviderId = store.provider(threadId) ?? "codex",
): string {
  const conversation = store.db
    .prepare(
      "SELECT blocked_reason,session_id IS NOT NULL AS has_session FROM conversations WHERE thread_id=?",
    )
    .get(threadId) as ConversationState | undefined;
  const counts = store.db
    .prepare(
      `SELECT COALESCE(SUM(status='queued'),0) queued,
        COALESCE(SUM(status='running'),0) running,
        COALESCE(SUM(status IN('queued','running') AND recovery_of IS NOT NULL),0) recovering
        FROM jobs WHERE thread_id=?`,
    )
    .get(threadId) as unknown as Counts;
  const occupied = Boolean(
    store.db.prepare("SELECT 1 FROM jobs WHERE status='running' LIMIT 1").get(),
  );
  const recent = store.db
    .prepare(
      `SELECT j.id,j.status,j.notification FROM jobs j
      JOIN job_acceptance accepted ON accepted.job_id=j.id
      WHERE j.thread_id=? ORDER BY accepted.sequence DESC LIMIT 8`,
    )
    .all(threadId) as unknown as RecentTask[];
  const uncertain = store.db
    .prepare(
      `SELECT j.id FROM jobs j JOIN job_acceptance accepted ON accepted.job_id=j.id
      WHERE j.thread_id=? AND j.notification='ambiguous' ORDER BY accepted.sequence DESC LIMIT 1`,
    )
    .get(threadId) as { id: string } | undefined;
  const currentWorkflow = store.db
    .prepare(
      `SELECT w.job_id FROM workflows w JOIN jobs j ON j.id=w.job_id
      JOIN job_acceptance accepted ON accepted.job_id=j.id
      WHERE j.thread_id=? ORDER BY (j.status='running') DESC,(w.state='active') DESC,
        CASE WHEN w.state='active' THEN accepted.sequence END ASC,accepted.sequence DESC LIMIT 1`,
    )
    .get(threadId) as { job_id: string } | undefined;
  const workflow = currentWorkflow
    ? store.workflow(currentWorkflow.job_id)
    : undefined;
  const goal = workflow ? store.goal(workflow.job_id) : undefined;
  const effect = store.effect(threadId);
  const maintenance =
    !effect ||
    (effect.exported_generation >= effect.generation &&
      effect.synced_generation >= effect.generation)
      ? "Maintenance: transcript and memory Git sync are up to date."
      : effect.last_error === "transcript_export_failed"
        ? "Maintenance: transcript export is degraded; a durable retry is pending. Task state is saved independently."
        : effect.last_error === "memory_sync_blocked"
          ? "Maintenance: transcript export is saved; memory Git sync is blocked. Clear conflicting staged files or unsafe paths on the host; durable retries continue."
          : effect.last_error === "memory_sync_failed"
            ? "Maintenance: transcript export is saved; memory Git sync is degraded and will retry."
            : "Maintenance: transcript export or memory Git sync is pending. Task state is saved independently.";
  const blocked = conversation?.blocked_reason;
  const lines = [
    provider === "opencode"
      ? authReady
        ? "OpenCode: local prerequisites and credential entry present; remote authentication is untested."
        : "OpenCode: local prerequisites unverified; queued work waits. Remote authentication is untested."
      : authReady
        ? `${providerLabel(provider)}: authenticated.`
        : `${providerLabel(provider)}: login unverified; queued work waits until authentication is confirmed.`,
    blocked
      ? blocked === "failed" || blocked === "interrupted"
        ? `Thread: blocked after ${blocked === "interrupted" ? "an interrupted" : "a failed"} task. Queued messages cannot run until you choose recovery or a new session.`
        : "Thread: blocked; owner action is required before queued messages can run."
      : "Thread: not blocked.",
    `Session: ${conversation?.has_session ? "saved for this thread" : "not started"}.`,
    `Queue in this thread: ${counts.queued} queued; ${counts.running} running.`,
    occupied
      ? counts.running > 0
        ? "Worker: running a task in this thread."
        : "Worker: busy in another thread. This thread's queued tasks are waiting."
      : "Worker: idle. Queued tasks have not started yet.",
    maintenance,
    ...(workflow
      ? [
          `Work session ${workflow.job_id}: ${workflow.state}; ${workflow.step_count}/${workflow.max_steps} completed steps; ${Math.max(0, Math.ceil((workflow.budget_ms - workflow.elapsed_ms) / 1000))} seconds of active budget remain.`,
          ...(workflow.last_summary
            ? [
                `Last ${goal ? "accepted supervisor review" : "verified checkpoint"}: ${workflow.last_summary}`,
              ]
            : []),
          ...(goal
            ? [
                `Supervisor: ${goal.pending_output ? "worker candidate saved; review pending" : "waiting for the next worker result"}; control ${goal.control}; ${goal.stalled_count}/3 consecutive stalled reviews.`,
                ...(workflow.next_action
                  ? [`Follow-up: ${workflow.next_action}`]
                  : []),
              ]
            : []),
          ...(workflow.state === "paused"
            ? [
                goal
                  ? "The supervised goal is not marked complete. Use !goal resume if budget remains and this thread is idle; otherwise authorize a fresh !goal budget."
                  : "The work-session goal is not marked complete. A fresh explicit !work budget can continue this thread's saved session.",
              ]
            : []),
        ]
      : []),
    "Recent tasks:",
    ...(recent.length
      ? recent.map(
          (job) =>
            `${job.id}: ${job.status}${job.notification === "ambiguous" ? " (response delivery uncertain)" : ""}`,
        )
      : ["No tasks in this thread."]),
  ];
  if (uncertain)
    lines.push(
      `Response delivery is uncertain for task ${uncertain.id}. Use !result ${uncertain.id} to read its saved response; do not repeat the task just to resend a response.`,
    );
  if (counts.recovering > 0)
    lines.push(
      "Next: a manual recovery is already queued or running in this thread. Wait for its result; do not queue another recovery.",
    );
  else if (blocked && counts.running === 0) {
    const blocker = store.blockingJob(threadId);
    const blockedWorkflow = blocker ? store.workflow(blocker.id) : undefined;
    const needsBudget =
      blockedWorkflow &&
      (blockedWorkflow.state === "paused" ||
        blockedWorkflow.elapsed_ms >= blockedWorkflow.budget_ms ||
        blockedWorkflow.step_count >= blockedWorkflow.max_steps);
    lines.push(
      blocker && !needsBudget
        ? `Next: use !recover ${blocker.id} to inspect prior actions and continue. Recovery replaces queued follow-ups in this thread. Use !new-session instead to cancel queued work and start fresh; history is retained.`
        : blocker
          ? "Next: use !work 30m <goal> to authorize a fresh budget, reconcile prior actions and continue the saved session. Queued follow-ups are replaced and prior spent budget is retained. Use !new-session only if you want a fresh session."
          : "Next: use !new-session to clear this thread's block and start fresh. This cancels queued work; history is retained. No failed or interrupted task is eligible for recovery.",
    );
  } else if (counts.running > 0)
    lines.push(
      "Next: wait for the current task or use !cancel <task ID> to stop it.",
    );
  else if (!authReady && counts.queued > 0)
    lines.push(
      provider === "opencode"
        ? "Next: verify OpenCode configuration and local credentials on the host. Remote authentication is untested; these tasks remain saved in the queue."
        : `Next: complete ${providerLabel(provider)} login on the host. These tasks remain saved in the queue.`,
    );
  else if (counts.queued > 0)
    lines.push(
      "Next: wait for the worker to claim this thread's queued tasks.",
    );
  else lines.push("Next: send a normal message to queue a task, or use !help.");
  return lines.join("\n");
}
