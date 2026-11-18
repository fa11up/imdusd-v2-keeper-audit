// Robinhood Chain (4663) duties against a fake chain (test/lib/rh-world.mjs): the Pulse, liquidations under a Pulse grace, stock auction
// ticks / cancels, MarketHoursFeed.sync, writeOff, RateFeed pokes. Property-style: seeded random worlds, the duty run as it runs live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, utils } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-rh-duties-"));
const { pulseDue, pulseAlerts, runPulse } = await import("../lib/pulse.mjs");
const { runPositions } = await import("../lib/positions.mjs");
const { auctionStep, runStocks, syncStep, writeOffStep, WRITEOFF_DELAY, WRITEOFF_WINDOW } = await import("../lib/stocks.mjs");
const { rateDue, runRates } = await import("../lib/rates.mjs");
const { makeWorld, rng } = await import("./lib/rh-world.mjs");

const E18 = BigNumber.from(10).pow(18);
const ID = (s) => utils.formatBytes32String(s);
const fresh = () => {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
};

// ---------------------------------------------------------------- Pulse

test("pulse: with the loop every <= 90 s and pokeAfter 480, no poke of ours ever finds the 15-min gap passed (300 seeded runs)", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    let now = 0, last = 0, maxSilence = 0;
    for (let step = 0; step < 2000; step++) {
      now += 30 + Math.floor(r() * 60); // the loop: 30-90 s between passes (a slow RPC, a send waiting)
      if (r() < 0.05) last = now; // someone else (an accrual, a mark) poked
      const d = pulseDue({ now, lastPulse: last, gap: 900, pokeAfter: 480 });
      if (d.due) {
        maxSilence = Math.max(maxSilence, d.silence);
        assert.equal(d.opensGrace, false, `seed ${seed}: our poke opened a grace at silence ${d.silence}`);
        last = now;
      }
    }
    assert.ok(maxSilence <= 480 + 90, `seed ${seed}: silence ${maxSilence}`);
  }
});

test("pulse: alerts critical in grace, warn when silent past 3/4 of the gap", () => {
  assert.equal(pulseAlerts({ now: 1000, lastPulse: 0, gap: 900, graceUntil: 4000, inGrace: true })[0].level, "critical");
  assert.equal(pulseAlerts({ now: 700, lastPulse: 0, gap: 900, graceUntil: 0, inGrace: false })[0].key, "pulse-silent");
  assert.deepEqual(pulseAlerts({ now: 100, lastPulse: 0, gap: 900, graceUntil: 0, inGrace: false }), []);
});

test("pulse loop: pokes when due, on the urgent tier; idle otherwise", async () => {
  fresh();
  const { w, ctx } = makeWorld();
  w.lastPulse = w.now - 500;
  await runPulse(ctx);
  assert.deepEqual(w.acts.map((a) => a.fn), ["poke"]);
  w.acts.length = 0;
  w.lastPulse = w.now - 100;
  await runPulse(ctx);
  assert.equal(w.acts.length, 0);
});

// ---------------------------------------------------------------- liquidations and the Pulse grace

const ETH = ID("ETH"), SPY = ID("STOCK-SPY");

test("positions: during a Pulse grace no bite or liquidate is ever sent; marks only; outside it, the close goes (400 seeded worlds)", async () => {
  for (let seed = 1; seed <= 400; seed++) {
    fresh();
    const r = rng(seed);
    const n = 1 + Math.floor(r() * 5);
    const positions = [...Array(n).keys()].map((i) => ({ id: 100 + i, ilk: r() < 0.5 ? ETH : SPY, healthy: r() < 0.3, debt: E18.mul(r() < 0.1 ? 5 : 200) }));
    const { w, ctx } = makeWorld({ types: [{ id: ETH, name: "ETH" }, { id: SPY, name: "STOCK-SPY", auction: true, stock: true }], positions });
    w.grace = r() < 0.5;
    for (const p of positions) if (r() < 0.3) w.marks.set(String(p.id), w.now - 100);
    for (const p of positions) if (p.ilk === SPY && r() < 0.3) w.auctions.set(String(p.id), { startAt: w.now - Math.floor(r() * 3 * 3600), lastTick: w.now - 60, ran: 0 });
    await runPositions(ctx);
    const closes = w.acts.filter((a) => /^(bite|liquidate)/.test(a.label));
    if (w.grace) assert.equal(closes.length, 0, `seed ${seed}: a close was sent in a grace: ${closes.map((a) => a.label)}`);
    for (const a of w.acts) {
      const id = a.args[0];
      if (a.fn === "tick") continue;
      const p = w.positions.get(id);
      assert.ok(!p.healthy && p.debt.gte(E18.mul(15)), `seed ${seed}: acted on a healthy or dust position ${id}`);
      const au = w.auctions.get(id);
      if (p.ilk === SPY && au) assert.ok(w.now > au.startAt + 7200, `seed ${seed}: acted on a stock position whose auction still runs`);
    }
    if (!w.grace) {
      // every unhealthy, non-dust position not owned by a running auction is closed (unmarked: liquidate; marked: bite)
      const want = positions.filter((p) => !p.healthy && p.debt.gte(E18.mul(15)) && !(p.ilk === SPY && w.auctions.get(String(p.id)) && w.now <= w.auctions.get(String(p.id)).startAt + 7200));
      assert.equal(closes.length, want.length, `seed ${seed}`);
    }
  }
});

