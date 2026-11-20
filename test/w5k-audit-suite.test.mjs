// Internal review of the bridge-watcher fixes after audit wave 5; the reviewer's cases A-D and the migration proof, ported onto the
// repo's bridge-world fakes as properties.
//   P1  a state file written before the wave-5 fixes, upgraded, then hit by a reorg (of the newest checkpoint, or deeper than every
//       checkpoint), never calls a past honest transfer forged; a reorg deeper than everything kept is critical `bridge-reindex-*` with
//       the index kept.
//   P2a (A) one RPC with a far-too-high head cannot keep a forgery from being named FORGED.
//   P2b (B) home logs/counters that cannot be read (RPCs disagree) are a gap: critical after unverifiedSeconds.
//   P2c (C) a home RPC that freezes is critical `bridge-head-stalled-*` within headStallSeconds (+ a pass).
//   P3  (D) a first pass that cannot find the peer's start saves no peer side; the journal's "mined" is trusted for a while only; the
//       alert lifecycle: a one-shot undelivered key is retried, a never-delivered key clears without a "cleared", a failed "cleared"
//       is retried.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utils } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5k-aud-"));
const { runBridge, claimLabel } = await import("../lib/bridge.mjs");
const { statePath } = await import("../lib/state.mjs");
const { makeAlerts } = await import("../lib/alerts.mjs");
const { EID } = await import("../lib/robinhood.mjs");
const { E18, T0, bridgeCtx, forge, honest, makeBridgeWorld, runPasses } = await import("./lib/bridge-world.mjs");

const reset = () => rmSync(process.env.STATE_DIR, { recursive: true, force: true });
const file = () => join(process.env.STATE_DIR, "bridge-watch.json");
const keys = (raised) => [...new Set(raised.map((a) => a.key))];
async function passes(w, ctx, from, to) {
  for (let p = from; p <= to; p += 120) { if (w.t < p) w.t = p; try { await runBridge(ctx); } catch { /* the loop logs it */ } }
}
/** What a keeper before the wave-5 fixes (f30a9d0) left: no start, checkpoints, base, kept events or first-seen times (bounds stamped with no lag rule). */
function legacy() {
  const s = JSON.parse(readFileSync(file(), "utf8"));
  for (const side of [s.home, s.peer]) {
    for (const k of ["start", "cp", "base", "baseCp", "log", "headSeen", "reindex"]) delete side[k];
    for (const m of ["received", "queue"]) for (const e of Object.values(side[m] ?? {})) delete e.seenAt;
    for (const byHash of Object.values(side.verified ?? {})) for (const v of Object.values(byHash)) delete v.seenAt;
  }
  delete s.hist;
  writeFileSync(file(), JSON.stringify(s));
}

test("P1: a pre-wave-5 state file + a reorg of the first new checkpoint never flags past transfers forged (reviewer's proof)", async () => {
  reset();
  const w = makeBridgeWorld({ seed: 9, home: 1 });
  for (let i = 1; i <= 3; i++) honest(w, 4663, i, T0 + 100 * i, 120, E18.mul(100));
  const raised = [];
  const ctx = bridgeCtx(w, raised, {}, { peerLagSeconds: 600 });
  await passes(w, ctx, T0 + 60, T0 + 1800);
  legacy();
  raised.length = 0;
  w.t += 120; await runBridge(ctx);
  const s1 = JSON.parse(readFileSync(file(), "utf8"));
  w.peer.reorgFrom(s1.peer.cp.at(-1).block);
  await passes(w, ctx, w.t + 120, w.t + 120 * 30);
  const s2 = JSON.parse(readFileSync(file(), "utf8"));
  assert.deepEqual(Object.keys(s2.peer.sent).sort(), ["30101:1", "30101:2", "30101:3"].map((k) => k.replace("30101", String(EID[1]))).sort(), "the peer's history was dropped");
  assert.deepEqual(keys(raised).filter((k) => /^bridge-(forged|counters)-/.test(k)), []);
});

