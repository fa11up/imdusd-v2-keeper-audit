// Wave-4 judge proofs (imdusd/imdusd-v2-keeper-audit e53d362, job ae48df88), verbatim: each asserts the CORRECT behaviour,
// so each FAILED on e53d362. Kept as regression tests; the property tests are in test/w4-*.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, providers, utils, Wallet } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-judge-"));
const { readState, writeState, statePath, takeLock } = await import("../lib/state.mjs");
const { advanceOrders, buyHold, lostOrders, loadOrders, spentToday, startOrder } = await import("../lib/orders.mjs");
const { planeClient, signPayment, IMD } = await import("../lib/x402.mjs");
const { guardedSigner, send } = await import("../lib/tx.mjs");
const { recordIntent, pendingIntents } = await import("../lib/journal.mjs");
const { runDepth } = await import("../lib/depth.mjs");
const { fallDecision } = await import("../lib/feeds.mjs");
const { plane, nhiFromSwarm } = await import("../lib/plane.mjs");
const { makeAlerts } = await import("../lib/alerts.mjs");
const { runWatch } = await import("../lib/watch.mjs");
const { bodyOf, buildInput, questionHash } = await import("../lib/oracle.mjs");
const { makeMockPlane } = await import("./lib/mock-plane.mjs");

const E18 = BigNumber.from(10).pow(18);
const P = E18.div(250);
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ATTESTER = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
const PAY_TO = "0x4e0fa57bde726079356537e2f34d671e9f41adbc";
const holdCtx = () => ({ cfg: {}, planeState: { ok: true }, signer: { address: "0x00000000000000000000000000000000000000ee" },
  provider: { getBalance: async () => E18, getGasPrice: async () => BigNumber.from(10).pow(9) }, book: { token: () => ({ balanceOf: async () => E18.mul(50) }) } });
const reset = () => { for (const f of ["orders.json", "imd-spend.json", "STOP", "alerts.json", "depth.json", "feeds.json"]) rmSync(statePath(f), { force: true }); };

async function flow() {
  reset();
  const clock = { number: 1000, timestamp: 1_800_000_000, hash: `0x${"11".repeat(32)}` };
  const mock = makeMockPlane({ answer: () => ({ value: P }), chain: async () => clock, attesterKey: ATTESTER });
  const base = await mock.listen();
  const wallet = new Wallet(KEY);
  const provider = { getBlock: async () => ({ number: clock.number, timestamp: clock.timestamp }), getBalance: async () => E18, getGasPrice: async () => BigNumber.from(10).pow(9), unpin() {} };
  const leafAddr = "0x00000000000000000000000000000000000000a1";
  const leaf = { address: leafAddr, MIN_PANEL_SIZE: async () => 100, minAgreed: async () => 67, expectedQuestionHash: async (a, b) => questionHash(bodyOf("price"), Number(a), Number(b)) };
  const token = { balanceOf: async () => E18.mul(50), allowance: async () => E18.mul(50) };
  const signer = { address: wallet.address, provider, _signTypedData: (...a) => wallet._signTypedData(...a) };
  process.env.PLANE_BEARER = "local-test-bearer";
  const ctx = { execute: true, cfg: { PLANE: { payTo: PAY_TO } }, provider, signer, keeperAddress: wallet.address, log() {}, planeState: { ok: true, base },
    planeClient: planeClient(base, "local-test-bearer"), book: { token: () => token, leaf: () => leaf }, alerts: { raise: async () => {} } };
  const input = await buildInput(leaf, "price");
  return { ctx, mock, input, leafAddr, close: () => mock.close() };
}
// Findings not yet fixed on this branch: their proofs run as `todo` (reported, never failing the suite) until the commit that fixes them.
const OPEN = new Set([]); // every finding is fixed: all twelve proofs run as ordinary tests
const jtest = (name, fn) => test(name, OPEN.has(name.split(" ")[0]) ? { todo: "fixed in a later commit" } : {}, fn);
const rounds = async (ctx, n) => { for (let i = 0; i < n; i++) await advanceOrders(ctx); };


