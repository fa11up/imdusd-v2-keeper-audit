// Internal review after audit wave 5 (keeper scheduling/sends + keeper vs the wave-5b contracts snapshot). The write-off cases are in
// rh-duties (writeOff on the wave-5b LedgerSettlement model). Here:
//   P2 the loop-slow watchdog speaks again every deadline while a pass hangs; a new run of skipped sends after a quiet gap starts its
//      own clock (warn first, not critical at once); the bridge's journal settlement waits for the send lock; PricerOracle refusing
//      a sleeve's price while the legs disagree is said.
//   P3 UNCAPPED RateFeeds are not poked; a late stock tick stands instead of flapping; --only naming no loop and a non-numeric
//      LOOP_DEADLINE_SECONDS are refused; the twin rule's TWIN_STEP bound in the test model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, constants, utils } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5k-r3-"));
const { runRound, checkSchedule, ROBINHOOD_LOOPS } = await import("../keeper.mjs");
const { act, withSendLock } = await import("../lib/act.mjs");
const { statePath } = await import("../lib/state.mjs");
const { runBackstop } = await import("../lib/backstop.mjs");
const { runRates } = await import("../lib/rates.mjs");
const { runStocks } = await import("../lib/stocks.mjs");
const { autoClaim } = await import("../lib/bridge.mjs");
const { pricerLow } = await import("./lib/pricer-model.mjs");
const { makeWorld } = await import("./lib/rh-world.mjs");
const W = await import("./lib/bridge-world.mjs");

const E18 = BigNumber.from(10).pow(18);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fresh = () => rmSync(process.env.STATE_DIR, { recursive: true, force: true });

test("P2: the loop-slow watchdog raises again every deadline while a pass hangs", async () => {
  const raised = [];
  const ctx = { cfg: { LOOP_DEADLINE_SECONDS: 0.1 }, provider: {}, log() {}, loops: [{ name: "x", run: async () => wait(450) }], alerts: { raise: async (l, k) => raised.push(k), settle: async () => {} } };
  await runRound(ctx, ["x"]);
  assert.ok(raised.filter((k) => k === "loop-slow-x").length >= 3, `raised ${raised.length} times`);
});

