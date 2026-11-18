// Governable delay settings and bulk cancel: THE AUTO-CLAIM
// FOLLOWS THE PATH'S LIVE DELAY SETTINGS.
// A claim is claimable at queuedAt + the path's delay AT CLAIM TIME (`breakers(srcEid).delay`), not at the Queued event's claimableAt:
// the Safe may lengthen the delay at once (`tighten`) or shorten it after the timelock (SET_DELAY), and either applies to claims
// already queued. A bulk-cancel cutoff (`breakers(srcEid).cancelledFrom`) refuses every claim queued at or after it (CancelledSince)
// until a SET_DELAY clears it or moves it later; nothing is lost.
// PROPERTIES (fuzzed over clock skew, slow RPCs, empty log answers, restarts):
//   D1 no claim is sent before queuedAt + the delay in force; a claim matured under the settings in force is sent in the first pass
//      that starts with it matured, the path open and the settings unchanged through the pass (a shortened delay included);
//   D2 a claim the cutoff covers is never sent and raises no warning or critical of its own (refused, late, cancelled-honest); the
//      cutoff raises info `bridge-bulk-cancel-*`; once the cutoff is cleared or moved past it, it is claimed like any other (D1);
//   D3 every DelaySet is indexed with the two-agreeing-reads discipline: the index holds the chain's latest settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utils } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5-delayset-"));
const { runBridge } = await import("../lib/bridge.mjs");
const { clearIntent, pendingIntents, recordIntent } = await import("../lib/journal.mjs");
const { readStateOr } = await import("../lib/state.mjs");
const { EID } = await import("../lib/robinhood.mjs");
const { bridgeCtx, E18, honest, makeBridgeWorld, nameOf, setDelay, settleClaim, T0 } = await import("./lib/bridge-world.mjs");
const { rng } = await import("./lib/rh-world.mjs");

const DELAY = 2400;
const EVERY = 120;
const lc = (a) => String(a).toLowerCase();

/** lib/tx.mjs send rules on the real journal (as in w5-bridge-claim.test.mjs), every send mined at once. */
function sendHook(w, sends) {
  let nonce = 0;
  const settle = async () => {
    for (const it of pendingIntents("tx")) clearIntent(it.nonce, "mined", { hash: it.hash }, "tx");
  };
  const hook = async (label, contract, fn, args, opts) => {
    await settle();
    try {
      await contract.callStatic.claim(...args);
    } catch (e) {
      return { refused: e.errorName ?? e.message };
    }
    const hash = utils.hexZeroPad(utils.hexlify(0xd1a1000 + sends.length + 1), 32);
    recordIntent({ nonce: nonce++, hash, signed: "0x00", label }, "tx");
    sends.push({ guid: lc(args[1]), srcEid: Number(args[0]), t: w.t, tier: opts.tier });
    const k = w.home.claims.get(`${Number(args[0])}:${lc(args[1])}`);
    settleClaim(w, w.home.id, k, 2, { hash });
    return { hash, block: 0, gas: "108227" };
  };
  return { hook, settle };
}

async function run(w, { horizon, events = [], restartP = 0 }) {
  const raised = [], sends = [], passes = [], errors = [];
  const h = sendHook(w, sends);
  const make = () => bridgeCtx(w, raised, { execute: true, actHook: h.hook, settleSends: h.settle });
  let ctx = make();
  for (let p = T0 + 60; p <= T0 + horizon; p += EVERY) {
    if (w.t < p) w.t = p;
    for (const ev of events) if (!ev.done && w.t >= ev.at) { ev.done = true; ev.run(); }
    if (restartP && w.r() < restartP) ctx = make();
    passes.push(w.t);
    try {
      await runBridge(ctx);
    } catch (e) {
      errors.push(String(e.message));
      ctx = make();
    }
  }
  return { raised, sends, passes, errors };
}

/** Honest queued transfers peer -> home only (the keeper's own chain), spread over `span` seconds. */
function queuedTraffic(w, r, span) {
  const srcId = w.peer.id;
  const k = 4 + Math.floor(r() * 5);
  for (let i = 1; i <= k; i++) honest(w, srcId, i, T0 + 60 + r() * span, srcId === 1 ? 180 + r() * 600 : 60 + r() * 600, E18.mul(6000 + Math.floor(r() * 30_000)), { queue: true });
}