// ---------------------------------------------------------------- stock auction ticks

test("stock auctions: while one runs every read is <= 300 s apart (TICK_SPAN), none after it lapses (200 seeded timelines)", async () => {
  for (let seed = 1; seed <= 200; seed++) {
    fresh();
    const r = rng(seed);
    const { w, ctx } = makeWorld({ types: [{ id: SPY, name: "STOCK-SPY", auction: true, stock: true }], positions: [{ id: 7, ilk: SPY }] });
    const start = w.now;
    const a = { startAt: start, lastTick: start, ran: 0 };
    w.auctions.set("7", a);
    const reads = [start];
    ctx.actHook = async (label, contract, fn, args) => {
      w.acts.push({ fn, label, at: w.now });
      if (fn === "tick") { a.lastTick = w.now; reads.push(w.now); }
      return { hash: "0x01" };
    };
    while (w.now < start + 3 * 3600) {
      w.now += 30 + Math.floor(r() * 30); // the loop every 30-60 s
      if (r() < 0.02) { a.lastTick = w.now; reads.push(w.now); } // a taker or stranger ticks
      w.types.get(SPY).priced = r() < 0.7; // market open/closed, pauses: ticks go on regardless
      await runStocks(ctx);
    }
    const live = reads.filter((t) => t <= start + 7200);
    for (let i = 1; i < live.length; i++) assert.ok(live[i] - live[i - 1] <= 300, `seed ${seed}: ${live[i] - live[i - 1]} s between reads of a live auction`);
    assert.ok(start + 7200 - live.at(-1) <= 300, `seed ${seed}: the last stretch went unticked`);
    assert.equal(w.acts.filter((x) => x.fn === "tick" && x.at > start + 7200).length, 0, `seed ${seed}: ticked a lapsed auction`);
  }
});

test("stock auctions: a healed or repaid position's auction is cancelled; a live one is not", async () => {
  fresh();
  const { w, ctx } = makeWorld({ types: [{ id: SPY, name: "STOCK-SPY", auction: true, stock: true }], positions: [{ id: 1, ilk: SPY, healthy: true }, { id: 2, ilk: SPY, debt: BigNumber.from(0) }, { id: 3, ilk: SPY }] });
  for (const id of ["1", "2", "3"]) w.auctions.set(id, { startAt: w.now - 10, lastTick: w.now - 10, ran: 0 });
  await runStocks(ctx);
  assert.deepEqual(w.acts.filter((a) => a.fn === "cancel").map((a) => a.args[0]).sort(), ["1", "2"]);
  assert.equal(w.acts.filter((a) => a.fn === "tick").length, 0, "the live one was read 10 s ago: not due");
  assert.equal(auctionStep({ a: { startAt: 0 }, now: 1, auctionTime: 3600 }).live, false);
});

// ---------------------------------------------------------------- MarketHoursFeed.sync

test("sync: only when the step has landed and the feed has not seen it; a scheduled step is pending (never synced: it reverts)", () => {
  const m = (x) => E18.mul(x);
  assert.deepEqual(syncStep({ current: m(1), next: m(1), seen: m(1) }), { sync: false, pending: false });
  assert.deepEqual(syncStep({ current: m(2), next: m(2), seen: m(1) }), { sync: true, pending: false });
  assert.deepEqual(syncStep({ current: m(1), next: m(2), seen: m(1) }), { sync: false, pending: true });
  for (let seed = 1; seed <= 500; seed++) {
    const r = rng(seed);
    const [c, n, s] = [1 + Math.floor(r() * 3), 1 + Math.floor(r() * 3), 1 + Math.floor(r() * 3)].map(m);
    const st = syncStep({ current: c, next: n, seen: s });
    assert.equal(st.sync, c.eq(n) && !c.eq(s), `seed ${seed}`);
  }
});

test("sync loop: a landed multiplier step is synced on the urgent tier; a pending one alerts", async () => {
  fresh();
  const { w, ctx } = makeWorld({ types: [{ id: SPY, name: "STOCK-SPY", auction: true, stock: true, mult: E18.mul(2), nextMult: E18.mul(2), seen: E18 }] });
  await runStocks(ctx);
  assert.deepEqual(w.acts.map((a) => a.fn), ["sync"]);
});

// ---------------------------------------------------------------- writeOff

