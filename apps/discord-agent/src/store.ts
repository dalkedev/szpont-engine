import { DatabaseSync } from "node:sqlite";
import {
  isSessionId,
  MAX_MESSAGE,
  PROVIDERS,
  SNOWFLAKE,
  type ProviderId,
} from "./config.js";
import { validateSavedImages, type SavedImage } from "./images.js";
import type { WorkOutcome } from "./workflow.js";

export const SCHEMA_VERSION = 5;
export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled";
export interface Job {
  id: string;
  thread_id: string;
  provider: ProviderId;
  prompt: string;
  status: JobStatus;
  created_at: number;
  queued_at: number;
  started_at: number | null;
  finished_at: number | null;
  result: string | null;
  error_code: string | null;
  notification: string;
  recovery_of: string | null;
}
export interface Workflow {
  job_id: string;
  goal: string;
  budget_ms: number;
  elapsed_ms: number;
  max_steps: number;
  step_count: number;
  last_summary: string | null;
  next_action: string | null;
  state: "active" | "completed" | "paused" | "blocked" | "cancelled";
}
export interface Goal {
  job_id: string;
  pending_output: string | null;
  control: "active" | "pause" | "stop";
  stalled_count: number;
  last_review: string | null;
  last_candidate: string | null;
}
export interface GoalReview {
  job_id: string;
  step: number;
  candidate: string;
  review: string;
  progress: boolean;
  elapsed_ms: number;
  created_at: number;
}
export interface WorkflowStep {
  job_id: string;
  step: number;
  outcome: WorkOutcome["outcome"];
  summary: string;
  next_action: string;
  elapsed_ms: number;
  created_at: number;
}
export interface Effect {
  thread_id: string;
  generation: number;
  exported_generation: number;
  synced_generation: number;
  attempts: number;
  retry_at: number;
  last_error: EffectError | null;
}
export type EffectError =
  | "transcript_export_failed"
  | "memory_sync_failed"
  | "memory_sync_blocked";

export interface RecoveryOptions {
  note?: string;
  /** A fresh, explicitly authorized work budget; prior execution stays charged. */
  work?: { goal: string; budgetMs: number; supervised?: boolean };
  images?: readonly SavedImage[];
}

export interface QueueItem {
  id: string;
  provider: ProviderId;
  status: "queued" | "running";
  reason:
    | "running"
    | "blocked_thread"
    | "runner_mismatch"
    | "earlier_task"
    | "runner_unavailable"
    | "eligible";
}

export interface ThreadQueue {
  workerBusy: boolean;
  items: QueueItem[];
}

// Both inspection and claiming use these predicates. Fair yielding changes
// queued_at, but must never let a later message overtake this thread's head.
const queueJoin = `FROM jobs j JOIN conversations c ON c.thread_id=j.thread_id
  JOIN job_acceptance accepted ON accepted.job_id=j.id`;
const earlierQueued = `EXISTS(SELECT 1 FROM jobs earlier
  JOIN job_acceptance predecessor ON predecessor.job_id=earlier.id
  WHERE earlier.thread_id=j.thread_id AND earlier.status='queued'
    AND predecessor.sequence<accepted.sequence)`;
