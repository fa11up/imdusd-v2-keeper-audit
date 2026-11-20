// wave-5 keeper audit #5, #8, #10, #11, #14, #15, #22: THE WATCHER'S INDEX AND ITS ALERTS.
//   #5  a pass reads a bounded number of ranges and keeps every range it proved (the next pass resumes).
//   #8  (P4) a gap alert stands, and its 30 min count to critical runs on, through a pass that read nothing (a stale head).
//   #10  (C3/P5) a reorg deeper than the lag that rewrites indexed blocks is followed: honest transfers never stay "forged", the cursor
//       never stops for good.
//   #11 (P5/P4) a packet verified at the endpoint and waiting is never lost behind a log RPC that answers [] for the endpoint's logs:
//       the cursor stays (gap) until the PacketVerified is read, then the forgery is flagged.
//   #14 every supply term is read at one block.
//   #15 (P4) a standing claim alert is not cleared by a pass whose claims() read failed.
//   #22 (P8) a claim the journal records as mined is not sent again, whatever a lagging node says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, providers, utils } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5k-misc-"));
const { runBridge, indexSide, emptySide, readSupply, autoClaim, claimLabel } = await import("../lib/bridge.mjs");
const { readStateOr, statePath } = await import("../lib/state.mjs");
const { EID } = await import("../lib/robinhood.mjs");
const W = await import("./lib/bridge-world.mjs");
const { BRIDGE_IFACE, E18, T0, bridgeCtx, forge, guidOf, honest, makeBridgeWorld, pushLog, settleClaim } = W;

const fresh = () => rmSync(process.env.STATE_DIR, { recursive: true, force: true });
const user = (i) => utils.getAddress(utils.hexZeroPad(utils.hexlify(0x1000 + i), 20));
/** Alerts as lib/alerts.mjs keeps them (raise stands a key, settle clears what a pass did not hold). */
const recorder = (w) => {
  const standing = new Map(), log = [];
  return { standing, log,
    raise: async (level, key, msg) => { standing.set(key, level); log.push({ t: Math.round(w.t - T0), level, key, msg }); },
    settle: async (prefix, held) => { const keep = typeof held === "function" ? held : (k) => held.has(k); for (const k of [...standing.keys()]) if (k.startsWith(prefix) && !keep(k)) { log.push({ t: Math.round(w.t - T0), level: "cleared", key: k }); standing.delete(k); } } };
};
async function passes(w, ctx, from, to, each = () => {}) {
  for (let p = from; p <= to; p += 120) { if (w.t < p) w.t = p; await each(p); try { await runBridge(ctx); } catch { /* the loop logs it */ } }
}

test("#5: one indexSide call reads at most maxChunks ranges and keeps them; repeated calls reach head - lag", async () => {
  const w = makeBridgeWorld({ seed: 2, home: 4663 });
  w.t = T0 + 3600;
  const side = emptySide(1);
  let calls = 0;
  const p = { ...w.peer.provider, getLogs: async (f) => { calls++; return w.peer.provider.getLogs(f); } };
  const r = await indexSide(p, w.peer.bridgeContract, side, { lag: 3, chunk: 100, maxChunks: 5 });
  assert.ok(r.partial, "a bounded pass says partial");
  assert.equal(side.throughBlock, 500, "five proven ranges kept");
  assert.ok(calls <= 5 * 4, `${calls} log reads`);
  for (let i = 0; i < 100 && side.throughBlock < w.peer.headAt(w.t) - 3; i++) await indexSide(p, w.peer.bridgeContract, side, { lag: 3, chunk: 1000, maxChunks: 50 });
  assert.equal(side.throughBlock, w.peer.headAt(w.t) - 3);
});

