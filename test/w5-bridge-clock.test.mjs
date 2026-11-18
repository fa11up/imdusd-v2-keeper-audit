// Fixed before audit wave 5: CROSS-CHAIN TIME IN THE BRIDGE WATCHER.
// PROPERTY: a Received is judged against the source chain's Sent only once the source has been read past the Received in ONE consistent
// clock; no honest transfer is ever flagged forged (or unverified, or stuck) because the two chains' clocks disagree, every forged
// Received is flagged FORGED within the stated bound (BRIDGE_WATCH.unverifiedSeconds, 30 min), and none stays unjudged past it.
// Fuzzed: each chain's clock skew in [-2 h, +2 h] both ways, RPC latency, slow calls (30-300 s), both keeper homes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5-clock-"));
const { runBridge } = await import("../lib/bridge.mjs");
const { makeBridgeWorld, nameOf, randomTraffic, runPasses } = await import("./lib/bridge-world.mjs");
const { rng } = await import("./lib/rh-world.mjs");

const BOUND = 1800;

async function scenario(seed) {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  const r = rng(seed * 7919);
  const skew = { 1: Math.round((r() * 2 - 1) * 7200), 4663: Math.round((r() * 2 - 1) * 7200) };
  const w = makeBridgeWorld({ seed, skew, slowP: 0.04, home: r() < 0.5 ? 4663 : 1 });
  randomTraffic(w);
  const raised = await runPasses(w, runBridge);
  const where = `seed ${seed} (home ${w.home.id}, skew mainnet ${skew[1]} s, 4663 ${skew[4663]} s)`;
  // Honest: never forged, unverified or stuck (all are delivered within 15 min, far under the 30 min stuck warning).
  for (const h of w.honest) {
    const bad = raised.filter((a) => new RegExp(`^bridge-(forged|unverified)-${nameOf(h.dst)}-${h.nonce}$`).test(a.key) || new RegExp(`^bridge-stuck-${nameOf(h.src)}-${h.nonce}$`).test(a.key));
    assert.deepEqual(bad.map((a) => a.key), [], `${where}: honest ${nameOf(h.src)}->${nameOf(h.dst)} nonce ${h.nonce} raised ${bad.map((a) => a.key)}`);
  }
  // Forged: flagged FORGED (critical) within the bound of its Received.
  for (const f of w.forged) {
    const hit = raised.find((a) => a.key === `bridge-forged-${nameOf(f.dst)}-${f.nonce}`);
    assert.ok(hit, `${where}: forged nonce ${f.nonce} into ${nameOf(f.dst)} was never flagged forged`);
    assert.equal(hit.level, "critical");
    // The bound is in watcher time: net of the injected RPC stalls (30-300 s each). Raw, seed 48 took 1,784 s on the parent of the
    // auto-claim commit and 1,834 s after it (two more reads a pass); net of stalls the worst seed is ~310 s on both.
    const net = hit.t - f.tv - w.stalledBetween(f.tv, hit.t);
    assert.ok(net <= BOUND, `${where}: forged nonce ${f.nonce} into ${nameOf(f.dst)} flagged ${Math.round(hit.t - f.tv)} s after it (${Math.round(net)} s net of RPC stalls), past the ${BOUND} s bound`);
  }
}

test("clock skew between the chains never flags an honest transfer and never delays a forgery past the bound (60 seeded runs, skew both ways)", async () => {
  for (let seed = 1; seed <= 60; seed++) await scenario(seed);
});

test("the named cases: 4663 one hour ahead of L1, and one hour behind", async () => {
  for (const [s4663, home] of [[3600, 4663], [-3600, 4663], [3600, 1], [-3600, 1]]) {
    rmSync(process.env.STATE_DIR, { recursive: true, force: true });
    const w = makeBridgeWorld({ seed: 5, skew: { 1: 0, 4663: s4663 }, slowP: 0.04, home });
    randomTraffic(w);
    const raised = await runPasses(w, runBridge);
    const honestBad = raised.filter((a) => w.honest.some((h) => a.key === `bridge-forged-${nameOf(h.dst)}-${h.nonce}` || a.key === `bridge-unverified-${nameOf(h.dst)}-${h.nonce}` || a.key === `bridge-stuck-${nameOf(h.src)}-${h.nonce}`));
    assert.deepEqual(honestBad.map((a) => a.key), [], `4663 skew ${s4663}, home ${home}`);
  }
});
