import { backup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// This tool deliberately does not import the engine, its configuration or any secrets.
export const MAX_SCHEMA_VERSION = 5;
const publicRoot = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const usage =
  "Usage: node scripts/state-snapshot.mjs backup|restore --source /private/input.sqlite --destination /private/new.sqlite";
const withinPublic = (path) =>
  path === publicRoot || path.startsWith(publicRoot + sep);
const fail = (code) => {
  throw Object.assign(new Error(code), { snapshotCode: code });
};
const sameFile = (left, right) =>
  left.dev === right.dev && left.ino === right.ino;

async function absent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    fail("path_check_failed");
  }
  fail("destination_exists");
}

async function privateParent(path) {
  const parent = await realpath(dirname(path));
  if (withinPublic(parent)) fail("public_checkout_forbidden");
  const info = await stat(parent);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    fail("parent_must_be_owned_and_private");
  return parent;
}

async function validateSourceSidecars(path) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    let info;
    try {
      info = await lstat(path + suffix);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      fail("path_check_failed");
    }
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.()
    )
      fail("source_sidecar_must_be_owned_regular_file");
  }
}

function inspect(db) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version > MAX_SCHEMA_VERSION) fail("future_schema_unsupported");
  if (!Number.isSafeInteger(version) || version < 0)
    fail("invalid_schema_version");
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
      .all()
      .map((row) => row.name),
  );
  if (!["conversations", "jobs", "controls"].every((name) => tables.has(name)))
    fail("not_an_engine_database");
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (
    integrity.length !== 1 ||
    Object.values(integrity[0])[0] !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").all().length !== 0
  )
    fail("database_integrity_failed");
  return version;
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Create a consistent verified database at a new private path; never replace a file. */
export async function snapshotState({ operation, source, destination }) {
  if (Number(process.versions.node.split(".")[0]) !== 24)
    fail("node_24_required");
  if (!["backup", "restore"].includes(operation)) fail("invalid_operation");
  if (
    typeof source !== "string" ||
    typeof destination !== "string" ||
    !isAbsolute(source) ||
    !isAbsolute(destination) ||
    source.includes("\0") ||
    destination.includes("\0")
  )
    fail("absolute_paths_required");
  source = resolve(source);
  destination = resolve(destination);
  if (withinPublic(source) || withinPublic(destination))
    fail("public_checkout_forbidden");

  let temporary;
  let db;
  try {
    const sourceInfo = await lstat(source);
    if (
      !sourceInfo.isFile() ||
      sourceInfo.isSymbolicLink() ||
      sourceInfo.nlink !== 1 ||
      sourceInfo.uid !== process.getuid?.()
    )
      fail("source_must_be_owned_regular_file");
    const canonicalSource = await realpath(source);
    if (withinPublic(canonicalSource)) fail("public_checkout_forbidden");
    await privateParent(source);
    await validateSourceSidecars(canonicalSource);
    const parent = await privateParent(destination);
    destination = join(parent, basename(destination));
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      await absent(destination + suffix);
    if (source === destination || canonicalSource === destination)
      fail("destination_exists");

    // All temporary material stays in the private destination filesystem. A killed
    // process can leave this private staging directory, but never a partial final file.
    temporary = await mkdtemp(join(parent, ".szpont-snapshot-"));
    await chmod(temporary, 0o700);
    const staged = join(temporary, "state.sqlite");
    const reservation = await open(staged, "wx", 0o600);
    await reservation.close();
    db = new DatabaseSync(canonicalSource, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000");
    if (!sameFile(sourceInfo, await lstat(canonicalSource)))
      fail("source_changed_during_open");
    inspect(db);
    await backup(db, staged);
    db.close();
    db = undefined;

    // Normalize only the staged copy into a standalone file: no source WAL
    // checkpoint or schema migration is performed by this tool.
    const verified = new DatabaseSync(staged);
    let schemaVersion;
    try {
      verified.exec("PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE");
      schemaVersion = inspect(verified);
    } finally {
      verified.close();
    }
    await chmod(staged, 0o600);
    const file = await open(staged, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    const info = await stat(staged);
    const sha256 = await digest(staged);
    // A hard link publishes the complete verified file atomically and fails if
    // another process created the destination. rename() could silently overwrite.
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      await absent(destination + suffix);
    await link(staged, destination);
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return { operation, schemaVersion, bytes: info.size, sha256 };
  } catch (error) {
    if (error.snapshotCode) throw error;
    if (error.code === "EEXIST") fail("destination_exists");
    // SQLite errors can contain SQL, paths or data; keep diagnostics predictable.
    fail("snapshot_failed");
  } finally {
    db?.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

export function parseSnapshotArguments(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return null;
  const [operation, ...rest] = args;
  if (!["backup", "restore"].includes(operation) || rest.length !== 4)
    fail("invalid_arguments");
  const options = { operation };
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    if (!["--source", "--destination"].includes(name)) fail("invalid_arguments");
    const key = name.slice(2);
    if (options[key] !== undefined) fail("invalid_arguments");
    options[key] = rest[index + 1];
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseSnapshotArguments(process.argv.slice(2));
    console.log(options ? JSON.stringify(await snapshotState(options)) : usage);
  } catch (error) {
    console.error(
      "State snapshot failed: " + (error.snapshotCode || "snapshot_failed"),
    );
    if (error.snapshotCode === "invalid_arguments") console.error(usage);
    process.exitCode = 1;
  }
}