test("P1: a reorg deeper than everything kept keeps the index and says re-index (critical); nothing past is called forged", async () => {
  reset();
  const w = makeBridgeWorld({ seed: 10, home: 1 });
  for (let i = 1; i <= 3; i++) honest(w, 4663, i, T0 + 100 * i, 120, E18.mul(100));
  const raised = [];
  const ctx = bridgeCtx(w, raised, {}, { peerLagSeconds: 600 });
  await passes(w, ctx, T0 + 60, T0 + 1800);
  w.peer.reorgFrom(0); // every block the watcher ever proved has a new hash
  await passes(w, ctx, w.t + 120, w.t + 120 * 20);
  const s = JSON.parse(readFileSync(file(), "utf8"));
  assert.equal(Object.keys(s.peer.sent).length, 3, "index kept");
  assert.ok(raised.some((a) => a.key === "bridge-reindex-4663" && a.level === "critical"), keys(raised).join(","));
  assert.deepEqual(keys(raised).filter((k) => /^bridge-(forged|counters)-/.test(k)), []);
});

test("A: one peer RPC with a far-too-high head: a forged mint is still named FORGED", async () => {
  reset();
  const w = makeBridgeWorld({ seed: 3, home: 1 });
  w.peer.provider.maxHead = async () => w.peer.headAt(w.t) + 1_000_000_000;
  const f = forge(w, 1, 1000, T0 + 1000, E18.mul(5000));
  const raised = await runPasses(w, runBridge, { horizon: 4 * 3600, watch: { peerLagSeconds: 600 } });
  const hit = raised.find((a) => a.key === "bridge-forged-mainnet-1000" && a.level === "critical");
  assert.ok(hit && hit.t - f.tv <= 1800 + 600, `${hit ? `named ${Math.round(hit.t - f.tv)} s late` : "never named"}: ${keys(raised)}`);
});

test("B: home log RPCs that disagree from +1200 s on: a critical gap within unverifiedSeconds (+ a pass)", async () => {
  reset();
  const w = makeBridgeWorld({ seed: 4, home: 1 });
  honest(w, 4663, 1, T0 + 900, 30000, E18.mul(6000));
  forge(w, 1, 1000, T0 + 1500, E18.mul(5000));
  const g = w.home.provider.getLogs;
  w.home.provider.getLogs = async (q) => { if (w.t > T0 + 1200) throw new Error("read RPCs disagree on getLogs at blocks x-y (a vs b)"); return g(q); };
  const raised = await runPasses(w, runBridge, { horizon: 4 * 3600, watch: { peerLagSeconds: 600 } });
  const crit = raised.find((a) => a.key === "bridge-index-gap-mainnet" && a.level === "critical");
  assert.ok(crit && crit.t - (T0 + 1200) <= 1800 + 300, `${crit ? `critical ${Math.round(crit.t - T0 - 1200)} s after` : "never critical"}: ${keys(raised)}`);
});

test("C: a home RPC that freezes at +1200 s is critical bridge-head-stalled within headStallSeconds + a pass", async () => {
  reset();
  const w = makeBridgeWorld({ seed: 5, home: 1 });
  const TF = T0 + 1200;
  for (const obj of [w.home.provider, w.home.bridgeContract, w.home.endpointContract]) for (const [k, f] of Object.entries(obj)) {
    if (typeof f !== "function") continue;
    obj[k] = async (...a) => { const d = Math.max(0, w.t - TF); w.t -= d; try { return await f(...a); } finally { w.t += d; } };
  }
  forge(w, 1, 1000, T0 + 1500, E18.mul(5000));
  const raised = await runPasses(w, runBridge, { horizon: 4 * 3600, watch: { peerLagSeconds: 600 } });
  const hit = raised.find((a) => a.key === "bridge-head-stalled-mainnet" && a.level === "critical");
  assert.ok(hit && hit.t - TF <= 600 + 300, `${hit ? `${Math.round(hit.t - TF)} s after the freeze` : "never"}: ${keys(raised)}`);
});

