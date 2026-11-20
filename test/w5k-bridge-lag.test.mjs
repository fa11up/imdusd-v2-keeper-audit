// wave-5 keeper audit #1: A LAGGING SOURCE RPC.
// PROPERTY (P5/C3): an RPC that serves the peer chain as it was up to BRIDGE_WATCH.peerLagSeconds (600 s, the production default) ago,
// consistently (heads, blocks, logs, counters, settings all from the same stale view), never makes an honest transfer FORGED, its
// queued claim FORGED, or the counters critical; and every forgery is still flagged critical (forged, or unverified when it cannot be
// proven) within 30 min + the lag. Fuzzed: lag 0-600 s, skew, both homes, random honest traffic both ways (minted and queued).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5k-lag-"));
const { runBridge } = await import("../lib/bridge.mjs");
const { E18, honest, makeBridgeWorld, nameOf, randomTraffic, runPasses, T0 } = await import("./lib/bridge-world.mjs");
const { rng } = await import("./lib/rh-world.mjs");

function lagPeer(w, lag) {
  for (const obj of [w.peer.provider, w.peer.bridgeContract, w.peer.endpointContract]) {
    for (const [k, f] of Object.entries(obj)) {
      if (typeof f !== "function") continue;
      obj[k] = async (...a) => { w.t -= lag; try { return await f(...a); } finally { w.t += lag; } };
    }
  }
}

test("a peer RPC lagging up to 600 s never makes an honest transfer forged; forgeries are still flagged critical (15 seeded runs)", async () => {
  for (let seed = 1; seed <= 15; seed++) {
    rmSync(process.env.STATE_DIR, { recursive: true, force: true });
    const r = rng(seed * 7717);
    const lag = Math.floor(r() * 600);
    const w = makeBridgeWorld({ seed, skew: { 1: Math.round((r() * 2 - 1) * 600), 4663: Math.round((r() * 2 - 1) * 600) }, home: r() < 0.5 ? 4663 : 1 });
    randomTraffic(w);
    honest(w, w.peer.id, 900, T0 + 1500, 120, E18.mul(6000), { queue: true });
    lagPeer(w, lag);
    const raised = await runPasses(w, runBridge, { horizon: 2 * 3600, watch: { peerLagSeconds: 600 } });
    const where = `seed ${seed} (home ${w.home.id}, peer lag ${lag} s)`;
    for (const h of w.honest) {
      const bad = raised.filter((a) => a.key === `bridge-forged-${nameOf(h.dst)}-${h.nonce}` || a.key === `bridge-queued-forged-${nameOf(h.dst)}-${h.nonce}`);
      assert.deepEqual(bad.map((a) => a.key), [], `${where}: honest ${nameOf(h.src)}->${nameOf(h.dst)} nonce ${h.nonce}`);
    }
    for (const id of [1, 4663]) {
      if (w.forged.some((f) => f.dst === id && f.executed)) continue; // a forged mint really is received without a burn
      assert.deepEqual(raised.filter((a) => a.key === `bridge-counters-${nameOf(id)}`).map((a) => `${Math.round(a.t - T0)} ${a.msg}`).slice(0, 2), [], `${where}: counters`);
    }
    for (const f of w.forged) {
      const hit = raised.find((a) => a.level === "critical" && (a.key === `bridge-forged-${nameOf(f.dst)}-${f.nonce}` || a.key === `bridge-unverified-${nameOf(f.dst)}-${f.nonce}` || a.key === `bridge-verified-forged-${nameOf(f.dst)}-${f.nonce}`));
      if (f.tv > T0 + 2 * 3600 - 2400) continue;
      assert.ok(hit && hit.t - f.tv - w.stalledBetween(f.tv, hit.t) <= 1800 + lag + 300, `${where}: forged nonce ${f.nonce} into ${nameOf(f.dst)} ${hit ? `flagged ${Math.round(hit.t - f.tv)} s late` : "never flagged"}`);
    }
  }
});
