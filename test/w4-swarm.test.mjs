// PROPERTY (audit wave 4, P1): untrusted /swarm input never takes a duty down with it. For any document the plane serves, the NHI
// index is either refused (no read) or a value in [0, 1e18] the leaf can be asked about; and whatever the NHI decision does (a hostile
// document, a failing read), the feeds pass still makes the fall decision and the legs-apart check. Seeded fuzz over documents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w4-swarm-"));
const { nhiFromSwarm } = await import("../lib/plane.mjs");
const { runFeeds } = await import("../lib/feeds.mjs");
const { feedsWorld } = await import("./lib/feeds-world.mjs");

const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const WAD = 10n ** 18n;
const VALUES = [0, 1, 5, 10, -1, -100, 1e20, 2 ** 60, NaN, Infinity, -Infinity, 1.5, "7", "", null, undefined, true, {}, [], "-3"];
const pick = (r) => (r() < 0.5 ? VALUES[Math.floor(r() * VALUES.length)] : Math.floor((r() - 0.3) * 10 ** (1 + Math.floor(r() * 6))));
const doc = (r) => ({
  health: { agentsOnline: pick(r), seatsEnrolled: pick(r), verifierUp: r() < 0.5 ? true : pick(r), publisherUp: true, deployerUp: r() < 0.5 },
  counts: { jobStates: { completed: pick(r), blocked: pick(r), cancelled: pick(r) } },
});

test("property P1: any /swarm document gives an index in [0, 1e18] or none (seeded fuzz, 3000 documents)", () => {
  const r = rng(0x51);
  for (let i = 0; i < 3000; i++) {
    const d = doc(r);
    let v = null;
    try { v = nhiFromSwarm(d); } catch { v = null; }
    if (v !== null) assert.ok(v >= 0n && v <= WAD, `${JSON.stringify(d)} -> ${v}`);
  }
});

test("property P1: a hostile /swarm or a failing NHI read never stops the fall decision and the legs-apart check (seeded fuzz, 80 passes)", async () => {
  const r = rng(0x52);
  const failures = [];
  for (let i = 0; i < 80 && failures.length < 5; i++) {
    const w = feedsWorld();
    w.truth.debt = BigNumber.from(10).pow(20); // sIMD debt exists, so NHI is due
    w.truth.nhiAge = 23 * 3600;
    w.swarm = doc(r);
    if (r() < 0.2) w.fail.add("nhi.latestValue");
    const ctx = w.ctx({ raise: async () => {}, settle: async () => {} });
    let quotes = 0;
    const q = ctx.book.pricer.quote;
    ctx.book.pricer.quote = async (...a) => { quotes += 1; return q(...a); };
    try {
      await runFeeds(ctx);
    } catch (e) {
      failures.push(`pass ${i}: the feeds pass died: ${e.message} (swarm ${JSON.stringify(w.swarm)})`);
      continue;
    }
    if (quotes < 2) failures.push(`pass ${i}: the fall decision or the legs-apart check did not run (${quotes} quote reads)`);
  }
  assert.deepEqual(failures, []);
});