jtest("J1 C9: a corrupt orders.json / imd-spend.json must not read as nothing held / nothing spent", async () => {
  reset(); process.env.PLANE_BEARER = "x";
  writeState("orders.json", { list: [{ key: "k", purpose: "fall", stage: "refused-paid", planeOrder: "o1" }] });
  writeState("imd-spend.json", { day: new Date().toISOString().slice(0, 10), imd: utils.parseEther("5").toString() });
  assert.match(await buyHold(holdCtx(), E18.div(2)), /refused a paid order/);
  writeFileSync(statePath("orders.json"), '{"list":[{"key":"k","stage":"refused-paid"');
  writeFileSync(statePath("imd-spend.json"), "\u0000garbage");
  const hold = await buyHold(holdCtx(), E18.div(2));
  // Adapted (message only): the original message called spentToday()/lostOrders() eagerly, which now throw StateUnreadable by design.
  assert.notEqual(hold, null, "ACTUAL: buyHold=null");
  assert.throws(() => spentToday(), /cannot be read/);
  assert.throws(() => lostOrders(), /cannot be read/);
});

jtest("J4 P3: real guardedSigner.bump on a never-mined urgent send: fees stay under MAX_GAS_GWEI", async () => {
  reset();
  for (const f of pendingIntents()) rmSync(statePath(`tx/${f.nonce}.json`), { force: true });
  let relayed = 0;
  providers.StaticJsonRpcProvider.prototype.sendTransaction = async (signed) => { relayed += 1; return { hash: utils.keccak256(signed) }; };
  const gwei = (n) => utils.parseUnits(String(n), "gwei");
  const provider = { getBlock: async () => ({ baseFeePerGas: gwei(10) }), getTransactionReceipt: async () => null, getTransactionCount: async () => 5, getGasPrice: async () => gwei(10), getBalance: async () => E18 };
  const cfg = { SEND_RPC_URLS: ["https://relay.invalid"], MAX_GAS_GWEI: 100, URGENT_WAIT_SECONDS: 60 };
  const w = guardedSigner(new Wallet(KEY), provider, cfg, "tx");
  const signed = await w.signTransaction({ type: 2, chainId: 1, nonce: 5, to: PAY_TO, data: "0x", value: 0, gasLimit: 300000, maxPriorityFeePerGas: gwei(0.3), maxFeePerGas: gwei(20.3) });
  recordIntent({ nonce: 5, hash: utils.keccak256(signed), signed, label: "bite SIMD #1" });
  const proxy = { provider, address: w.address, rebroadcast: w.rebroadcast, bump: w.bump, journalScope: "tx" };
  const timeout = () => ({ hash: "0xnew", wait: async () => { const e = new Error("t"); e.code = "TIMEOUT"; throw e; } });
  for (let pass = 0; pass < 60; pass++) {
    const p = statePath("tx/5.json"); const it = JSON.parse(readFileSync(p, "utf8")); it.at = new Date(Date.now() - 61_000).toISOString(); writeFileSync(p, JSON.stringify(it));
    await send(proxy, "bite SIMD #1", async () => {}, async () => timeout(), cfg, { tier: "urgent" });
  }
  const t = utils.parseTransaction(JSON.parse(readFileSync(statePath("tx/5.json"), "utf8")).signed);
  const max = Number(utils.formatUnits(t.maxFeePerGas, "gwei")), tip = Number(utils.formatUnits(t.maxPriorityFeePerGas, "gwei"));
  assert.ok(max <= 100, `ACTUAL after 60 urgent passes: nonce 5 tip ${tip.toFixed(1)} gwei, maxFee ${max.toFixed(1)} gwei (MAX_GAS_GWEI 100), ${relayed} signed txs relayed, still open`);
});

jtest("J2 C8: 'expired' on a LOST (paid, never admitted) order must not release the hold", async () => {
  const f = await flow();
  try {
    f.mock.state.admit = false;
    startOrder("fall", [{ role: "price", leaf: f.leafAddr, input: f.input }]);
    await rounds(f.ctx, 2);
    assert.equal(f.mock.state.payments.length, 1);
    const list = loadOrders(); list[0].paidAt = new Date(Date.now() - 2 * 3600_000).toISOString(); writeState("orders.json", { list });
    await advanceOrders(f.ctx);
    assert.equal(lostOrders().length, 1, "lost: held");
    f.mock.state.orders.get(list[0].planeOrder).status = "expired";
    await advanceOrders(f.ctx);
    startOrder("fall", [{ role: "price", leaf: f.leafAddr, input: f.input }]);
    await rounds(f.ctx, 3);
    assert.equal(f.mock.state.payments.length, 1, `ACTUAL: lost=${lostOrders().length}, payments=${f.mock.state.payments.length}`);
  } finally { await f.close(); }
});

