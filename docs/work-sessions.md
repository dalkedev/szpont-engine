# Bounded work sessions

For an independent supervisor that reviews each worker step, use
[`!goal` / `!loop`](supervised-goals.md). The `!work` interface below stays unchanged.

A normal Discord message requests one runner turn. Use an explicit owner command when a goal
needs several verified steps:

```text
!work 30m Add regression coverage for the importer, fix the failing cases and prepare a focused PR.
!work 2h Measure the archive's memory usage, implement one bounded improvement and report the evidence.
```

Only a leading `!work` command allocates a budget. Quoted examples, model output and ordinary
prose cannot silently create one. Whole-minute budgets are 1–120 minutes (`1m` through `120m`,
or `1h` / `2h`), with at most 32 completed steps. A budget is a ceiling, not a request to spend
all available time. The engine stops when the fixed goal is complete or blocked.

## What happens between steps

1. The owner goal, budget and parent Discord message ID enter SQLite in one transaction.
2. One worker claims one step. The bound runner receives the fixed goal, saved session and prior checkpoint.
3. The process must exit successfully and emit `turn.completed`. Its final answer must match
   the bundled schema: `outcome`, `summary` and `nextAction`, without extra properties.
4. The engine commits the step result and charged execution time before reporting progress.
5. A valid `continue` checkpoint returns the same parent job to the queue tail. Other eligible
   threads get a turn; later messages in this thread cannot overtake its active work session.

Since 0.3.1, a durable acceptance sequence orders jobs within a thread independently of
wall-clock timestamps and the mutable queue position used for fair yielding. Migrated
legacy jobs retain the previous `(created_at,id)` order: historical intake order cannot
be reconstructed when the old database did not record it.

The queue is serialized because the workspace, Git index and optional browser profile are
shared. A long individual step still holds the worker until it finishes or times out. This is
fairness between completed steps, not preemption or parallel execution.

Use `!queue` for a read-only snapshot of this thread's queued and running task IDs,
runner and waiting reason. It distinguishes a blocked thread, unverified runner
readiness, an earlier accepted task and eligibility for the shared worker. Worker
occupancy is shown without identifiers or content from other threads. It reports
the worker's last readiness check; this command does not probe a runner, call a
model, change queue order or retry a task. Eligibility does not predict a start time
or a global rank. A running task may still finish or fail before the next claim.

An ordinary message accepted in a blocked thread also warns that it cannot run yet
and points to `!queue`. Read the blocker and saved result before choosing recovery;
a new message alone does not authorize replay of an uncertain external action.

Each text field is limited to 4,000 UTF-8 bytes. Checkpoints are historical model output,
not new owner authority. They must be reconciled with current files and actual action receipts.
The engine does not verify the truth of a model's completion claim; the summary must provide
evidence a person can review.

## Budgets and stop conditions

Only elapsed runner execution consumes the budget. Queue, authentication, transcript export and
memory commit waits do not. Elapsed execution uses a monotonic process clock; system clock
corrections do not change the charge. Each subprocess is capped by both the configured task timeout and
remaining work budget. The prompt states both the aggregate remaining budget and this turn's actual hard deadline, and asks for a checkpoint within 80% of the turn deadline. This is scheduling guidance, not a guarantee that a model will finish in time. This does not promise a wall-clock completion deadline or a token/cost
limit; the configured account's usage allowance remains separate.

| Outcome                                            | Durable state                                     | Next action                                          |
| -------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| Valid `continue`, budget and steps available       | Same job queued with checkpoint                   | Continue automatically after eligible thread heads   |
| Valid `completed`                                  | Job succeeded, workflow completed                 | Review the saved result and receipts                 |
| Valid `blocked`                                    | Interrupted workflow, blocked conversation        | Inspect the blocker and deliberately recover         |
| Valid `continue` reaches budget or step cap        | Paused workflow, conversation available           | Give a fresh explicit `!work` budget if desired      |
| Timeout, crash, missing completion or invalid JSON | Failed/interrupted workflow, blocked conversation | Reconcile possible partial actions before `!recover` |
| Owner cancellation or service stop during a turn   | Interrupted workflow, blocked conversation        | Inspect state; no automatic replay                   |

A verified pause retains the provider-bound session. `!work 30m Continue the importer goal using its
last verified checkpoint` is a new budget and goal in the same thread. `!recover` cannot renew
an exhausted budget. In a blocked thread, a new explicit `!work 30m <goal>` authorizes a fresh
budget and reconciles prior actions before continuing the saved provider-bound session. It replaces
queued follow-ups atomically; previous execution stays recorded against the previous budget.
Use `!new-session` only when you deliberately want a fresh runner session. A recoverable failure keeps the
remaining budget, original goal and checkpoint context, including recovery of an earlier ancestor.

A host restart marks running work interrupted. Its unfinished step has no trustworthy measured
duration, so the engine conservatively consumes that workflow's remaining active allowance.
Inspect its saved result and external receipts, then explicitly choose `!work 30m <goal>`
for fresh-budget reconciliation if needed. A restart never silently refunds unknown execution time.
Verified queued steps retain their recorded budget and remain queued. External
writes are not transactional with SQLite: always inspect the destination before repeating a
publication, deployment or other consequential operation.

Use `!recover` to select the task actually blocking the current thread, or
`!recover <task ID> [instruction]` to select one explicitly. A note such as
`!recover Check the remote branch first, then push the saved changes` is carried as the
current owner instruction; prior prompts and checkpoints remain historical context.
Recovery always checks saved state and external receipts before repeating any action.
A normal message alone never silently renews a budget or retries an uncertain write.

## Exports, memory and delivery

Job execution, Markdown export, local Git commit and final Discord delivery have separate
durable state. `!status` shows workflow progress and maintenance health only for the current
authorized thread. `!result MESSAGE_ID` reads the saved result without running the model.

Every history-changing mutation increments an export generation. A maintenance pass exports
and commits at most two due threads, recording only the generation it actually processed.
Failures use bounded backoff from one second to five minutes and survive restart; the regular
30-second tick attempts due retries while idle. A blocked Git index remains visible until
the owner resolves it. No model turn is repeated merely because an export or commit failed.

Progress messages are best effort. A failed final Discord send is ambiguous and is not
automatically resent. The stored job result and `!result` remain available. See
[architecture](architecture.md) and [backups](state-backups.md) for the state boundaries.

Runner-specific checkpoint protocols and experimental limits are described in [runners](runners.md).
