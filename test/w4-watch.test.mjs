// PROPERTY (audit wave 4, P4, watch): a loop reports cleared only alerts it raises itself. The watch pass never clears a key another
// loop raises (depth's proof/prove/poke/round alerts, feeds, seats, send-stuck, state-unreadable, ...), and clears one of its own only
// when this pass read the condition and did not raise it. Seeded fuzz over standing keys and the watch's own readings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w4-watch-"));
const { statePath, writeState } = await import("../lib/state.mjs");
const { makeAlerts } = await import("../lib/alerts.mjs");
const { runWatch } = await import("../lib/watch.mjs");

const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const E18 = BigNumber.from(10).pow(18);
// Keys other loops raise (from lib/: depth, feeds, seats, positions, tx/act, state, peg, backstop, allocator, guardian, keeper.mjs).
const OTHERS = ["depth-proof-failed-0xabc", "depth-prove-now-failed", "depth-sampler-reverted", "depth-round-read-failed", "depth-poke-failed",
  "feeds-not-converged-median", "feeds-order-lost", "seats-buy-held", "index-incomplete", "cannot-close-7", "send-stuck", "state-unreadable",
  "peg-twap-push", "backstop-unconverted-blue", "allocator-unsold", "guardian-unknown-actor", "loop-failing-depth"];
// Keys the watch pass itself raises in this fake.
const MINE = ["rpc-stale", "unbacked", "edge-in-auction", "keeper-eth-low", "depth-zero", "unpriced-ETH"];

test("property P4 (watch): the watch pass clears only its own alerts, and only those it read as gone (seeded fuzz, 200 passes)", async () => {
  const r = rng(0x99);
  const failures = [];
  for (let i = 0; i < 200 && failures.length < 6; i++) {
    rmSync(statePath("alerts.json"), { force: true });
    const standing = {};
    for (const k of [...OTHERS, ...MINE]) if (r() < 0.4) standing[k] = { at: 0, level: "warn" };
    writeState("alerts.json", standing);
    const t = { unbacked: r() < 0.3, auction: r() < 0.3, lowEth: r() < 0.3, depthZero: r() < 0.3, unpriced: r() < 0.3 };
    const ts = Math.floor(Date.now() / 1000);
    const Z = BigNumber.from(0);
    const book = {
      ilks: [{ name: "ETH", id: "0x01", config: { token: "0x0000000000000000000000000000000000000001" } }], samplers: [],
      ledger: { unbacked: async () => (t.unbacked ? E18 : Z), ilkDebt: async () => E18 },
      liquidator: { edgeInAuction: async () => (t.auction ? E18 : Z) },
      pricer: { quote: async () => ({ priced: !t.unpriced }) },
      params: { RETIRE_SLEEVE_TOKEN: async () => 1, pendingOf: async () => ({ payload: "0x", eta: Z }), depthIMD: async () => (t.depthZero ? Z : E18) },
      imdDepth: { lowOf: async () => ({ day: 0, usd: 0 }) },
    };
    const provider = { getBlock: async () => ({ number: 1, timestamp: ts }), getBalance: async () => (t.lowEth ? Z : E18), unpin() {} };
    const logs = [];
    await runWatch({ book, cfg: {}, provider, keeperAddress: "0x00000000000000000000000000000000000000ee", log() {}, alerts: makeAlerts((s) => logs.push(s)) });
    const raisedNow = { unbacked: t.unbacked, "edge-in-auction": t.auction, "keeper-eth-low": t.lowEth, "depth-zero": t.depthZero, "unpriced-ETH": t.unpriced, "rpc-stale": false };
    for (const l of logs) {
      const m = /ALERT INFO (\S+): cleared/.exec(l);
      if (!m) continue;
      if (OTHERS.includes(m[1])) failures.push(`pass ${i}: watch cleared ${m[1]}, another loop's alert`);
      else if (raisedNow[m[1]]) failures.push(`pass ${i}: watch cleared ${m[1]} while raising it`);
    }
  }
  assert.deepEqual(failures, []);
});
