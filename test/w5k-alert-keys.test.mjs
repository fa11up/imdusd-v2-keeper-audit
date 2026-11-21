// A review before wave 5b (alerts): EVERY ALERT KEY HAS A CLEAR PATH, OWNED BY A READ OF ITS CONDITION.
// The fixture below is the complete list of alert keys (prefixes up to the first `${`), where they are raised, and the one place that
// clears them, with the read that clears them. The test fails when a key is raised that is not in the fixture (a new key must say how
// it clears), when a fixture key is no longer raised, or when the clear site named is gone from its file. Behaviour of the clears that
// this commit changed is tested below (permit2, orders, state-unreadable, cannot-close, depth, send-skipped).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5k-keys-"));
const here = new URL("..", import.meta.url).pathname;

const W = (k) => ({ in: "lib/watch.mjs", by: "MINE", read: `runWatch re-reads ${k} every pass` });
const S = (file, lit, read) => ({ in: file, by: lit, read });
// key prefix -> { in: the file that clears it, by: a literal that must be in that file, read: what read clears it }
const KEYS = {
  "allocator-frozen": S("lib/allocator.mjs", 'settle("allocator-"', "the allocator pass re-reads frozen()"),
  "allocator-not-keeper": S("lib/allocator.mjs", 'settle("allocator-"', "the pass re-reads keepers()"),
  "allocator-sale-setup-": S("lib/allocator.mjs", 'settle("allocator-"', "the pass re-reads each configured sale"),
  "allocator-unsold-": S("lib/allocator.mjs", 'settle("allocator-"', "the pass re-reads the sleeve holdings"),
  "backstop-room-empty-": S("lib/backstop.mjs", 'settle("backstop-"', "bidRoomNow re-read per sleeve and type"),
  "backstop-room-fell-": S("lib/backstop.mjs", 'settle("backstop-"', "bidRoomNow re-read"),
  "backstop-room-thin-": S("lib/backstop.mjs", 'settle("backstop-"', "bidRoomNow re-read"),
  "backstop-unconverted-": S("lib/backstop.mjs", 'settle("backstop-"', "matured buckets re-read"),
  "backstop-unpriced-legs-": S("lib/backstop.mjs", 'settle("backstop-"', "quote + priceOf re-read per covered type"),
  ...Object.fromEntries(["bridge-breaker-tripped-", "bridge-bulk-cancel-", "bridge-cancelled-honest-", "bridge-claim-late-", "bridge-claim-mismatch-", "bridge-claim-refused-", "bridge-claim-unread-",
    "bridge-claims-closed-", "bridge-claims-unread-", "bridge-counters-", "bridge-forged-", "bridge-head-stalled-", "bridge-held-", "bridge-index-gap-", "bridge-index-unchecked-", "bridge-paused-",
    "bridge-paused-unread-", "bridge-peer-fromblock-", "bridge-peer-unread-", "bridge-queued-forged-", "bridge-queued-unverified-", "bridge-reindex-", "bridge-reorg-", "bridge-stuck-", "bridge-supply-",
    "bridge-supply-unread-", "bridge-unverified-", "bridge-verified-forged-", "bridge-verified-replay-", "bridge-not-wired-", "bridge-verified-unverified-", "bridge-voided-", "bridge-voided-honest-"].map((k) =>
    [k, S("lib/bridge.mjs", 'settle("bridge-"', "a COMPLETE watcher pass (settle skipped otherwise); unread conditions held per key (heldKeys/heldPrefixes)")])),
  "bridge-watch-off": S("keeper.mjs", 'settle("bridge-watch-off"', "a start whose config runs the watcher and auto-claim"),
  "cannot-close-": S("lib/positions.mjs", 'settle("cannot-close-"', "the position re-read this pass (unpriced types' positions are not read: held)"),
  "depth-buckets-": W("the sampler buckets"), "depth-falling": W("depth"), "depth-high-sample-": W("samples"), "depth-low-sample-": W("samples"),
  "depth-sample-age-": W("sample ages"), "depth-zero": W("depthIMD"),
  "depth-poke-failed": S("lib/depth.mjs", 'clear(ctx, "depth-poke-failed")', "a poke that landed"),
  "depth-proof-failed-": S("lib/depth.mjs", "clear(ctx, `depth-proof-failed-", "that feed's proof built"),
  "depth-proof-late": S("lib/depth.mjs", 'clear(ctx, "depth-proof-late")', "a depth round that landed"),
  "depth-prove-now-failed": S("lib/depth.mjs", 'clear(ctx, "depth-prove-now-failed")', "a proof that landed"),
  "depth-round-read-failed": S("lib/depth.mjs", 'clear(ctx, "depth-round-read-failed")', "the round simulated"),
  "depth-sampler-reverted": S("lib/depth.mjs", 'clear(ctx, "depth-sampler-reverted")', "a round with no failing sampler"),
  "edge-in-auction": W("edgeInAuction"), "keeper-eth-low": W("the keeper's balance"), "retire-while-priced": W("the pending retire"),
  "rpc-stale": W("the head's time"), "unbacked": W("unbacked()"), "unpriced-": W("each type's quote"),
  "feeds-": S("lib/feeds.mjs", 'settle("feeds-"', "the decision re-made (failed decisions hold their keys: unread)"),
  ...Object.fromEntries(["feeds-buy-held", "feeds-imd-empty", "feeds-imd-low", "feeds-median-held", "feeds-nhi-gap", "feeds-not-converged-", "feeds-not-converged-unread-", "feeds-plane-hold",
    "feeds-proven-spot-ageing", "feeds-proven-spot-stale", "feeds-proven-spot-unread", "feeds-question-mismatch", "feeds-simd-rally", "feeds-simd-refused", "feeds-unseeded", "feeds-walking"].map((k) =>
    [k, S("lib/feeds.mjs", 'settle("feeds-"', "the feeds pass re-reads it; an unread one is held (unread)")])),
  "feeds-answer-failed-": S("lib/orders.mjs", 'settle?.("feeds-answer-"', "orders.json read: no open order with a failed child of that role"),
  "feeds-order-lost": S("lib/orders.mjs", 'settle?.("feeds-order-"', "orders.json read: no lost order"),
  "feeds-order-refused-": S("lib/orders.mjs", 'settle?.("feeds-order-"', "orders.json read: no held order of that purpose"),
  "feeds-order-unpaid-": S("lib/orders.mjs", 'settle?.("feeds-order-"', "an event: cleared by the next orders.json read after it was raised"),
  "feeds-permit2-unapproved": S("lib/orders.mjs", 'settle?.("feeds-permit2-unapproved"', "an allowance read that covers the cost, from any loop"),
  "guardian-freeze-now": S("lib/guardian.mjs", 'settle("guardian-"', "the guardian conditions re-read"),
  "imdfeeds-": S("lib/imdfeeds.mjs", 'settle("imdfeeds-"', "the decision re-made"),
  ...Object.fromEntries(["imdfeeds-buy-held", "imdfeeds-nhi-gap", "imdfeeds-plane-hold", "imdfeeds-question-mismatch", "imdfeeds-walking", "imdfeeds-imd-", "imdfeeds-not-converged-"].map((k) =>
    [k, S("lib/imdfeeds.mjs", 'settle("imdfeeds-"', "the imdfeeds pass re-reads it; an unread one is held")])),
  "index-incomplete": S("lib/positions.mjs", 'settle("index-"', "the index proven against the collateral totals"),
  "loop-failing-": S("keeper.mjs", "settle(`loop-failing-", "a pass of that loop that completed"),
  "loop-slow-": S("keeper.mjs", "settle(`loop-slow-", "a pass of that loop that completed inside its deadline"),
  "peg-no-bid": S("lib/peg.mjs", 'settle("peg-"', "the hook re-read"), "peg-quote-unsound": S("lib/peg.mjs", 'settle("peg-"', "the quote re-read"), "peg-twap-push": S("lib/peg.mjs", 'settle("peg-"', "the TWAP re-read"),
  "pulse-grace": S("lib/pulse.mjs", 'settle("pulse-"', "Pulse re-read"), "pulse-silent": S("lib/pulse.mjs", 'settle("pulse-"', "Pulse re-read"),
  "rates-unreadable-": S("lib/rates.mjs", 'settle("rates-"', "the feed's rate re-read"),
  "seats-auction-void-": S("lib/seats.mjs", 'settle("seats-"', "the auction re-read"), "seats-buy-held": S("lib/seats.mjs", 'settle("seats-"', "the decision re-made"), "seats-question-mismatch": S("lib/seats.mjs", 'settle("seats-"', "the leaf re-read"),
  "send-skipped": S("lib/act.mjs", 'settle?.("send-skipped"', "an URGENT send that landed (urgent sends go out again)"),
  "send-stuck": S("lib/act.mjs", 'settle?.("send-stuck"', "any send that landed: the key's nonce moved past the stuck one"),
  "state-unreadable-": S("keeper.mjs", "settle(`state-unreadable-", "a successful read of that file (lib/state.mjs drainReadOk)"),
  "stocks-feed-silent-": S("lib/stocks.mjs", 'settle("stocks-"', "a pass that read a NEWER round (the session-time record resets with it)"),
  "stocks-frozen-": S("lib/stocks.mjs", 'settle("stocks-"', "frozen() re-read"), "stocks-multiplier-pending-": S("lib/stocks.mjs", 'settle("stocks-"', "multipliers re-read"),
  "stocks-tick-late-": S("lib/stocks.mjs", 'settle("stocks-"', "an hour after the late tick (state/stocks-late.json)"), "stocks-worthless-": S("lib/stocks.mjs", 'settle("stocks-"', "worthless() re-read"),
};
// Keys built from another key at run time (the extractor cannot see them).
const DYNAMIC = new Set(["imdfeeds-imd-", "imdfeeds-not-converged-"]);

