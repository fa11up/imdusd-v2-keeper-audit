// Two fake chains on ONE real-time axis for the bridge watcher (lib/bridge.mjs): mainnet (12 s blocks) and 4663 (1 s blocks), each
// with its own clock skew (block timestamp = real time + skew), RPC latency, sometimes a slow call (the 4663 public RPC halving a
// range), and optionally a log RPC that answers EMPTY for a range at random. Honest transfers are a Sent on the source and, `delay`
// later in real time, the destination endpoint's PacketVerified and then the bridge's Received; forgeries are a PacketVerified and
// (unless they cannot execute) a Received with no Sent. Every event is encoded with the real ABIs. Nothing here touches a chain.
// INBOUND DELAY: a transfer can arrive QUEUED instead (Queued, then Claimed by anyone once the destination's
// clock passes claimableAt = its block time + `delay`), a forger can queue a claim, the Safe can cancel or restore one, a path can be
// paused or its claim breaker tripped (intervals of real time), and the bridge's sent/received/queued counters move as ImdBridge's do.
// GOVERNABLE DELAY: each chain's path has a delay and a bulk-cancel cutoff that change over time
// (`setDelay`, which emits DelaySet); a claim is claimable at queuedAt + the delay AT CLAIM TIME, and refused (CancelledSince) while
// the cutoff is set at or before its queuedAt.
import { BigNumber, utils } from "ethers";
import { BRIDGE_ABI, EID } from "../../lib/robinhood.mjs";
import { rng } from "./rh-world.mjs";

export const E18 = BigNumber.from(10).pow(18);
export const BRIDGE_IFACE = new utils.Interface(BRIDGE_ABI);
export const ENDPOINT_IFACE = new utils.Interface([
  "event PacketVerified((uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver, bytes32 payloadHash)",
  "function inboundPayloadHash(address receiver, uint32 srcEid, bytes32 sender, uint64 nonce) view returns (bytes32)",
]);
export const T0 = 1_800_000_000;
export const ABI_DELAYSET = "event DelaySet(uint32 indexed srcEid, uint256 instantCap, uint256 delay, uint256 queueBreaker, uint256 cancelFrom)";
const BRIDGES = { 1: "0x00000000000000000000000000000000000B0001", 4663: "0x00000000000000000000000000000000000B4663" };
const ENDPOINTS = { 1: "0x1a44076050125825900e736c501f859c50fE728c", 4663: "0x00000000000000000000000000000000000E4663" };
const user = (i) => utils.getAddress(utils.hexZeroPad(utils.hexlify(0x1000 + i), 20));
const CONVERSION = BigNumber.from(10).pow(12);

/**
 * opts: seed, skew {1, 4663} (seconds, block time minus real time), emptyP (chance one getLogs answers [] for a non-empty range),
 * slowP (chance one RPC call takes 30-300 s), home (the keeper's chain).
 */