const homeClaims = (w) => [...w.home.claims.values()].filter((k) => k.honest);
const changesIn = (w, a, b) => w.home.settings.some(([t]) => t > a && t < b);
const openThrough = (w, a, b) => ![...w.home.paused, ...w.home.tripped].some(([x, y]) => x < b && y > a);

/** D1/D2: the pass a claim is owed in: the first that starts matured, open, not cut, settings unchanged through it. */
function owedPass(w, k, passes) {
  return passes.findIndex((p, j) => {
    const end = passes[j + 1] ?? p + EVERY;
    return p >= k.matureAt(p) && !k.cutAt(p) && openThrough(w, p, end) && !changesIn(w, p - 1, end);
  });
}

function checkD1(w, sends, passes, where) {
  for (const s of sends) {
    const k = w.home.claims.get(`${s.srcEid}:${s.guid}`);
    assert.ok(s.t >= k.matureAt(s.t), `${where}: D1: claim nonce ${k.nonce} sent at ${Math.round(s.t - T0)} s, before queuedAt + the delay in force (${Math.round(k.matureAt(s.t) - T0)} s)`);
    assert.ok(!k.cutAt(s.t), `${where}: D2: claim nonce ${k.nonce} sent while the bulk cutoff covers it`);
  }
  for (const k of homeClaims(w)) {
    const i = owedPass(w, k, passes);
    if (i < 0) continue;
    const sent = sends.find((s) => s.guid === k.guid);
    assert.ok(sent, `${where}: D1: claim nonce ${k.nonce} owed in the pass at ${Math.round(passes[i] - T0)} s was never sent`);
    assert.ok(sent.t < (passes[i + 1] ?? Infinity), `${where}: D1: claim nonce ${k.nonce} owed in the pass at ${Math.round(passes[i] - T0)} s, sent at ${Math.round(sent.t - T0)} s`);
  }
}

test("D1: a lengthened delay holds every claim back, a shortened one (after the timelock) claims them sooner (25 seeded runs)", async () => {
  for (let seed = 1; seed <= 25; seed++) {
    rmSync(process.env.STATE_DIR, { recursive: true, force: true });
    const r = rng(seed * 6007);
    const w = makeBridgeWorld({ seed: seed + 500, skew: { 1: Math.round((r() * 2 - 1) * 3600), 4663: Math.round((r() * 2 - 1) * 3600) }, slowP: 0.02, home: r() < 0.5 ? 4663 : 1, delay: DELAY });
    queuedTraffic(w, r, 2400);
    // tighten: the delay doubles at once, while claims are pending; later a SET_DELAY shortens it below the launch value.
    const up = T0 + 1800 + r() * 1800, down = up + 1200 + r() * 2400;
    const events = [
      { at: up, run: () => setDelay(w, w.home.id, { delay: DELAY * 2 }) },
      { at: down, run: () => setDelay(w, w.home.id, { delay: Math.round(DELAY / 2) }) },
    ];
    const { raised, sends, passes, errors } = await run(w, { horizon: 2400 + DELAY * 3, events, restartP: 0.05 });
    const where = `seed ${seed} (home ${w.home.id}, up ${Math.round(up - T0)} s, down ${Math.round(down - T0)} s)`;
    assert.deepEqual(errors, [], `${where}: passes threw`);
    checkD1(w, sends, passes, where);
    const noisy = raised.filter((a) => /^bridge-claim-(refused|late|mismatch)-/.test(a.key));
    assert.deepEqual([...new Set(noisy.map((a) => a.key))], [], `${where}: an honest claim waiting on a changed delay raised warnings`);
    for (const k of homeClaims(w)) assert.equal(k.state, 2, `${where}: honest claim nonce ${k.nonce} never claimed`);
  }
});

