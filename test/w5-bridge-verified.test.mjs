// Fixed before audit wave 5: THE WATCHER SEES A FORGERY BEFORE IT MINTS, WHEN IT CAN.
// PROPERTY: an inbound packet verified at the destination EndpointV2 for our bridge whose payload hash matches no Sent at that nonce on
// the source (judged in the source's own blocks) raises a CRITICAL `bridge-verified-forged-*` while it is still waiting
// at the endpoint (verified, not executed), within the stated bound; an honest verified packet never does. A packet that executes in
// the block it is verified (anyone may run lzReceive at once) is caught only by its Received: there is NO window then, and the test
// says so instead of pretending otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5-verified-"));
const { runBridge } = await import("../lib/bridge.mjs");
const { forge, makeBridgeWorld, nameOf, randomTraffic, runPasses, T0, E18 } = await import("./lib/bridge-world.mjs");
const { rng } = await import("./lib/rh-world.mjs");

const BOUND = 1800;

test("a forged packet waiting at the endpoint is flagged critical before it executes; honest verified packets never are (40 seeded runs)", async () => {
  for (let seed = 1; seed <= 40; seed++) {
    rmSync(process.env.STATE_DIR, { recursive: true, force: true });
    const r = rng(seed * 15485863);
    const skew = { 1: Math.round((r() * 2 - 1) * 3600), 4663: Math.round((r() * 2 - 1) * 3600) };
    const w = makeBridgeWorld({ seed, skew, slowP: 0.02, home: r() < 0.5 ? 4663 : 1 });
    // Forgeries wait at the endpoint (inbound limit spent, path paused, a hold): never executed, or executed only 20-60 min later.
    randomTraffic(w, { forgeries: false });
    for (const dst of [1, 4663]) {
      const n = 1 + Math.floor(r() * 2);
      for (let f = 0; f < n; f++) {
        const late = r() < 0.5;
        forge(w, dst, 1000 + f, T0 + 300 + r() * 3000, E18.mul(5000), late ? { executeAfter: 1200 + r() * 2400 } : { execute: false });
      }
    }
    const raised = await runPasses(w, runBridge);
    const where = `seed ${seed} (home ${w.home.id}, skew mainnet ${skew[1]} s, 4663 ${skew[4663]} s)`;
    for (const f of w.forged) {
      const hit = raised.find((a) => a.key === `bridge-verified-forged-${nameOf(f.dst)}-${f.nonce}`);
      assert.ok(hit, `${where}: forged packet nonce ${f.nonce} waiting at ${nameOf(f.dst)}'s endpoint was never flagged`);
      assert.equal(hit.level, "critical");
      assert.ok(hit.t - f.tv <= BOUND, `${where}: flagged ${Math.round(hit.t - f.tv)} s after verification, past the bound`);
      if (f.te !== null) assert.ok(hit.t < f.te, `${where}: nonce ${f.nonce} flagged at ${Math.round(hit.t - f.tv)} s, AFTER it executed at ${Math.round(f.te - f.tv)} s`);
      assert.match(hit.msg, /NOT (YET )?EXECUTED|waits at the endpoint/i, `${where}: the alert must tell the Safe it can still hold/void`);
    }
    for (const h of w.honest) {
      const bad = raised.filter((a) => a.key === `bridge-verified-forged-${nameOf(h.dst)}-${h.nonce}` || a.key === `bridge-verified-unverified-${nameOf(h.dst)}-${h.nonce}`);
      assert.deepEqual(bad.map((a) => a.key), [], `${where}: honest nonce ${h.nonce} into ${nameOf(h.dst)} raised ${bad.map((a) => a.key)}`);
    }
  }
});

test("NO WINDOW: a forgery executed in the block it is verified is caught by its Received (bridge-forged), after the mint", async () => {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  const w = makeBridgeWorld({ seed: 9, home: 4663 });
  randomTraffic(w, { forgeries: false });
  const f = forge(w, 4663, 1000, T0 + 900, E18.mul(5000));
  const raised = await runPasses(w, runBridge);
  const minted = raised.find((a) => a.key === `bridge-forged-4663-${f.nonce}`);
  assert.ok(minted && minted.level === "critical", "the executed forgery is flagged FORGED from its Received");
  assert.ok(minted.t > f.te, "...necessarily after its mint: the endpoint stored it for no block the watcher could read");
  const waiting = raised.find((a) => a.key === `bridge-verified-forged-4663-${f.nonce}`);
  assert.ok(!waiting || !/NOT (YET )?EXECUTED/i.test(waiting.msg), "it must never be reported as still holdable");
});