jtest("J3 C7: a failed read in the depth round leaves the hour open", async () => {
  reset();
  const now = 20_000 * 86_400 + 3600;
  writeState("depth.json", { hour: Math.floor(now / 3600), at: now - 1, done: false });
  const sent = [];
  const c = (name, fn) => { const x = { address: `0x${name}`, callStatic: { [fn]: async () => {} }, [fn]: async () => { sent.push(name); return { hash: "0x1", wait: async () => ({ blockNumber: 1, gasUsed: 1 }) }; }, interface: { encodeFunctionData: (f) => f } }; x.connect = () => x; return x; };
  const multicall = c("batch", "aggregate3"); multicall.callStatic.aggregate3 = async () => { throw new Error("read RPCs disagree on call at 1"); };
  const provider = { getBlock: async () => ({ number: 1, timestamp: now, baseFeePerGas: 1n }), getStorageAt: async () => "0x0", getGasPrice: async () => BigNumber.from(1), getBalance: async () => E18, unpin() {} };
  const imdDepth = { ...c("poke", "poke"), lowOf: async () => ({ day: 20_000 }) }; imdDepth.connect = () => imdDepth;
  await runDepth({ execute: true, log() {}, provider, multicall, cfg: {}, signer: { provider, address: "0xk" }, book: { imdDepth, samplers: [c("sampler", "sample")] }, alerts: { raise: async () => {} } });
  assert.deepEqual(sent, ["poke"]);
  assert.equal(readState("depth.json").done, false, "ACTUAL: done=true after a failed read, no samples this hour");
});

jtest("J8 Q4: fallDecision measures from Pricer.quote().low (unconverged median within skew; stale spot)", () => {
  const base = { skewBps: 500, triggerBps: 500, atRisk: true, lastBuyAt: 0, now: 1, minGapSeconds: 0, hadOpenOrder: false };
  // (a) median 100 not converged, spot 98 (within 5%): Pricer agree=false -> twin rule low = max = 100. pool 94 is 6% under it.
  // Adapted: fallDecision now takes the Pricer's quote as read on chain (`quote`, `live`); here the Pricer's low as the finding states it.
  const a = fallDecision({ ...base, median: P, spot: P.mul(98).div(100), pool: P.mul(94).div(100), quote: { priced: true, low: P }, live: P.mul(94).div(100) });
  // (b) proven spot 120 STALE, median 100: Pricer low = m = 100. pool 110 is a rise.
  const b = fallDecision({ ...base, median: P, spot: P.mul(120).div(100), pool: P.mul(110).div(100), quote: { priced: true, low: P }, live: P.mul(110).div(100) });
  assert.deepEqual([a.kind, b.kind], ["buy", "no-fall"], `ACTUAL: (a) ${a.kind}, (b) ${b.kind}`);
});

jtest("J5 P4: a failed converged() read keeps feeds-not-converged-median (alerts.settle path)", async () => {
  // Adapted: the original called alerts.settle('feeds-', {}) itself, simulating runFeeds line 192, so it clears by construction.
  // This drives runFeeds over the same state: alerts.json holds the key, and this pass's converged() read throws.
  reset();
  const { feedsWorld } = await import("./lib/feeds-world.mjs");
  const logs = []; const a = makeAlerts((s) => logs.push(s));
  await a.raise("warn", "feeds-not-converged-median", "held short");
  const w = feedsWorld();
  w.fail = new Set(["median.converged"]);
  const { runFeeds } = await import("../lib/feeds.mjs");
  await runFeeds(w.ctx(a));
  assert.ok(!logs.some((l) => /feeds-not-converged-median: cleared/.test(l)), `ACTUAL: ${logs.join(" | ")}`);
});

jtest("J9 P4: the watch pass must not clear the depth loop's proof alerts", async () => {
  reset();
  const logs = []; const alerts = makeAlerts((s) => logs.push(s));
  await alerts.raise("warn", "depth-proof-failed-0xabc", "proof failed");
  await alerts.raise("warn", "depth-prove-now-failed", "prove failed");
  const ts = Math.floor(Date.now() / 1000);
  const provider = { getBlock: async () => ({ number: 1, timestamp: ts }), getBalance: async () => E18, unpin() {} };
  const Z = BigNumber.from(0);
  const book = { ilks: [], samplers: [], ledger: { unbacked: async () => Z }, liquidator: { edgeInAuction: async () => Z },
    params: { RETIRE_SLEEVE_TOKEN: async () => 1, pendingOf: async () => ({ payload: "0x", eta: Z }), depthIMD: async () => Z },
    imdDepth: { lowOf: async () => ({ day: 0, usd: 0 }) } };
  try { await runWatch({ book, cfg: {}, provider, log() {}, alerts }); } catch (e) { logs.push(`watch threw: ${e.message}`); }
  assert.ok(!logs.some((l) => /depth-prov.*cleared/.test(l)), `ACTUAL: ${logs.filter((l) => /cleared|threw/.test(l)).join(" | ")}`);
});

