import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber } from "ethers";
import { bucketAlerts, depthAlerts, depthPlan, pokeNeeded, pokeTier, runDepth } from "../lib/depth.mjs";
import { liqStep, minSeized, needsTick } from "../lib/positions.mjs";
import { shouldFire } from "../lib/alerts.mjs";
import { pendingIntents, recordIntent, settleIntents } from "../lib/journal.mjs";
import { send } from "../lib/tx.mjs";
import { readState, writeState } from "../lib/state.mjs";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-test-"));

const E18 = BigNumber.from(10).pow(18);
const usd = (n) => E18.mul(n);

test("depth: one random second per hour, due once, reset by the next hour", () => {
  const roll = () => 1800;
  const hour = 500;
  const a = depthPlan(hour * 3600 + 10, null, roll);
  assert.equal(a.due, false);
  assert.equal(a.state.at, hour * 3600 + 1800);
  const b = depthPlan(hour * 3600 + 1800, a.state, () => assert.fail("must not re-roll within an hour"));
  assert.equal(b.due, true);
  assert.equal(depthPlan(hour * 3600 + 1900, { ...b.state, done: true }).due, false);
  const c = depthPlan((hour + 1) * 3600 + 5, { ...b.state, done: true }, roll);
  assert.equal(c.state.done, false);
  assert.equal(c.state.hour, hour + 1);
});

test("poke tier: urgent only late in a UTC day with no poke yet", () => {
  const day = 20_000;
  assert.equal(pokeTier(day * 86_400 + 3_600, day - 1), "routine");
  assert.equal(pokeTier(day * 86_400 + 18 * 3_600, day - 1), "urgent");
  assert.equal(pokeTier(day * 86_400 + 18 * 3_600, day), "routine");
});

test("depth alerts: operator thresholds; zero depth is critical only once sIMD has a line", () => {
  const ok = { address: "0xa", age: 100, filled: 24 };
  const keys = (x) => depthAlerts({ samplers: [ok], today: 100n, yesterday: 100n, depthIMD: 1n, simdLine: 0n, warmedUp: true, ...x }).map((a) => `${a.level}:${a.key}`);
  assert.deepEqual(keys({}), []);
  assert.deepEqual(keys({ samplers: [{ ...ok, age: 7201 }] }), ["critical:depth-sample-age-0xa"]);
  assert.deepEqual(keys({ samplers: [{ ...ok, filled: 21 }] }), ["warn:depth-buckets-0xa"]);
  assert.deepEqual(keys({ samplers: [{ ...ok, age: 9999, filled: 0 }], warmedUp: false }), []);
  assert.deepEqual(keys({ today: 69n }), ["warn:depth-falling"]);
  assert.deepEqual(keys({ today: 70n }), []);
  assert.deepEqual(keys({ depthIMD: 0n }), ["info:depth-zero"]);
  assert.deepEqual(keys({ depthIMD: 0n, simdLine: 1n }), ["critical:depth-zero"]);
});

test("bucket alerts: hours far from the window median, low (push) and high (sandwich); too few buckets says nothing", () => {
  const e = 10n ** 18n;
  const nowHour = 500_000;
  const window = (vs) => vs.map((v, i) => ({ hour: nowHour - i, v: v * e }));
  const keys = (bs) => bucketAlerts({ address: "0xa", buckets: bs, nowHour }).map((a) => `${a.level}:${a.key}`);
  const flat = Array(24).fill(40_000n);
  assert.deepEqual(keys(window(flat)), []);
  assert.deepEqual(keys(window([19_000n, ...flat.slice(1)])), ["warn:depth-low-sample-0xa"]);
  assert.deepEqual(keys(window([20_000n, ...flat.slice(1)])), []);
  assert.deepEqual(keys(window([61_000n, ...flat.slice(1)])), ["warn:depth-high-sample-0xa"]);
  assert.deepEqual(keys(window([1n, 90_000n, ...flat.slice(2)])), ["warn:depth-low-sample-0xa", "warn:depth-high-sample-0xa"]);
  // Out of the window (26 h) or never filled: ignored.
  assert.deepEqual(keys([...window(flat.slice(1)), { hour: nowHour - 30, v: 1n }, { hour: 0, v: 0n }]), []);
  assert.deepEqual(keys(window([1n, 40_000n, 40_000n])), []);
});

