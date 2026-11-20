// wave-5 keeper audit #18, #19, #20: 4663 DUTIES AND THE STARTUP CHECK.
//   #19 PROPERTY (P6): a close that would seize nothing is never sent (the Pulse grace may open mid-pass: inGrace is read once); the
//       position is marked instead when no mark is live.
//   #18 PROPERTY (P1): with the loop scheduled from its pass's start and up to 90 s of other work in a round, a live stock auction's
//       tick is decided at most TICK_SPAN (300 s) after its last read; a read found older than that at its tick is said.
//   #20 PROPERTY (C6): a record that names a bridge says so at startup when the watcher or auto-claim will not actually run, on either
//       chain, whatever switched it off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, utils } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5k-duties-"));
const { runPositions } = await import("../lib/positions.mjs");
const { runStocks } = await import("../lib/stocks.mjs");
const { bridgeWatchOff } = await import("../lib/bridge.mjs");
const { makeWorld, rng } = await import("./lib/rh-world.mjs");

const E18 = BigNumber.from(10).pow(18);
const ID = (s) => utils.formatBytes32String(s);
const ETH = ID("ETH"), SPY = ID("STOCK-SPY");
const fresh = () => rmSync(process.env.STATE_DIR, { recursive: true, force: true });

test("#19: the grace opening mid-pass never lets a seize-0 close go out (judge shape + 200 seeded worlds)", async () => {
  for (let seed = 0; seed <= 200; seed++) {
    fresh();
    const r = rng(seed * 13 + 1);
    const n = seed === 0 ? 2 : 1 + Math.floor(r() * 5);
    const positions = [...Array(n).keys()].map((i) => ({ id: 100 + i, ilk: ETH, healthy: false, debt: E18.mul(200) }));
    const { w, book, ctx } = makeWorld({ types: [{ id: ETH, name: "ETH" }], positions });
    const opensAt = seed === 0 ? 1 : 1 + Math.floor(r() * n); // the act after which the grace opens
    const seize = async () => ({ seized: w.grace ? BigNumber.from(0) : E18 });
    book.liquidator.callStatic = { "liquidate(uint256,uint256)": seize, "bite(uint256,uint256)": seize };
    ctx.actHook = async (label, contract, fn, args) => {
      w.acts.push({ label, fn, args: args.map(String) });
      if (w.acts.length >= opensAt) w.grace = true;
      return { hash: "0x01", block: 1, gas: "1" };
    };
    await runPositions(ctx);
    const zero = w.acts.filter((a) => /^(liquidate|bite)/.test(a.label) && a.args[1] === "0");
    assert.deepEqual(zero.map((a) => a.label), [], `seed ${seed}: a close with minSeized 0 was sent`);
    for (const p of positions) assert.ok(w.acts.some((a) => a.args[0] === String(p.id)), `seed ${seed}: position ${p.id} was neither closed nor marked`);
  }
});

test("#18: ticks land inside TICK_SPAN with the loop scheduled from its start and up to 90 s of other work (200 seeded timelines)", async () => {
  for (let seed = 1; seed <= 200; seed++) {
    fresh();
    const r = rng(seed * 101);
    const { w, ctx } = makeWorld({ types: [{ id: SPY, name: "STOCK-SPY", auction: true, stock: true }], positions: [{ id: 7, ilk: SPY }] });
    ctx.cfg.STOCKS = {}; // the shipped default
    const start = w.now;
    const a = { startAt: start, lastTick: start - Math.floor(r() * 60), ran: 0 };
    w.auctions.set("7", a);
    let worst = 0;
    ctx.actHook = async (label, contract, fn) => {
      if (fn === "tick") { worst = Math.max(worst, w.now - a.lastTick); a.lastTick = w.now; }
      return { hash: "0x01" };
    };
    while (w.now < start + 7000) {
      await runStocks(ctx);
      w.now += Math.max(60, Math.floor(r() * 90)); // next pass: 60 s after this one STARTED, or later when the round ran long
    }
    assert.ok(worst <= 300, `seed ${seed}: a tick was decided ${worst} s after the last read`);
  }
});

test("#18: a tick found later than TICK_SPAN raises stocks-tick-late", async () => {
  fresh();
  const { w, ctx } = makeWorld({ types: [{ id: SPY, name: "STOCK-SPY", auction: true, stock: true }], positions: [{ id: 7, ilk: SPY }] });
  const raised = [];
  ctx.alerts = { raise: async (l, k) => raised.push(k), settle: async () => {} };
  w.auctions.set("7", { startAt: w.now - 500, lastTick: w.now - 400, ran: 0 });
  await runStocks(ctx);
  assert.ok(raised.includes("stocks-tick-late-STOCK-SPY"), JSON.stringify(raised));
});

test("#20: the bridge watcher or auto-claim switched off ANY way says so at startup, on both chains", () => {
  const bridge = "0x00000000000000000000000000000000000B0001";
  const loops = [{ name: "pulse" }, { name: "bridge" }];
  for (const CHAIN_ID of [1, 4663]) {
    const on = CHAIN_ID === 1 ? { BRIDGE_WATCH: { enabled: true } } : {};
    assert.equal(bridgeWatchOff({ CHAIN_ID, ...on }, { bridge }, { loops }), null, `chain ${CHAIN_ID}: running`);
    assert.ok(bridgeWatchOff({ CHAIN_ID, ...on, BRIDGE_ENABLED: false }, { bridge }, { loops }), `chain ${CHAIN_ID}: BRIDGE_ENABLED false`);
    assert.ok(bridgeWatchOff({ CHAIN_ID, ...on }, { bridge }, { loops, only: ["pulse"] }), `chain ${CHAIN_ID}: --only`);
    assert.ok(bridgeWatchOff({ CHAIN_ID, BRIDGE_WATCH: { ...on.BRIDGE_WATCH, autoClaim: false } }, { bridge }, { loops }), `chain ${CHAIN_ID}: autoClaim false`);
  }
  assert.ok(bridgeWatchOff({ CHAIN_ID: 1 }, { bridge }), "mainnet with BRIDGE_WATCH off");
});