export function makeBridgeWorld({ seed = 1, skew = { 1: 0, 4663: 0 }, emptyP = 0, slowP = 0, home = 4663, delay = 43_200, staleClaimsP = 0 } = {}) {
  const r = rng(seed);
  const w = { t: T0, r, chains: {}, honest: [], forged: [], calls: 0, delay, violations: [], stalls: [] };
  /** Seconds the RPCs stalled (slowP) between real times a and b. */
  w.stalledBetween = (a, b) => w.stalls.filter(([t]) => t >= a && t < b).reduce((x, [, d]) => x + d, 0);
  for (const id of [1, 4663]) {
    const c = { id, bt: id === 1 ? 12 : 1, skew: skew[id] ?? 0, genesis: T0 - 50_000, logs: [], bridge: BRIDGES[id], endpoint: ENDPOINTS[id], stored: new Map(), claims: new Map(), receipts: new Map(), paused: [], tripped: [], settings: [[-Infinity, { delay, cutoff: 0 }, -Infinity]] };
    /** The path's settings at real time t (the last change at or before t), and as stored at block n. */
    c.settingsAt = (t) => [...c.settings].reverse().find(([at]) => at <= t)[1];
    c.settingsAtBlock = (n) => [...c.settings].reverse().find(([, , b]) => b <= n)[1];
    c.headAt = (t) => Math.floor((t - c.genesis) / c.bt);
    c.timeOf = (n) => Math.floor(c.genesis + n * c.bt + c.skew);
    c.realOf = (n) => c.genesis + n * c.bt;
    const tick = () => {
      w.calls++;
      w.t += 0.05 + r() * 0.5;
      if (slowP && r() < slowP) {
        const stall = 30 + r() * 270;
        w.stalls.push([w.t, stall]); // RPC stall time: a bound in watcher time is measured net of it (stalledBetween)
        w.t += stall;
      }
    };
    c.provider = {
      getBlockNumber: async () => (tick(), c.headAt(w.t)),
      getBlock: async (n) => {
        tick();
        const b = n === "latest" ? c.headAt(w.t) : Number(n);
        return { number: b, timestamp: c.timeOf(b) };
      },
      getTransactionReceipt: async (h) => (tick(), c.receipts.get(String(h).toLowerCase()) ?? null),
      getLogs: async ({ address, topics, fromBlock, toBlock }) => {
        tick();
        const head = c.headAt(w.t);
        const out = c.logs
          .filter((l) => lc(l.address) === lc(address) && l.block >= fromBlock && l.block <= toBlock && l.block <= head && (!topics?.[0] || l.topic0 === topics[0]))
          .map((l) => ({ ...l.encoded, address: l.address, blockNumber: l.block, transactionHash: l.tx, logIndex: l.logIndex }));
        if (emptyP && out.length && r() < emptyP) return [];
        return out;
      },
    };
    // The counters at a block, as ImdBridge moves them: each log carries its delta (push below).
    const sumAt = (field, tag) => {
      const top = Math.min(tag === undefined || tag === "latest" ? Infinity : Number(tag), c.headAt(w.t));
      return c.logs.filter((l) => l.d?.[field] && l.block <= top).reduce((a, l) => a.add(l.d[field]), BigNumber.from(0));
    };
    const during = (spans) => spans.some(([a, b]) => w.t >= a && w.t < b);
    c.isPaused = () => during(c.paused);
    c.isTripped = () => during(c.tripped);
    const err = (errorName) => Object.assign(new Error(errorName), { errorName });
    const stateOf = (k) => {
      const asOf = staleClaimsP && r() < staleClaimsP ? w.t - r() * 600 : w.t;
      return [...k.history].reverse().find(([t]) => t <= asOf)?.[1] ?? 0;
    };
    c.bridgeContract = {
      address: c.bridge,
      sent: async (o) => (tick(), sumAt("sent", o?.blockTag)),
      received: async (o) => (tick(), sumAt("received", o?.blockTag)),
      queued: async (o) => (tick(), sumAt("queued", o?.blockTag)),
      paused: async () => (tick(), c.isPaused()),
      // ImdBridge Breaker: (day, trips, tripped, breakerSD, delay, cancelledFrom, version)
      breakers: async (eid, o) => {
        tick();
        const st = o?.blockTag !== undefined && o.blockTag !== "latest" ? c.settingsAtBlock(Number(o.blockTag)) : c.settingsAt(w.t);
        return { day: 0, trips: c.tripped.length, tripped: c.isTripped(), breakerSD: BigNumber.from(50_000e6), delay: st.delay, cancelledFrom: st.cutoff, version: c.settings.length - 1 };
      },
      endpoint: async () => c.endpoint,
      // A lagging read node (staleClaimsP): the claim's state as it was up to 10 min ago, for reads and simulations alike.
      claims: async (srcEid, guid) => {
        tick();
        const k = c.claims.get(`${Number(srcEid)}:${String(guid).toLowerCase()}`);
        if (!k) return { to: utils.hexZeroPad("0x", 20), amountSD: BigNumber.from(0), claimableAt: 0, state: 0 };
        return { to: k.to, amountSD: BigNumber.from(k.amount).div(CONVERSION), queuedAt: k.queuedAt, state: stateOf(k) };
      },
      callStatic: {
        // ImdBridge.claim's checks: pending and matured, path not paused (and not tripped: the coming breaker).
        claim: async (srcEid, guid) => {
          tick();
          const k = c.claims.get(`${Number(srcEid)}:${String(guid).toLowerCase()}`);
          const st = c.settingsAt(w.t);
          if (!k || stateOf(k) !== 1 || c.timeOf(c.headAt(w.t)) < k.queuedAt + st.delay) throw err("NotClaimable");
          if (c.isPaused()) throw err("PathPaused");
          if (c.isTripped()) throw err("Tripped");
          if (st.cutoff !== 0 && k.queuedAt >= st.cutoff) throw err("CancelledSince");
          return [];
        },
      },
      // A real send never reaches the fake contract: tests route sends through ctx.actHook. Reaching here is a violation.
      claim: async (...a) => {
        w.violations.push({ what: "claim() called directly", args: a, t: w.t });
        throw new Error("the fake bridge's claim() must never be called directly");
      },
    };
    c.endpointContract = {
      address: c.endpoint,
      inboundPayloadHash: async (receiver, srcEid, sender, nonce) => {
        tick();
        const e = c.stored.get(`${Number(srcEid)}:${Number(nonce)}`);
        return e && w.t >= e.from && w.t < e.until ? e.hash : utils.hexZeroPad("0x", 32);
      },
    };
    w.chains[id] = c;
  }
  w.home = w.chains[home];
  w.peer = w.chains[home === 1 ? 4663 : 1];
  return w;
}