test("writeOff: never before 1 h after the arming reading, re-armed past the window, cleared once worth again (2,000 seeded)", () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const r = rng(seed);
    const since = r() < 0.3 ? 0 : 1_000_000;
    const now = 1_000_000 + Math.floor((r() - 0.1) * 9 * 86_400);
    const worth = r() < 0.3 ? E18 : BigNumber.from(0);
    const st = writeOffStep({ worth, since, now });
    if (st.act === "writeoff") assert.ok(since !== 0 && now >= since + WRITEOFF_DELAY && now <= since + WRITEOFF_WINDOW && worth.isZero(), `seed ${seed}`);
    if (!worth.isZero()) assert.ok(["clear", "none"].includes(st.act));
    if (worth.isZero() && (since === 0 || now > since + WRITEOFF_WINDOW)) assert.equal(st.act, "arm");
  }
});

test("writeOff loop: worthless custody arms once, then writes each position with debt off an hour later", async () => {
  fresh();
  const { w, ctx, book } = makeWorld({ types: [{ id: SPY, name: "STOCK-SPY", auction: true, stock: true, worthless: true }], positions: [{ id: 1, ilk: SPY }, { id: 2, ilk: SPY }, { id: 3, ilk: SPY, debt: BigNumber.from(0) }] });
  book.ledger.address = "0x00000000000000000000000000000000000000Ed";
  await runStocks(ctx);
  assert.deepEqual(w.acts.map((a) => `${a.fn} ${a.args[0]}`), ["writeOff 1"]);
  w.acts.length = 0;
  w.types.get(SPY).worthlessSince = w.now;
  w.now += 3600;
  await runStocks(ctx);
  assert.deepEqual(w.acts.map((a) => `${a.fn} ${a.args[0]}`), ["writeOff 1", "writeOff 2"]);
});

test("writeOff waits out the Pulse grace: arming still goes, no position is written off in grace, all go once it ends", async () => {
  fresh();
  const { w, ctx, book } = makeWorld({ types: [{ id: SPY, name: "STOCK-SPY", auction: true, stock: true, worthless: true }], positions: [{ id: 1, ilk: SPY }, { id: 2, ilk: SPY }] });
  book.ledger.address = "0x00000000000000000000000000000000000000Ed";
  w.grace = true;
  await runStocks(ctx);
  assert.deepEqual(w.acts.map((a) => `${a.fn} ${a.args[0]}`), ["writeOff 1"], "arming seizes nothing and is not held by the grace");
  w.acts.length = 0;
  w.types.get(SPY).worthlessSince = w.now;
  w.now += 3600;
  const alerts = [];
  ctx.alerts = { raise: async (level, key, msg) => alerts.push({ level, key, msg }), settle: async () => {} };
  await runStocks(ctx);
  assert.deepEqual(w.acts.map((a) => `${a.fn} ${a.args[0]}`), [], "no seizing writeOff is sent while the Pulse is in grace (it would revert SequencerGrace)");
  assert.ok(alerts.some((a) => a.key === "stocks-worthless-STOCK-SPY" && /grace/i.test(a.msg)), "the worthless alert says the write-off waits out the grace");
  assert.ok(!alerts.some((a) => /fail|refus/i.test(a.key)), "the wait is expected: no failure alert");
  w.grace = false;
  await runStocks(ctx);
  assert.deepEqual(w.acts.map((a) => `${a.fn} ${a.args[0]}`), ["writeOff 1", "writeOff 2"], "once the grace ends every position with debt is written off");
});

test("SequencerGrace is in the 4663 Ledger ABI, so a writeOff refused in grace reads as the expected wait", async () => {
  const { LEDGER_4663_ABI } = await import("../lib/robinhood.mjs");
  const iface = new utils.Interface(LEDGER_4663_ABI);
  assert.equal(iface.parseError(iface.getSighash("SequencerGrace")).name, "SequencerGrace");
});

// ---------------------------------------------------------------- RateFeed pokes

test("rate pokes: rises only, past minMove or the max age", () => {
  const base = { now: 100_000, checkpointRate: E18, checkpointAt: 100_000 - 3600, minMoveBps: 5, maxAgeSeconds: 86_400 };
  assert.equal(rateDue({ ...base, rate: E18.mul(10006).div(10000) }).due, true);
  assert.equal(rateDue({ ...base, rate: E18.mul(10001).div(10000) }).due, false);
  assert.equal(rateDue({ ...base, rate: E18.mul(10001).div(10000), checkpointAt: 0 }).due, true);
  assert.equal(rateDue({ ...base, rate: E18.mul(9990).div(10000), checkpointAt: 0 }).due, false, "a fall needs no poke");
});

test("rates loop: pokes the due feed, alerts on one reading 0", async () => {
  fresh();
  const { w, ctx, book } = makeWorld();
  const feed = (addr, rate) => ({ address: addr, rate: async () => rate, checkpointRate: async () => E18, checkpointAt: async () => w.now - 90_000 });
  book.rates = [{ feed: feed("0x00000000000000000000000000000000000000a1", E18.mul(1001).div(1000)), ilks: ["S-USDG"] }, { feed: feed("0x00000000000000000000000000000000000000a2", BigNumber.from(0)), ilks: ["STOCK-SPY"] }];
  await runRates(ctx);
  assert.deepEqual(w.acts.map((a) => `${a.fn} ${a.to}`), ["poke 0x00000000000000000000000000000000000000a1"]);
});