test("#8: a stale head every 5th pass never clears the gap alert nor restarts its count; it turns critical after 30 min", async () => {
  fresh();
  const w = makeBridgeWorld({ seed: 4, home: 4663 });
  honest(w, 1, 1, T0 + 200, 100, E18.mul(10));
  const hidden = w.home.logs.find((l) => l.name === "Received");
  const real = w.home.provider.getLogs, head = w.home.provider.getBlockNumber;
  w.home.provider.getLogs = async (f) => (await real(f)).filter((l) => l.transactionHash !== hidden.tx);
  let n = 0;
  w.home.provider.getBlockNumber = async () => (++n % 5 === 0 ? readStateOr("bridge-watch.json", {}).home?.next ?? 0 : head());
  const a = recorder(w);
  await passes(w, bridgeCtx(w, [], { alerts: a }), T0 + 60, T0 + 90 * 60);
  const cleared = a.log.filter((x) => x.level === "cleared" && x.key === "bridge-index-gap-4663");
  assert.deepEqual(cleared, [], `cleared ${cleared.length} times: ${JSON.stringify(a.log.filter((x) => x.key.includes("gap") && x.level !== "warn").slice(0, 3))}`);
  const crit = a.log.find((x) => x.key === "bridge-index-gap-4663" && x.level === "critical");
  const first = a.log.find((x) => x.key === "bridge-index-gap-4663");
  assert.ok(crit && crit.t - first.t <= 1800 + 240, `critical ${crit ? `${crit.t - first.t}s after the first warn` : "never"}`);
});

test("M9a: two Sents of one 4663 block re-sequenced by a reorg: the honest deliveries are never called forged", async () => {
  fresh();
  const w = makeBridgeWorld({ seed: 6, home: 1 });
  const ts = T0 + 300;
  honest(w, 4663, 1, ts, null, E18.mul(100));
  honest(w, 4663, 2, ts, null, E18.mul(100));
  const a = recorder(w);
  const ctx = bridgeCtx(w, [], { alerts: a });
  await passes(w, ctx, T0 + 60, T0 + 900);
  // the reorg: the same block, the two recipients swapped (same guids = nonces, same amounts, same sent counter)
  const sents = w.peer.logs.filter((l) => l.name === "Sent");
  for (const l of sents) {
    const args = BRIDGE_IFACE.parseLog(l.encoded).args;
    const swapped = Number(args.nonce) === 1 ? user(2) : user(1);
    l.encoded = BRIDGE_IFACE.encodeEventLog(BRIDGE_IFACE.getEvent("Sent"), [args.guid, args.dstEid, args.from, utils.hexZeroPad(swapped, 32), args.amount, args.nonce]);
  }
  w.peer.reorgFrom(sents[0].block);
  for (const [nonce, to] of [[1, user(2)], [2, user(1)]]) pushLog(w.home, w.home.headAt(w.t), w.home.bridge, BRIDGE_IFACE, "Received", [guidOf(4663, nonce), EID[4663], to, E18.mul(100), nonce], { amount: E18.mul(100) });
  await passes(w, ctx, T0 + 1020, T0 + 4800);
  const bad = a.log.filter((x) => /^bridge-(forged|counters)-/.test(x.key));
  assert.deepEqual(bad.map((x) => x.key), [], "honest deliveries flagged after the reorg");
  assert.ok(a.log.some((x) => x.key === "bridge-reorg-4663"), "the reorg is said");
});

test("M9b: a reorg that moves an indexed Sent to a later block: the cursor keeps moving and nothing honest is flagged", async () => {
  fresh();
  const w = makeBridgeWorld({ seed: 8, home: 1 });
  honest(w, 4663, 1, T0 + 100, null, E18.mul(50));
  const a = recorder(w);
  const ctx = bridgeCtx(w, [], { alerts: a });
  await passes(w, ctx, T0 + 60, T0 + 600);
  const l = w.peer.logs.find((x) => x.name === "Sent");
  w.peer.reorgFrom(l.block);
  l.block = w.peer.headAt(w.t) + 20; // re-included later, past the cursor
  w.peer.logs.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
  pushLog(w.home, w.home.headAt(T0 + 800), w.home.bridge, BRIDGE_IFACE, "Received", [guidOf(4663, 1), EID[4663], user(1), E18.mul(50), 1], { amount: E18.mul(50) });
  await passes(w, ctx, T0 + 720, T0 + 4200);
  const s = readStateOr("bridge-watch.json", {});
  assert.ok(s.peer.throughBlock >= w.peer.headAt(w.t) - 200, `peer cursor ${s.peer.throughBlock}, head ${w.peer.headAt(w.t)}`);
  assert.deepEqual(a.log.filter((x) => /^bridge-(forged|counters|index-gap)-/.test(x.key) && x.level !== "cleared").map((x) => x.key), []);
});

