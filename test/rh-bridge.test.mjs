// The bridge watcher (lib/bridge.mjs) against two fake chains serving real ImdBridge event logs (encoded with the contract's own event
// ABI). Properties: every Received has a matching Sent or is alerted FORGED once the source is indexed through the head read after it
// (here, with log lag 0, the same pass); an honest stream raises
// nothing; a Sent not received is stuck (warn, then critical) unless held or voided, which alert as such; counters and the supply equation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, utils } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-rh-bridge-"));
const { counterAlerts, matchDirection, payloadHashOf, runBridge, supplyCheck } = await import("../lib/bridge.mjs");
const { BRIDGE_ABI, EID } = await import("../lib/robinhood.mjs");
const { rng } = await import("./lib/rh-world.mjs");

const E18 = BigNumber.from(10).pow(18);
const IFACE = new utils.Interface(BRIDGE_ABI);
const HOME_BRIDGE = "0x00000000000000000000000000000000000B4663";
const PEER_BRIDGE = "0x00000000000000000000000000000000000B0001";
const T0 = 1_800_000_000;
const user = (i) => utils.getAddress(utils.hexZeroPad(utils.hexlify(0x1000 + i), 20));

/** A fake chain: block n has timestamp T0 + n; `logs` are [{ block, name, args }]. */
function fakeChain(address) {
  const c = { head: 0, logs: [], paused: false };
  c.provider = {
    getBlockNumber: async () => c.head,
    getBlock: async (n) => ({ number: n, timestamp: T0 + n }),
    getLogs: async ({ fromBlock, toBlock }) => c.logs.filter((l) => l.block >= fromBlock && l.block <= toBlock).map((l, i) => ({
      ...IFACE.encodeEventLog(IFACE.getEvent(l.name), l.args), address, blockNumber: l.block, transactionHash: utils.hexZeroPad(utils.hexlify(l.block * 1000 + i + 1), 32), logIndex: i,
    })),
  };
  // The counters are what the chain's own Sent/Received logs add up to at the block asked (as ImdBridge's do), forgeries included.
  const sum = (name, o) => c.logs.filter((l) => l.name === name && l.block <= (o?.blockTag ?? Infinity)).reduce((a, l) => a.add(name === "Sent" ? l.args[4] : l.args[3]), E18.mul(0));
  c.bridge = { address, received: async (o) => sum("Received", o), sent: async (o) => sum("Sent", o), paused: async () => c.paused };
  return c;
}

/** Honest transfer src -> dst at src block `at`, delivered `delay` later (null: not yet). */
function transfer(src, dst, srcEid, dstEid, nonce, at, delay, amount) {
  const guid = utils.keccak256(utils.toUtf8Bytes(`${srcEid}-${nonce}`));
  const to = user(nonce);
  src.logs.push({ block: at, name: "Sent", args: [guid, dstEid, user(0), utils.hexZeroPad(to, 32), amount, nonce] });
  if (delay !== null) {
    dst.logs.push({ block: at + delay, name: "Received", args: [guid, srcEid, to, amount, nonce] });
  }
  return { guid, to, amount };
}

function setup() {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  const home = fakeChain(HOME_BRIDGE), peer = fakeChain(PEER_BRIDGE);
  const raised = [];
  const ctx = {
    // peerLagSeconds 0: this file proves the one-clock rule alone, on fresh nodes (the lag tolerance is test/w5k-judge-h1 + w5k-bridge-lag).
    cfg: { CHAIN_ID: 4663, LOGS: { lag: 0, chunk: 100_000 }, BRIDGE_WATCH: { peer: { bridge: PEER_BRIDGE, fromBlock: 0 }, peerLogs: { lag: 0, chunk: 100_000 }, directions: "both", peerLagSeconds: 0 } },
    provider: home.provider, peers: { 1: peer.provider }, peerBridge: peer.bridge, log: () => {},
    book: { bridge: home.bridge, record: { deployBlock: 0 }, ledger: {}, params: {}, usd: {}, pegHook: null },
    readSupply: async (p, a, br) => ({ totalSupply: (await br.received()).sub(await br.sent()), debts: [], badDebts: [], reserveBacked: 0, migrator: 0, pegKeeper: 0, received: await br.received(), sent: await br.sent() }),
    alerts: { raise: async (level, key, msg) => raised.push({ level, key, msg }), settle: async () => {} },
  };
  return { home, peer, ctx, raised };
}