test("D: a first-pass peer outage with peer.fromBlock unset saves no peer side; the next pass finds the deploy block", async () => {
  reset();
  const w = makeBridgeWorld({ seed: 6, home: 1 });
  const deploy = w.peer.headAt(T0) - 500;
  const ctx = bridgeCtx(w, [], {}, { peerLagSeconds: 600 });
  ctx.cfg.BRIDGE_WATCH.peer.fromBlock = null;
  w.peer.provider.getCode = async (a, b) => (Number(b) >= deploy ? "0x01" : "0x");
  const gb = w.peer.provider.getBlockNumber; let n = 0;
  w.peer.provider.getBlockNumber = async () => { if (n++ === 0) throw new Error("timeout"); return gb(); };
  w.t = T0 + 60; await runBridge(ctx).catch(() => {});
  const s0 = JSON.parse(readFileSync(file(), "utf8"));
  assert.ok(!s0.peer, `a peer side was saved with start ${s0.peer?.start}`);
  w.t = T0 + 180; await runBridge(ctx).catch(() => {});
  const s = JSON.parse(readFileSync(file(), "utf8"));
  assert.equal(s.peer.start, deploy);
});

test("P3: the journal's 'mined' is trusted for minedTrustSeconds only: a claim the chain still shows pending 2 h later goes again", async () => {
  reset();
  const w = makeBridgeWorld({ seed: 5, home: 4663, delay: 600 });
  const rec = honest(w, 1, 1, T0 + 100, 200, E18.mul(100), { queue: true });
  const sends = [];
  const ctx = bridgeCtx(w, [], { execute: true, settleSends: async () => {}, actHook: async (label) => { sends.push(label); return { hash: "0x01" }; } });
  await passes(w, ctx, T0 + 60, T0 + 780);
  const label = claimLabel(EID[1], rec.claim.guid), hash = utils.hexZeroPad("0xabab", 32), at = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  mkdirSync(process.env.STATE_DIR, { recursive: true });
  appendFileSync(statePath("journal.jsonl"), `${JSON.stringify({ at, step: "signed", scope: "tx", label, hash, nonce: 7 })}\n${JSON.stringify({ at, step: "mined", scope: "tx", nonce: 7, hash, block: 1 })}\n`);
  await passes(w, ctx, T0 + 900, T0 + 1500);
  assert.ok(sends.length >= 1, "a reorged-out claim was never sent again");
});

test("P3: alert lifecycle: a one-shot undelivered key is retried from settle; never delivered clears silently; a failed 'cleared' is retried", async () => {
  reset();
  process.env.TELEGRAM_BOT_TOKEN = "t"; process.env.TELEGRAM_CHAT_ID = "c";
  try {
    let ok = false;
    const sent = [];
    const fetchImpl = async (u, o) => { sent.push(JSON.parse(o.body).text.split("\n")[1]); return { ok }; };
    let t = 0;
    const a = makeAlerts(() => {}, "x", { fetchImpl, now: () => t });
    await a.raise("critical", "k-once", "forged");           // undelivered
    await a.raise("critical", "k-never", "x");               // undelivered, then cleared before any delivery
    ok = true;
    sent.length = 0;
    await a.settle("k-", new Set(["k-once"]));              // k-once retried; k-never clears silently
    assert.deepEqual(sent, ["k-once: forged"]);
    ok = false; sent.length = 0;
    await a.settle("k-", new Set());                         // k-once clears: its "cleared" fails
    ok = true; sent.length = 0;
    await a.settle("k-", new Set());                         // and goes now
    assert.deepEqual(sent, ["k-once: cleared (was critical)"]);
    sent.length = 0;
    await a.settle("k-", new Set());
    assert.deepEqual(sent, []);
  } finally {
    delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID;
  }
});