test("#11: a forged packet verified at the next nonce and waiting, behind a log RPC that hides the endpoint's logs, is flagged", async () => {
  fresh();
  const w = makeBridgeWorld({ seed: 10, home: 4663 });
  for (let n = 1; n <= 3; n++) honest(w, 1, n, T0 + 100 * n, 200, E18.mul(10));
  forge(w, 4663, 4, T0 + 900, E18.mul(40_000), { execute: false });
  const real = w.home.provider.getLogs;
  w.home.provider.getLogs = async (f) => (f.topics && w.t < T0 + 3600 ? [] : real(f));
  const a = recorder(w);
  await passes(w, bridgeCtx(w, [], { alerts: a }), T0 + 60, T0 + 4 * 3600);
  assert.ok(a.log.some((x) => x.key === "bridge-verified-forged-4663-4" && x.level === "critical"), `alerts: ${[...new Set(a.log.map((x) => x.key))]}`);
  const gap = a.log.find((x) => x.key === "bridge-index-gap-4663");
  assert.ok(gap && gap.t < 3600, "the hidden PacketVerified holds the cursor and says so while the logs are hidden");
});

test("#14: readSupply reads every term at one block (one read RPC)", async () => {
  const tags = [];
  class P extends providers.StaticJsonRpcProvider {
    constructor() { super("http://x.invalid", 1); }
    async detectNetwork() { return { chainId: 1, name: "homestead" }; }
    async perform(m, p) {
      if (m === "getBlockNumber") return 100 + tags.length;
      if (m === "call") { tags.push(p.blockTag); return utils.hexZeroPad("0x", 32); }
      throw new Error(m);
    }
  }
  const p = new P();
  const A = "0x00000000000000000000000000000000000000a1";
  await readSupply(p, { ledger: A, params: A, usd: A, migrator: A, pegHook: A }, new (await import("ethers")).Contract(A, ["function sent() view returns (uint256)", "function received() view returns (uint256)"], p));
  assert.ok(tags.length >= 6);
  assert.equal(new Set(tags).size, 1, `tags: ${tags}`);
  assert.notEqual(tags[0], "latest");
});

test("#15: a critical claim mismatch stands while claims() cannot be read", async () => {
  fresh();
  const w = makeBridgeWorld({ seed: 5, home: 4663, delay: 600 });
  const rec = honest(w, 1, 1, T0 + 100, 200, E18.mul(100), { queue: true });
  const a = recorder(w);
  const ctx = bridgeCtx(w, [], { alerts: a, execute: true, settleSends: async () => {}, actHook: async () => ({ skipped: "test" }) });
  const realClaims = w.home.bridgeContract.claims;
  w.home.bridgeContract.claims = async (...x) => {
    if (w.t >= T0 + 1020) throw new Error("429");
    const c = await realClaims(...x);
    return { ...c, amountSD: c.amountSD.add(1) }; // not the indexed Queued
  };
  await passes(w, ctx, T0 + 60, T0 + 1500);
  assert.ok(a.log.some((x) => x.key === "bridge-claim-mismatch-4663-1" && x.level === "critical"));
  assert.equal(a.standing.get("bridge-claim-mismatch-4663-1"), "critical", JSON.stringify(a.log.filter((x) => /claim/.test(x.key))));
  void rec;
});

test("#22: a claim the journal records as mined is not sent again when the read node lags", async () => {
  fresh();
  const w = makeBridgeWorld({ seed: 5, home: 4663, delay: 600 });
  const rec = honest(w, 1, 1, T0 + 100, 200, E18.mul(100), { queue: true });
  const sends = [];
  const ctx = bridgeCtx(w, [], { execute: true, settleSends: async () => {}, actHook: async (label) => { sends.push(label); return { hash: "0x01" }; } });
  await passes(w, ctx, T0 + 60, T0 + 780); // indexed and judged, not yet mature
  const label = claimLabel(EID[1], rec.claim.guid);
  const hash = utils.hexZeroPad("0xabab", 32);
  mkdirSync(process.env.STATE_DIR, { recursive: true });
  appendFileSync(statePath("journal.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), step: "signed", scope: "tx", label, hash, nonce: 7 })}\n${JSON.stringify({ at: new Date().toISOString(), step: "mined", scope: "tx", nonce: 7, hash, block: 1 })}\n`);
  await passes(w, ctx, T0 + 900, T0 + 1500); // the node lags: no receipt, claims() still pending
  assert.deepEqual(sends, [], "sent again");
});
