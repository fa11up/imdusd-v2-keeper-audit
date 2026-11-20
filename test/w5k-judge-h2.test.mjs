// wave-5 keeper audit: the judge's proof for HIGH finding 2, kept as a regression (it failed on f30a9d0 as claimed).
// AUDIT PROOF (P5 / P1): runBridge raises its alerts only at the very end, so any read that throws AFTER a forgery was indexed and judged
// drops the forged alert for that pass; while that read keeps failing the forgery is never flagged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "audit-dropped-"));
const { runBridge } = await import("../lib/bridge.mjs");
const { runRound } = await import("../keeper.mjs");
const { readStateOr } = await import("../lib/state.mjs");
const { bridgeCtx, E18, forge, makeBridgeWorld, T0 } = await import("./lib/bridge-world.mjs");

async function run(failPeerPaused) {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  const w = makeBridgeWorld({ seed: 7, home: 4663 });
  forge(w, 4663, 1000, T0 + 300, E18.mul(5000)); // a forged Received on 4663: minted, no Sent on mainnet
  // The mainnet peer RPC answers heads, logs, blocks and counters; ONE later read fails (rate limit): paused(eid), lib/bridge.mjs:722.
  if (failPeerPaused) w.peer.bridgeContract.paused = async () => { throw Object.assign(new Error("429 Too Many Requests"), { code: "SERVER_ERROR" }); };
  const raised = [];
  const ctx = bridgeCtx(w, raised, { loops: [{ name: "bridge", run: runBridge }] });
  for (let p = T0 + 60; p <= T0 + 2 * 3600; p += 120) { // 2 hours of passes, through keeper.mjs runRound (as the daemon runs it)
    if (w.t < p) w.t = p;
    await runRound(ctx, ["bridge"]);
  }
  return { raised, state: readStateOr("bridge-watch.json", {}) };
}

test("control: with every read answering, the forged Received is flagged critical within minutes", async () => {
  const { raised } = await run(false);
  const hit = raised.find((a) => a.key === "bridge-forged-4663-1000");
  assert.ok(hit && hit.level === "critical" && hit.t - (T0 + 300) < 600);
});

test("a forged Received already indexed and judged is flagged even if a LATER read of the pass throws", async () => {
  const { raised, state } = await run(true);
  const r = state.home?.received?.["30101:1000"];
  console.log(`state/bridge-watch.json holds the forged Received: ${JSON.stringify(r)}; mainnet read through ${state.peer?.throughBlock}`);
  console.log(`alerts raised in 2 h: ${JSON.stringify([...new Set(raised.map((a) => `${a.level} ${a.key}`))])}`);
  assert.ok(r && state.peer.throughBlock >= r.srcBound, "the watcher holds the proof (source read past the Received, no Sent)");
  assert.ok(raised.some((a) => a.key === "bridge-forged-4663-1000"), "the forged Received was NEVER flagged in 2 hours");
});