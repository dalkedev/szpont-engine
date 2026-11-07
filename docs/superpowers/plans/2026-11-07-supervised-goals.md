# Supervised Goals Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task by task; fresh whole-branch review before publication.

**Goal:** Durable owner-controlled goal loops with independent review per step.
**Architecture:** Extend existing workflows with candidate persistence and a fresh supervisor phase. Reuse queue, budgets, recovery and notifications.
**Tech Stack:** TypeScript, Node 24, SQLite, Codex CLI, node:test.
**Spec:** docs/superpowers/specs/2026-11-07-supervised-goals-design.md

## Global Constraints

English public code/docs and synthetic fixtures only. Existing 1–120 minute budget
and 32-step ceilings. Only Codex goals; no runner/model changes or deployment.

## Review Focus

Crash after worker output must never replay a write automatically. A supervisor
session cannot replace the worker session. Both phases consume one budget.
Owner controls cannot cross threads or bypass uncertainty. Malformed review and
three stalled steps must stop automatic execution.

## Tasks

- [x] 1. Add strict goal command/review protocol and tests; watch RED then GREEN.
- [x] 2. Add schema 5 goal candidate/review/control persistence, atomic transitions,
  migration/reopen/recovery tests; update snapshot supported schema.
- [x] 3. Add Codex supervisor option, schema, read-only sandbox and fake-CLI checks.
- [x] 4. Wire authorized intake, worker candidate saving, fresh review, bounded
  continuation and owner controls; integration tests cover focus cases above.
- [x] 5. Update help/status/README/operations, run full tests/build, fresh independent
  review and fixes. Publish one feature branch/draft PR and verify remote state.

## Execution ledger

Ruling: implement the requested reviewable PR autonomously; design choices above
are implementation proposals, not attributed owner decisions. No live rollout.

## Verification ledger

- Tasks 1–4 implemented with protocol, store and fake-CLI RED→GREEN tests.
- Initial locked dependency install needed an explicit writable npm cache; lock and
  dependency versions unchanged. Baseline 295 engine +108 script tests pass.
- Baseline default umask077 breaks three preexisting permission-fixture tests;
  `umask 022` restores the fixtures' requested modes. No permission checks weakened.
- Integrated full suite: 341 engine +109 script tests pass under Node24.22.2 /
  npm11.19.1; build and whitespace checks pass. No real account or model smoke test.
- Fresh independent whole-branch review found two P2 recovery gaps: omitted
  owner recovery context and inherited image input. Both reproduced RED, fixed
  GREEN and re-reviewed; fresh targeted52 PASS, reviewer Ready for draft PR.
  Terminal review precedence documented; no remaining gating findings.

- Final required full suite: 343 engine +109 script tests PASS (452 total),
  build and whitespace checks PASS. New image fixture uses explicit0700 so its
  input reaches the actual materialization boundary under standard umask022.
  Draft publication receipts remain separate from the tested source.


## Follow-up acceptance ledger

The requested continuation added verification evidence only, without runtime,
dependency or configuration changes. The existing real CLI adapter was attempted
once in a synthetic lab; it failed before session events with a read-only
filesystem diagnostic and the Engine blocked. No unsafe path/config/auth workaround
was attempted. A native-agent-backed injected bridge then exercised three reviewed
steps with two actual independent children and fresh supervisors, plus a separate
blocked-question / !recover scenario with the same native worker. Both bridge
experiments completed; actual CLI integration remains unaccepted. See the linked
verification record for scope and observed evidence.
