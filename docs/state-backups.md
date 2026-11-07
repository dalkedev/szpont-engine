# State backups and restore

Use the standalone Node 24 tool to create a consistent SQLite snapshot, including
committed WAL pages. It opens the source read-only, verifies database integrity and
foreign keys, and publishes a complete standalone database at a **new** path. No bot
token, engine configuration, Discord connection or model call is needed.

The tool supports legacy schemas 0–4 and current source schema 5. It does not migrate them, and
refuses a newer schema. Both `backup` and `restore` preserve jobs, sessions, workflow
checkpoints, notification receipts, pending transcript/memory effects private image bytes, saved goal candidates and supervisor reviews.

## Create a snapshot

Run as the dedicated service account, using its Node 24 runtime. Provision the source
and destination directories outside the public checkout, owned by that account with
mode `0700`. The destination parent must already exist; the tool does not change
permissions on existing directories. For example, with an already owned `/srv/szpont`:

```sh
install -d -m 700 /srv/szpont/backups
node /absolute/source/scripts/state-snapshot.mjs backup \
  --source /srv/szpont/state/agent.sqlite \
  --destination /srv/szpont/backups/pre-0.6.1.sqlite
```

The engine may keep running during an online backup. SQLite copies a consistent
database, rather than copying a main file without its live WAL. A busy writer may
extend backup time. For a coordinated upgrade checkpoint, stop the service and hold
its existing instance lock before backing up the database and private workspace.

Success prints only the operation, schema version, byte count and SHA-256 digest.
It does not print database rows, paths or secrets. Exit code `1` indicates failure;
diagnostics contain a fixed error code. Use a new destination filename for every
snapshot: an existing file, dangling symlink or SQLite sidecar is never overwritten.

Files are staged in an owned `0700` directory beside the destination, verified with
SQLite `integrity_check` and `foreign_key_check`, normalized to DELETE journal mode,
flushed and atomically published without replacement. The published file has mode
`0600`. The source database is never checkpointed, migrated or opened for writing.
SQLite may maintain its normal shared-memory bookkeeping when reading a live WAL.

## Restore into a new state directory

1. Stop the service and keep its instance lock held. Retain the current state folder;
   restoration never overwrites it. Use the same service account and Node 24 runtime.
2. Create a fresh owned private directory and restore into a new file:

   ```sh
   install -d -m 700 /srv/szpont/restored-state
   node /absolute/source/scripts/state-snapshot.mjs restore \
     --source /srv/szpont/backups/pre-0.6.1.sqlite \
     --destination /srv/szpont/restored-state/agent.sqlite
   ```

3. Inspect the restored database before enabling the engine. A snapshot restores
   the queue and receipts **as they were at snapshot time**. Reconcile queued/running
   jobs with journals and actual external results, including actions completed after
   the snapshot. Starting an old queue without that review can repeat external work.
   A successful integrity check establishes database consistency, not whether a post,
   payment or deployment already happened.
4. Point `SZPONT_STATE_DIR` and the service's instance-lock path to the new directory.
   Configure the matching private workspace separately. Keep only one engine instance.
   With Docker, use a separately restored state volume and stop the previous container
   before switching; a host path example is not a command to modify a container volume.
5. Start the chosen engine version under its instance lock. Version 0.6.1 retains schema 4 and migrates
   public schemas 0, 1, 2 and 3 to schema 4 at startup, preserving legacy provider
   identities as Codex. Inspect `!status`, interrupted jobs, workflow checkpoints
   and maintenance health. Recover uncertain work only after reconciling its action
   receipts; restoration itself never resumes a job.

Restore uses the same verified online-backup mechanism as backup. It creates a new
database and never starts the engine, changes service configuration, alters queue
statuses, resets a session or grants permission to repeat an action.

## Upgrade and rollback

Version 0.6.1 retains public schema 4 from 0.5.0. Its fresh-budget recovery keeps
the saved provider session, history and prior charged execution. A backup restores
those records as they were, so reconcile newer recovery jobs and external actions
before starting either version against restored state.

Version 0.5.0 adds private image bytes, MIME types and SHA-256 digests to jobs and
migrates public schema 3 to schema 4. Existing text jobs, provider bindings and
sessions are preserved. Schema-4 snapshots include all attachment bytes, including
images retained by manual recovery. The 0.4.0 engine rejects schema 4; rolling back
requires its compatible pre-upgrade snapshot and reconciliation of later accepted
work. Do not delete the image table or lower the schema version to force a downgrade.


