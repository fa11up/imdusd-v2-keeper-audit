// The keeper's state files, under STATE_DIR or the repo's state/ (gitignored). A fork test points STATE_DIR elsewhere so it
// can never touch a running keeper's state.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

/** One writer per state dir. Returns the release; a dead holder's lock is replaced, a live one's refuses. */
export function takeLock() {
  mkdirSync(stateDir(), { recursive: true });
  const p = statePath("keeper.lock");
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(p, `${process.pid}\n`, { flag: "wx" });
      return () => rmSync(p, { force: true });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(readFileSync(p, "utf8"));
      if (pid && pidAlive(pid)) throw new Error(`keeper pid ${pid} holds ${p}: one writer per state dir. Stop it first`);
      rmSync(p, { force: true });
    }
  }
  throw new Error(`could not take ${p}`);
}

export function readState(name, fallback) {
  try {
    const p = statePath(name);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}

/** Written whole or not at all: a crash mid-write must not lose a cursor. */
export function writeState(name, value) {
  mkdirSync(stateDir(), { recursive: true });
  const p = statePath(name);
  writeFileSync(`${p}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
}