const lc = (a) => String(a).toLowerCase();
let txn = 1;
const DELTA = { Sent: { sent: 1 }, Received: { received: 1 }, Queued: { queued: 1 }, Claimed: { received: 1, queued: -1 }, ClaimCancelled: { queued: -1 }, ClaimRestored: { queued: 1 } };
function push(c, block, address, iface, name, args, extra = {}) {
  const ev = iface.getEvent(name);
  const encoded = iface.encodeEventLog(ev, args);
  const logIndex = c.logs.filter((l) => l.block === block).length;
  const d = extra.amount && DELTA[name] ? Object.fromEntries(Object.entries(DELTA[name]).map(([k, v]) => [k, BigNumber.from(extra.amount).mul(v)])) : undefined;
  c.logs.push({ block, address, name, encoded, topic0: encoded.topics[0], tx: extra.tx ?? utils.hexZeroPad(utils.hexlify(txn++), 32), logIndex, d, ...extra });
  c.logs.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

export const payloadHash = (guid, to, amount) => utils.keccak256(utils.concat([guid, utils.solidityPack(["bytes32", "uint64"], [utils.hexZeroPad(to, 32), BigNumber.from(amount).div(CONVERSION)])]));

export const guidOf = (srcId, nonce) => utils.keccak256(utils.toUtf8Bytes(`${srcId}-${nonce}`));

/** Queue a claim on `dst` at real time `t` (the block it lands in): Queued, claimable at that block's time + w.delay. */
function queueAt(w, dst, srcEid, guid, to, amount, nonce, t, extra = {}) {
  const block = dst.headAt(t);
  const queuedAt = dst.timeOf(block);
  const delay = dst.settingsAt(t).delay;
  const claimableAt = queuedAt + delay; // what Queued says: the delay AT QUEUE TIME (the claim uses the delay at claim time)
  push(dst, block, dst.bridge, BRIDGE_IFACE, "Queued", [guid, srcEid, to, amount, nonce, claimableAt], { amount });
  const qr = dst.realOf(block);
  const k = { key: `${srcEid}:${lc(guid)}`, srcEid, guid: lc(guid), to: lc(to), amount: BigNumber.from(amount), nonce, queuedAt, queuedReal: qr, claimableAt, mature: qr + delay, state: 1, history: [[t, 1]], dst: dst.id, ...extra };
  /** Real time it is claimable under the settings at real time t; cut = the bulk cutoff covers it then. */
  k.matureAt = (t) => qr + dst.settingsAt(t).delay;
  k.cutAt = (t) => { const c = dst.settingsAt(t).cutoff; return c !== 0 && queuedAt >= c; };
  dst.claims.set(k.key, k);
  return k;
}

const DELAY_IFACE = new utils.Interface([ABI_DELAYSET]);
/** The Safe changes `dstId`'s path settings now (SET_DELAY or tighten): DelaySet at the head. `cutoff` in that chain's time, 0 = none. */
export function setDelay(w, dstId, { delay, cutoff = 0 }) {
  const dst = w.chains[dstId], srcEid = EID[dstId === 1 ? 4663 : 1];
  push(dst, dst.headAt(w.t), dst.bridge, DELAY_IFACE, "DelaySet", [srcEid, E18.mul(5000), delay, E18.mul(50_000), cutoff]);
  dst.settings.push([w.t, { delay, cutoff }, dst.headAt(w.t)]);
}

/** Move a claim to `state` (2 claimed, 3 cancelled, 1 restored) at the head, with its event; `hash`: the claim tx's receipt. */
export function settleClaim(w, dstId, k, state, { hash = null } = {}) {
  const dst = w.chains[dstId];
  const name = state === 2 ? "Claimed" : state === 3 ? "ClaimCancelled" : "ClaimRestored";
  const args = state === 2 ? [k.guid, k.srcEid, k.to, k.amount] : [k.guid, k.srcEid];
  const block = dst.headAt(w.t);
  push(dst, block, dst.bridge, BRIDGE_IFACE, name, args, { amount: k.amount, ...(hash ? { tx: hash } : {}) });
  k.state = state;
  k.history.push([w.t, state]);
  if (hash) dst.receipts.set(hash.toLowerCase(), { status: 1, blockNumber: block, transactionHash: hash });
}

/** An honest transfer src -> dst Sent at real time `ts`, verified `delay - g` and received `delay` later (delay null: never delivered).
 *  `queue`: it arrives as a claim (Queued) instead of a mint. */
export function honest(w, srcId, nonce, ts, delay, amount, { execute = true, queue = false } = {}) {
  const src = w.chains[srcId], dst = w.chains[srcId === 1 ? 4663 : 1];
  const guid = utils.keccak256(utils.toUtf8Bytes(`${srcId}-${nonce}`));
  const to = user(nonce);
  push(src, src.headAt(ts), src.bridge, BRIDGE_IFACE, "Sent", [guid, EID[dst.id], user(0), utils.hexZeroPad(to, 32), amount, nonce], { amount });
  const h = payloadHash(guid, to, amount);
  const rec = { src: srcId, dst: dst.id, nonce, ts, tr: delay === null ? null : ts + delay, hash: h };
  if (delay !== null) {
    const tv = ts + delay - Math.floor(w.r() * 20);
    push(dst, dst.headAt(tv), dst.endpoint, ENDPOINT_IFACE, "PacketVerified", [[EID[srcId], utils.hexZeroPad(src.bridge, 32), nonce], dst.bridge, h]);
    if (execute && queue) rec.claim = queueAt(w, dst, EID[srcId], guid, to, amount, nonce, ts + delay, { honest: true });
    else if (execute) push(dst, dst.headAt(ts + delay), dst.bridge, BRIDGE_IFACE, "Received", [guid, EID[srcId], to, amount, nonce], { amount });
    else dst.stored.set(`${EID[srcId]}:${nonce}`, { hash: h, from: tv, until: Infinity });
  }
  w.honest.push(rec);
  return rec;
}

/** A forged packet into `dstId` claiming to come from the peer, verified at real time `tv`; executed `executeAfter` seconds later
 *  (0: at once, in the verifying block), or never when `execute` is false (it waits at the endpoint: over the inbound limit, a paused
 *  path, a hold). Until it executes the endpoint stores its payload hash. */
export function forge(w, dstId, nonce, tv, amount, { execute = true, executeAfter = 0 } = {}) {
  const dst = w.chains[dstId], src = w.chains[dstId === 1 ? 4663 : 1];
  const guid = utils.keccak256(utils.toUtf8Bytes(`forged-${dstId}-${nonce}`));
  const to = user(900 + nonce);
  const h = payloadHash(guid, to, amount);
  push(dst, dst.headAt(tv), dst.endpoint, ENDPOINT_IFACE, "PacketVerified", [[EID[src.id], utils.hexZeroPad(src.bridge, 32), nonce], dst.bridge, h]);
  if (execute) push(dst, dst.headAt(tv + executeAfter), dst.bridge, BRIDGE_IFACE, "Received", [guid, EID[src.id], to, amount, nonce], { amount });
  dst.stored.set(`${EID[src.id]}:${nonce}`, { hash: h, from: tv, until: execute ? tv + executeAfter : Infinity });
  const rec = { dst: dstId, nonce, tv, executed: execute, te: execute ? tv + executeAfter : null, hash: h };
  w.forged.push(rec);
  return rec;
}

/** A forged packet into `dstId` that the bridge QUEUES at real time `tv` (verified and executed in one block: over the instant allowance).
 *  Its key is the GUID the bridge computes for that nonce (a forger cannot choose it): the honest GUID of the nonce; recipient and
 *  amount are the forger's. `atHonestNonce`: the nonce an honest Sent already used (a forgery over an honest pending transfer). */
export function forgeQueued(w, dstId, nonce, tv, amount) {
  const dst = w.chains[dstId], src = w.chains[dstId === 1 ? 4663 : 1];
  const guid = guidOf(src.id, nonce);
  const to = user(900 + nonce);
  const h = payloadHash(guid, to, amount);
  push(dst, dst.headAt(tv), dst.endpoint, ENDPOINT_IFACE, "PacketVerified", [[EID[src.id], utils.hexZeroPad(src.bridge, 32), nonce], dst.bridge, h]);
  const rec = { dst: dstId, nonce, tv, executed: true, te: tv, hash: h, queued: true };
  rec.claim = queueAt(w, dst, EID[src.id], guid, to, amount, nonce, tv, { forged: true });
  w.forged.push(rec);
  return rec;
}

/** Random honest traffic both ways over [T0, T0 + horizon - tail] plus up to 2 forgeries per direction (nonces 1000+). */
export function randomTraffic(w, { horizon = 2 * 3600, tail = 2400, forgeries = true, executeForged = true, executeAfter = () => 0 } = {}) {
  const r = w.r;
  for (const srcId of [1, 4663]) {
    const k = 2 + Math.floor(r() * 8);
    const times = [...Array(k)].map(() => T0 + 60 + r() * (horizon - tail)).sort((a, b) => a - b);
    times.forEach((ts, i) => honest(w, srcId, i + 1, ts, srcId === 1 ? 180 + r() * 720 : 60 + r() * 840, E18.mul(10 + Math.floor(r() * 500))));
    if (forgeries) {
      const nf = Math.floor(r() * 3);
      for (let f = 0; f < nf; f++) forge(w, srcId === 1 ? 4663 : 1, 1000 + f, T0 + 60 + r() * (horizon - tail), E18.mul(5000), { execute: executeForged, executeAfter: executeAfter() });
    }
  }
}

/** A runBridge context on the world's home chain. */
export function bridgeCtx(w, raised, extra = {}) {
  return {
    cfg: { CHAIN_ID: w.home.id, LOGS: { lag: 3, chunk: 9_000 }, BRIDGE_WATCH: { peer: { bridge: w.peer.bridge, fromBlock: w.peer.headAt(T0) }, fromBlock: w.home.headAt(T0), peerLogs: { lag: 3, chunk: 9_000 }, directions: "both" } },
    provider: w.home.provider, peers: { [w.peer.id]: w.peer.provider }, peerBridge: w.peer.bridgeContract,
    endpointAt: (id) => w.chains[id].endpointContract,
    log: () => {},
    book: { bridge: w.home.bridgeContract, record: { deployBlock: w.home.headAt(T0) }, ledger: {}, params: {}, usd: {}, pegHook: null },
    readSupply: async (p, a, br) => ({ totalSupply: (await br.received()).sub(await br.sent()), debts: [], badDebts: [], reserveBacked: 0, migrator: 0, pegKeeper: 0, received: await br.received(), sent: await br.sent() }),
    alerts: { raise: async (level, key, msg) => raised.push({ level, key, msg, t: w.t }), settle: async () => {} },
    ...extra,
  };
}

/** Run the watcher every `every` seconds of real time to the horizon; returns every alert with the real time it was raised. */
export async function runPasses(w, runBridge, { horizon = 2 * 3600, every = 120 } = {}) {
  const raised = [];
  const ctx = bridgeCtx(w, raised);
  for (let p = T0 + 60; p <= T0 + horizon; p += every) {
    if (w.t < p) w.t = p;
    await runBridge(ctx);
  }
  return raised;
}

export const nameOf = (id) => (id === 1 ? "mainnet" : "4663");