Version 0.4.0 adds immutable conversation-provider bindings and job-provider snapshots,
and migrates public schemas 0, 1 and 2 to schema 3. Every legacy conversation and job
remains Codex, independently of the new default runner. Back up the pre-upgrade database
and matching workspace before starting the new engine. The 0.3.x engines reject schema 3;
rolling back requires restoring their compatible pre-upgrade snapshot into a new private
state directory and reconciling intervening actions. Do not drop provider columns or
lower the recorded schema version to make an older engine open current state.

Version 0.3.1 adds an immutable acceptance ledger and migrates public schema 1 to 2.
Keep a verified pre-upgrade snapshot and matching workspace before starting it.
The 0.3.0 engine rejects schema 2; rolling back requires restoring its schema 1
snapshot into a new state directory, reconciling intervening work, then switching
the matching binary and workspace together. Public and private runtime databases
are not interchangeable: the public engine rejects private lane/publication state.

Before upgrading from 0.2, retain a verified **schema 0** snapshot and a matching private
workspace checkpoint. Version 0.3 adds durable workflows, effect generations and queue
ordering metadata. Do not point the old 0.2 engine at a database already migrated to
schema 1: that engine predates the version guard and cannot preserve the new semantics.

To roll back, stop 0.3, restore the pre-upgrade schema 0 snapshot into a new state
directory, reconcile intervening external actions and switch the old service to that
directory and its matching workspace. Keep the migrated database for investigation.
Do not lower `PRAGMA user_version`, delete tables or copy a running main database as a
shortcut. A state snapshot does not roll back files or external side effects.

## Scope and failure handling

- The snapshot contains private prompts, results, identifiers and image attachments. Keep it outside the
  public source, Docker build context, public Git remote and public CI artifacts.
  File permissions are access control, not encryption; encrypt off-host backups with
  your own backup system and check its destination permissions.
- Back up private Markdown memory, Git history and artifacts separately, using a
  coordinated stopped checkpoint when you need them to match SQLite exactly. Runner
  authentication, CLI session stores and browser profiles are separate private data and
  are not included.
- Absolute paths are required. Direct paths and directory aliases into this public
  checkout are rejected. Source files and existing source sidecars must be owned
  regular files with a single hard link. Source-file symlinks and all existing
  destination entries/sidecars are rejected. Private parents must be owned by the
  current account with no group/other permissions. Run on a local POSIX filesystem
  supporting SQLite locking, hard links and directory `fsync`.
- The boundary assumes a trusted service account controlling its private directories;
  it does not isolate a malicious process running as that same account or root.
- Normal failures remove staging files. A forced kill or power loss can leave a private
  `.szpont-snapshot-*` staging directory. After confirming no snapshot process is running,
  remove only that abandoned staging directory. A complete published file can survive
  an interruption just before success is reported; the next invocation refuses to
  replace it. Inspect and verify it, or use a new destination filename.
- An integrity failure, unsupported future schema or existing destination is a stop
  condition. Preserve the originals and investigate; there is no `--force` option.

The offline test suite covers legacy backup/restore and migration, current workflow
and effect state, live WAL contents, private permissions, concurrent publication,
aliases, existing sidecars, future schemas, corrupt inputs and sanitized CLI output.
Actual power-loss durability and every network filesystem are not simulated.

## Runner metadata (schema 3)

Version 0.4.0 migrates public schemas 0, 1 and 2 to schema 3.
Legacy conversations and jobs are labelled Codex, independently of the configured
default. The snapshot tool preserves provider columns, immutable bindings and
provider-specific session IDs. It does not start or replay jobs. The 0.3.x
engines reject this state; restore a compatible pre-upgrade snapshot before
rolling back and reconcile any later actions separately.


## Image attachments (schema 4)

Version 0.5.0 stores attachment bytes in SQLite, so no separate image-directory
backup is needed for queued jobs, workflow continuation or manual recovery. The
snapshot tool preserves the images and their media types, order and SHA-256 digests.
Generated per-turn `.turn-images-*` files are disposable and are not part of the
backup. See [image input](image-input.md) for limits, retention and private cleanup.
