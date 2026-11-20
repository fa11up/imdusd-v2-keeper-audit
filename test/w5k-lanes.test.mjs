// wave-5 keeper audit #3: ONE SLOW LOOP HOLDS EVERY DUTY, SILENTLY.
// PROPERTY (P1/C2/C5): no loop's slowness (log paging, a slow or hanging peer RPC, a send wait) delays another lane's duties, and a
// loop that runs past its deadline raises critical loop-slow-<name> WHILE it is still running (before the duties it holds are late);
// sends stay one at a time across lanes. Fuzzed: random loop durations (some hanging far past the deadline), random cadences.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5k-lanes-"));
const { runLanes, runRound, ROBINHOOD_LOOPS } = await import("../keeper.mjs");
const { act } = await import("../lib/act.mjs");
const { rng } = await import("./lib/rh-world.mjs");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function ctxOf(loops, cfg = {}) {
  const raised = [];
  return { raised, ctx: { cfg: { LANE_MIN_SLEEP_MS: 5, ...cfg }, loops, provider: {}, log() {}, alerts: { raise: async (l, k) => raised.push({ l, k, t: Date.now() }), settle: async () => {} } } };
}

test("the 4663 lanes: the Pulse is its own lane and the peer-reading loops (bridge, imdfeeds) share one apart from home duties", () => {
  const lane = Object.fromEntries(ROBINHOOD_LOOPS.map((l) => [l.name, l.lane ?? "home"]));
  assert.equal(lane.pulse, "pulse");
  assert.equal(lane.bridge, "peer");
  assert.equal(lane.imdfeeds, "peer");
  assert.equal(lane.positions, "home");
  assert.equal(lane.stocks, "stocks", "stock ticks have their own lane (internal review after wave 5)");
});

test("judge shape: a bridge pass held 1.5 s (scaled 20 min) never holds the Pulse; loop-slow-bridge is raised before it ends", async () => {
  const pokes = [];
  let bridgeEnd = 0;
  const loops = [
    { name: "pulse", lane: "pulse", every: () => 0.05, run: async () => { pokes.push(Date.now()); } },
    { name: "bridge", lane: "peer", every: () => 10, run: async () => { await wait(1500); bridgeEnd = Date.now(); } },
  ];
  const { ctx, raised } = ctxOf(loops, { LOOP_DEADLINE_SECONDS: { bridge: 0.5, pulse: 0.5 } });
  const t0 = Date.now();
  await runLanes(ctx, { until: () => Date.now() - t0 > 1800 });
  const during = pokes.filter((t) => t < bridgeEnd);
  assert.ok(during.length >= 10, `only ${during.length} Pulse passes ran during the bridge pass`);
  const slow = raised.find((a) => a.k === "loop-slow-bridge");
  assert.ok(slow && slow.l === "critical" && slow.t < bridgeEnd, `loop-slow-bridge ${slow ? `at +${slow.t - t0} ms, the pass ended +${bridgeEnd - t0}` : "never raised"}`);
});

test("property: random durations and cadences (25 seeds): every lane's gaps stay bounded by its own loops; a loop past its deadline is alerted while running", async () => {
  for (let seed = 1; seed <= 25; seed++) {
    const r = rng(seed * 977);
    const runs = {};
    const slowRuns = [];
    const loops = ["a", "b", "c", "d"].map((name, i) => ({
      name, lane: i < 2 ? `L${i}` : "home", every: () => 0.02 + r() * 0.05,
      run: async () => {
        const hang = r() < 0.15 && name !== "a";
        const d = hang ? 300 + r() * 300 : r() * 30;
        const st = Date.now();
        (runs[name] ??= []).push(st);
        await wait(d);
        if (hang) slowRuns.push({ name, st, end: Date.now() });
      },
    }));
    const { ctx, raised } = ctxOf(loops, { LOOP_DEADLINE_SECONDS: 0.2 });
    const t0 = Date.now();
    await runLanes(ctx, { until: () => Date.now() - t0 > 900 });
    // lane L0 holds only "a", which never hangs: its gaps never exceed its cadence + its own duration + scheduling slack
    const a = runs.a;
    for (let i = 1; i < a.length; i++) assert.ok(a[i] - a[i - 1] < 150, `seed ${seed}: loop a waited ${a[i] - a[i - 1]} ms (other lanes held it)`);
    for (const s of slowRuns) {
      const hit = raised.find((x) => x.k === `loop-slow-${s.name}` && x.t >= s.st && x.t <= s.end);
      assert.ok(hit, `seed ${seed}: ${s.name} ran ${s.end - s.st} ms, no loop-slow alert while it ran`);
    }
  }
});

test("sends stay one at a time across lanes (the send lock)", async () => {
  let open = 0, maxOpen = 0;
  const ctx = { execute: true, cfg: {}, log() {}, provider: { unpin() {} }, alerts: { raise: async () => {}, settle: async () => {} } };
  const c = { connect: () => c, callStatic: { f: async () => {} }, f: async () => {} };
  // send() itself is stubbed through a signer whose provider makes send() skip quickly after a delay: count overlap with a wrapper.
  const signer = { provider: { getGasPrice: async () => { open++; maxOpen = Math.max(maxOpen, open); await wait(20); open--; return BigNumber.from(10).pow(30); }, getBalance: async () => BigNumber.from(0) } };
  await Promise.all([...Array(6)].map((_, i) => act(ctx, `s${i}`, c, "f", [], { tier: "routine", signer })));
  assert.equal(maxOpen, 1, `${maxOpen} sends ran at once`);
});