jtest("J6 C6: a quiet plane whose newest 3 settled requests are a month-old 'blocked' must not hold buying for ever", async () => {
  const recent = { requests: [1, 2, 3].map(() => ({ status: "blocked", createdAt: new Date(Date.now() - 30 * 86400_000).toISOString() })) };
  const fetchImpl = async (url) => ({ ok: true, json: async () => (String(url).endsWith("/health") ? { status: "ok" } : recent) });
  const r = await plane(null, { API_BASE: "https://plane.test", PLANE: { useEns: false, holdAfterBlocked: 3 } }, fetchImpl);
  assert.equal(r.ok, true, `ACTUAL: ${r.why}`);
});

jtest("J7 P3: a second process on the same key with another STATE_DIR is refused", async () => {
  // Adapted: the lock is per KEY, taken by --execute with the signer's address (takeKeyLock), beside the per-dir lock; the second
  // "process" is a child node process, since one process may hold its own key lock for several contexts.
  const { takeKeyLock } = await import("../lib/state.mjs");
  const { execFileSync } = await import("node:child_process");
  const saved = process.env.STATE_DIR;
  process.env.KEEPER_LOCK_DIR = mkdtempSync(join(tmpdir(), "kl-"));
  const addr = new Wallet(KEY).address;
  process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "ka-")); const ra = takeLock(); const rk = takeKeyLock(addr);
  const dirB = mkdtempSync(join(tmpdir(), "kb-"));
  let refused = false;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", `const s = await import(${JSON.stringify(new URL("../lib/state.mjs", import.meta.url).href)}); s.takeLock(); s.takeKeyLock(${JSON.stringify(addr)});`], { env: { ...process.env, STATE_DIR: dirB }, stdio: "pipe" });
  } catch { refused = true; }
  ra(); rk(); process.env.STATE_DIR = saved;
  assert.ok(refused, "ACTUAL: both locks taken; each dir has its own spend ledger and nonce journal");
});

jtest("J10 P2: pay()'s last-moment re-check keeps reserveForFalls for a seat order", async () => {
  const f = await flow();
  try {
    writeState("imd-spend.json", { day: new Date().toISOString().slice(0, 10), imd: utils.parseEther("4").toString() });
    startOrder("seats", [{ role: "seatMedian", leaf: f.leafAddr, input: f.input }, { role: "seatSpot", leaf: f.leafAddr, input: f.input }]);
    await rounds(f.ctx, 2);
    assert.equal(f.mock.state.payments.length, 0, `ACTUAL: paid ${f.mock.state.payments.length}, spent today ${utils.formatEther(spentToday())} of 5 IMD (reserve 1 gone)`);
  } finally { await f.close(); }
});

jtest("J11 P2: the Permit2 deadline is bounded by the keeper, not the plane's maxTimeoutSeconds", async () => {
  const ch = { resource: {}, resourceUrl: "", requesterScopeHash: "ab".repeat(32), accepts: [{ scheme: "exact", network: "eip155:1", amount: "500000000000000000", asset: IMD, payTo: PAY_TO, maxTimeoutSeconds: 10 * 365 * 86400 }],
    quote: { id: "q", quoteHash: "cd".repeat(32), action: "oracle.request", expiresAt: 1, payment: { network: "eip155:1", asset: IMD, amount: "500000000000000000", payTo: PAY_TO } } };
  const { paymentHeader } = await signPayment(new Wallet(KEY), ch);
  const dl = Number(JSON.parse(Buffer.from(paymentHeader, "base64").toString()).payload.permit2Authorization.deadline);
  assert.ok(dl - Date.now() / 1000 <= 3600, `ACTUAL: permit valid for ${Math.round((dl - Date.now() / 1000) / 86400)} days`);
});

jtest("J12 P1: a /swarm document with a negative count yields an index in [0, 1e18]", () => {
  // Adapted: the fix REFUSES the document (throws; readLiveNhi then reads null, nothing bought) rather than clamping it.
  let v = null;
  try { v = nhiFromSwarm({ health: { agentsOnline: -100, seatsEnrolled: 10, verifierUp: true, publisherUp: true, deployerUp: true }, counts: { jobStates: { completed: 1 } } }); } catch { v = null; }
  assert.ok(v === null || v >= 0n, `ACTUAL: ${v} (S.nhi.accepts(${v}) then throws 'value out-of-bounds' inside decideNhi, before decideFall and proveNow)`);
});
