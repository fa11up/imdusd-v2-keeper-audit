// wave-5 keeper audit: the judge's proof for HIGH finding 3, second half (a backfill keeps what it proved), kept as a regression.
// Its first half drove runRound serially, the schedule the fix replaces: test/w5k-lanes.test.mjs is that half adapted to runLanes.
// AUDIT PROOF (C5 / P1): the loops are serial with no time budget and no watchdog. One bridge pass that pages the peer's logs from
// BRIDGE_WATCH.peer.fromBlock = 0 (config.example.js) holds the queue past the Pulse gap, silently; and the backfill is all-or-nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "audit-pulse-"));
const { ROBINHOOD_LOOPS, runRound } = await import("../keeper.mjs");
const { CHAIN_DEFAULTS } = await import("../lib/chains.mjs");
const { readStateOr } = await import("../lib/state.mjs");
const { bridgeCtx, makeBridgeWorld, setDelay, T0 } = await import("./lib/bridge-world.mjs");

const GAP = 900, GRACE = 3600;
const MAINNET_HEAD = 26_444_548; // eth_blockNumber on 2026-11-18

function world() {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  const w = makeBridgeWorld({ seed: 3, home: 4663 }); // the 4663 keeper; each fake RPC call takes 0.05-0.55 s (the project's own model)
  w.chains[1].genesis = T0 - MAINNET_HEAD * 12; // mainnet at its real height
  // As ImdBridge does: no delay before the path is configured, then DelaySet in the logs (an hour ago), so the settings proof holds.
  w.chains[1].settings[0][1] = { delay: 0, cutoff: 0 };
  const t = w.t;
  w.t = T0 - 3600;
  setDelay(w, 1, { delay: w.delay });
  w.t = t;
  const raised = [];
  const pulse = { last: 0, graceUntil: 0, pokes: [] };
  const now = () => w.home.timeOf(w.home.headAt(w.t));
  const ctx = bridgeCtx(w, raised, {
    loops: ROBINHOOD_LOOPS,
    // What `--chain 4663` runs on with config.example.js: CHAIN_DEFAULTS[4663].LOGS for home, and for the peer NO peerLogs (chunk 9,000) and fromBlock 0.
    cfg: { CHAIN_ID: 4663, LOGS: CHAIN_DEFAULTS[4663].LOGS, PULSE: {}, BRIDGE_WATCH: { peer: { bridge: w.peer.bridge, fromBlock: 0 }, directions: "both" } },
    actHook: async (label, c, fn) => {
      if (fn !== "poke") throw new Error(`unexpected act ${fn}`);
      if (now() - pulse.last > GAP) pulse.graceUntil = now() + GRACE; // Pulse.poke past the gap opens the grace
      pulse.pokes.push({ t: w.t, silence: now() - pulse.last });
      pulse.last = now();
      return { hash: "0x01" };
    },
  });
  ctx.book.pulse = { lastPulse: async () => pulse.last, gap: async () => GAP, graceUntil: async () => pulse.graceUntil, inGrace: async () => now() < pulse.graceUntil || now() - pulse.last > GAP };
  pulse.last = now() - 100; // somebody poked 100 s ago
  return { w, ctx, raised, pulse, now };
}

test("a backfill that fails on its last range keeps what it proved (the cursor moves)", async () => {
  const { w, ctx } = world();
  const real = w.peer.provider.getLogs;
  let n = 0;
  w.peer.provider.getLogs = async (f) => { if (++n === 11_700) throw new Error("429 Too Many Requests"); return real(f); };
  await runRound(ctx, ["bridge"]);
  const s = readStateOr("bridge-watch.json", {});
  console.log(`after ${n} getLogs calls and one failure: peer cursor = ${s.peer?.next ?? "nothing saved (starts again from block 0)"}`);
  assert.ok((s.peer?.next ?? 0) > 0, "11,699 answered log reads were thrown away: the next pass starts again from block 0");
});