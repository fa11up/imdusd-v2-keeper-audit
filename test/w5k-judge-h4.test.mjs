// wave-5 keeper audit: the judge's proof for HIGH finding 4, kept as a regression (it failed on f30a9d0 as claimed).
// C2/P8: while the PEER chain's RPC is down the bridge loop throws before anything else: a matured claim already matched to its Sent is not sent
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, utils } from "ethers";
process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "audit-"));
const { runBridge, judgeQueued } = await import("../lib/bridge.mjs");
const { readStateOr } = await import("../lib/state.mjs");
const { EID } = await import("../lib/robinhood.mjs");
const { BRIDGE_IFACE, bridgeCtx, E18, honest, makeBridgeWorld, guidOf, settleClaim, T0 } = await import("./lib/bridge-world.mjs");
const fresh = () => rmSync(process.env.STATE_DIR, { recursive: true, force: true });
const addr = (i) => utils.getAddress(utils.hexZeroPad(utils.hexlify(i), 20));
/** Alerts as lib/alerts.mjs keeps them: raise makes a key stand, settle clears every key of the prefix this pass did not raise. */
const recorder = (w) => {
  const standing = new Map(), log = [];
  return { standing, log,
    raise: async (level, key, msg) => { standing.set(key, level); log.push({ t: Math.round(w.t - T0), level, key, msg }); },
    settle: async (prefix, held) => { for (const k of [...standing.keys()]) if (k.startsWith(prefix) && !held.has(k)) { log.push({ t: Math.round(w.t - T0), level: "cleared", key: k, was: standing.get(k) }); standing.delete(k); } } };
};
/** The watcher every 120 s, as keeper.mjs runs it: a pass that throws is logged and the next one runs. */
async function passes(w, ctx, from, to, each = () => {}) {
  const errors = [];
  for (let p = from; p <= to; p += 120) { if (w.t < p) w.t = p; await each(p); try { await runBridge(ctx); } catch (e) { errors.push({ t: p - T0, e: e.message }); } }
  return errors;
}
async function run(outage) {
  fresh();
  const w = makeBridgeWorld({ seed: 5, home: 4663, delay: 600 });
  const rec = honest(w, 1, 1, T0 + 100, 200, E18.mul(100), { queue: true }); // Sent on mainnet +100 s, Queued on 4663 +300 s, matures +900 s
  const sends = [];
  const a = recorder(w);
  const ctx = bridgeCtx(w, [], { alerts: a, execute: true, settleSends: async () => {},
    actHook: async (label) => { sends.push({ t: Math.round(w.t - T0), label }); settleClaim(w, 4663, rec.claim, 2); return { hash: utils.hexZeroPad("0x01", 32), block: 0, gas: "1" }; } });
  let down = false;
  for (const o of [w.peer.provider, w.peer.bridgeContract]) for (const k of Object.keys(o)) if (typeof o[k] === "function") { const f = o[k]; o[k] = async (...x) => { if (down) throw new Error("mainnet RPC: 503"); return f(...x); }; }
  const verdictBefore = [];
  const errors = await passes(w, ctx, T0 + 60, T0 + 2700, (p) => {
    if (outage && p >= T0 + 850 && !down) { // the claim is indexed and judged before the peer goes down
      const s = readStateOr("bridge-watch.json", {});
      verdictBefore.push(judgeQueued(Object.values(s.home.queue)[0], "1", s.peer, EID[4663]).verdict);
      down = true;
    }
  });
  return { sends, errors, verdictBefore, alerts: [...new Set(a.log.map((x) => `${x.level} ${x.key}`))] };
}
test("control: with the mainnet RPC up, the honest matured claim is sent in the first pass after it matures", async () => {
  const r = await run(false);
  assert.equal(r.sends.length, 1);
  assert.ok(r.sends[0].t >= 900 && r.sends[0].t <= 1030, `sent at +${r.sends[0].t}s`);
});
test("a matured claim already matched to its Sent is sent while the PEER chain's RPC is down", async () => {
  const r = await run(true);
  console.log(`verdict saved before the outage: ${r.verdictBefore}; passes that threw: ${r.errors.length} ("${r.errors[0]?.e}"); bridge alerts in 30 min: [${r.alerts}]`);
  assert.equal(r.sends.length, 1, `matured at +900 s, verdict "${r.verdictBefore}" already on disk, ${r.errors.length} passes threw, ${r.sends.length} claims sent by +2700 s`);
});
test("P5: a FORGED claim queued at home while the peer RPC is down is flagged (forged or unverified) long before it matures", async () => {
  fresh();
  const { forgeQueued } = await import("./lib/bridge-world.mjs");
  const w = makeBridgeWorld({ seed: 9, home: 4663 }); // delay 12 h
  const f = forgeQueued(w, 4663, 1000, T0 + 900, E18.mul(40_000)); // queued on 4663 at +900 s, claimable by anyone 12 h later
  const a = recorder(w);
  const ctx = bridgeCtx(w, [], { alerts: a });
  let down = false;
  for (const o of [w.peer.provider, w.peer.bridgeContract]) for (const k of Object.keys(o)) if (typeof o[k] === "function") { const fn = o[k]; o[k] = async (...x) => { if (down) throw new Error("mainnet RPC: 503"); return fn(...x); }; }
  const errors = await passes(w, ctx, T0 + 60, T0 + 900 + 43_200, (p) => { if (p >= T0 + 850) down = true; });
  const named = a.log.filter((x) => /-1000$/.test(x.key));
  console.log(`forged claim of 40,000 imdUSD queued at +900 s, matured at +${Math.round(f.claim.mature - T0)} s; passes that threw: ${errors.length}; bridge alerts naming it in 12 h: [${named.map((x) => x.key)}]; all bridge alerts: [${[...new Set(a.log.map((x) => x.key))]}]`);
  assert.ok(named.length > 0, `home-chain reads worked all along, yet in 12 h no bridge alert named the forged Queued (only loop-failing-bridge from keeper.mjs after 5 passes)`);
});