test("liqStep: no grace closes in one call; grace waits, then bites; a dead mark starts over", () => {
  assert.deepEqual(liqStep({ now: 100, markAt: 0, markExpiresAt: 0, graceEnd: 0, lull: 0 }), { step: "close", fn: "liquidate" });
  assert.deepEqual(liqStep({ now: 100, markAt: 0, markExpiresAt: 0, graceEnd: 0, lull: 60 }), { step: "mark" });
  assert.equal(liqStep({ now: 100, markAt: 90, markExpiresAt: 1000, graceEnd: 150, lull: 60 }).step, "wait");
  assert.deepEqual(liqStep({ now: 150, markAt: 90, markExpiresAt: 1000, graceEnd: 150, lull: 60 }), { step: "close", fn: "bite" });
  assert.deepEqual(liqStep({ now: 1001, markAt: 90, markExpiresAt: 1000, graceEnd: 150, lull: 60 }), { step: "mark" });
});

test("minSeized and the tick rule", () => {
  assert.equal(minSeized(10_000, 50).toNumber(), 9_950);
  assert.equal(needsTick(0, true), false);
  assert.equal(needsTick(0, false), true);
  assert.equal(needsTick(123, false), false);
  assert.equal(needsTick(123, true), true);
});

test("alerts repeat by level", () => {
  assert.equal(shouldFire(undefined, "warn", 100), true);
  assert.equal(shouldFire({ at: 100 }, "critical", 3699), false);
  assert.equal(shouldFire({ at: 100 }, "critical", 3700), true);
});

test("no ABI output is named after an Array member (ethers results are arrays)", async () => {
  const { utils } = await import("ethers");
  const abis = await import("../lib/deployment.mjs");
  for (const [name, abi] of Object.entries(abis)) {
    if (!name.endsWith("_ABI")) continue;
    for (const f of new utils.Interface(abi).fragments) {
      for (const o of f.outputs ?? []) assert.ok(!(o.name in Array.prototype), `${name}: ${f.name} output ${o.name}`);
    }
  }
});

test("poke skip: writes exactly when ImdDepth.poke would", () => {
  const day = 20_000;
  const at = (hour) => day * 86_400 + hour * 3600 + 5;
  const low = (n, hours, usd) => ({ day, n, hours, usd });
  assert.equal(pokeNeeded({ ...low(4, [1, 2, 3, 4], [1n, 2n, 3n, 4n]), day: day - 7 }, at(9), 100n), true, "the slot holds another day: the first poke of a day always writes");
  const three = low(3, [1, 2, 3, 0], [10n, 20n, 30n, 0n]);
  assert.equal(pokeNeeded(three, at(9), 100n), true, "under 4 hours held: a new hour always enters");
  assert.equal(pokeNeeded(three, at(2), 20n), false, "this hour holds a reading no higher");
  assert.equal(pokeNeeded(three, at(2), 19n), true, "this hour's reading falls");
  const full = low(4, [1, 2, 3, 4], [10n, 20n, 30n, 40n]);
  assert.equal(pokeNeeded(full, at(9), 40n), false, "not among the day's lowest hours");
  assert.equal(pokeNeeded(full, at(9), 39n), true, "evicts the highest");
  assert.equal(pokeNeeded(full, at(4), 41n), false, "held hour, higher reading");
  assert.equal(pokeNeeded(low(4, [1, 2, 3, 4], [10n, 20n, 30n, (1n << 112n) - 1n]), at(9), 1n << 120n), false, "the reading clamps to uint112 like the contract");
});

// runDepth's path to the poke, with fake contracts: what is sent, in what order, whatever fails around it.
function fakeDepth({ now, lastDay, simulate, batch = async () => ({}) }) {
  const sent = [];
  const tx = (name, fn) => async (...a) => {
    await fn(...a);
    sent.push(name);
    return { hash: "0x1", wait: async () => ({ blockNumber: 1, gasUsed: 1 }) };
  };
  const contract = (name, fn) => {
    const c = { address: `0x${name}`, callStatic: { [fn]: async () => {} }, [fn]: tx(name, fn === "aggregate3" ? batch : async () => {}), interface: { encodeFunctionData: (f) => f } };
    c.connect = () => c;
    return c;
  };
  const multicall = contract("batch", "aggregate3");
  multicall.callStatic.aggregate3 = simulate;
  const provider = {
    getBlock: async () => ({ number: 1, timestamp: now, baseFeePerGas: 1n }),
    getStorageAt: async () => "0x0",
    getGasPrice: async () => BigNumber.from(1),
    getBalance: async () => BigNumber.from(10).pow(18),
    unpin() {},
  };
  const imdDepth = { ...contract("poke", "poke"), lowOf: async () => ({ day: lastDay }) };
  imdDepth.connect = () => imdDepth;
  imdDepth.interface = { encodeFunctionData: (f) => f };
  const alerts = [];
  const ctx = {
    execute: true, log() {}, provider, multicall, cfg: {}, signer: { provider, address: "0xk" },
    book: { imdDepth, samplers: [contract("sampler", "sample")] },
    alerts: { raise: async (level, key) => alerts.push(`${level}:${key}`) },
  };
  return { ctx, sent, alerts };
}
const okRound = async () => [{ success: true, returnData: "0x" }, { success: true, returnData: "0x01" }];