function raisedKeys() {
  const files = ["keeper.mjs", ...readdirSync(join(here, "lib")).filter((f) => f.endsWith(".mjs")).map((f) => `lib/${f}`)];
  const out = new Map();
  const pats = [
    /raise\??\.?\(\s*(?:"(?:info|warn|critical)"|level|[^,()]*\?\s*"(?:critical|warn)"\s*:\s*"(?:critical|warn)")\s*,\s*[`"]([a-z0-9-]+)/g,
    /\{\s*level:[^{}]*?key:\s*[`"]([a-z0-9-]+)/g,
  ];
  for (const f of files) {
    const s = readFileSync(join(here, f), "utf8");
    for (const re of pats) for (const m of s.matchAll(re)) out.set(m[1], [...(out.get(m[1]) ?? []), f]);
  }
  return out;
}

test("every raised alert key is in the fixture with a clear path, and every fixture key is still raised", () => {
  const got = raisedKeys();
  const missing = [...got.keys()].filter((k) => !KEYS[k]);
  assert.deepEqual(missing, [], `keys raised with no clear path in the fixture: ${missing.map((k) => `${k} (${got.get(k)})`).join(", ")}`);
  const stale = Object.keys(KEYS).filter((k) => !got.has(k) && !DYNAMIC.has(k));
  assert.deepEqual(stale, [], "fixture keys no longer raised");
});

test("every clear site named in the fixture exists in its file", () => {
  const watch = readFileSync(join(here, "lib/watch.mjs"), "utf8");
  const mine = new RegExp(/const MINE = (\/.*\/);/.exec(watch)[1].slice(1, -1));
  for (const [k, v] of Object.entries(KEYS)) {
    if (v.by === "MINE") assert.ok(mine.test(k) || mine.test(`${k}x`), `${k}: not owned by runWatch's MINE`);
    else assert.ok(readFileSync(join(here, v.in), "utf8").includes(v.by), `${k}: ${v.in} has no ${v.by}`);
    assert.ok(v.read, `${k}: no read named`);
  }
});

// ---- behaviour of the clears this commit changed

const recorder = () => {
  const standing = new Map();
  return { standing, raise: async (l, k) => standing.set(k, l), settle: async (p, held) => { const keep = typeof held === "function" ? held : (k) => held.has(k); for (const k of [...standing.keys()]) if (k.startsWith(p) && !keep(k)) standing.delete(k); } };
};

test("feeds-permit2-unapproved clears only on an allowance read that covers the cost, from whichever loop asks; the feeds loop never clears it", async () => {
  const { ensureAllowance } = await import("../lib/orders.mjs");
  const a = recorder();
  let allowance = BigNumber.from(0);
  const ctx = { signer: { address: "0x00000000000000000000000000000000000000ee" }, pay: { provider: {} }, cfg: {}, alerts: a, book: {} };
  const { Contract } = await import("ethers");
  const orig = Contract.prototype.allowance;
  // payToken builds a Contract on ctx.pay.provider: stub its allowance read
  ctx.pay.provider = { _isProvider: true, call: async () => "0x" + allowance.toHexString().slice(2).padStart(64, "0"), getNetwork: async () => ({ chainId: 1 }), resolveName: async (n) => n };
  assert.equal(await ensureAllowance(ctx, BigNumber.from(10)), false);
  assert.ok(a.standing.has("feeds-permit2-unapproved"));
  allowance = BigNumber.from(100);
  assert.equal(await ensureAllowance(ctx, BigNumber.from(10)), true);
  assert.ok(!a.standing.has("feeds-permit2-unapproved"), "cleared by the read that covers the cost");
  void orig;
});

test("order keys clear only on an orders.json read that shows the condition gone; an event stands until the next read", async () => {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  const { writeState } = await import("../lib/state.mjs");
  const { advanceOrders } = await import("../lib/orders.mjs");
  const a = recorder();
  a.standing.set("feeds-order-lost", "critical");
  a.standing.set("feeds-order-refused-fall", "critical");
  writeState("orders.json", { list: [{ key: "k", purpose: "fall", stage: "lost", planeOrder: "p", at: new Date().toISOString(), paidAt: new Date().toISOString(), questions: [] }] });
  const ctx = { execute: true, cfg: {}, log() {}, alerts: a, planeClient: { order: async () => ({ status: 200, body: {} }) } };
  await advanceOrders(ctx);
  assert.ok(a.standing.has("feeds-order-lost") && a.standing.has("feeds-order-refused-fall"), "held while the lost order stands");
  writeState("orders.json", { list: [] }); // a human ran --clear-lost
  await advanceOrders(ctx);
  assert.ok(!a.standing.has("feeds-order-lost") && !a.standing.has("feeds-order-refused-fall"));
});

test("state-unreadable-<file> clears when that file reads again, and only that file's key", async () => {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  mkdirSync(process.env.STATE_DIR, { recursive: true });
  const { runRound } = await import("../keeper.mjs");
  const { readState, statePath } = await import("../lib/state.mjs");
  writeFileSync(statePath("orders.json"), "{torn");
  const a = recorder();
  a.standing.set("state-unreadable-imd-spend.json", "critical");
  const loop = { name: "x", run: async () => readState("orders.json", { list: [] }) };
  const ctx = { cfg: {}, provider: {}, log() {}, loops: [loop], alerts: a };
  await runRound(ctx, ["x"]);
  assert.ok(a.standing.has("state-unreadable-orders.json"), "raised for the file that failed");
  writeFileSync(statePath("orders.json"), JSON.stringify({ list: [] }));
  await runRound(ctx, ["x"]);
  assert.ok(!a.standing.has("state-unreadable-orders.json"), "cleared by a good read of it");
  assert.ok(a.standing.has("state-unreadable-imd-spend.json"), "another file's key is not cleared by it");
});

test("send-skipped clears on a landed URGENT send only; a routine one proves nothing about urgent sends", async () => {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  const { act } = await import("../lib/act.mjs");
  const a = recorder();
  a.standing.set("send-skipped", "critical");
  const ctx = { execute: true, cfg: {}, log() {}, provider: { unpin() {} }, alerts: a };
  const c = { connect: () => c, callStatic: { f: async () => {} }, f: async () => ({ hash: "0x1", wait: async () => ({ blockNumber: 1, gasUsed: BigNumber.from(1) }) }) };
  const signer = { provider: { getGasPrice: async () => BigNumber.from(1), getBalance: async () => BigNumber.from(10).pow(18) } };
  await act(ctx, "routine", c, "f", [], { tier: "routine", signer });
  assert.ok(a.standing.has("send-skipped"), "cleared by a routine send");
  await act(ctx, "urgent", c, "f", [], { tier: "urgent", signer });
  assert.ok(!a.standing.has("send-skipped"));
});

test("cannot-close-<id> stands while its type is unpriced (not read), clears once the position is read and closable", async () => {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  const { utils } = await import("ethers");
  const { runPositions } = await import("../lib/positions.mjs");
  const { makeWorld } = await import("./lib/rh-world.mjs");
  const ETH = utils.formatBytes32String("ETH");
  const { w, ctx } = makeWorld({ types: [{ id: ETH, name: "ETH", priced: false }], positions: [{ id: 5, ilk: ETH }] });
  const a = recorder();
  a.standing.set("cannot-close-5", "warn");
  ctx.alerts = a;
  await runPositions(ctx);
  assert.ok(a.standing.has("cannot-close-5"), "cleared without reading the position");
  w.types.get(ETH).priced = true;
  await runPositions(ctx);
  assert.ok(!a.standing.has("cannot-close-5"), "the position was read and closed: the key clears");
});
