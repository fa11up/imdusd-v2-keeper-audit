// PROPERTY (audit wave 4, P3): one writer per key. On one machine, whatever STATE_DIR each process uses, at most one live process holds
// a key (and at most one holds a state dir); a dead holder's lock is taken over. Across machines nothing local can lock: --execute
// refuses to start while the mempool holds a nonce of the key this state dir never signed (foreignPending).
// Seeded fuzz: real child processes over random dirs and keys, killed at random; and random mempool/journal states.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w4-lock-"));
process.env.KEEPER_LOCK_DIR = mkdtempSync(join(tmpdir(), "keeper-w4-keylocks-"));
const state = await import("../lib/state.mjs");
const { recordIntent } = await import("../lib/journal.mjs");

const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const KEYS = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000b2"];
const STATE_URL = new URL("../lib/state.mjs", import.meta.url).href;

function child(dir, key) {
  const code = `const s = await import(${JSON.stringify(STATE_URL)}); try { s.takeLock(); s.takeKeyLock(${JSON.stringify(key)}); console.log("got"); setInterval(() => {}, 1000); } catch (e) { console.log("refused"); process.exit(0); }`;
  const p = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, STATE_DIR: dir }, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve) => p.stdout.once("data", (b) => resolve({ p, got: String(b).trim() === "got", dir, key })));
}

test("property P3: at most one live process per key and per state dir on this machine; a dead holder is replaced (seeded fuzz, 12 rounds)", async () => {
  const r = rng(0x73);
  const dirs = [mkdtempSync(join(tmpdir(), "kd1-")), mkdtempSync(join(tmpdir(), "kd2-")), mkdtempSync(join(tmpdir(), "kd3-"))];
  let live = [];
  const failures = [];
  try {
    for (let round = 0; round < 12; round++) {
      // Kill some holders (a crash: the lock file stays behind).
      for (const h of live) if (r() < 0.4) { h.p.kill("SIGKILL"); h.dead = true; }
      await new Promise((res) => setTimeout(res, 50));
      live = live.filter((h) => !h.dead);
      const c = await child(dirs[Math.floor(r() * dirs.length)], KEYS[Math.floor(r() * KEYS.length)]);
      const clash = live.some((h) => h.key === c.key || h.dir === c.dir);
      if (c.got && clash) failures.push(`round ${round}: a second writer took ${c.key} / ${c.dir}`);
      if (!c.got && !clash) failures.push(`round ${round}: refused with no live holder of ${c.key} / ${c.dir}`);
      if (c.got) live.push(c);
    }
  } finally {
    for (const h of live) h.p.kill("SIGKILL");
  }
  assert.deepEqual(failures, []);
});

test("property P3: --execute refuses while the mempool holds a nonce of the key this state dir never signed (seeded fuzz, 300 states)", async () => {
  const { foreignPending } = await import("../lib/tx.mjs");
  const r = rng(0x74);
  for (let i = 0; i < 300; i++) {
    rmSync(state.statePath("tx"), { recursive: true, force: true });
    const latest = Math.floor(r() * 5);
    const pending = latest + Math.floor(r() * 3);
    const mine = new Set();
    for (let n = latest; n < latest + 3; n++) if (r() < 0.5) { mine.add(n); recordIntent({ nonce: n, hash: `0x${n}`, signed: `0x${n}`, label: "x" }); }
    const provider = { getTransactionCount: async (_a, tag) => (tag === "pending" ? pending : latest) };
    const why = await foreignPending(provider, KEYS[0]);
    let foreign = false;
    for (let n = latest; n < pending; n++) if (!mine.has(n)) foreign = true;
    assert.equal(Boolean(why), foreign, `latest ${latest} pending ${pending} mine ${[...mine]}: ${why}`);
  }
});
