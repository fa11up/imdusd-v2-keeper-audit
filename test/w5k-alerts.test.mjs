// wave-5 keeper audit #7 + #21: ALERT DELIVERY.
// PROPERTY (P1/P5): a condition is heard as soon as it is judged at its level: (a) a key raised at a HIGHER level than it last fired at
// is emitted in that same raise (warn -> critical never waits out the warn's repeat interval); (b) a raise whose Telegram delivery
// failed is tried again on the next raise of the key, until one is accepted; (c) a delivered key still repeats only after its interval.
// Fuzzed: random level walks, random Telegram failures (throw, 429, 5xx), random raise cadence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5k-alerts-"));
const { makeAlerts } = await import("../lib/alerts.mjs");
const { rng } = await import("./lib/rh-world.mjs");

const RANK = { info: 0, warn: 1, critical: 2 };
const REPEAT = { critical: 3600, warn: 6 * 3600, info: 24 * 3600 };

test("#7 (judge proof shape): warn at 0 min, critical from 30 min on: the first CRITICAL line is at 30 min, not 60", async () => {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  let t = 0;
  const lines = [];
  const a = makeAlerts((s) => lines.push({ t, s }), "x", { now: () => t });
  for (t = 0; t <= 90 * 60; t += 120) await a.raise(t >= 1800 ? "critical" : "warn", "bridge-index-gap-4663", "gap");
  const firstCrit = lines.find((l) => l.s.startsWith("ALERT CRITICAL"));
  assert.ok(firstCrit, "no critical line at all");
  assert.equal(firstCrit.t, 1800, `first critical at ${firstCrit.t / 60} min`);
});

test("#21 (judge proof shape): a critical whose first Telegram delivery fails is tried again on the next raise", async () => {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  process.env.TELEGRAM_BOT_TOKEN = "t"; process.env.TELEGRAM_CHAT_ID = "c";
  let t = 0, n = 0;
  const tried = [];
  const fetchImpl = async () => { tried.push(t / 60); if (n++ === 0) throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }); return { ok: true }; };
  const a = makeAlerts(() => {}, "x", { fetchImpl, now: () => t });
  for (t = 0; t < 3600; t += 120) await a.raise("critical", "bridge-queued-forged-mainnet-7", "forged");
  delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID;
  assert.deepEqual(tried, [0, 2]);
});

test("property: escalation fires at once, undelivered retries, delivered repeats only after its interval (60 seeded walks)", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "t"; process.env.TELEGRAM_CHAT_ID = "c";
  try {
    for (let seed = 1; seed <= 60; seed++) {
      rmSync(process.env.STATE_DIR, { recursive: true, force: true });
      const r = rng(seed * 7919);
      let t = 0;
      const sends = []; // { t, level, ok }
      let curLevel = null;
      const fetchImpl = async (url, o) => {
        const level = JSON.parse(o.body).text.split("\n")[0].split(" ").pop().toLowerCase();
        const x = r();
        const ok = x > 0.3;
        sends.push({ t, level, ok });
        if (x < 0.1) throw new Error("ECONNRESET");
        return { ok, status: ok ? 200 : x < 0.2 ? 429 : 502 };
      };
      const a = makeAlerts(() => {}, "x", { fetchImpl, now: () => t });
      let lastFull = null; // time of the last fire that was not a pure delivery retry
      let maxSent = null; // the level the key last fired at (a pure retry keeps it)
      for (let i = 0; i < 40; i++) {
        t += Math.floor(r() * 900);
        curLevel = ["info", "warn", "critical"][Math.floor(r() * 3)];
        const before = sends.length;
        await a.raise(curLevel, "k", "m");
        const fired = sends.length > before;
        const prevUndelivered = before > 0 && !sends[before - 1].ok;
        const higher = maxSent === null || RANK[curLevel] > RANK[maxSent];
        if (higher) assert.ok(fired, `seed ${seed} step ${i}: ${curLevel} after ${maxSent} did not fire at once`);
        if (prevUndelivered) assert.ok(fired, `seed ${seed} step ${i}: an undelivered message was not retried`);
        if (fired && !higher && !prevUndelivered) assert.ok(t - lastFull >= REPEAT[curLevel], `seed ${seed} step ${i}: fired ${t - lastFull}s after the last (interval ${REPEAT[curLevel]})`);
        if (fired) {
          const pureRetry = prevUndelivered && !higher && t - lastFull < REPEAT[curLevel];
          if (!pureRetry) { lastFull = t; maxSent = curLevel; }
        }
      }
    }
  } finally {
    delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID;
  }
});