test("honest streams both ways raise nothing; every forged Received is alerted FORGED in the first pass that reads it (150 seeded runs)", async () => {
  for (let seed = 1; seed <= 150; seed++) {
    const r = rng(seed);
    const { home, peer, ctx, raised } = setup();
    const k = 1 + Math.floor(r() * 12);
    // honest: mainnet -> 4663 and 4663 -> mainnet, delivered 120-900 s later
    for (let n = 1; n <= k; n++) transfer(peer, home, EID[1], EID[4663], n, 100 * n, 120 + Math.floor(r() * 780), E18.mul(10 + Math.floor(r() * 100)));
    for (let n = 1; n <= k; n++) transfer(home, peer, EID[4663], EID[1], n, 100 * n + 7, 120 + Math.floor(r() * 780), E18.mul(10 + Math.floor(r() * 100)));
    home.head = peer.head = 100 * k + 1000;
    // forgeries on 4663: a nonce never sent, or a sent nonce with another amount or recipient
    const forged = new Set();
    const nf = Math.floor(r() * 3);
    for (let f = 0; f < nf; f++) {
      const kind = r();
      let nonce, args;
      if (kind < 0.5) {
        nonce = k + 1 + f;
        args = [utils.keccak256(utils.toUtf8Bytes(`forge-${seed}-${f}`)), EID[1], user(99), E18.mul(5000), nonce];
      } else {
        nonce = 1 + Math.floor(r() * k);
        const honest = home.logs.find((l) => l.name === "Received" && Number(l.args[4]) === nonce);
        if (!honest) continue;
        home.logs.splice(home.logs.indexOf(honest), 1);
        args = kind < 0.75 ? [honest.args[0], EID[1], honest.args[2], E18.mul(9999), nonce] : [honest.args[0], EID[1], user(77), honest.args[3], nonce];
      }
      home.logs.push({ block: home.head - 5, name: "Received", args });
      forged.add(String(nonce));
    }
    await runBridge(ctx);
    const flagged = new Set(raised.filter((a) => a.key.startsWith("bridge-forged-4663-")).map((a) => a.key.split("-").at(-1)));
    assert.deepEqual([...flagged].sort(), [...forged].sort(), `seed ${seed}: forged ${[...forged]} flagged ${[...flagged]}`);
    const other = raised.filter((a) => !a.key.startsWith("bridge-forged-4663-") && !a.key.startsWith("bridge-counters-4663") && !a.key.startsWith("bridge-supply"));
    assert.deepEqual(other.map((a) => a.key), [], `seed ${seed}: an honest stream raised ${other.map((a) => a.key)}`);
    for (const a of raised.filter((x) => x.key.startsWith("bridge-forged-"))) assert.equal(a.level, "critical");
  }
});

test("a Received is judged only once the source has been indexed through its srcBound (source blocks, never timestamps); past the bound unverified is critical", () => {
  // The source's timestamps are far past the Received's: under the old cross-chain time rule this was judged; it must not be.
  const src = { sent: {}, throughTime: 9e9, throughBlock: 1 };
  const dst = { received: { [`${EID[1]}:5`]: { guid: "0x01", to: user(1).toLowerCase(), amount: "1", time: 200, tx: "0x", srcBound: 10 } }, holds: {}, voids: {}, throughTime: 200 };
  const base = { src, dst, srcEid: EID[1], dstEid: EID[4663], srcName: "mainnet", dstName: "4663" };
  assert.deepEqual(matchDirection({ ...base, now: 300 }).alerts, []);
  assert.match(matchDirection({ ...base, now: 200 + 1801 }).alerts[0].key, /^bridge-unverified-4663-5$/);
  assert.match(matchDirection({ ...base, src: { ...src, throughTime: 0, throughBlock: 10 }, now: 300 }).alerts[0].key, /^bridge-forged-4663-5$/);
  const unstamped = { ...dst, received: { [`${EID[1]}:5`]: { ...dst.received[`${EID[1]}:5`], srcBound: undefined } } };
  assert.deepEqual(matchDirection({ ...base, dst: unstamped, src: { ...src, throughBlock: 99 }, now: 300 }).alerts, [], "no bound read yet: not judged");
});