test("P2: a new run of skipped urgent sends after a quiet gap starts warn, not critical", async () => {
  fresh();
  mkdirSync(process.env.STATE_DIR, { recursive: true });
  const raised = [];
  const ctx = { execute: true, cfg: {}, log() {}, provider: { unpin() {} }, alerts: { raise: async (l, k) => raised.push(l), settle: async () => {} } };
  const c = { connect: () => c, callStatic: { f: async () => {} }, f: async () => {} };
  const realNow = Date.now;
  let t = 1_800_000_000_000;
  Date.now = () => t;
  try {
    writeFileSync(statePath("STOP"), "");
    await act(ctx, "a", c, "f", [], { tier: "urgent", signer: {} });
    t += 3 * 3600 * 1000; // a quiet gap: nothing skipped for 3 h
    raised.length = 0;
    await act(ctx, "b", c, "f", [], { tier: "urgent", signer: {} });
    rmSync(statePath("STOP"));
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(raised, ["warn"]);
});

test("P2: the bridge auto-claim settles the send journal only while holding the send lock", async () => {
  fresh();
  const w = W.makeBridgeWorld({ seed: 5, home: 4663, delay: 600 });
  W.honest(w, 1, 1, W.T0 + 100, 200, E18.mul(100), { queue: true });
  let released = 0, settledAt = 0;
  const ctx = W.bridgeCtx(w, [], { execute: true, settleSends: async () => { settledAt = Date.now(); }, actHook: async () => ({ hash: "0x01" }) });
  const { runBridge } = await import("../lib/bridge.mjs");
  for (let p = W.T0 + 60; p <= W.T0 + 780; p += 120) { if (w.t < p) w.t = p; await runBridge(ctx); }
  w.t = W.T0 + 1000;
  const s = JSON.parse((await import("node:fs")).readFileSync(join(process.env.STATE_DIR, "bridge-watch.json"), "utf8"));
  const held = withSendLock(ctx, async () => { await wait(80); released = Date.now(); });
  const { EID } = await import("../lib/robinhood.mjs");
  w.t = W.T0 + 1200;
  await autoClaim(ctx, { side: s.home, src: s.peer, srcEid: EID[1], dstEid: EID[4663], name: "4663", W: {} });
  await held;
  assert.ok(settledAt >= released && released > 0, `settled at ${settledAt}, lock released at ${released}`);
});

test("P2: PricerOracle refusing a sleeve's price while the legs disagree is alerted (prove or buy a median)", async () => {
  fresh();
  const raised = [];
  const token = "0x00000000000000000000000000000000000000aa";
  const sleeve = { openHead: async () => BigNumber.from(0), openDaysLength: async () => BigNumber.from(0), tokenCount: async () => BigNumber.from(0), ilks: async () => ({ on: true }), bidRoomNow: async () => E18.mul(1000), address: "0x01" };
  const ctx = {
    cfg: {}, log() {}, execute: false, provider: { getBlock: async () => ({ number: 1, timestamp: 1_800_000_000 }) },
    book: { blue: sleeve, edge: sleeve, ilks: [{ id: utils.formatBytes32String("SIMD"), name: "SIMD", config: { token } }], ledger: { ilkDebt: async () => E18 },
      pricer: { quote: async () => ({ priced: true, agree: false, low: E18, high: E18 }) }, backstopOracle: { priceOf: async () => ({ low: 0, high: 0, ok: false }) }, record: {} },
    alerts: { raise: async (l, k, m) => raised.push({ l, k, m }), settle: async () => {} },
  };
  await runBackstop(ctx);
  assert.ok(raised.some((a) => a.k === "backstop-unpriced-legs-SIMD" && /[Pp]rove/.test(a.m)), JSON.stringify(raised));
});

test("P3: an UNCAPPED RateFeed is never poked; a capped one past its move is", async () => {
  fresh();
  const pokes = [];
  const feed = (addr, cap) => ({ address: addr, maxGrowthPerSecond: async () => cap, rate: async () => E18.mul(2), checkpointRate: async () => E18, checkpointAt: async () => 1_700_000_000 });
  const ctx = { cfg: {}, log() {}, provider: { getBlock: async () => ({ number: 1, timestamp: 1_800_000_000 }) }, alerts: { raise: async () => {}, settle: async () => {} },
    book: { rates: [{ feed: feed("0x01", constants.MaxUint256), ilks: ["A"] }, { feed: feed("0x02", BigNumber.from(1e9)), ilks: ["B"] }] },
    actHook: async (label, c) => { pokes.push(c.address); return { hash: "0x1" }; } };
  await runRates(ctx);
  assert.deepEqual(pokes, ["0x02"]);
});

test("P3: a late stock tick stands for an hour instead of flapping between ticks", async () => {
  fresh();
  const SPY = utils.formatBytes32String("STOCK-SPY");
  const { w, ctx } = makeWorld({ types: [{ id: SPY, name: "STOCK-SPY", auction: true, stock: true }], positions: [{ id: 7, ilk: SPY }] });
  const standing = new Set();
  ctx.alerts = { raise: async (l, k) => standing.add(k), settle: async (p, held) => { for (const k of [...standing]) if (k.startsWith(p) && !held.has(k)) standing.delete(k); } };
  const a = { startAt: w.now - 500, lastTick: w.now - 400, ran: 0 };
  w.auctions.set("7", a);
  ctx.actHook = async (label, c, fn) => { if (fn === "tick") a.lastTick = w.now; return { hash: "0x1" }; };
  await runStocks(ctx);
  assert.ok(standing.has("stocks-tick-late-STOCK-SPY"));
  w.now += 60; await runStocks(ctx); // no tick due this pass
  assert.ok(standing.has("stocks-tick-late-STOCK-SPY"), "cleared on the next pass with no tick: a flap");
});

test("P3: --only naming no loop, and a non-numeric LOOP_DEADLINE_SECONDS, are refused at start", () => {
  assert.throws(() => checkSchedule({}, ROBINHOOD_LOOPS, ["brigde"]), /--only names no loop/);
  assert.throws(() => checkSchedule({ LOOP_DEADLINE_SECONDS: "4m" }, ROBINHOOD_LOOPS), /not a positive number/);
  assert.throws(() => checkSchedule({ LOOP_DEADLINE_SECONDS: { bridge: 0 } }, ROBINHOOD_LOOPS), /not a positive number/);
  checkSchedule({ LOOP_DEADLINE_SECONDS: { bridge: 300 } }, ROBINHOOD_LOOPS, ["bridge", "pulse"]);
  assert.equal(ROBINHOOD_LOOPS.find((l) => l.name === "stocks").lane, "stocks");
});

test("P3: the test model of the twin rule holds low within TWIN_STEP (20%) of a median above the proven spot", () => {
  const r = pricerLow({ m: "1000", s: "500", attested: "100", skewBps: 500 });
  assert.equal(r.low, 800n);
});

test("writeOff cadence follows the chain's Ledger.worthlessLast (any caller's reading): a reading 2 min old is not repeated", async () => {
  fresh();
  const SPY = utils.formatBytes32String("STOCK-SPY");
  const { w, ctx, book } = makeWorld({ types: [{ id: SPY, name: "STOCK-SPY", auction: true, stock: true, worthless: true }], positions: [{ id: 1, ilk: SPY }] });
  book.ledger.address = "0x00000000000000000000000000000000000000Ed";
  const t = w.types.get(SPY);
  t.worthlessSince = w.now - 1800;
  t.worthlessLast = w.now - 120; // someone else read it 2 min ago; this keeper's own state is empty
  await runStocks(ctx);
  assert.deepEqual(w.acts.filter((a) => a.fn === "writeOff"), []);
  w.now += 600;
  await runStocks(ctx);
  assert.deepEqual(w.acts.filter((a) => a.fn === "writeOff").map((a) => a.label), ["writeOff STOCK-SPY record"]);
});