test("depth round: a failed read still pokes", async () => {
  const now = 20_000 * 86_400 + 3600;
  writeState("depth.json", { hour: Math.floor(now / 3600), at: now - 1, done: false });
  const f = fakeDepth({ now, lastDay: 19_999, simulate: async () => { throw new Error("rpc cap"); } });
  await runDepth(f.ctx);
  assert.deepEqual(f.sent, ["poke"]);
  assert.deepEqual(f.alerts, ["warn:depth-round-read-failed"]);
});

test("depth round: a batch that dies after its simulation still pokes, and the hour stays open", async () => {
  const now = 20_000 * 86_400 + 3600;
  writeState("depth.json", { hour: Math.floor(now / 3600), at: now - 1, done: false });
  const f = fakeDepth({ now, lastDay: 19_999, simulate: okRound, batch: async () => { throw new Error("estimate reverted"); } });
  await runDepth(f.ctx);
  assert.deepEqual(f.sent, ["poke"]);
  assert.equal(readState("depth.json").done, false);
});

test("depth round: late in a day with no poke, the poke goes first and alone", async () => {
  const now = 20_000 * 86_400 + 19 * 3600;
  writeState("depth.json", { hour: Math.floor(now / 3600), at: now - 1, done: false });
  const f = fakeDepth({ now, lastDay: 19_999, simulate: okRound });
  await runDepth(f.ctx);
  assert.deepEqual(f.sent, ["poke", "batch"]);
  assert.equal(readState("depth.json").done, true);
});

test("depth round: normally one transaction", async () => {
  const now = 20_000 * 86_400 + 3600;
  writeState("depth.json", { hour: Math.floor(now / 3600), at: now - 1, done: false });
  const f = fakeDepth({ now, lastDay: 19_999, simulate: okRound });
  await runDepth(f.ctx);
  assert.deepEqual(f.sent, ["batch"]);
  assert.equal(readState("depth.json").done, true);
});

test("journal: a restart settles what the last run left before anything new is decided", async () => {
  const again = [];
  const provider = (receipts, count) => ({ getTransactionReceipt: async (h) => receipts[h] ?? null, getTransactionCount: async () => count });
  const rebroadcast = async (raw) => again.push(raw);
  recordIntent({ nonce: 7, hash: "0xa", signed: "0xaa", label: "open" });
  let open = await settleIntents(provider({}, 7), "0xk", rebroadcast);
  assert.deepEqual(open.map((i) => i.hash), ["0xa"], "not mined, nonce unused: still open");
  assert.deepEqual(again, ["0xaa"], "the same signed bytes go out again, never a new transaction");
  open = await settleIntents(provider({ "0xa": { status: 1, blockNumber: 5 } }, 8), "0xk", rebroadcast);
  assert.deepEqual(open, []);
  assert.deepEqual(pendingIntents(), [], "mined clears it");
  recordIntent({ nonce: 9, hash: "0xb", signed: "0xbb", label: "replaced" });
  assert.deepEqual(await settleIntents(provider({}, 10), "0xk", rebroadcast), []);
  assert.deepEqual(pendingIntents(), [], "the nonce went to something else: it can never be mined");
  assert.equal(again.length, 1);
});

