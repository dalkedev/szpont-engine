# Supervised goals and continuous work

Status: proposed implementation for review; no deployment. Date: 2026-11-07.

## Intent and constraints

An authenticated owner can start a fixed goal from a Discord thread and leave the
engine to continue useful steps until completion, a blocker, a pause or a budget
ceiling. A main agent may coordinate available subagents. A separate fresh Codex
session reviews each worker result before accepting completion or continuing.
This adds no authority beyond the original request. Provider/model settings,
credentials, public destinations and live deployment remain unchanged.

## Approaches

An unbounded in-process retry loop is small but loses recovery state and can
repeat uncertain external effects. A second always-running daemon duplicates
queue and lifecycle machinery. The implementation choice is a supervisor phase
on the existing durable bounded workflow: worker, saved candidate checkpoint,
fresh reviewer, accepted checkpoint, fair queue yield. This preserves existing
recovery, cancellation, time accounting and cross-thread scheduling.

## Owner interface

`!goal [30m|2h] <goal>` and `!loop [30m|2h] <goal>` are equivalent. The default
active execution budget is 30 minutes; explicit budgets use existing 1–120 minute
validation and at most 32 reviewed steps. The loop runs without per-step owner
confirmation, with a concrete follow-up question when blocked. It does not invent
new goals when finished. `!goal status`, `!goal pause`, `!goal resume`,
`!goal stop` (and `!loop` forms) target the latest supervised goal in this thread;
optional task IDs are accepted. Pause/stop during a process take effect at its
successful boundary; `!cancel <id>` retains immediate uncertain interruption.
A terminal completed/blocked review takes precedence over pending controls;
blocked state retains its reconciliation target. Resume cannot replenish a
budget, clear an uncertain block, or overtake other
queued work. Explicit `!recover` retains supervision and saved candidate output;
a fresh `!goal <budget> <goal>` in a blocked thread authorizes a new supervised
budget after reconciliation. Ordinary `!work` remains unchanged.

## State and review protocol

SQLite schema 5 adds goal metadata and review history, linked to workflows.
Worker output uses the existing strict WorkOutcome schema. Save and charge a
successful worker candidate before starting review. The candidate is not yet a
verified checkpoint. A crash leaves the job interrupted, never automatically
replayed. Manual recovery preserves a saved candidate so review need not rerun
the worker. Startup crashes retain the existing conservative policy: consume
the unknown remaining allowance and require a fresh explicit !goal budget.
The candidate carries forward only if the new fixed goal is unchanged. A supervisor starts with null session and a separate session callback;
its session never replaces the worker's persisted conversation session.

The supervisor returns a strict object with `outcome` (continue/completed/blocked),
`summary`, `nextAction`, and boolean `progress`. Text bounds match WorkOutcome.
It checks the fixed goal, prior accepted checkpoint and candidate evidence,
asks for missing evidence before completion, and puts an owner question in
nextAction when blocked. Continuation requires a concrete nextAction. Three
consecutive reviews without progress block the goal. Repeated identical worker
candidates count as no progress even if the reviewer says otherwise. Model
judgments are fallible; this is evidence review, not an authorization boundary.
Review uses Codex's read-only filesystem sandbox; configured MCP tools are not
claimed to be read-only. Instructions prohibit reviewer writes and delegation.
The worker is explicitly instructed to use subagents for independent work when
available, reconcile consequential writes and return evidence.

Only Codex-bound threads may start supervised goals in this increment. Other
providers receive a clear rejection before enqueue; no provider fallback.
Worker and reviewer share the original active budget. Timeout, invalid output,
cancellation or failure in either phase interrupts and blocks automatic work.
Pause preserves a pending candidate; stop retains history. Queue/maintenance time
is uncharged. Fairness is retained between reviewed worker/reviewer pairs.

## Verification and scope

Synthetic local tests cover intake authorization/deduplication, alias/parser
bounds, actual store migration/reopen, worker/reviewer session separation,
completion veto, no-progress stop, pause/resume/stop and cross-thread controls,
shared monotonic budget, malformed/failing reviewer, restart/recovery, queue
fairness and real fake-CLI schema/sandbox arguments. Run full npm tests and build.
No real Discord sends, model calls or public posts serve as smoke tests. A draft
PR is the deliverable; merging and deploying this engine are outside this task.
