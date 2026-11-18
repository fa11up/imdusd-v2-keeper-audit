// THE KEEPER AUTO-CLAIMS HONEST QUEUED TRANSFERS, AND ONLY THOSE.
// ImdBridge queues an inbound transfer over the path's instant allowance: `Queued(guid, srcEid, to, amount, nonce,
// claimableAt)`, then anyone may `claim(srcEid, guid)` once the destination's clock passes claimableAt (12 h; shortened here so the
// Safe's window is the tighter case), unless the path is paused or its claim breaker tripped, or the Safe cancelled it.
// PROPERTIES (fuzzed over event orders, clock skew, slow RPCs, a lagging read node, restarts, sends that stay pending, are dropped or
// outlive a crash, paused and tripped paths, strangers claiming first, the Safe cancelling and restoring):
//   P1 every queued transfer on the keeper's chain that matches its Sent is claimed in the first pass after it matures while the path
//      is open (routine tier; urgent once the user has waited over 1 h past maturity);
//   P2 no claim that does not match a Sent is ever sent (nor one on the peer chain, where the keeper holds no key);
//   P3 no double send: a claim is never sent again while an earlier send of it is open or after one mined, across restarts;
//   P4 a forged Queued raises critical `bridge-queued-forged-*`, naming the Safe's calls, before its claimableAt (the Safe's window)
//      and within the watcher's 30 min bound; an honest one never does;
//   and report-only mode sends nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utils } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5-claim-"));
const { runBridge } = await import("../lib/bridge.mjs");
const { clearIntent, pendingIntents, recordIntent } = await import("../lib/journal.mjs");
const { statePath } = await import("../lib/state.mjs");
const { EID } = await import("../lib/robinhood.mjs");
const { bridgeCtx, E18, forgeQueued, honest, makeBridgeWorld, nameOf, settleClaim, T0 } = await import("./lib/bridge-world.mjs");
const { rng } = await import("./lib/rh-world.mjs");

const BOUND = 1800;
const DELAY = 2400; // the Safe's window in these worlds (12 h in production): over the 30 min bound, so P4 is tested tight
const EVERY = 120;
const lc = (a) => String(a).toLowerCase();

/** The send path of lib/tx.mjs, reduced to what P3 is about, on the REAL send journal: settle what is open (mined, or its nonce used
 *  by something else), wait while anything is open, simulate, record the intent, then the transaction mines now, later, never (dropped:
 *  its nonce is later used by a cancel), or the keeper crashes right after broadcasting it. */
function sendHook(w, sends, { pendingP = 0, dropP = 0, crashP = 0 } = {}) {
  let nonce = 0;
  w.txs = new Map();
  // lib/journal.mjs settleIntents, against this world: mined clears, a nonce something else used clears, the rest stays open.
  const settle = async () => {
    for (const it of pendingIntents("tx")) {
      const tx = w.txs.get(it.hash);
      if (tx.mined) clearIntent(it.nonce, tx.status ? "mined" : "reverted", { hash: it.hash }, "tx");
      else if (tx.dropAt !== undefined && w.t >= tx.dropAt) clearIntent(it.nonce, "nonce-used-elsewhere", { hash: it.hash }, "tx");
    }
  };
  const hook = async (label, contract, fn, args, opts) => {
    if (fn !== "claim") throw new Error(`unexpected act ${fn}`);
    await settle();
    // lib/tx.mjs send(): a routine send waits on any open send; an URGENT one waits only URGENT_WAIT_SECONDS (60 s), then raises the
    // open one's fees on its own nonce and goes out after it, on the next nonce (here the bump changes nothing about the old one).
    const open = pendingIntents("tx");
    const held = opts.tier === "urgent" ? open.filter((i) => (w.t - w.txs.get(i.hash).s.t) < 60) : open;
    if (held.length) return { skipped: `waiting on ${held[0].label}` };
    try {
      await contract.callStatic.claim(...args);
    } catch (e) {
      return { refused: e.errorName ?? e.message };
    }
    const hash = utils.hexZeroPad(utils.hexlify(0xc1a1000 + sends.length + 1), 32);
    recordIntent({ nonce: nonce++, hash, signed: "0x00", label }, "tx");
    const s = { label, srcEid: Number(args[0]), guid: lc(args[1]), t: w.t, hash, tier: opts.tier };
    sends.push(s);
    const tx = { s, mined: false };
    w.txs.set(hash, tx);
    const u = w.r();
    if (u < crashP) {
      tx.mineAt = w.t + 20 + w.r() * 200;
      throw new Error("the keeper died right after broadcasting");
    }
    if (u < crashP + pendingP) {
      tx.mineAt = w.t + 200 + w.r() * 1500;
      return { pending: hash };
    }
    if (u < crashP + pendingP + dropP) {
      tx.dropAt = w.t + 200 + w.r() * 1200;
      return { pending: hash };
    }
    mine(w, tx);
    return { hash, block: 0, gas: "108227" };
  };
  return { hook, settle };
}

