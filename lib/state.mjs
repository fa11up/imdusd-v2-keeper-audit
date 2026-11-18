// The keeper's state files, under STATE_DIR or the repo's state/ (gitignored). A fork test points STATE_DIR elsewhere so it
// can never touch a running keeper's state.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const stateDir = () => process.env.STATE_DIR ?? fileURLToPath(new URL("../state/", import.meta.url));
export const statePath = (name) => join(stateDir(), name);
/** A report-only run's own state: it must never move a live keeper's cursors, proofs or depth hour. */
export const reportStateDir = () => join(stateDir(), "report");

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

function lockFile(p, what, { reentrant = false, note = "" } = {}) {
  mkdirSync(dirname(p), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(p, `${process.pid}\n${note}`, { flag: "wx" });
      return () => rmSync(p, { force: true });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const [pidText, dir] = readFileSync(p, "utf8").split("\n");
      const pid = Number(pidText);
      // This process already holds it (several contexts on one key, as the fork tests make): one writer, nothing to release twice.
      if (reentrant && pid === process.pid) return () => {};
      if (pid && pidAlive(pid)) throw new Error(`keeper pid ${pid} holds ${p}${dir ? ` (state dir ${dir})` : ""}: ${what}. Stop it first`);
      rmSync(p, { force: true });
    }
  }
  throw new Error(`could not take ${p}`);
}

/** One writer per state dir. Returns the release; a dead holder's lock is replaced, a live one's refuses. */
export function takeLock() {
  mkdirSync(stateDir(), { recursive: true });
  return lockFile(statePath("keeper.lock"), "one writer per state dir");
}

/** Where the per-key locks live: one place per machine, whatever STATE_DIR says. */
export const keyLockDir = () => process.env.KEEPER_LOCK_DIR ?? join(homedir(), ".imdusd-v2-keeper", "locks");

/**
 * One writer per KEY on this machine (audit wave 4, P3): the spend ledger, the order latch and the nonce journal are per state dir,
 * so a second --execute process on the same key with another STATE_DIR would have its own cap, decide the same fall and sign the same
 * nonce. The lock is named by the signer's address in keyLockDir(). Another machine on the same key is not seen here (see
 * foreignPending in lib/tx.mjs and the README).
 */
export function takeKeyLock(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address))) throw new Error(`takeKeyLock: ${address} is not an address`);
  return lockFile(join(keyLockDir(), `${String(address).toLowerCase()}.lock`), "one writer per key on this machine", { reentrant: true, note: `${stateDir()}\n` });
}

/**
 * A state file that exists and cannot be read (torn, garbled, wrong shape, EACCES, EIO). It is never read as empty: what it held
 * (a paid order, the day's spend, an open nonce) is unknown, so whatever depends on it refuses, and it is never written over.
 * A human looks at it, then fixes or removes it (audit wave 4, C9).
 */
export class StateUnreadable extends Error {
  constructor(name, why) {
    super(`state file ${name} exists and cannot be read (${why}): everything that depends on it is held until a human fixes or removes it`);
    this.code = "STATE_UNREADABLE";
    this.file = name;
  }
}
export const isUnreadable = (e) => e?.code === "STATE_UNREADABLE";

const SHAPES = new Map();
/** Declare the shape a safety file must have: a file of another shape is unreadable for every read AND write of it. */
export const declareShape = (name, check) => SHAPES.set(name, check);

/** The parsed file, `fallback` ONLY when it does not exist, and StateUnreadable when it exists and cannot be read. `check` may refuse a shape. */
export function readState(name, fallback, check = SHAPES.get(name) ?? null) {
  const p = statePath(name);
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw new StateUnreadable(name, e.code ?? e.message);
  }
  let v;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    throw new StateUnreadable(name, `not JSON: ${String(e.message).slice(0, 80)}`);
  }
  const bad = check?.(v);
  if (bad) throw new StateUnreadable(name, bad);
  return v;
}

/**
 * For state whose loss costs only work (a cursor, a timer, the alert memory), never money: an unreadable file is MOVED ASIDE
 * (kept for a human, <name>.unreadable-<time>), noted in journal.jsonl, and `fallback` is used. Never for orders, spend, the buy
 * gap or the send journal: those use readState and fail closed.
 */
export function readStateOr(name, fallback) {
  try {
    return readState(name, fallback);
  } catch (e) {
    if (!isUnreadable(e)) throw e;
    const p = statePath(name);
    const aside = `${p}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      renameSync(p, aside);
    } catch { /* gone or unmovable: the write below refuses over it, and the loop says so */ }
    try {
      appendFileSync(statePath("journal.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), step: "state-moved-aside", file: name, aside, why: e.message })}\n`);
    } catch { /* the move is the record */ }
    return fallback;
  }
}

/** Write-to-temp, fsync, rename, fsync the directory: after a crash the file is the old one or the new one, never part of either. */
export function writeAtomic(p, text) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, p);
  try {
    const d = openSync(dirname(p), "r");
    try { fsyncSync(d); } finally { closeSync(d); }
  } catch { /* a platform without directory fsync */ }
}

/** Written whole or not at all, and never over a file that exists and cannot be read (that would erase what it held). */
export function writeState(name, value) {
  mkdirSync(stateDir(), { recursive: true });
  const p = statePath(name);
  if (existsSync(p)) readState(name, null); // throws StateUnreadable rather than overwrite it
  writeAtomic(p, `${JSON.stringify(value, null, 2)}\n`);
}
