# Supervised goal validation

Date: 2026-11-07. Runtime source under test: `d8cbb9c` (PR #7).
This record separates deterministic checks, real model coordination and live CLI
integration. None establishes real Discord delivery or a deployed service.

## Deterministic regression and hosted checks

The source passed 452 offline tests: 343 engine tests and 109 script tests, plus
TypeScript build, formatting, whitespace and public-tree checks. Tests use real
SQLite state and fake CLI processes. Hosted workflow
[42379049912](https://github.com/dalkedev/szpont-engine/actions/runs/42379049912)
passed all five jobs: Engine/Node 24, Browser/Python 3.12, public repository
hygiene, and native amd64/arm64 container builds and offline smoke checks.

## Actual CLI startup: blocked in this executor

The existing configured Codex CLI reports version 0.166.0 and successful login
status. A synthetic Engine attempt through the unmodified CLI adapter exited
before any `thread.started` or model event. The process emitted a read-only
filesystem diagnostic; no task files or supervisor review were produced.
The Engine saved a failed job and blocked its workflow, with no automatic replay.
A separate no-tools startup diagnostic confirmed the pre-session failure.

Authentication status alone therefore does not establish that this executor can
start an agent. No home/configuration relocation, authentication copy, model or
permission change, or sandbox bypass was used. Raw diagnostics, credentials and
private runtime state are excluded from this public repository. The actual CLI
path still needs acceptance in an operator-owned writable runtime with the
existing credentials kept in place.

## Real native-agent experiment

A separate synthetic experiment connects the real Engine state machine to actual
native Codex agents through an injected test bridge. It uses no Discord network
transport. Adapter session IDs are synthetic; this does **not** test CLI session
persistence, the production CLI adapter, or its filesystem sandbox enforcement.
The controller transfers model checkpoints and supplies a small, sanitized
receipt of observed native collaboration status; it does not export raw session
history or private diagnostics.

The main worker created exactly two independent child agents, one implementing
`sumEven(numbers)` and one writing three `node:test` cases. Both children finished
before the worker's first checkpoint. The first supervisor inspected the files,
found test execution unverified and returned `continue` with a concrete request
to run tests. The Engine resumed the same native worker. That worker ran the
three tests and saved the observed 3-pass/0-fail result.

A second fresh supervisor accepted the code/test evidence but requested independent
delegation corroboration. The controller supplied a receipt based on the actual
child completion messages and status readback. The next worker step reconciled
that receipt without repeating delegation, tests or earlier changes.

A third fresh supervisor inspected the independent controller receipt and accepted
completion. Engine readback shows `succeeded` / workflow `completed`, three
reviewed steps and three saved reviews. The same native worker handled all three
worker turns; every review used a different fresh native supervisor. The planned
two-step fixture required one additional evidence-reconciliation step. A separate
parent check read both source files and ran the three tests: 3 passed, 0 failed.
This small scenario is evidence for exercised coordination, not a reliability
benchmark or proof of a strict two-step completion guarantee.

### Missing decision and explicit recovery

A second native-agent experiment asked for a greeting artifact but intentionally
omitted its required recipient. The worker asked which name to use; a fresh
supervisor independently confirmed the missing input and returned `blocked` with
the concrete question. Engine state was `interrupted` / workflow `blocked`.
Calling the worker tick again produced no additional agent calls.

The controlled synthetic owner then answered through `!recover`, supplying `Ada`.
The same native worker read that explicit recovery instruction and created exactly
`Hello, Ada!` followed by one newline. A new fresh supervisor read and verified all
12 bytes. Final Engine readback shows the recovery job `succeeded`, workflow
`completed`, two retained reviews and the same synthetic worker-session binding.
The native task identity was also reused. No real owner message was sent by this
experiment; the controlled local test transport supplied the fixture input.

## Remaining acceptance before deployment

Run the same worker/subagent/reviewer sequence through the actual configured CLI
in a suitable private lab, verify real resume and reviewer separation, and exercise
pause/stop and an uncertain interruption there. Keep all input synthetic, use a
local test transport, preserve action receipts, and inspect any failed/uncertain
attempt before deliberate recovery. Never use public posts or real account
messages as smoke tests. This PR remains a draft; no merge, release or service
rollout follows from these checks.