test("D2: a bulk cutoff holds every claim it covers without noise, says so as info, and releases them when cleared (25 seeded runs)", async () => {
  for (let seed = 1; seed <= 25; seed++) {
    rmSync(process.env.STATE_DIR, { recursive: true, force: true });
    const r = rng(seed * 7121);
    const w = makeBridgeWorld({ seed: seed + 700, skew: { 1: Math.round((r() * 2 - 1) * 3600), 4663: Math.round((r() * 2 - 1) * 3600) }, slowP: 0.02, home: r() < 0.5 ? 4663 : 1, delay: DELAY });
    queuedTraffic(w, r, 2400);
    // tighten(cancelFrom): a cutoff in the middle of the queue times, set before most of them mature; a SET_DELAY clears it later
    // (or, in some runs, moves it past every claim).
    const qs = homeClaims(w).map((k) => k.queuedAt).sort((a, b) => a - b);
    const cutoff = qs[Math.floor(qs.length / 2)];
    let setAt = null;
    const at = T0 + 600 + r() * 1200, clear = at + DELAY + r() * 3000, movePast = r() < 0.5;
    const events = [
      { at, run: () => { setAt = w.t; setDelay(w, w.home.id, { delay: DELAY, cutoff }); } },
      { at: clear, run: () => setDelay(w, w.home.id, { delay: DELAY, cutoff: movePast ? qs[qs.length - 1] + 1 : 0 }) },
    ];
    const { raised, sends, passes, errors } = await run(w, { horizon: clear - T0 + 2 * DELAY, events, restartP: 0.05 });
    const where = `seed ${seed} (home ${w.home.id}, cutoff ${cutoff - w.home.timeOf(0)}, set ${Math.round(at - T0)} s, ${movePast ? "moved past" : "cleared"} ${Math.round(clear - T0)} s)`;
    assert.deepEqual(errors, [], `${where}: passes threw`);
    checkD1(w, sends, passes, where);
    const cut = homeClaims(w).filter((k) => k.queuedAt >= cutoff);
    assert.ok(cut.length > 0, `${where}: the cutoff covers nothing (test setup)`);
    for (const k of cut) {
      const noisy = raised.filter((a) => a.level !== "info" && a.key.endsWith(`-${k.nonce}`) && /^bridge-(claim|cancelled-honest|stuck)-/.test(a.key));
      assert.deepEqual(noisy.map((a) => a.key), [], `${where}: D2: claim nonce ${k.nonce} under the cutoff raised ${noisy.map((a) => a.key)}`);
    }
    const info = raised.filter((a) => a.key === `bridge-bulk-cancel-${nameOf(w.home.id)}`);
    assert.ok(info.length && info.every((a) => a.level === "info"), `${where}: D2: the cutoff must raise info bridge-bulk-cancel`);
    // Raised in the first pass that starts after the cutoff (its raise lands before the next pass starts; slow RPCs stretch a pass).
    const i = passes.findIndex((p) => p >= setAt);
    assert.ok(info.some((a) => a.t >= setAt && a.t <= (passes[i + 1] ?? Infinity)), `${where}: D2: the info alert comes in the first pass after the cutoff`);
    for (const k of homeClaims(w)) assert.equal(k.state, 2, `${where}: honest claim nonce ${k.nonce} never claimed after the cutoff was lifted`);
  }
});

test("D3: DelaySet is indexed under empty log answers; the index holds the chain's latest settings (15 seeded runs)", async () => {
  for (let seed = 1; seed <= 15; seed++) {
    rmSync(process.env.STATE_DIR, { recursive: true, force: true });
    const r = rng(seed * 8111);
    const w = makeBridgeWorld({ seed: seed + 900, emptyP: 0.1 + r() * 0.4, home: r() < 0.5 ? 4663 : 1, delay: DELAY });
    queuedTraffic(w, r, 1200);
    const events = [...Array(3)].map((_, i) => ({ at: T0 + 300 + i * 900 + r() * 600, run: () => setDelay(w, w.home.id, { delay: DELAY + 600 * (i + 1), cutoff: i === 1 ? w.home.timeOf(w.home.headAt(w.t)) : 0 }) }));
    await run(w, { horizon: 4000, events });
    const where = `seed ${seed} (home ${w.home.id})`;
    const side = readStateOr("bridge-watch.json", {}).home;
    const got = side?.delays?.[String(EID[w.peer.id])];
    const want = w.home.settings.at(-1)[1];
    assert.ok(got, `${where}: D3: no DelaySet indexed`);
    assert.equal(Number(got.delay), want.delay, `${where}: D3: indexed delay`);
    assert.equal(Number(got.cancelFrom), want.cutoff, `${where}: D3: indexed cutoff`);
  }
});