/** A claim transaction lands: it mints if the claim is still pending and the path open, else it reverts. */
function mine(w, tx) {
  const k = w.home.claims.get(`${tx.s.srcEid}:${tx.s.guid}`);
  tx.mined = true;
  tx.status = Boolean(k && k.state === 1 && !w.home.isPaused() && !w.home.isTripped());
  if (tx.status) settleClaim(w, w.home.id, k, 2, { hash: tx.s.hash });
  else w.home.receipts.set(tx.s.hash.toLowerCase(), { status: 0, transactionHash: tx.s.hash });
}

/**
 * Run the watcher every EVERY s of real time. Before each pass the world moves: pending claim txs land, strangers (and forgers) claim
 * what they planned to, the Safe cancels or restores. `restartP`: the process restarts (a new context, same state dir).
 */
async function runClaimPasses(w, { horizon, execute = true, hookOpts = {}, restartP = 0, breaker = true, events = [], log = () => {}, claimUrgentSeconds }) {
  const raised = [], sends = [], passes = [], errors = [];
  const hook = execute ? sendHook(w, sends, hookOpts) : null;
  const make = () => {
    const ctx = bridgeCtx(w, raised, { execute, log, ...(hook ? { actHook: hook.hook, settleSends: hook.settle } : {}) });
    // No breaker view: the bridge's simulation refusal (Tripped) is all the duty has to go on.
    if (!breaker) ctx.book.bridge = { ...ctx.book.bridge, breakers: undefined };
    if (claimUrgentSeconds !== undefined) ctx.cfg.BRIDGE_WATCH.claimUrgentSeconds = claimUrgentSeconds;
    return ctx;
  };
  let ctx = make();
  for (let p = T0 + 60; p <= T0 + horizon; p += EVERY) {
    if (w.t < p) w.t = p;
    for (const tx of w.txs?.values() ?? []) if (!tx.mined && tx.mineAt !== undefined && w.t >= tx.mineAt) mine(w, tx);
    for (const ev of events) if (!ev.done && w.t >= ev.at()) { ev.done = true; ev.run(); }
    if (restartP && w.r() < restartP) ctx = make();
    passes.push(w.t);
    try {
      await runBridge(ctx);
    } catch (e) {
      errors.push(String(e.message));
      ctx = make(); // a crash: the next pass is a fresh process
    }
  }
  return { raised, sends, passes, errors };
}

/** Honest queued transfers both ways, plus forged queued claims into both chains; returns the claims. */
function traffic(w, r, { horizon, forgeries = true }) {
  for (const srcId of [1, 4663]) {
    const k = 3 + Math.floor(r() * 6);
    for (let i = 1; i <= k; i++) {
      const ts = T0 + 60 + r() * horizon;
      const queue = r() < 0.75; // the rest mint at once (within the instant allowance)
      honest(w, srcId, i, ts, srcId === 1 ? 180 + r() * 720 : 60 + r() * 840, E18.mul(queue ? 5001 + Math.floor(r() * 40_000) : 10 + Math.floor(r() * 500)), { queue });
    }
    if (!forgeries) continue;
    const dst = srcId === 1 ? 4663 : 1;
    for (let f = 0; f < 1 + Math.floor(r() * 2); f++) forgeQueued(w, dst, 1000 + f, T0 + 300 + r() * horizon, E18.mul(5001 + Math.floor(r() * 40_000)));
    // A forgery over an honest transfer still in flight: the source Sent at that nonce, the forger's claim took it first.
    if (r() < 0.5) {
      const ts = T0 + 300 + r() * horizon;
      honest(w, srcId, 500, ts, null, E18.mul(7000));
      forgeQueued(w, dst, 500, ts + 30 + r() * 300, E18.mul(9000));
    }
  }
}