test("stuck: warn after 30 min, critical after 2 h; a held nonce and a voided honest payload alert as such instead", () => {
  const s = { guid: utils.hexZeroPad("0x0a", 32), to: utils.hexZeroPad(user(3), 32).toLowerCase(), amount: E18.mul(20).toString(), time: 0, tx: "0x" };
  const src = { sent: { [`${EID[4663]}:3`]: s }, throughTime: 10_000 };
  const dst = (t, extra = {}) => ({ received: {}, holds: {}, voids: {}, throughTime: t, ...extra });
  // Stuck ages are in the SOURCE's clock (srcNow), whatever the destination's clock reads.
  const m = (d) => matchDirection({ src, dst: { ...d, throughTime: 9e9 }, srcEid: EID[1], dstEid: EID[4663], now: 9e9, srcNow: d.throughTime, srcName: "mainnet", dstName: "4663" }).alerts;
  assert.deepEqual(m(dst(600)), []);
  assert.equal(m(dst(1900))[0].level, "warn");
  assert.equal(m(dst(7300))[0].level, "critical");
  assert.match(m(dst(7300, { holds: { [`${EID[1]}:3`]: { payloadHash: payloadHashOf(s), until: 9e9, released: false } } }))[0].key, /^bridge-held-4663-3$/);
  assert.match(m(dst(7300, { voids: { [payloadHashOf(s)]: { at: 1 } } }))[0].key, /^bridge-voided-honest-4663-3$/);
  const forgedHold = m(dst(10, { holds: { [`${EID[1]}:8`]: { payloadHash: "0xbad", until: 9e9, released: false } } }));
  assert.equal(forgedHold[0].level, "critical", "a hold on a nonce nobody sent: a forgery under hold");
});

test("the payload hash is keccak(guid ‖ to ‖ uint64 amountSD), as ImdBridge stores and voids it", () => {
  const guid = utils.hexZeroPad("0x0a", 32), to = utils.hexZeroPad(user(3), 32), amount = E18.mul(20);
  const message = utils.solidityPack(["bytes32", "uint64"], [to, amount.div(BigNumber.from(10).pow(12))]);
  assert.equal(payloadHashOf({ guid, to, amount }), utils.keccak256(utils.concat([guid, message])));
});

test("counters: received past what the peer ever sent is critical; supply equation off past the tolerance is critical", () => {
  assert.deepEqual(counterAlerts({ dstReceived: 5, srcSent: 5, srcName: "mainnet", dstName: "4663" }), []);
  assert.equal(counterAlerts({ dstReceived: 6, srcSent: 5, srcName: "mainnet", dstName: "4663" })[0].level, "critical");
  const base = { debts: [E18.mul(100)], badDebts: [E18], reserveBacked: E18, migrator: 0, pegKeeper: E18.mul(2), received: E18.mul(50), sent: E18.mul(10), name: "4663" };
  assert.equal(supplyCheck({ ...base, totalSupply: E18.mul(145) }).alert, null);
  assert.equal(supplyCheck({ ...base, totalSupply: E18.mul(147) }).alert.level, "critical");
});

test("held and voided payloads and a paused path are critical through the loop", async () => {
  const { home, peer, ctx, raised } = setup();
  const t = transfer(peer, home, EID[1], EID[4663], 1, 10, null, E18.mul(50));
  home.logs.push({ block: 50, name: "HoldPlaced", args: [EID[1], utils.hexZeroPad(PEER_BRIDGE, 32), 1, payloadHashOf({ ...t, to: utils.hexZeroPad(t.to, 32) }), T0 + 3 * 86_400] });
  home.paused = true;
  home.head = peer.head = 100;
  await runBridge(ctx);
  const keys = raised.map((a) => `${a.level} ${a.key}`);
  assert.ok(keys.includes("critical bridge-held-4663-1"), keys.join(", "));
  assert.ok(keys.includes("critical bridge-paused-4663"), keys.join(", "));
});
