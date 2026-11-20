// wave-5 keeper audit: the judge's proof for HIGH finding 1, kept as a regression (it failed on f30a9d0 as claimed).
// AUDIT PROOF (C3 / P5): a source RPC that LAGS (a stale head that still advances) makes the watcher call an honest transfer FORGED.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "audit-stale-head-"));
const { runBridge } = await import("../lib/bridge.mjs");
const { E18, honest, makeBridgeWorld, runPasses, T0 } = await import("./lib/bridge-world.mjs");

/** The peer's RPC answers everything (head, blocks, logs, counters, settings) as the chain was `lag` seconds ago: one consistent, stale node. */
function lagPeer(w, lag) {
  for (const obj of [w.peer.provider, w.peer.bridgeContract]) {
    for (const [k, f] of Object.entries(obj)) {
      if (typeof f !== "function") continue;
      obj[k] = async (...a) => {
        w.t -= lag;
        try { return await f(...a); } finally { w.t += lag; }
      };
    }
  }
}

async function run(lag) {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  const w = makeBridgeWorld({ seed: 11, home: 1 }); // the MAINNET keeper; its peer is 4663, read through ONE RPC (config.example.js PEERS)
  if (lag) lagPeer(w, lag);
  honest(w, 4663, 1, T0 + 2000, 120, E18.mul(100)); // Sent on 4663, Received on mainnet 2 min later
  honest(w, 4663, 2, T0 + 2060, 120, E18.mul(6000), { queue: true }); // over the instant cap: Queued on mainnet
  const raised = await runPasses(w, runBridge, { horizon: 3600, watch: { peerLagSeconds: 600 } }); // the production default
  return raised.filter((a) => a.level === "critical" && /^bridge-(forged|queued-forged|counters)-/.test(a.key));
}

test("control: a fresh 4663 RPC, the two honest transfers raise nothing", async () => {
  assert.deepEqual((await run(0)).map((a) => a.key), []);
});

test("a lone 4663 RPC lagging 10 min (advancing, self-consistent) never makes an honest transfer FORGED", async () => {
  const bad = await run(600);
  for (const a of bad.filter((x, i) => bad.findIndex((y) => y.key === x.key) === i)) console.log(`t+${Math.round(a.t - T0)}s ${a.level} ${a.key}: ${a.msg.slice(0, 230)}`);
  assert.deepEqual([...new Set(bad.map((a) => a.key))], [], "honest transfers were flagged as forgeries");
});