const homeClaims = (w) => [...w.home.claims.values()];
const peerClaims = (w) => [...w.peer.claims.values()];
const openThrough = (w, a, b) => ![...w.home.paused, ...w.home.tripped].some(([x, y]) => x < b && y > a);
const spansOpen = (w, t) => !w.home.paused.some(([a, b]) => t >= a && t < b) && !w.home.tripped.some(([a, b]) => t >= a && t < b);

function checkP2P3(w, sends, where) {
  for (const s of sends) {
    const k = w.home.claims.get(`${s.srcEid}:${s.guid}`);
    assert.ok(k, `${where}: sent a claim the home bridge never queued (${s.guid})`);
    assert.ok(k.honest, `${where}: P2: sent a claim that matches no Sent (nonce ${k.nonce}, ${s.guid})`);
    assert.equal(s.srcEid, EID[w.peer.id], `${where}: P2: claimed on a path that is not peer -> home`);
  }
  const byGuid = new Map();
  for (const s of sends) byGuid.set(s.guid, [...(byGuid.get(s.guid) ?? []), s]);
  for (const [guid, list] of byGuid) {
    for (let i = 1; i < list.length; i++) {
      const prev = w.txs.get(list[i - 1].hash);
      const ok = !prev.status && ((prev.dropAt !== undefined && prev.dropAt <= list[i].t) || (prev.mined && !prev.status));
      assert.ok(ok, `${where}: P3: claim ${guid} sent again at ${Math.round(list[i].t - T0)} s while its send of ${Math.round(list[i - 1].t - T0)} s was ${prev.mined ? "mined" : "still open"}`);
    }
  }
  assert.deepEqual(w.violations, [], `${where}: the fake contract's claim() was called directly`);
}

function checkP4(w, raised, where) {
  for (const f of w.forged) {
    const hit = raised.find((a) => a.key === `bridge-queued-forged-${nameOf(f.dst)}-${f.nonce}` && a.level === "critical");
    assert.ok(hit, `${where}: P4: forged queued claim nonce ${f.nonce} into ${nameOf(f.dst)} never flagged`);
    assert.ok(hit.t - f.tv <= BOUND, `${where}: P4: flagged ${Math.round(hit.t - f.tv)} s after it was queued, past the bound`);
    assert.ok(hit.t < f.claim.mature, `${where}: P4: flagged at ${Math.round(hit.t - f.tv)} s, AFTER it became claimable (${w.delay} s)`);
    assert.match(hit.msg, new RegExp(`cancelClaim\\(${f.claim.srcEid}, ${f.claim.guid}\\)`), `${where}: the alert names the exact cancelClaim`);
    assert.match(hit.msg, new RegExp(`pause\\(${f.claim.srcEid}\\)`), `${where}: the alert names the pause`);
  }
  for (const h of w.honest) {
    const bad = raised.filter((a) => [`bridge-queued-forged-${nameOf(h.dst)}-${h.nonce}`, `bridge-queued-unverified-${nameOf(h.dst)}-${h.nonce}`, `bridge-stuck-${nameOf(h.src)}-${h.nonce}`, `bridge-forged-${nameOf(h.dst)}-${h.nonce}`].includes(a.key) && (h.nonce !== 500));
    assert.deepEqual(bad.map((a) => a.key), [], `${where}: honest nonce ${h.nonce} ${nameOf(h.src)} -> ${nameOf(h.dst)} raised ${bad.map((a) => a.key)}`);
  }
}