function readyPredicate(providers: readonly ProviderId[]): string {
  if (providers.some((provider) => !PROVIDERS.includes(provider)))
    throw new Error("Invalid runner provider");
  return providers.length
    ? `j.provider IN(${providers.map(() => "?").join(",")})`
    : "0";
}

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      // Inspect before PRAGMAs or DDL: a newer engine's database is not ours to alter.
      const version = (
        this.db.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version;
      if (version > SCHEMA_VERSION)
        throw new Error(`Unsupported database schema version ${version}`);
      const jobColumns = this.db.prepare("PRAGMA table_info(jobs)").all() as {
        name: string;
      }[];
      // A private deployment has lane/publication state this public worker cannot honor.
      // Its old schema 2 must not be mistaken for this public schema 2.
      if (jobColumns.some((column) => ["source", "lane"].includes(column.name)))
        throw new Error(
          "Unsupported database variant: private state requires the private engine",
        );
      if (
        version >= 2 &&
        !this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_acceptance'",
          )
          .get()
      )
        throw new Error(
          "Invalid database schema: acceptance ordering is missing",
        );
      if (version >= 3) {
        const conversationColumns = this.db
          .prepare("PRAGMA table_info(conversations)")
          .all() as { name: string }[];
        if (
          !jobColumns.some((column) => column.name === "provider") ||
          !conversationColumns.some((column) => column.name === "provider")
        )
          throw new Error(
            "Invalid database schema: runner bindings are missing",
          );
      }
      if (
        version >= 4 &&
        !this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_images'",
          )
          .get()
      )
        throw new Error("Invalid database schema: image storage is missing");
      if (version >= 5) this.validateGoals();
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      if (version === 0) this.migrate();
      if (version < 2) this.migrateAcceptance();
      if (version < 3) this.migrateProviders();
      if (version < 4) this.migrateImages();
      if (version < 5) this.migrateGoals();
      this.validateGoals();
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private migrate(): void {
    this.transaction(() => {
      // Another process may have migrated while this connection waited for the write lock.
      const lockedVersion = (
        this.db.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version;
      if (lockedVersion >= 1 && lockedVersion <= SCHEMA_VERSION) return;
      if (lockedVersion !== 0)
        throw new Error(`Unsupported database schema version ${lockedVersion}`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS conversations(thread_id TEXT PRIMARY KEY,session_id TEXT UNIQUE,blocked_reason TEXT,created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES conversations(thread_id),prompt TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN('queued','running','succeeded','failed','interrupted','cancelled')),created_at INTEGER NOT NULL,
          started_at INTEGER,finished_at INTEGER,result TEXT,error_code TEXT,notification TEXT NOT NULL DEFAULT 'pending',recovery_of TEXT);
        CREATE INDEX IF NOT EXISTS job_status ON jobs(status,created_at);
        CREATE TABLE IF NOT EXISTS controls(message_id TEXT PRIMARY KEY);
      `);
      const columns = this.db.prepare("PRAGMA table_info(jobs)").all() as {
        name: string;
      }[];
      if (!columns.some((column) => column.name === "queued_at")) {
        this.db.exec(
          "ALTER TABLE jobs ADD COLUMN queued_at INTEGER NOT NULL DEFAULT 0",
        );
        this.db.exec("UPDATE jobs SET queued_at=created_at");
      }
      this.db.exec(`
        CREATE INDEX job_fair_queue ON jobs(status,queued_at,id);
        CREATE TABLE workflows(
          job_id TEXT PRIMARY KEY REFERENCES jobs(id),goal TEXT NOT NULL,
          budget_ms INTEGER NOT NULL CHECK(budget_ms BETWEEN 60000 AND 7200000),
          elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK(elapsed_ms>=0),
          max_steps INTEGER NOT NULL CHECK(max_steps BETWEEN 1 AND 32),
          step_count INTEGER NOT NULL DEFAULT 0 CHECK(step_count BETWEEN 0 AND max_steps),
          last_summary TEXT,next_action TEXT,
          state TEXT NOT NULL CHECK(state IN('active','completed','paused','blocked','cancelled')));
        CREATE TABLE workflow_steps(
          job_id TEXT NOT NULL REFERENCES workflows(job_id),step INTEGER NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN('continue','completed','blocked')),
          summary TEXT NOT NULL,next_action TEXT NOT NULL,elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms>=1),
          created_at INTEGER NOT NULL,PRIMARY KEY(job_id,step));
        CREATE TABLE effects(
          thread_id TEXT PRIMARY KEY REFERENCES conversations(thread_id),
          generation INTEGER NOT NULL CHECK(generation>=1),
          exported_generation INTEGER NOT NULL DEFAULT 0 CHECK(exported_generation>=0 AND exported_generation<=generation),
          synced_generation INTEGER NOT NULL DEFAULT 0 CHECK(synced_generation>=0 AND synced_generation<=exported_generation),
          attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,last_error TEXT
            CHECK(last_error IS NULL OR last_error IN('transcript_export_failed','memory_sync_failed','memory_sync_blocked')));
        INSERT INTO effects(thread_id,generation) SELECT thread_id,1 FROM conversations;
        PRAGMA user_version=1;
      `);
    });
  }
  private migrateAcceptance(): void {
    this.transaction(() => {
      const version = (
        this.db.prepare("PRAGMA user_version").get() as { user_version: number }
      ).user_version;
      if (version >= 2 && version <= SCHEMA_VERSION) return;
      if (version !== 1)
        throw new Error(`Unsupported database schema version ${version}`);
      this.db.exec(`
        CREATE TABLE job_acceptance(
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id));
        -- Historical acceptance order was not persisted. Retain the previous
        -- (created_at,id) FIFO contract for old jobs, including continued work.
        INSERT INTO job_acceptance(job_id) SELECT id FROM jobs ORDER BY created_at,id;
        -- Intake, workflow recovery and direct legacy adapters share this atomic ledger.
        CREATE TRIGGER record_job_acceptance AFTER INSERT ON jobs BEGIN
          INSERT INTO job_acceptance(job_id) VALUES(NEW.id);
        END;
        CREATE TRIGGER preserve_job_acceptance BEFORE UPDATE ON job_acceptance BEGIN
          SELECT RAISE(ABORT,'Job acceptance order is immutable');
        END;
        PRAGMA user_version=2;
      `);
    });
  }
  private migrateProviders(): void {
    this.transaction(() => {
      const version = (
        this.db.prepare("PRAGMA user_version").get() as { user_version: number }
      ).user_version;
      if (version >= 3 && version <= SCHEMA_VERSION) return;
      if (version !== 2)
        throw new Error(`Unsupported database schema version ${version}`);
      // Legacy sessions and queued work always belong to Codex, independent
      // of the deployment's current default runner. Never reinterpret history.
      this.db.exec(`
        ALTER TABLE conversations ADD COLUMN provider TEXT NOT NULL DEFAULT 'codex'
          CHECK(provider IN('codex','claude','opencode'));
        ALTER TABLE jobs ADD COLUMN provider TEXT NOT NULL DEFAULT 'codex'
          CHECK(provider IN('codex','claude','opencode'));
        CREATE TRIGGER preserve_conversation_provider BEFORE UPDATE OF provider ON conversations
          WHEN NEW.provider<>OLD.provider BEGIN
          SELECT RAISE(ABORT,'Thread runner binding is immutable');
        END;
        CREATE TRIGGER preserve_job_provider BEFORE UPDATE OF provider ON jobs
          WHEN NEW.provider<>OLD.provider BEGIN
          SELECT RAISE(ABORT,'Job runner snapshot is immutable');
        END;
        PRAGMA user_version=3;
      `);
    });
  }
  private migrateImages(): void {
    this.transaction(() => {
      const version = (
        this.db.prepare("PRAGMA user_version").get() as { user_version: number }
      ).user_version;
      if (version >= 4 && version <= SCHEMA_VERSION) return;
      if (version !== 3)
        throw new Error(`Unsupported database schema version ${version}`);
      this.db.exec(`
        CREATE TABLE job_images(
          job_id TEXT NOT NULL REFERENCES jobs(id),
          ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 3),
          media_type TEXT NOT NULL CHECK(media_type IN('image/png','image/jpeg','image/webp')),
          sha256 TEXT NOT NULL CHECK(length(sha256)=64),
          data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 8388608),
          PRIMARY KEY(job_id,ordinal));
        PRAGMA user_version=4;
      `);
    });
  }
  private validateGoals(): void {
    for (const [table, columns] of [
      [
        "goals",
        [
          "job_id",
          "pending_output",
          "control",
          "stalled_count",
          "last_review",
          "last_candidate",
        ],
      ],
      [
        "goal_reviews",
        [
          "job_id",
          "step",
          "candidate",
          "review",
          "progress",
          "elapsed_ms",
          "created_at",
        ],
      ],
    ] as const) {
      const actual = this.db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[];
      if (
        !columns.every((name) => actual.some((column) => column.name === name))
      )
        throw new Error(
          "Invalid database schema: supervised goal storage is missing",
        );
    }
  }
  private migrateGoals(): void {
    this.transaction(() => {
      const version = (
        this.db.prepare("PRAGMA user_version").get() as { user_version: number }
      ).user_version;
      if (version === 5) {
        this.validateGoals();
        return;
      }
      if (version !== 4)
        throw new Error(`Unsupported database schema version ${version}`);
      this.db.exec(`
        CREATE TABLE goals(
          job_id TEXT PRIMARY KEY REFERENCES workflows(job_id),pending_output TEXT,
          control TEXT NOT NULL DEFAULT 'active' CHECK(control IN('active','pause','stop')),
          stalled_count INTEGER NOT NULL DEFAULT 0 CHECK(stalled_count>=0),last_review TEXT,last_candidate TEXT);
        CREATE TABLE goal_reviews(
          job_id TEXT NOT NULL REFERENCES goals(job_id),step INTEGER NOT NULL CHECK(step>=1),
          candidate TEXT NOT NULL,review TEXT NOT NULL,progress INTEGER NOT NULL CHECK(progress IN(0,1)),
          elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms>=1),created_at INTEGER NOT NULL,
          PRIMARY KEY(job_id,step));
        PRAGMA user_version=5;
      `);
    });
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private dirty(threadId: string): void {
    this.db
      .prepare(
        `INSERT INTO effects(thread_id,generation) VALUES(?,1)
      ON CONFLICT(thread_id) DO UPDATE SET generation=generation+1,attempts=0,retry_at=0`,
      )
      .run(threadId);
  }
  private nextQueueTime(): number {
    const latest = this.db
      .prepare("SELECT MAX(queued_at) latest FROM jobs")
      .get() as {
      latest: number | null;
    };
    return Math.max(Date.now(), (latest.latest ?? 0) + 1);
  }
  close(): void {
    this.db.close();
  }
  conversationProviders(): ProviderId[] {
    return (
      this.db.prepare("SELECT DISTINCT provider FROM conversations").all() as {
        provider: ProviderId;
      }[]
    ).map((row) => row.provider);
  }
  recoverStartup(): number {
    return this.transaction(() => {
      const threads = this.db
        .prepare("SELECT DISTINCT thread_id FROM jobs WHERE status='running'")
        .all() as { thread_id: string }[];
      // A host crash loses the active execution clock. Consume the remaining
      // allowance rather than refunding unknown work through manual recovery.
      this.db.exec(
        "UPDATE workflows SET state='blocked',elapsed_ms=MAX(elapsed_ms,budget_ms) WHERE job_id IN(SELECT id FROM jobs WHERE status='running')",
      );
      this.db.exec(
        "UPDATE conversations SET blocked_reason='interrupted' WHERE thread_id IN(SELECT thread_id FROM jobs WHERE status='running')",
      );
      const count = Number(
        this.db
          .prepare(
            "UPDATE jobs SET status='interrupted',error_code='process_restarted',finished_at=? WHERE status='running'",
          )
          .run(Date.now()).changes,
      );
      this.db.exec(
        "UPDATE jobs SET notification='ambiguous' WHERE notification='sending'",
      );
      for (const thread of threads) this.dirty(thread.thread_id);
      return count;
    });
  }
  controlOnce(id: string): boolean {
    return (
      Number(
        this.db.prepare("INSERT OR IGNORE INTO controls VALUES(?)").run(id)
          .changes,
      ) === 1
    );
  }
  enqueue(
    id: string,
    threadId: string,
    prompt: string,
    recoveryOf: string | null = null,
    defaultProvider: ProviderId = "codex",
    images: readonly SavedImage[] = [],
  ): boolean {
    this.validateIdentity(id, threadId);
    validateSavedImages(images);
    return this.transaction(() => {
      if (this.get(id)) return false;
      this.insertQueuedJob(id, threadId, prompt, recoveryOf, defaultProvider);
      this.insertImages(id, images);
      this.dirty(threadId);
      return true;
    });
  }
  enqueueWorkflow(
    id: string,
    threadId: string,
    goal: string,
    budgetMs: number,
    maxSteps = 32,
    defaultProvider: ProviderId = "codex",
    images: readonly SavedImage[] = [],
  ): boolean {
    this.validateIdentity(id, threadId);
    validateSavedImages(images);
    if (
      !goal.trim() ||
      !Number.isSafeInteger(budgetMs) ||
      budgetMs < 60_000 ||
      budgetMs > 7_200_000 ||
      !Number.isSafeInteger(maxSteps) ||
      maxSteps < 1 ||
      maxSteps > 32
    )
      throw new Error("Invalid work budget, goal or step limit");
    return this.transaction(() => {
      if (this.get(id)) return false;
      this.insertQueuedJob(id, threadId, goal, null, defaultProvider);
      this.insertImages(id, images);
      this.db
        .prepare(
          "INSERT INTO workflows(job_id,goal,budget_ms,max_steps,state) VALUES(?,?,?,?,'active')",
        )
        .run(id, goal, budgetMs, maxSteps);
      this.dirty(threadId);
      return true;
    });
  }
  enqueueGoal(
    id: string,
    threadId: string,
    goal: string,
    budgetMs: number,
    defaultProvider: ProviderId = "codex",
  ): boolean {
    this.validateIdentity(id, threadId);
    if (
      !goal.trim() ||
      goal.length > MAX_MESSAGE ||
      !Number.isSafeInteger(budgetMs) ||
      budgetMs < 60_000 ||
      budgetMs > 7_200_000
    )
      throw new Error("Invalid work budget or goal");
    return this.transaction(() => {
      if (this.get(id)) return false;
      if ((this.provider(threadId) ?? defaultProvider) !== "codex")
        throw new Error("Supervised goals require a Codex-bound thread");
      this.insertQueuedJob(id, threadId, goal, null, defaultProvider);
      this.db
        .prepare(
          "INSERT INTO workflows(job_id,goal,budget_ms,max_steps,state) VALUES(?,?,?,32,'active')",
        )
        .run(id, goal, budgetMs);
      this.db.prepare("INSERT INTO goals(job_id) VALUES(?)").run(id);
      this.dirty(threadId);
      return true;
    });
  }
  goal(id: string): Goal | undefined {
    return this.db.prepare("SELECT * FROM goals WHERE job_id=?").get(id) as
      | Goal
      | undefined;
  }
  latestGoal(threadId: string): Goal | undefined {
    return this.db
      .prepare(
        `SELECT g.* FROM goals g JOIN jobs j ON j.id=g.job_id
      JOIN job_acceptance a ON a.job_id=j.id WHERE j.thread_id=? ORDER BY a.sequence DESC LIMIT 1`,
      )
      .get(threadId) as Goal | undefined;
  }
  goalReviews(id: string): GoalReview[] {
    return (
      this.db
        .prepare("SELECT * FROM goal_reviews WHERE job_id=? ORDER BY step")
        .all(id) as unknown as (Omit<GoalReview, "progress"> & {
        progress: number;
      })[]
    ).map((row) => ({ ...row, progress: Boolean(row.progress) }));
  }
  saveGoalWorker(id: string, outcome: WorkOutcome, elapsedMs: number): void {
    this.validateCheckpoint(outcome);
    const spent = this.spent(elapsedMs);
    this.transaction(() => {
      const job = this.get(id),
        workflow = this.workflow(id),
        goal = this.goal(id);
      if (
        !job ||
        job.status !== "running" ||
        !workflow ||
        workflow.state !== "active" ||
        !goal
      )
        throw new Error("Goal ownership lost");
      if (goal.pending_output !== null)
        throw new Error("Goal candidate already saved");
      const candidate = JSON.stringify({
        outcome: outcome.outcome,
        summary: outcome.summary,
        nextAction: outcome.nextAction,
      });
      this.db
        .prepare("UPDATE goals SET pending_output=? WHERE job_id=?")
        .run(candidate, id);
      this.db
        .prepare("UPDATE workflows SET elapsed_ms=? WHERE job_id=?")
        .run(this.totalSpent(workflow.elapsed_ms, spent), id);
      this.dirty(job.thread_id);
    });
  }
  reviewGoal(
    id: string,
    outcome: WorkOutcome,
    progress: boolean,
    elapsedMs: number,
  ): { continued: boolean; status: JobStatus; reason: string | null } {
    this.validateCheckpoint(outcome);
    if (typeof progress !== "boolean") throw new Error("Invalid goal progress");
    const spent = this.spent(elapsedMs);
    return this.transaction(() => {
      const goal = this.goal(id),
        workflow = this.workflow(id);
      if (!goal?.pending_output || !workflow)
        throw new Error("Goal candidate is missing");
      const verifiedProgress =
        progress && goal.last_candidate !== goal.pending_output;
      const stalled = verifiedProgress ? 0 : goal.stalled_count + 1;
      const accepted: WorkOutcome =
        stalled >= 3
          ? {
              outcome: "blocked",
              summary:
                "Three consecutive reviews found no progress. " +
                outcome.summary.slice(0, 900),
              nextAction: outcome.nextAction.trim()
                ? outcome.nextAction
                : "Which prerequisite or verified evidence should change before the next attempt? Reconcile the repeated candidate and saved receipts first.",
            }
          : outcome;
      const review = JSON.stringify({ ...outcome, progress: verifiedProgress });
      this.db
        .prepare(
          "INSERT INTO goal_reviews(job_id,step,candidate,review,progress,elapsed_ms,created_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          workflow.step_count + 1,
          goal.pending_output,
          review,
          Number(verifiedProgress),
          spent,
          Date.now(),
        );
      this.db
        .prepare(
          "UPDATE goals SET pending_output=NULL,stalled_count=?,last_review=?,last_candidate=? WHERE job_id=?",
        )
        .run(stalled, review, goal.pending_output, id);
      const result = this.acceptCheckpoint(id, accepted, spent);
      if (result.continued && goal.control !== "active") {
        this.goalControlBoundary(id);
        const stopped = this.get(id)!;
        return {
          continued: false,
          status: stopped.status,
          reason: stopped.error_code,
        };
      }
      return result;
    });
  }
  requestGoalControl(
    id: string,
    threadId: string,
    action: "pause" | "stop",
  ): boolean {
    if (!["pause", "stop"].includes(action))
      throw new Error("Invalid goal control");
    return this.transaction(() => {
      const job = this.get(id),
        workflow = this.workflow(id);
      if (
        !job ||
        job.thread_id !== threadId ||
        !this.goal(id) ||
        !workflow ||
        !(
          ["queued", "running"].includes(job.status) ||
          (action === "stop" && workflow.state === "paused")
        )
      )
        return false;
      this.db
        .prepare("UPDATE goals SET control=? WHERE job_id=?")
        .run(action, id);
      if (job.status !== "running") this.goalControlBoundary(id);
      else this.dirty(threadId);
      return true;
    });
  }
  applyGoalControl(id: string): boolean {
    return this.transaction(() => this.goalControlBoundary(id));
  }
  private goalControlBoundary(id: string): boolean {
    const job = this.get(id),
      workflow = this.workflow(id),
      goal = this.goal(id);
    if (!job || !workflow || !goal) throw new Error("Goal ownership lost");
    if (
      !["queued", "running"].includes(job.status) &&
      !(workflow.state === "paused" && goal.control === "stop")
    )
      return job.status !== "running";
    const exhausted = workflow.elapsed_ms >= workflow.budget_ms,
      capped = workflow.step_count >= workflow.max_steps;
    if (goal.control === "active" && !exhausted && !capped) return false;
    const stopped = goal.control === "stop";
    const reason = stopped
      ? "owner_stopped_goal"
      : goal.control === "pause"
        ? "owner_paused_goal"
        : exhausted
          ? "workflow_budget_exhausted"
          : "workflow_step_limit";
    this.db
      .prepare("UPDATE workflows SET state=? WHERE job_id=?")
      .run(stopped ? "cancelled" : "paused", id);
    this.db
      .prepare(
        "UPDATE jobs SET status=?,error_code=?,finished_at=?,notification='pending' WHERE id=?",
      )
      .run(stopped ? "cancelled" : "interrupted", reason, Date.now(), id);
    this.dirty(job.thread_id);
    return true;
  }
  resumeGoal(id: string, threadId: string): boolean {
    return this.transaction(() => {
      const job = this.get(id),
        workflow = this.workflow(id),
        goal = this.goal(id);
      if (
        !job ||
        job.thread_id !== threadId ||
        job.status !== "interrupted" ||
        !goal ||
        !workflow ||
        workflow.state !== "paused" ||
        workflow.elapsed_ms >= workflow.budget_ms ||
        workflow.step_count >= workflow.max_steps ||
        this.db
          .prepare(
            "SELECT 1 FROM conversations WHERE thread_id=? AND blocked_reason IS NOT NULL",
          )
          .get(threadId) ||
        this.db
          .prepare(
            "SELECT 1 FROM jobs WHERE thread_id=? AND status IN('queued','running')",
          )
          .get(threadId)
      )
        return false;
      this.db
        .prepare("UPDATE workflows SET state='active' WHERE job_id=?")
        .run(id);
      this.db
        .prepare("UPDATE goals SET control='active' WHERE job_id=?")
        .run(id);
      this.db
        .prepare(
          "UPDATE jobs SET status='queued',error_code=NULL,finished_at=NULL,queued_at=?,notification='pending' WHERE id=?",
        )
        .run(this.nextQueueTime(), id);
      this.dirty(threadId);
      return true;
    });
  }
  private validateIdentity(id: string, threadId: string): void {
    if (!SNOWFLAKE.test(id) || !SNOWFLAKE.test(threadId))
      throw new Error("Invalid queue identity");
  }
  private insertQueuedJob(
    id: string,
    threadId: string,
    prompt: string,
    recoveryOf: string | null,
    defaultProvider: ProviderId = "codex",
  ): void {
    if (!["codex", "claude", "opencode"].includes(defaultProvider))
      throw new Error("Invalid runner provider");
    const counts = this.db
      .prepare(
        "SELECT COUNT(*) n,SUM(CASE WHEN thread_id=? THEN 1 ELSE 0 END) t FROM jobs WHERE status IN('queued','running')",
      )
      .get(threadId) as { n: number; t: number | null };
    if (counts.n >= 30 || (counts.t ?? 0) >= 8)
      throw new Error("Queue is full");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO conversations(thread_id,created_at,provider) VALUES(?,?,?)",
      )
      .run(threadId, Date.now(), defaultProvider);
    const provider = this.provider(threadId);
    if (!provider) throw new Error("Missing thread runner binding");
    if (recoveryOf && provider !== this.get(recoveryOf)?.provider)
      throw new Error("Recovery runner does not match this thread");
    this.db
      .prepare(
        "INSERT INTO jobs(id,thread_id,prompt,status,created_at,queued_at,recovery_of,provider) VALUES(?,?,?,'queued',?,?,?,?)",
      )
      .run(
        id,
        threadId,
        prompt,
        Date.now(),
        this.nextQueueTime(),
        recoveryOf,
        provider,
      );
  }
  private insertImages(id: string, images: readonly SavedImage[]): void {
    if (images.length && this.get(id)?.provider !== "codex")
      throw new Error("Runner does not support images");
    const insert = this.db.prepare(
      "INSERT INTO job_images(job_id,ordinal,media_type,sha256,data) VALUES(?,?,?,?,?)",
    );
    for (const [index, image] of images.entries())
      insert.run(id, index, image.mediaType, image.sha256, image.data);
  }
  imageCount(id: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) count FROM job_images WHERE job_id=?")
        .get(id) as { count: number }
    ).count;
  }
  images(id: string): SavedImage[] {
    return (
      this.db
        .prepare(
          "SELECT media_type,sha256,data FROM job_images WHERE job_id=? ORDER BY ordinal",
        )
        .all(id) as unknown as {
        media_type: string;
        sha256: string;
        data: Uint8Array;
      }[]
    ).map((image) => ({
      mediaType: image.media_type,
      sha256: image.sha256,
      data: image.data,
    }));
  }
  get(id: string): Job | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as
      | Job
      | undefined;
  }
  workflow(id: string): Workflow | undefined {
    return this.db.prepare("SELECT * FROM workflows WHERE job_id=?").get(id) as
      | Workflow
      | undefined;
  }
  workflowSteps(id: string): WorkflowStep[] {
    return this.db
      .prepare("SELECT * FROM workflow_steps WHERE job_id=? ORDER BY step")
      .all(id) as unknown as WorkflowStep[];
  }
  provider(threadId: string): ProviderId | null {
    return (
      (
        this.db
          .prepare("SELECT provider FROM conversations WHERE thread_id=?")
          .get(threadId) as { provider: ProviderId } | undefined
      )?.provider ?? null
    );
  }
  queuedProviders(): ProviderId[] {
    return (
      this.db
        .prepare("SELECT DISTINCT provider FROM jobs WHERE status='queued'")
        .all() as { provider: ProviderId }[]
    ).map((row) => row.provider);
  }
  session(threadId: string): string | null {
    return (
      (
        this.db
          .prepare("SELECT session_id FROM conversations WHERE thread_id=?")
          .get(threadId) as { session_id: string | null } | undefined
      )?.session_id ?? null
    );
  }
  setSession(
    threadId: string,
    sessionId: string,
    expectedProvider?: ProviderId,
  ): void {
    this.transaction(() => {
      const provider = this.provider(threadId);
      if (
        !provider ||
        (expectedProvider !== undefined && provider !== expectedProvider)
      )
        throw new Error("Session runner does not match this thread");
      if (!isSessionId(sessionId, provider))
        throw new Error("Invalid runner session ID");
      const old = this.session(threadId);
      if (old && old !== sessionId)
        throw new Error("Runner session changed unexpectedly");
      if (old === sessionId) return;
      if (
        Number(
          this.db
            .prepare("UPDATE conversations SET session_id=? WHERE thread_id=?")
            .run(sessionId, threadId).changes,
        )
      )
        this.dirty(threadId);
    });
  }
  claim(
    eligibleProviders: readonly ProviderId[] = ["codex", "claude", "opencode"],
  ): Job | undefined {
    const ready = readyPredicate(eligibleProviders);
    if (!eligibleProviders.length) return undefined;
    return this.transaction(() => {
      const job = this.db
        .prepare(
          `UPDATE jobs SET status='running',started_at=? WHERE id=(
        SELECT j.id ${queueJoin}
        WHERE j.status='queued' AND c.blocked_reason IS NULL
          AND j.provider=c.provider AND ${ready}
          AND NOT ${earlierQueued}
        ORDER BY j.queued_at,j.id LIMIT 1)
        AND status='queued' AND NOT EXISTS(SELECT 1 FROM jobs WHERE status='running') RETURNING *`,
        )
        .get(Date.now(), ...eligibleProviders) as Job | undefined;
      if (job) this.dirty(job.thread_id);
      return job;
    });
  }
  /** Read-only, bounded by the per-thread intake cap; never returns task content. */
  queue(
    threadId: string,
    eligibleProviders: readonly ProviderId[] = PROVIDERS,
  ): ThreadQueue {
    const ready = readyPredicate(eligibleProviders);
    const rows = this.db
      .prepare(
        `SELECT j.id,j.provider,j.status,
        CASE WHEN j.status='running' THEN 'running'
          WHEN c.blocked_reason IS NOT NULL THEN 'blocked_thread'
          WHEN j.provider<>c.provider THEN 'runner_mismatch'
          WHEN ${earlierQueued} THEN 'earlier_task'
          WHEN NOT (${ready}) THEN 'runner_unavailable'
          ELSE 'eligible' END AS reason,
        EXISTS(SELECT 1 FROM jobs WHERE status='running') AS worker_busy
        ${queueJoin}
        WHERE j.thread_id=? AND j.status IN('queued','running')
        ORDER BY accepted.sequence LIMIT 8`,
      )
      .all(...eligibleProviders, threadId) as unknown as (QueueItem & {
      worker_busy: number;
    })[];
    return {
      workerBusy: rows.length
        ? Boolean(rows[0]!.worker_busy)
        : Boolean(
            this.db
              .prepare("SELECT 1 FROM jobs WHERE status='running' LIMIT 1")
              .get(),
          ),
      items: rows.map(({ worker_busy: _, ...item }) => item),
    };
  }
  checkpoint(
    id: string,
    outcome: WorkOutcome,
    elapsedMs: number,
  ): { continued: boolean; status: JobStatus; reason: string | null } {
    this.validateCheckpoint(outcome);
    const spent = this.spent(elapsedMs);
    return this.transaction(() => {
      if (this.goal(id)) throw new Error("Supervised goal requires a review");
      return this.acceptCheckpoint(id, outcome, spent);
    });
  }
  private validateCheckpoint(outcome: WorkOutcome): void {
    if (
      !outcome ||
      Object.keys(outcome).sort().join(",") !== "nextAction,outcome,summary" ||
      !["continue", "completed", "blocked"].includes(outcome.outcome) ||
      typeof outcome.summary !== "string" ||
      !outcome.summary.trim() ||
      Buffer.byteLength(outcome.summary) > 4000 ||
      typeof outcome.nextAction !== "string" ||
      Buffer.byteLength(outcome.nextAction) > 4000 ||
      (outcome.outcome === "continue" && !outcome.nextAction.trim())
    )
      throw new Error("Invalid workflow checkpoint");
  }
  private acceptCheckpoint(
    id: string,
    outcome: WorkOutcome,
    spent: number,
  ): { continued: boolean; status: JobStatus; reason: string | null } {
    const job = this.get(id),
      workflow = this.workflow(id);
    if (
      !job ||
      job.status !== "running" ||
      !workflow ||
      workflow.state !== "active"
    )
      throw new Error("Workflow ownership lost");
    const elapsed = this.totalSpent(workflow.elapsed_ms, spent),
      step = workflow.step_count + 1;
    if (step > workflow.max_steps)
      throw new Error("Workflow step limit exceeded");
    let state: Workflow["state"],
      status: JobStatus,
      reason: string | null = null;
    if (outcome.outcome === "completed") {
      state = "completed";
      status = "succeeded";
    } else if (outcome.outcome === "blocked") {
      state = "blocked";
      status = "interrupted";
      reason = "workflow_blocked";
    } else if (elapsed >= workflow.budget_ms) {
      state = "paused";
      status = "interrupted";
      reason = "workflow_budget_exhausted";
    } else if (step >= workflow.max_steps) {
      state = "paused";
      status = "interrupted";
      reason = "workflow_step_limit";
    } else {
      state = "active";
      status = "queued";
    }
    this.db
      .prepare(
        "INSERT INTO workflow_steps(job_id,step,outcome,summary,next_action,elapsed_ms,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        step,
        outcome.outcome,
        outcome.summary,
        outcome.nextAction,
        spent,
        Date.now(),
      );
    this.db
      .prepare(
        "UPDATE workflows SET elapsed_ms=?,step_count=?,last_summary=?,next_action=?,state=? WHERE job_id=?",
      )
      .run(elapsed, step, outcome.summary, outcome.nextAction, state, id);
    this.db
      .prepare(
        "UPDATE jobs SET status=?,result=?,error_code=?,finished_at=?,queued_at=?,notification='pending' WHERE id=?",
      )
      .run(
        status,
        outcome.summary,
        reason,
        status === "queued" ? null : Date.now(),
        status === "queued" ? this.nextQueueTime() : job.queued_at,
        id,
      );
    if (state === "blocked")
      this.db
        .prepare(
          "UPDATE conversations SET blocked_reason='workflow_blocked' WHERE thread_id=?",
        )
        .run(job.thread_id);
    this.dirty(job.thread_id);
    return { continued: status === "queued", status, reason };
  }
  private spent(elapsedMs: number): number {
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0)
      throw new Error("Invalid elapsed execution time");
    return Math.max(1, elapsedMs);
  }
  private totalSpent(before: number, spent: number): number {
    if (!Number.isSafeInteger(before + spent))
      throw new Error("Elapsed execution time overflow");
    return before + spent;
  }
  finish(
    id: string,
    status: "succeeded" | "failed" | "interrupted",
    result: string,
    error: string | null = null,
    elapsedMs = 0,
  ): void {
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0)
      throw new Error("Invalid elapsed execution time");
    this.transaction(() => {
      const job = this.get(id),
        workflow = this.workflow(id);
      if (!job || job.status !== "running")
        throw new Error("Job ownership lost");
      if (workflow) {
        if (status === "succeeded")
          throw new Error("Workflow completion requires a checkpoint");
        this.db
          .prepare(
            "UPDATE workflows SET elapsed_ms=?,state='blocked' WHERE job_id=?",
          )
          .run(this.totalSpent(workflow.elapsed_ms, this.spent(elapsedMs)), id);
      }
      this.db
        .prepare(
          "UPDATE jobs SET status=?,result=?,error_code=?,finished_at=? WHERE id=?",
        )
        .run(status, result, error, Date.now(), id);
      if (status !== "succeeded")
        this.db
          .prepare(
            "UPDATE conversations SET blocked_reason=? WHERE thread_id=?",
          )
          .run(status, job.thread_id);
      this.dirty(job.thread_id);
    });
  }
  /** The actual failed task holding this thread, independent of queued followups. */
  blockingJob(threadId: string): Job | undefined {
    return this.db
      .prepare(
        `WITH RECURSIVE resolved(id) AS (
          SELECT recovery_of FROM jobs WHERE thread_id=? AND status='succeeded' AND recovery_of IS NOT NULL
          UNION SELECT j.recovery_of FROM jobs j JOIN resolved r ON j.id=r.id
            WHERE j.thread_id=? AND j.recovery_of IS NOT NULL
        ) SELECT j.* FROM jobs j JOIN conversations c ON c.thread_id=j.thread_id
        JOIN job_acceptance accepted ON accepted.job_id=j.id
        WHERE j.thread_id=? AND c.blocked_reason IS NOT NULL AND j.status IN('failed','interrupted')
          AND j.id NOT IN(SELECT id FROM resolved)
        ORDER BY accepted.sequence DESC LIMIT 1`,
      )
      .get(threadId, threadId, threadId) as Job | undefined;
  }
  recover(
    id: string,
    threadId: string,
    newId: string,
    options: RecoveryOptions = {},
  ): boolean {
    this.validateIdentity(newId, threadId);
    if (
      options.note !== undefined &&
      (typeof options.note !== "string" || options.note.length > MAX_MESSAGE)
    )
      throw new Error("Invalid recovery instruction");
    if (options.images !== undefined) validateSavedImages(options.images);
    if (
      options.work &&
      (!options.work.goal.trim() ||
        options.work.goal.length > MAX_MESSAGE ||
        !Number.isSafeInteger(options.work.budgetMs) ||
        options.work.budgetMs < 60_000 ||
        options.work.budgetMs > 7_200_000)
    )
      throw new Error("Invalid explicit recovery work budget");
    return this.transaction(() => {
      const old = this.get(id);
      if (
        !old ||
        old.thread_id !== threadId ||
        !["interrupted", "failed"].includes(old.status)
      )
        throw new Error(
          "Only an interrupted/failed job in this thread can be recovered",
        );
      if (this.get(newId)) return false;
      if (
        this.db
          .prepare(
            "SELECT id FROM jobs WHERE thread_id=? AND (status='running' OR (status='queued' AND recovery_of IS NOT NULL)) LIMIT 1",
          )
          .get(threadId)
      )
        throw new Error("A turn or recovery is already pending in this thread");
      if (
        this.db
          .prepare(
            `WITH RECURSIVE recoveries(id,status) AS (
        SELECT id,status FROM jobs WHERE recovery_of=? AND thread_id=? UNION
        SELECT j.id,j.status FROM jobs j JOIN recoveries r ON j.recovery_of=r.id WHERE j.thread_id=?
      ) SELECT id FROM recoveries WHERE status='succeeded' LIMIT 1`,
          )
          .get(id, threadId, threadId)
      )
        throw new Error("This job has already been successfully recovered");
      // Recovering an ancestor follows the latest accepted recovery, including an
      // explicitly fresh budget. Wall-clock timestamps and elapsed totals cannot
      // order distinct budgets or refund execution charged to a later recovery.
      const workflow = this.db
        .prepare(
          `WITH RECURSIVE chain(id) AS (
        SELECT ? UNION SELECT j.id FROM jobs j JOIN chain c ON j.recovery_of=c.id WHERE j.thread_id=?
      ) SELECT w.* FROM workflows w JOIN chain c ON c.id=w.job_id
        JOIN job_acceptance accepted ON accepted.job_id=w.job_id ORDER BY accepted.sequence DESC LIMIT 1`,
        )
        .get(id, threadId) as Workflow | undefined;
      if (
        !options.work &&
        workflow &&
        (workflow.state === "paused" ||
          workflow.elapsed_ms >= workflow.budget_ms ||
          workflow.step_count >= workflow.max_steps)
      )
        throw new Error(
          "Workflow budget is exhausted or paused; start a new explicit !work budget",
        );
      const priorGoal = workflow ? this.goal(workflow.job_id) : undefined;
      const supervised = options.work
        ? options.work.supervised === true
        : Boolean(priorGoal);
      if (supervised && old.provider !== "codex")
        throw new Error("Supervised goals require a Codex-bound thread");
      this.cancelQueued(threadId, "superseded_by_recovery");
      this.insertQueuedJob(
        newId,
        threadId,
        `Manual recovery of message ${id}. The previous turn may have changed files or published content. Inspect the saved session, transcript, journal and external publication receipts before taking any action. Never blindly repeat a publication. Original request:\n\n${old.prompt}${options.note?.trim() ? `\n\nCurrent verified owner recovery instruction (JSON string):\n${JSON.stringify(options.note.trim())}` : ""}${options.work ? `\n\nThe owner explicitly authorized a fresh work session with a new goal (JSON string):\n${JSON.stringify(options.work.goal)}\nReconcile previous actions first, then work only toward this current goal. Previous spent execution remains recorded; this is a new budget.` : ""}`,
        id,
        old.provider,
      );
      if (options.images?.length) this.insertImages(newId, options.images);
      else
        this.db
          .prepare(
            "INSERT INTO job_images SELECT ?,ordinal,media_type,sha256,data FROM job_images WHERE job_id=?",
          )
          .run(newId, id);
      if (workflow || options.work) {
        this.db
          .prepare(
            "INSERT INTO workflows(job_id,goal,budget_ms,elapsed_ms,max_steps,step_count,last_summary,next_action,state) VALUES(?,?,?,?,?,?,?,?,'active')",
          )
          .run(
            newId,
            options.work?.goal ?? workflow!.goal,
            options.work?.budgetMs ?? workflow!.budget_ms,
            options.work ? 0 : workflow!.elapsed_ms,
            options.work ? 32 : workflow!.max_steps,
            options.work ? 0 : workflow!.step_count,
            workflow?.last_summary ?? null,
            workflow?.next_action ?? null,
          );
        if (workflow && !options.work)
          this.db
            .prepare(
              "INSERT INTO workflow_steps SELECT ?,step,outcome,summary,next_action,elapsed_ms,created_at FROM workflow_steps WHERE job_id=?",
            )
            .run(newId, workflow.job_id);
      }
      if (supervised) {
        const sameGoal = !options.work || options.work.goal === workflow?.goal;
        this.db
          .prepare(
            "INSERT INTO goals(job_id,pending_output,stalled_count,last_review,last_candidate) VALUES(?,?,?,?,?)",
          )
          .run(
            newId,
            sameGoal ? (priorGoal?.pending_output ?? null) : null,
            !options.work ? (priorGoal?.stalled_count ?? 0) : 0,
            priorGoal?.last_review ?? null,
            sameGoal ? (priorGoal?.last_candidate ?? null) : null,
          );
        if (priorGoal && !options.work)
          this.db
            .prepare(
              "INSERT INTO goal_reviews SELECT ?,step,candidate,review,progress,elapsed_ms,created_at FROM goal_reviews WHERE job_id=?",
            )
            .run(newId, priorGoal.job_id);
      }
      this.db
        .prepare(
          "UPDATE conversations SET blocked_reason=NULL WHERE thread_id=?",
        )
        .run(threadId);
      this.dirty(threadId);
      return true;
    });
  }
  private cancelQueued(threadId: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE goals SET control='stop' WHERE job_id IN(SELECT id FROM jobs WHERE thread_id=? AND status='queued')",
      )
      .run(threadId);
    this.db
      .prepare(
        "UPDATE workflows SET state='cancelled' WHERE job_id IN(SELECT id FROM jobs WHERE thread_id=? AND status='queued')",
      )
      .run(threadId);
    this.db
      .prepare(
        "UPDATE jobs SET status='cancelled',error_code=?,finished_at=? WHERE thread_id=? AND status='queued'",
      )
      .run(reason, Date.now(), threadId);
  }
  resetSession(threadId: string): void {
    this.transaction(() => {
      if (
        this.db
          .prepare("SELECT id FROM jobs WHERE thread_id=? AND status='running'")
          .get(threadId)
      )
        throw new Error("A turn is still running");
      this.cancelQueued(threadId, "owner_started_new_session");
      this.db
        .prepare(
          `UPDATE jobs SET status='cancelled',error_code='owner_started_new_session',finished_at=?
        WHERE thread_id=? AND status='interrupted' AND id IN(SELECT g.job_id FROM goals g JOIN workflows w ON w.job_id=g.job_id WHERE w.state='paused')`,
        )
        .run(Date.now(), threadId);
      this.db
        .prepare(
          "UPDATE goals SET control='stop' WHERE job_id IN(SELECT job_id FROM workflows WHERE state='paused' AND job_id IN(SELECT id FROM jobs WHERE thread_id=? AND error_code='owner_started_new_session'))",
        )
        .run(threadId);
      this.db
        .prepare(
          "UPDATE workflows SET state='cancelled' WHERE state='paused' AND job_id IN(SELECT id FROM jobs WHERE thread_id=? AND error_code='owner_started_new_session')",
        )
        .run(threadId);
      if (
        Number(
          this.db
            .prepare(
              "UPDATE conversations SET session_id=NULL,blocked_reason=NULL WHERE thread_id=?",
            )
            .run(threadId).changes,
        )
      )
        this.dirty(threadId);
    });
  }
  cancel(id: string, threadId: string): boolean {
    return this.transaction(() => {
      const changed =
        Number(
          this.db
            .prepare(
              "UPDATE jobs SET status='cancelled',error_code='owner_cancelled',finished_at=? WHERE id=? AND thread_id=? AND status='queued'",
            )
            .run(Date.now(), id, threadId).changes,
        ) === 1;
      if (changed) {
        this.db
          .prepare("UPDATE goals SET control='stop' WHERE job_id=?")
          .run(id);
        this.db
          .prepare("UPDATE workflows SET state='cancelled' WHERE job_id=?")
          .run(id);
        this.dirty(threadId);
      }
      return changed;
    });
  }
  recent(threadId: string): Job[] {
    return this.db
      .prepare(
        `SELECT j.* FROM jobs j JOIN job_acceptance accepted ON accepted.job_id=j.id
        WHERE j.thread_id=? ORDER BY accepted.sequence DESC LIMIT 8`,
      )
      .all(threadId) as unknown as Job[];
  }
  pendingNotification(): Job | undefined {
    return this.db
      .prepare(
        "SELECT * FROM jobs WHERE (status IN('succeeded','failed','interrupted') OR (status='cancelled' AND id IN(SELECT job_id FROM goals))) AND notification='pending' ORDER BY finished_at,id LIMIT 1",
      )
      .get() as Job | undefined;
  }
  notification(id: string, state: "sending" | "sent" | "ambiguous"): void {
    this.db.prepare("UPDATE jobs SET notification=? WHERE id=?").run(state, id);
  }
  effect(threadId: string): Effect | undefined {
    return this.db
      .prepare("SELECT * FROM effects WHERE thread_id=?")
      .get(threadId) as Effect | undefined;
  }
  pendingEffects(now = Date.now(), limit = 2): Effect[] {
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      limit > 100
    )
      throw new Error("Invalid effect query");
    return this.db
      .prepare(
        "SELECT * FROM effects WHERE (exported_generation<generation OR synced_generation<generation) AND retry_at<=? ORDER BY retry_at,thread_id LIMIT ?",
      )
      .all(now, limit) as unknown as Effect[];
  }
  completeEffect(
    threadId: string,
    generation: number,
    kind: "transcript" | "memory",
  ): void {
    this.transaction(() => {
      const effect = this.checkedEffect(threadId, generation);
      if (kind !== "transcript" && kind !== "memory")
        throw new Error("Invalid effect kind");
      if (kind === "memory" && effect.exported_generation < generation)
        throw new Error("Transcript must be exported before memory sync");
      const column =
        kind === "transcript" ? "exported_generation" : "synced_generation";
      this.db
        .prepare(
          `UPDATE effects SET ${column}=MAX(${column},?) WHERE thread_id=?`,
        )
        .run(generation, threadId);
      this.db
        .prepare(
          "UPDATE effects SET attempts=0,retry_at=0,last_error=NULL WHERE thread_id=? AND exported_generation=generation AND synced_generation=generation",
        )
        .run(threadId);
    });
  }
  failEffect(
    threadId: string,
    generation: number,
    error: EffectError,
    now = Date.now(),
  ): void {
    if (
      ![
        "transcript_export_failed",
        "memory_sync_failed",
        "memory_sync_blocked",
      ].includes(error)
    )
      throw new Error("Invalid effect error");
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("Invalid effect retry time");
    this.transaction(() => {
      const effect = this.checkedEffect(threadId, generation);
      if (generation < effect.generation) return;
      const attempts = Math.min(effect.attempts + 1, 20);
      const delay = Math.min(1000 * 2 ** (attempts - 1), 300_000);
      if (!Number.isSafeInteger(now + delay))
        throw new Error("Effect retry time overflow");
      this.db
        .prepare(
          "UPDATE effects SET attempts=?,retry_at=?,last_error=? WHERE thread_id=?",
        )
        .run(attempts, now + delay, error, threadId);
    });
  }
  private checkedEffect(threadId: string, generation: number): Effect {
    const effect = this.effect(threadId);
    if (
      !effect ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      generation > effect.generation
    )
      throw new Error("Invalid effect generation");
    return effect;
  }
}