test("journal: an open send holds routine work, and urgent work only for a minute", async () => {
  const provider = { getTransactionReceipt: async () => null, getTransactionCount: async () => 3, getGasPrice: async () => BigNumber.from(1), getBalance: async () => E18 };
  const signer = { provider, address: "0xk", rebroadcast: async () => {} };
  const attempt = (tier) => send(signer, "next", async () => {}, async () => ({ hash: "0xn", wait: async () => ({ blockNumber: 1, gasUsed: 1 }) }), {}, { tier });
  recordIntent({ nonce: 3, hash: "0xc", signed: "0xcc", label: "stuck" });
  assert.match((await attempt("routine")).skipped, /waiting on stuck/);
  assert.match((await attempt("urgent")).skipped, /waiting on stuck/, "a fresh send gets its minute");
  recordIntent({ nonce: 3, hash: "0xc", signed: "0xcc", label: "stuck", at: new Date(Date.now() - 61_000).toISOString() });
  assert.match((await attempt("routine")).skipped, /waiting on stuck/);
  assert.equal((await attempt("urgent")).hash, "0xn");
  recordIntent({ nonce: 3, hash: "0xc", signed: "0xcc", label: "done", at: new Date(0).toISOString() });
  provider.getTransactionReceipt = async () => ({ status: 1, blockNumber: 2 });
  assert.equal((await attempt("routine")).hash, "0xn", "settled, so nothing holds");
  assert.deepEqual(pendingIntents(), []);
});

test("send: a send past its wait leaves the queue, its intent still open", async () => {
  const provider = { getGasPrice: async () => BigNumber.from(1), getBalance: async () => E18 };
  const signer = { provider, address: "0xk" };
  let args;
  // As ethers' Contract calls it: confirmations only. The bound is the transaction's own default (guardedSigner), proven on the fork.
  const stuck = async () => ({ hash: "0xs", wait: async (...a) => { args = a; throw Object.assign(new Error("timeout exceeded"), { code: "TIMEOUT" }); } });
  const r = await send(signer, "slow", async () => {}, stuck, { SEND_WAIT_SECONDS: 7 });
  assert.deepEqual(args, [1], "no timeout argument: a Contract wrapper would drop it");
  assert.equal(r.pending, "0xs");
  assert.equal(r.hash, undefined, "not landed");
  assert.match(r.skipped, /not mined within 7s/);
  const reverted = async () => ({ hash: "0xr", wait: async () => { throw new Error("0xr reverted"); } });
  await assert.rejects(send(signer, "bad", async () => {}, reverted, {}), /reverted/, "a revert is still an error");
});

test("index: a position opened past the index's last block is not a shortfall", async () => {
  const { refreshIndex, shortfalls } = await import("../lib/index.mjs");
  const ledger = "0x00000000000000000000000000000000000000aa";
  const ILK = `0x${"11".repeat(32)}`;
  const provider = { getBlockNumber: async () => 103, getLogs: async () => [] };
  const { ids, top } = await refreshIndex(provider, ledger, 100, { lag: 3 });
  assert.equal(top, 100);
  // A position with 5 opened at block 102: the head's total has it, the index cannot yet.
  const book = { ilks: [{ id: ILK, name: "ETH" }], ledger: { ilkState: async (_, o) => ({ collateral: BigNumber.from(o?.blockTag >= 102 || o?.blockTag === undefined ? 5 : 0) }), position: async () => ({ collateral: BigNumber.from(0) }) } };
  assert.deepEqual(await shortfalls(book, ids, top), [], "compared at the index's block");
  assert.equal((await shortfalls(book, ids, 103)).length, 1, "at the head it would read short");
});

test("a stuck send: its replacement beats both fees by 12.5%, and new work goes after every open nonce", async () => {
  const { bumpFees, nextNonce } = await import("../lib/tx.mjs");
  const g = (n) => BigNumber.from(n).mul(1e9);
  const old = { maxPriorityFeePerGas: g(1), maxFeePerGas: g(40) };
  const low = bumpFees(old, { maxPriorityFeePerGas: g(1), maxFeePerGas: g(30) });
  assert.ok(low.maxPriorityFeePerGas.mul(10_000).gte(old.maxPriorityFeePerGas.mul(11_250)));
  assert.ok(low.maxFeePerGas.mul(10_000).gte(old.maxFeePerGas.mul(11_250)));
  const high = bumpFees(old, { maxPriorityFeePerGas: g(3), maxFeePerGas: g(90) });
  assert.ok(high.maxFeePerGas.eq(g(90)) && high.maxPriorityFeePerGas.eq(g(3)), "the market's own fee when that is higher");
  assert.equal(nextNonce(7, [7]), 8, "the read node cannot see a private send: never reuse its nonce");
  assert.equal(nextNonce(9, [7]), 9);
  assert.equal(nextNonce(7, [7, 8]), 9);
});