test("P1 + P2 + P4: every honest matured claim on the keeper's chain is sent in the first open pass after it matures; forged ones never, and they alert before claimableAt (30 seeded runs)", async () => {
  for (let seed = 1; seed <= 30; seed++) {
    rmSync(process.env.STATE_DIR, { recursive: true, force: true });
    const r = rng(seed * 7919);
    const skew = { 1: Math.round((r() * 2 - 1) * 3600), 4663: Math.round((r() * 2 - 1) * 3600) };
    const w = makeBridgeWorld({ seed, skew, slowP: 0.02, staleClaimsP: 0.2, home: r() < 0.5 ? 4663 : 1, delay: DELAY });
    const horizon = 5400;
    traffic(w, r, { horizon });
    // The path closes for a while in some runs: paused by the Safe, or tripped by the queue breaker.
    const breaker = r() < 0.5;
    if (r() < 0.6) (r() < 0.5 ? w.home.paused : w.home.tripped).push([T0 + DELAY + r() * horizon, T0 + DELAY + horizon + r() * 5000]);
    // The forger claims his own once he can (the Safe did not act here: the keeper must still never send it).
    const events = homeClaims(w).filter((k) => k.forged).map((k) => ({ at: () => k.mature + 30, run: () => k.state === 1 && spansOpen(w, w.t) && settleClaim(w, w.home.id, k, 2) }));
    const end = horizon + DELAY + 7000;
    const { raised, sends, passes, errors } = await runClaimPasses(w, { horizon: end, breaker, events });
    const where = `seed ${seed} (home ${w.home.id}, skew mainnet ${skew[1]} s / 4663 ${skew[4663]} s, ${breaker ? "breaker view" : "no breaker view"}, paused ${JSON.stringify(w.home.paused.map((s) => s.map((x) => Math.round(x - T0))))}, tripped ${JSON.stringify(w.home.tripped.map((s) => s.map((x) => Math.round(x - T0))))})`;
    assert.deepEqual(errors, [], `${where}: passes threw`);
    for (const k of homeClaims(w).filter((c) => c.honest)) {
      // The first pass that starts with the claim matured and the path open for the whole pass.
      const i = passes.findIndex((p, j) => p >= k.mature && openThrough(w, p, passes[j + 1] ?? p + EVERY));
      if (i < 0) continue; // never open again before the run ends
      const sent = sends.find((s) => s.guid === k.guid);
      const passEnd = passes[i + 1] ?? Infinity;
      assert.ok(sent, `${where}: P1: honest claim nonce ${k.nonce} matured at ${Math.round(k.mature - T0)} s was never claimed`);
      assert.ok(sent.t >= k.mature, `${where}: P1: claimed before it matured`);
      assert.ok(sent.t < passEnd, `${where}: P1: honest claim nonce ${k.nonce} owed in the pass at ${Math.round(passes[i] - T0)} s, sent at ${Math.round(sent.t - T0)} s`);
      // The keeper times lateness by the head block it read (12 s blocks on mainnet), the test by the send's wall time: within a
      // minute of the 1 h line either tier is right.
      if (Math.abs(sent.t - k.mature - 3600) > 60) assert.equal(sent.tier, sent.t - k.mature > 3600 ? "urgent" : "routine", `${where}: tier`);
      assert.equal(k.state, 2, `${where}: P1: the claim minted`);
    }
    for (const s of sends) assert.ok(!peerClaims(w).some((k) => k.guid === s.guid && k.srcEid === s.srcEid && k.dst !== w.home.id), `${where}: claimed on the peer chain`);
    checkP2P3(w, sends, where);
    checkP4(w, raised, where);
    // A closed path with matured honest claims says so (a tripped breaker is critical; a pause is already critical on its own).
    const [ta, tb] = w.home.tripped[0] ?? [];
    if (ta && breaker) assert.ok(raised.some((a) => a.key === `bridge-breaker-tripped-${nameOf(w.home.id)}` && a.level === "critical" && a.t >= ta && a.t < tb + 2 * EVERY), `${where}: a tripped breaker is a standing critical alert`);
    if (ta && homeClaims(w).some((k) => k.honest && k.mature < tb - 2 * EVERY && sends.some((s) => s.guid === k.guid && s.t >= tb))) {
      assert.ok(raised.some((a) => a.key === `bridge-claims-closed-${nameOf(w.home.id)}` && a.level === "critical"), `${where}: a tripped path holding matured claims must alert`);
    }
  }
});

test("P3: no double send across restarts, crashes after broadcast, sends left pending or dropped, strangers claiming first and a lagging read node (30 seeded runs)", async () => {
  for (let seed = 1; seed <= 30; seed++) {
    rmSync(process.env.STATE_DIR, { recursive: true, force: true });
    const r = rng(seed * 104729 + 3);
    const w = makeBridgeWorld({ seed: seed + 100, skew: { 1: Math.round((r() * 2 - 1) * 1800), 4663: Math.round((r() * 2 - 1) * 1800) }, slowP: 0.03, staleClaimsP: 0.5, home: r() < 0.5 ? 4663 : 1, delay: DELAY });
    const horizon = 3600;
    traffic(w, r, { horizon, forgeries: r() < 0.5 });
    // Strangers claim some honest ones first, at random after maturity; the Safe cancels one honest claim and restores it later.
    const events = [];
    for (const k of homeClaims(w).filter((c) => c.honest)) if (r() < 0.3) events.push({ at: () => k.mature + r() * 400, run: () => k.state === 1 && spansOpen(w, w.t) && settleClaim(w, w.home.id, k, 2) });
    const victim = homeClaims(w).find((c) => c.honest);
    if (victim && r() < 0.5) {
      events.push({ at: () => victim.mature - 600, run: () => victim.state === 1 && settleClaim(w, w.home.id, victim, 3) });
      events.push({ at: () => victim.mature + 1800, run: () => victim.state === 3 && settleClaim(w, w.home.id, victim, 1) });
    }
    const urgent = r() < 0.5; // half the runs: every claim is late enough to go urgent, so a new send does not wait behind an open one
    const { raised, sends } = await runClaimPasses(w, { horizon: horizon + DELAY + 6000, restartP: 0.15, claimUrgentSeconds: urgent ? 0 : 3600, hookOpts: { pendingP: 0.25, dropP: 0.15, crashP: 0.1 }, events });
    const where = `seed ${seed} (home ${w.home.id})`;
    checkP2P3(w, sends, where);
    // Liveness under all that: every honest claim that was never cancelled for good ends up minted (by us or a stranger).
    for (const k of homeClaims(w).filter((c) => c.honest)) assert.equal(k.state, 2, `${where}: honest claim nonce ${k.nonce} ended in state ${k.state}`);
    if (victim?.history.some(([, s]) => s === 3)) {
      assert.ok(raised.some((a) => a.key === `bridge-cancelled-honest-${nameOf(w.home.id)}-${victim.nonce}` && a.level === "critical"), `${where}: an honest claim cancelled by the Safe must alert`);
    }
  }
});

test("report-only mode simulates every matured honest claim and sends nothing", async () => {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  const r = rng(4242);
  const w = makeBridgeWorld({ seed: 77, home: 4663, delay: DELAY });
  traffic(w, r, { horizon: 1800 });
  const lines = [];
  const { sends, errors } = await runClaimPasses(w, { horizon: 1800 + DELAY + 2000, execute: false, log: (l) => lines.push(l) });
  assert.deepEqual(errors, []);
  assert.equal(sends.length, 0);
  assert.deepEqual(w.violations, [], "claim() was called");
  assert.ok(!existsSync(statePath("tx")), "report-only wrote a send intent");
  assert.ok(homeClaims(w).filter((k) => k.honest).every((k) => k.state === 1), "a claim moved in report-only mode");
  const would = lines.filter((l) => l.startsWith("would   bridge claim"));
  assert.ok(homeClaims(w).filter((k) => k.honest).every((k) => would.some((l) => l.includes(k.guid))), "every matured honest claim is simulated");
  assert.ok(!homeClaims(w).filter((k) => k.forged).some((k) => would.some((l) => l.includes(k.guid))), "P2 holds in report-only too");
});

test("the counters prove the queue: an empty log answer cannot hide a Queued or a Claimed (20 seeded runs)", async () => {
  for (let seed = 1; seed <= 20; seed++) {
    rmSync(process.env.STATE_DIR, { recursive: true, force: true });
    const r = rng(seed * 31337);
    const w = makeBridgeWorld({ seed: seed + 300, emptyP: 0.1 + r() * 0.4, slowP: 0.02, home: r() < 0.5 ? 4663 : 1, delay: DELAY });
    traffic(w, r, { horizon: 2400 });
    const { raised, sends } = await runClaimPasses(w, { horizon: 2400 + DELAY + 4000 });
    const where = `seed ${seed} (home ${w.home.id})`;
    checkP2P3(w, sends, where);
    checkP4(w, raised, where);
    for (const k of homeClaims(w).filter((c) => c.honest)) assert.equal(k.state, 2, `${where}: honest claim nonce ${k.nonce} not claimed`);
  }
});
