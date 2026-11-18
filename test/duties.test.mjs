import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, providers, utils, Wallet } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-duties-"));
const { convergenceAlert, fallDecision, imdAlerts, loansAtRisk, nhiDecision, provenSpotAlert, underMargin } = await import("../lib/feeds.mjs");
const { bodyOf, buildInput, guardsFor, leafProblems, preflightAttestation, questionHash, stepsNeeded } = await import("../lib/oracle.mjs");
const { advanceOrders, buyHold, childrenOf, clearLost, loadOrders, lostOrders, openOrders, spendAllows, spentToday, startOrder } = await import("../lib/orders.mjs");
const { challengeProblem, planeClient, signPayment, IMD } = await import("../lib/x402.mjs");
const { nhiFromSwarm } = await import("../lib/plane.mjs");
const { auctionStep, seatLegsDue, seatPokeNeeded } = await import("../lib/seats.mjs");
const { pegPlan, sweepDue, twapPushAlert } = await import("../lib/peg.mjs");
const { convertPlan, needsRealize, roomAlerts } = await import("../lib/backstop.mjs");
const { heldConditions, logConditions, offPool } = await import("../lib/guardian.mjs");
const { auctionKey, collateralAuctionStep, saleAmount, sleeveLevelNow, unsoldWatch } = await import("../lib/allocator.mjs");
const { refuseGuardianKey } = await import("../lib/tx.mjs");
const { pendingIntents, recordIntent, signedHashes } = await import("../lib/journal.mjs");
const { reportStateDir, stateDir, takeLock, writeState, statePath } = await import("../lib/state.mjs");
const { makeMockPlane } = await import("./lib/mock-plane.mjs");

const E18 = BigNumber.from(10).pow(18);
const P = E18.div(250); // 0.004 ETH per IMD

// ---------------------------------------------------------------- the frozen questions

// keccak of the document the leaves pin for window [26000000, 26000600], from the hex prefixes in the contracts' src/feeds/SwarmFeeds.sol (the fork test asks the deployed leaves too).
const PINNED = JSON.parse(readFileSync(new URL("./question-hashes.json", import.meta.url), "utf8"));
test("bodies: each hashes to the question its leaf pins", () => {
  for (const [role, hash] of Object.entries(PINNED)) assert.equal(questionHash(bodyOf(role), 26_000_000, 26_000_600), hash, role);
});

const fakeLeaf = (expected, over = {}) => ({
  address: "0xAbCdEf0000000000000000000000000000000001",
  expectedQuestionHash: async () => expected, attestationChainId: async () => 1, attestationAnswerType: async () => 3, MIN_PANEL_SIZE: async () => 100, minAgreed: async () => 67, ...over,
});

test("a leaf whose expectedQuestionHash disagrees with the payload is a problem before anything is paid", async () => {
  assert.deepEqual(await leafProblems(fakeLeaf(PINNED.price), "price"), []);
  const out = await leafProblems(fakeLeaf(PINNED.spot), "price");
  assert.equal(out.length, 1);
  assert.match(out[0], /every answer would be refused/);
});

test("the sent body: frozen question, the leaf as lowercase consumer, its own floors as the panel", async () => {
  const input = await buildInput(fakeLeaf(PINNED.price), "price", { guards: { min: "1", max: "2" } });
  assert.deepEqual(input.consumer, { chainId: 1, verifyingContract: "0xabcdef0000000000000000000000000000000001" });
  assert.equal(input.panelSize, 100);
  assert.equal(input.quorum, 67);
  assert.deepEqual(input.guards, { min: "1", max: "2" });
  assert.equal(questionHash(input, 26_000_000, 26_000_600), PINNED.price, "what changes per purchase is not in the hash");
});

test("guards hold the leaf's band and the answer we expect, and a gap counts its steps", () => {
  assert.deepEqual(guardsFor(1000n * 10n ** 12n, 2000, [900n * 10n ** 12n]), { min: "800000000000000", max: "1200000000000000" });
  const g = guardsFor(1000n * 10n ** 12n, 2000, [700n * 10n ** 12n]);
  assert.equal(g.min, "686000000000000", "an answer past the band still lies inside the guards: `accepts` decides, not the guards");
  assert.equal(stepsNeeded(P, P.mul(50).div(100), 2000), 4, "halving at 20% a step");
  assert.equal(stepsNeeded(P, P.mul(90).div(100), 2000), 1);
});

// ---------------------------------------------------------------- buy / no buy: the price (design C: the spot is proven, not bought)

// Audit wave 4 Q4: the reference is Pricer.quote().low, read on chain; here the Pricer's own rule (test/lib/pricer-model.mjs) stands in,
// with converged, fresh, proven legs and the live leg = the pool (one unit).
const { pricerLow } = await import("./lib/pricer-model.mjs");
const fall = (x = {}) => {
  const a = { median: P, spot: P, pool: P.mul(90).div(100), skewBps: 500, triggerBps: 500, atRisk: true, lastBuyAt: 0, now: 100_000, minGapSeconds: 1800, hadOpenOrder: false, ...x };
  const q = pricerLow({ m: a.median.toString(), s: a.spot.toString(), skewBps: a.skewBps });
  return fallDecision({ quote: { priced: q.priced, low: q.low.toString() }, live: a.pool, ...a });
};

test("falls buy; rises and flat never do, stale or not", () => {
  assert.equal(fall().buy, true);
  assert.equal(fall({ pool: P.mul(120).div(100) }).kind, "no-fall", "a rise");
  assert.equal(fall({ pool: P }).kind, "no-fall", "flat, though the legs may be stale");
  assert.equal(fall({ pool: P.mul(96).div(100) }).kind, "no-fall", "under the trigger");
  assert.equal(fall({ pool: P.mul(95).div(100) }).buy, true, "exactly the trigger is not above it: 5% buys");
});

test("a fall with nothing at risk buys nothing", () => {
  assert.equal(fall({ atRisk: false }).kind, "no-risk");
});

test("the reference is what loans are measured at: the lower leg within skew, the HIGHER leg once apart (design C twin rule)", () => {
  const within = fall({ median: P, spot: P.mul(97).div(100), pool: P.mul(94).div(100) });
  assert.equal(within.kind, "no-fall", "3% under the lower leg");
  const apart = fall({ median: P, spot: P.mul(80).div(100), pool: P.mul(85).div(100) });
  assert.equal(apart.buy, true, "legs apart, median above an unclamped (attested) median: loans are measured at the median (max(s, min(m, attested)) = m), 15% above the pool");
  const spotHigh = fall({ median: P.mul(80).div(100), spot: P, pool: P.mul(85).div(100) });
  assert.equal(spotHigh.buy, true, "a stale-low median under a proven spot: loans are measured at the proven spot, 15% above the pool");
});

test("design C: a fall wider than the allowance is still bought (the leaf clamps, never refuses)", () => {
  assert.equal(fall({ pool: P.mul(40).div(100) }).buy, true, "a 60% fall");
});

test("design C: a leg short of its last answer raises a not-converged warning", () => {
  assert.equal(convergenceAlert({ role: "median", converged: true, stored: "1", attested: "1" }), null);
  const a = convergenceAlert({ role: "median", converged: false, stored: "8", attested: "5" });
  assert.equal(a.key, "feeds-not-converged-median");
  assert.equal(a.level, "warn");
});

test("an empty leaf is the deployment's: never bought", () => {
  assert.equal(fall({ median: 0 }).kind, "unseeded");
  assert.equal(fall({ spot: 0 }).kind, "unseeded");
});

test("one order at a time, and a gap between buys", () => {
  assert.equal(fall({ hadOpenOrder: true }).kind, "open");
  assert.equal(fall({ lastBuyAt: 99_000 }).kind, "wait");
  assert.equal(fall({ lastBuyAt: 98_200 }).buy, true);
});

test("dust does not count as at risk; the margin is mat + 10% at the pool price", () => {
  const mat = utils.parseEther("1.7");
  const price = utils.parseEther("10");
  const loan = (debt, coll) => ({ debt: E18.mul(debt), collateral: E18.mul(coll) });
  const opts = { price, mat, minDebt: E18.mul(15), marginBps: 1000 };
  assert.equal(loansAtRisk([loan(14, 1)], opts).length, 0, "14 imdUSD is dust however thin");
  assert.equal(loansAtRisk([loan(15, 1)], opts).length, 1, "15 is not: 10 of value vs 28");
  assert.equal(underMargin({ debt: E18.mul(100), collateral: E18.mul(19), price, mat }), false, "190 is over 187");
  assert.equal(underMargin({ debt: E18.mul(100), collateral: E18.mul(18), price, mat }), true, "180 < 187");
  assert.equal(underMargin({ debt: E18.mul(100), collateral: E18.mul(19), price, mat, marginBps: 0 }), false, "190 >= 170");
});

// ---------------------------------------------------------------- NHI

const nhi = (x = {}) => nhiDecision({ value: E18, age: 23 * 3600, refreshAfter: 22 * 3600, debt: E18, acceptsLive: true, hadOpenOrder: false, ...x });
test("NHI: daily, only while sIMD debt exists, never an answer the leaf would refuse", () => {
  assert.equal(nhi().buy, true);
  assert.equal(nhi({ debt: 0 }).kind, "no-debt");
  assert.equal(nhi({ age: 3600 }).kind, "fresh");
  assert.equal(nhi({ acceptsLive: false }).kind, "gap");
  assert.equal(nhi({ acceptsLive: null }).kind, "no-read");
  assert.equal(nhi({ value: 0 }).kind, "unseeded");
  assert.equal(nhi({ hadOpenOrder: true }).kind, "open");
  assert.equal(nhi({ age: Infinity }).buy, true, "long stale still buys: debt exists");
});

test("NHI index matches the body's arithmetic", () => {
  const v = nhiFromSwarm({ health: { agentsOnline: 5, seatsEnrolled: 10, verifierUp: true, publisherUp: true, deployerUp: false }, counts: { jobStates: { completed: 3, blocked: 1, cancelled: 0 } } });
  const p = 5n * 10n ** 17n, s = (2n * 10n ** 18n) / 3n, r = (3n * 10n ** 18n) / 4n;
  assert.equal(v, (4n * p + 3n * s + 3n * r) / 10n);
});

// ---------------------------------------------------------------- spend + IMD alerts

test("the spend cap: a question over it never starts", () => {
  assert.equal(spendAllows(0, utils.parseEther("1"), 5), true);
  assert.equal(spendAllows(utils.parseEther("4"), utils.parseEther("1"), 5), true);
  assert.equal(spendAllows(utils.parseEther("4.5"), utils.parseEther("1"), 5), false);
  assert.equal(spendAllows(utils.parseEther("3.5"), utils.parseEther("1"), 5, utils.parseEther("1")), false, "seat legs leave the last pair for a fall");
});

test("low IMD alerts", () => {
  const keys = (b, inUse = true) => imdAlerts({ balance: utils.parseEther(String(b)), warnImd: 5, needImd: 1, inUse }).map((a) => `${a.level}:${a.key}`);
  assert.deepEqual(keys(6), []);
  assert.deepEqual(keys(4), ["warn:feeds-imd-low"]);
  assert.deepEqual(keys(0.5), ["critical:feeds-imd-empty"]);
  assert.deepEqual(keys(0.5, false), ["warn:feeds-imd-low"], "before there is anything to pay for it is only a warning");
});

test("a challenge asking more than the price, or not IMD, or short per question, is refused", () => {
  const PAY = "0x4e0fa57bde726079356537e2f34d671e9f41adbc";
  const ch = (amount, asset = IMD, x = {}) => ({ accepts: [{ amount, payTo: PAY, ...x }], quote: { payment: { asset, amount, payTo: PAY } } });
  const challengeProblemAt = challengeProblem;
  const challengeProblem_ = (c, n, u) => challengeProblemAt(c, n, u, PAY);
  const unit = utils.parseEther("0.5");
  assert.equal(challengeProblem_(ch(unit.mul(2).toString()), 2, unit), null);
  assert.match(challengeProblem_(ch(unit.mul(3).toString()), 2, unit), /over the limit/);
  assert.match(challengeProblem_(ch(unit.toString(), "0x1111111111111111111111111111111111111111"), 1, unit), /not IMD/);
  assert.match(challengeProblem_(ch("1000000000000000001"), 2, unit), /over the limit/);
  assert.match(challengeProblem_(ch("999999999999999999"), 2, unit), /does not divide/);
  assert.match(challengeProblem_({}, 1, unit), /no payment terms/);
  // Whoever answers as the plane must not choose who is paid, or slip a second amount past the check.
  assert.match(challengeProblem_(ch(unit.toString(), IMD, { payTo: "0x000000000000000000000000000000000000dEaD" }), 1, unit), /not the pinned/);
  assert.match(challengeProblemAt(ch(unit.toString()), 1, unit, undefined), /no pinned payTo/);
  assert.match(challengeProblem_(ch(unit.toString(), IMD, { amount: 0 }), 1, unit), /amounts disagree/);
  assert.match(challengeProblem_(ch("0"), 1, unit), /asks for nothing/);
  assert.match(challengeProblem_(ch(unit.toString(), IMD, { network: "eip155:8453" }), 1, unit), /not Ethereum/);
});

test("the x402 port signs byte for byte what the production sender signs", async () => {
  const v = JSON.parse(readFileSync(new URL("./x402-vector.json", import.meta.url), "utf8"));
  const r = await signPayment(new Wallet(v.key), v.challenge, { nonce: v.nonce, deadline: v.deadline });
  assert.equal(r.paymentHeader, v.paymentHeader);
  assert.equal(r.quoteSignature, v.quoteSignature);
  assert.equal(r.amount.toString(), v.amount);
});

test("admissions: a group's children in order, a single, a refusal", () => {
  assert.deepEqual(childrenOf({ admission: { result: { kind: "oracle-group", requests: [{ requestId: "a" }, { requestId: "b" }] } } }), ["a", "b"]);
  assert.deepEqual(childrenOf({ admission: { result: { kind: "oracle", requestId: "a" } } }), ["a"]);
  assert.ok(childrenOf({ admission: { result: { kind: "refused", problems: [1] } } }).refused);
  assert.equal(childrenOf({ admission: null }), null);
});

// ---------------------------------------------------------------- the paid flow against the mock plane, with fake contracts

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ATTESTER = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

async function flow({ answer = () => ({ value: P }), imd = E18.mul(50), allowance = E18.mul(50), reset = true } = {}) {
  if (reset) for (const f of ["orders.json", "imd-spend.json", "STOP", "journal.jsonl"]) rmSync(statePath(f), { force: true });
  const clock = { number: 1000, timestamp: 1_800_000_000, hash: `0x${"11".repeat(32)}` };
  const mock = makeMockPlane({ answer, chain: async () => clock, attesterKey: ATTESTER });
  const base = await mock.listen();
  const wallet = new Wallet(KEY);
  const provider = {
    getBlock: async () => ({ number: clock.number, timestamp: clock.timestamp }),
    getBalance: async () => E18, getGasPrice: async () => BigNumber.from(10).pow(9),
    unpin() {},
  };
  const relays = [];
  const leafAddr = "0x00000000000000000000000000000000000000a1";
  const leaf = {
    address: leafAddr, attester: async () => mock.attesterAddress, attestationChainId: async () => 1, attestationAnswerType: async () => 3, maxAge: async () => 3600,
    usedRequests: async () => false, DOMAIN_SEPARATOR: async () => utils._TypedDataEncoder.hashDomain({ name: "IdentityMD Oracle", version: "2", chainId: 1, verifyingContract: leafAddr }),
    MIN_PANEL_SIZE: async () => 100, minAgreed: async () => 67, latestValue: async () => ({ value: E18, updatedAt: 0 }), lastToBlock: async () => 0,
    expectedQuestionHash: async (from, to) => questionHash(bodyOf("price"), Number(from), Number(to)), accepts: async () => true,
    callStatic: { submitAttestation: async () => {} },
    submitAttestation: async (...a) => { relays.push(a); return { hash: `0x${"22".repeat(32)}`, wait: async () => ({ blockNumber: 1, gasUsed: 1 }) }; },
    connect() { return this; },
  };
  const token = { balanceOf: async () => imd, allowance: async () => allowance, approve: async () => { throw new Error("no approve expected"); } };
  const signer = Object.assign(Object.create(null), { address: wallet.address, provider, _signTypedData: (...a) => wallet._signTypedData(...a) });
  const logs = [];
  const raised = [];
  process.env.PLANE_BEARER = "local-test-bearer";
  const ctx = {
    execute: true, cfg: { PLANE: { payTo: "0x4e0fa57bde726079356537e2f34d671e9f41adbc" } }, provider, signer, keeperAddress: wallet.address, log: (s) => logs.push(s), planeState: { ok: true, base },
    planeClient: planeClient(base, "local-test-bearer"),
    book: { token: () => token, leaf: () => leaf },
    alerts: { raise: async (l, k, m) => raised.push(`${l}:${k}: ${m}`) },
  };
  const input = await buildInput(leaf, "price");
  const start = () => startOrder("fall", [{ role: "price", leaf: leafAddr, input }, { role: "spot", leaf: leafAddr, input: { ...input, question: `${input.question} x` } }]);
  return { ctx, mock, start, relays, raised, logs, clock, close: () => mock.close() };
}
const rounds = async (ctx, n) => { for (let i = 0; i < n; i++) await advanceOrders(ctx); };

test("order: quote, pay once, admitted, both answers relayed, done", async () => {
  const f = await flow();
  f.start();
  await rounds(f.ctx, 4);
  assert.equal(f.mock.state.quotes, 1);
  assert.equal(f.mock.state.payments.length, 1, "one payment");
  assert.equal(f.mock.state.payments[0].amount, utils.parseEther("1").toString(), "0.5 per question");
  assert.equal(spentToday().toString(), utils.parseEther("1").toString());
  // The second question's text differs from the leaf's, so only the first relays.
  assert.equal(f.relays.length, 1);
  assert.deepEqual(openOrders(), [], f.logs.join("\n"));
  await f.close();
});

test("crash between the latch and the payment: the restart never pays; the order ends unpaid when the plane says so", async () => {
  const f = await flow();
  f.start();
  f.ctx.crashAfterLatch = true;
  await advanceOrders(f.ctx);
  assert.equal(loadOrders()[0].stage, "paying");
  assert.equal(f.mock.state.payments.length, 0, "the money never left");
  assert.equal(spentToday().toString(), utils.parseEther("1").toString(), "and it counts until known otherwise");
  f.ctx.crashAfterLatch = false;
  await rounds(f.ctx, 3); // a restart
  assert.equal(f.mock.state.payments.length, 0, "a latched order is only ever polled");
  const o = loadOrders()[0];
  f.mock.state.orders.get(o.planeOrder).status = "expired";
  // Audit wave 4 C8: the plane's word alone ends nothing. The chain's does: past the permit's deadline, its Permit2 nonce unused.
  f.ctx.permit2 = { nonceBitmap: async () => BigNumber.from(0) };
  f.clock.timestamp = o.permitDeadline - 10;
  await advanceOrders(f.ctx);
  assert.equal(loadOrders()[0].stage, "paying", "expired, says the plane, but the permit could still be taken: still open");
  f.clock.timestamp = o.permitDeadline + 1;
  await advanceOrders(f.ctx);
  assert.deepEqual(loadOrders(), [], "past the deadline, nonce unused on chain: nothing was charged, and it is over");
  await f.close();
});

test("restart after payment: never a second payment, and the answers still land", async () => {
  const f = await flow();
  f.mock.state.admit = false;
  f.start();
  await rounds(f.ctx, 2);
  assert.equal(f.mock.state.payments.length, 1);
  await rounds(f.ctx, 3);
  assert.equal(f.mock.state.payments.length, 1, "still one");
  assert.equal(f.mock.state.quotes, 1, "not even a new quote");
  await f.close();
});

test("paid and never admitted: lost, all buying held until the plane admits it or the owner clears it", async () => {
  const f = await flow();
  f.mock.state.admit = false;
  f.start();
  await rounds(f.ctx, 2);
  const list = JSON.parse(readFileSync(statePath("orders.json"), "utf8")).list;
  list[0].paidAt = new Date(Date.now() - 2 * 3600_000).toISOString();
  writeState("orders.json", { list });
  await advanceOrders(f.ctx);
  assert.equal(lostOrders().length, 1);
  assert.ok(f.raised.some((r) => r.startsWith("critical:feeds-order-lost")), f.raised.join("\n"));
  assert.match(await buyHold(f.ctx, E18), /never admitted/);
  assert.equal(clearLost(), 1);
  assert.equal(await buyHold(f.ctx, E18), null);
  await f.close();
});

test("refused after payment: all buying held until the owner clears it, so a repeat cannot spend the day's cap", async () => {
  const f = await flow();
  f.mock.state.refuseAfterPayment = true;
  f.start();
  await rounds(f.ctx, 3);
  assert.equal(f.mock.state.payments.length, 1, "paid once");
  assert.equal(lostOrders().length, 1);
  assert.equal(lostOrders()[0].stage, "refused-paid");
  assert.ok(f.raised.some((r) => r.startsWith("critical:feeds-order-refused-fall")), f.raised.join("\n"));
  assert.match(await buyHold(f.ctx, E18), /refused a paid order/);
  f.start(); // the same fall decided again
  await rounds(f.ctx, 3);
  assert.equal(f.mock.state.payments.length, 1, "held: no second payment");
  assert.equal(clearLost(), 1);
  assert.equal(await buyHold(f.ctx, E18), null);
  await f.close();
});

test("a lost order the plane admits after all picks up again", async () => {
  const f = await flow();
  f.mock.state.admit = false;
  f.start();
  await rounds(f.ctx, 2);
  const list = JSON.parse(readFileSync(statePath("orders.json"), "utf8")).list;
  list[0].stage = "lost";
  writeState("orders.json", { list });
  const o = f.mock.state.orders.get(list[0].planeOrder);
  const mockRequest = { requestId: "11111111-1111-4111-8111-111111111111" };
  o.admission = { result: { kind: "oracle-group", requests: [mockRequest, mockRequest] } };
  await advanceOrders(f.ctx);
  assert.equal(loadOrders()[0].stage, "admitted");
  assert.deepEqual(lostOrders(), []);
  await f.close();
});

test("the last-moment holds: kill switch, cap, balance, no bearer, failing plane", async () => {
  const f = await flow();
  assert.equal(await buyHold(f.ctx, E18), null);
  writeFileSync(statePath("STOP"), "");
  assert.match(await buyHold(f.ctx, E18), /kill switch/);
  f.start();
  await rounds(f.ctx, 2);
  assert.equal(f.mock.state.payments.length, 0, "STOP after the decision still stops the payment");
  rmSync(statePath("STOP"));
  writeState("imd-spend.json", { day: new Date().toISOString().slice(0, 10), imd: utils.parseEther("4.5").toString() });
  assert.match(await buyHold(f.ctx, E18), /the day's cap/);
  await rounds(f.ctx, 1);
  assert.equal(f.mock.state.payments.length, 0, "over the cap: the open order waits, unpaid");
  writeState("imd-spend.json", { day: "2000-01-01", imd: utils.parseEther("4.5").toString() });
  assert.equal(await buyHold(f.ctx, E18), null, "a new UTC day starts at zero");
  f.ctx.planeState = { ok: false, why: "blocked" };
  assert.match(await buyHold(f.ctx, E18), /plane: blocked/);
  f.ctx.planeState = { ok: true };
  delete process.env.PLANE_BEARER;
  assert.match(await buyHold(f.ctx, E18), /PLANE_BEARER/);
  process.env.PLANE_BEARER = "x";
  await f.close();
});

test("an order unpaid past its limit is dropped, not paid on its old decision", async () => {
  const f = await flow();
  writeFileSync(statePath("STOP"), "");
  f.start();
  await rounds(f.ctx, 1);
  rmSync(statePath("STOP"));
  const list = JSON.parse(readFileSync(statePath("orders.json"), "utf8")).list;
  assert.equal(list[0].stage, "quoted", "held at the last moment");
  list[0].at = new Date(Date.now() - 601_000).toISOString();
  writeState("orders.json", { list });
  await rounds(f.ctx, 1);
  assert.equal(f.mock.state.payments.length, 0);
  assert.equal(loadOrders().length, 0, "dropped, so the next round decides afresh");
  assert.equal(spentToday().toString(), "0");
  await f.close();
});

test("a plane asking more than the price is refused, unpaid", async () => {
  const f = await flow();
  await f.mock.close();
  const mock = makeMockPlane({ answer: () => ({ value: P }), chain: async () => f.clock, attesterKey: ATTESTER, price: utils.parseEther("0.6").toString() });
  const base = await mock.listen();
  f.ctx.planeClient = planeClient(base, "local-test-bearer");
  f.start();
  await rounds(f.ctx, 2);
  assert.equal(mock.state.payments.length, 0);
  assert.deepEqual(openOrders(), []);
  assert.ok(f.raised.some((r) => r.startsWith("critical:feeds-order-refused-fall")));
  await mock.close();
});

test("a panel under the leaf's floor is not relayed", async () => {
  const f = await flow({ answer: () => ({ value: P, agreed: 50 }) });
  f.start();
  await rounds(f.ctx, 4);
  assert.equal(f.relays.length, 0);
  assert.ok(f.raised.some((r) => /agreed 50 under the floor/.test(r)), f.raised.join("\n"));
  await f.close();
});

// ---------------------------------------------------------------- seats

const legs = (x = {}) => seatLegsDue({ median: E18, spot: E18, medianAge: 23 * 3600, spotAge: 23 * 3600, refreshAfter: 22 * 3600, line: E18, seats: 1, collateral: 0, debt: 0, hadOpenOrder: false, ...x });
test("seat legs: daily, only once the type is open with seats or debt", () => {
  assert.deepEqual(legs().legs, ["seatMedian", "seatSpot"]);
  assert.deepEqual(legs({ median: 0 }).legs, [], "unseeded");
  assert.deepEqual(legs({ line: 0 }).legs, [], "line 0 and no debt");
  assert.deepEqual(legs({ line: 0, debt: E18 }).legs, ["seatMedian", "seatSpot"], "debt keeps them going");
  assert.deepEqual(legs({ seats: 0 }).legs, [], "nothing pledged");
  assert.deepEqual(legs({ medianAge: 100 }).legs, ["seatSpot"], "one leg alone is one question");
  assert.deepEqual(legs({ medianAge: 100, spotAge: 100 }).legs, []);
  assert.deepEqual(legs({ hadOpenOrder: true }).legs, []);
});

const pokeArgs = { median: E18, medianAt: 100, capAt: 100, capRaw: E18, feedStale: false, usdNow: E18, ringDay: 7, today: 7 };
test("seat poke: after a new median, an equal-time replacement, or an empty day's slot; never for nothing", () => {
  assert.equal(seatPokeNeeded(pokeArgs), false);
  assert.equal(seatPokeNeeded({ ...pokeArgs, medianAt: 101 }), true);
  assert.equal(seatPokeNeeded({ ...pokeArgs, capRaw: E18.add(1) }), true);
  assert.equal(seatPokeNeeded({ ...pokeArgs, figure: 90, capFigureRaw: 150 }), true, "a replacement that changes only the figure");
  assert.equal(seatPokeNeeded({ ...pokeArgs, figure: 150, capFigureRaw: 150 }), false);
  assert.equal(seatPokeNeeded({ ...pokeArgs, ringDay: 6 }), true);
  assert.equal(seatPokeNeeded({ ...pokeArgs, ringDay: 6, feedStale: true }), false, "a stale feed writes no ring");
  assert.equal(seatPokeNeeded({ ...pokeArgs, median: 0, medianAt: 101 }), false);
});

const auc = { startAt: 50, isExpired: false, attestedAt: 100, medianAt: 100, healthy: false, priced: true, debt: E18 };
test("seat auctions: tick after a median, reopen when void and still under, cancel when healed", () => {
  assert.equal(auctionStep({ ...auc, startAt: 0 }), "none");
  assert.equal(auctionStep(auc), "none");
  assert.equal(auctionStep({ ...auc, medianAt: 101 }), "tick");
  assert.equal(auctionStep({ ...auc, isExpired: true }), "reopen");
  assert.equal(auctionStep({ ...auc, isExpired: true, healthy: true }), "cancel");
  assert.equal(auctionStep({ ...auc, healthy: true }), "cancel");
  assert.equal(auctionStep({ ...auc, debt: 0 }), "cancel");
  assert.equal(auctionStep({ ...auc, isExpired: true, priced: false }), "none", "void and unpriced waits for a median");
  assert.equal(auctionStep({ ...auc, priced: false, medianAt: 101 }), "tick");
  assert.equal(auctionStep({ ...auc, priced: false, ethStaleSinceTick: true }), "tick", "ETH/USD went stale after the last tick: record the gap");
  assert.equal(auctionStep({ ...auc, priced: false, ethStaleSinceTick: false }), "none", "already recorded");
  // audit wave 3: SeatFeed at 0 with both legs fresh.
  assert.equal(auctionStep({ ...auc, priced: false, readsZero: true, zeroAtTick: false }), "tick", "record that it reads 0");
  assert.equal(auctionStep({ ...auc, priced: false, readsZero: true, zeroAtTick: true }), "none", "already recorded");
  assert.equal(auctionStep({ ...auc, zeroAtTick: true }), "tick", "priced again: record it");
  assert.equal(auctionStep({ ...auc, sinceTick: 3600 }), "tick", "hourly while it runs");
  assert.equal(auctionStep({ ...auc, sinceTick: 3599 }), "none");
});

// ---------------------------------------------------------------- peg

const peg = (x = {}) => pegPlan({ twap: 0, spot: 0, outstanding: 0, buffer: 0, surplus: 0, bufferRoom: 0, cap: 0, quoteSound: true, ...x });
test("peg: the hook's gates", () => {
  assert.equal(peg({ twap: null }).withdraw, false);
  assert.equal(peg().provide, false);
  assert.equal(peg({ twap: 26, spot: 6, cap: 100 }).provide, true);
  assert.equal(peg({ twap: 25, spot: 6, cap: 100 }).provide, false, "in the band");
  assert.equal(peg({ twap: 26, spot: 5, cap: 100 }).provide, false, "spot back near the target");
  assert.equal(peg({ twap: 26, spot: 6, cap: 100, outstanding: 100 }).provide, false, "cap reached");
  assert.equal(peg({ twap: 26, spot: 6, cap: 100, quoteSound: false }).provide, false, "quote gate");
  assert.equal(peg({ twap: -26, spot: -6, outstanding: 1 }).withdraw, true, "burning outstanding is never gated");
  assert.equal(peg({ twap: -26, spot: -6, outstanding: 1, quoteSound: false }).withdraw, true);
  assert.equal(peg({ twap: -26, spot: -6, buffer: 1 }).withdraw, true);
  assert.equal(peg({ twap: -26, spot: -6, buffer: 1, quoteSound: false }).withdraw, false, "the buffer buys only on a sound quote");
  assert.equal(peg({ twap: -26, spot: -6, surplus: 5, bufferRoom: 5 }).withdraw, true, "surplus folds in first");
  assert.equal(peg({ twap: -26, spot: -6, surplus: 5, bufferRoom: 0 }).withdraw, false, "no room to fold");
  assert.equal(peg({ twap: -26, spot: -6 }).noBid, true);
  assert.equal(peg({ twap: -26, spot: -5, buffer: 1 }).withdraw, false, "spot at the target");
});

test("sweep: a floor per side; USDC at once when the bid needs it", () => {
  const usdc = (n) => BigNumber.from(10).pow(6).mul(n);
  assert.equal(sweepDue({ claims: 0, decimals: 6, minUsd: 25, bidNeeded: true, feedsBuffer: true }), false);
  assert.equal(sweepDue({ claims: usdc(24), decimals: 6, minUsd: 25, bidNeeded: false, feedsBuffer: true }), false);
  assert.equal(sweepDue({ claims: usdc(25), decimals: 6, minUsd: 25, bidNeeded: false, feedsBuffer: true }), true);
  assert.equal(sweepDue({ claims: usdc(1), decimals: 6, minUsd: 25, bidNeeded: true, feedsBuffer: true }), true);
  assert.equal(sweepDue({ claims: usdc(1), decimals: 6, minUsd: 25, bidNeeded: true, feedsBuffer: false }), false);
  assert.equal(sweepDue({ claims: E18.mul(25), decimals: 18, minUsd: 25, bidNeeded: false, feedsBuffer: false }), true);
});

// ---------------------------------------------------------------- backstop

test("backstop room alerts", () => {
  const keys = (x) => roomAlerts({ sleeve: "blue", name: "ETH", room: E18, debt: 0, ...x }).map((a) => `${a.level}:${a.key}`);
  assert.deepEqual(keys({}), []);
  assert.deepEqual(keys({ room: 0, debt: E18 }), ["info:backstop-room-empty-blue-ETH"]);
  assert.deepEqual(keys({ room: 0, debt: 0 }), [], "nothing to cover");
  assert.deepEqual(keys({ room: E18, debt: E18.mul(100) }), ["warn:backstop-room-thin-blue-ETH"]);
  assert.deepEqual(keys({ room: E18.mul(5), debt: E18.mul(100) }), []);
  assert.deepEqual(keys({ room: E18.mul(69), previous: E18.mul(100) }), ["warn:backstop-room-fell-blue-ETH"]);
  assert.deepEqual(keys({ room: E18.mul(70), previous: E18.mul(100) }), []);
});

test("matured deposits convert right after maturity, urgent after an hour, warn after two", () => {
  const D = 86_400, day = 20_000, at = (day + 2) * D;
  assert.deepEqual(convertPlan([], at), { due: false });
  assert.deepEqual(convertPlan([{ day, amount: E18 }], at - 1), { due: false }, "not matured yet");
  assert.deepEqual(convertPlan([{ day, amount: 0 }], at + 60), { due: false }, "a bucket cancelled to zero is not worth a call");
  assert.deepEqual(convertPlan([{ day, amount: E18 }], at + 60), { due: true, tier: "routine", late: 60, warn: false });
  assert.deepEqual(convertPlan([{ day: day - 1, amount: 0 }, { day, amount: E18 }], at + 60), { due: true, tier: "urgent", late: D + 60, warn: true }, "late from the oldest matured bucket");
  assert.deepEqual(convertPlan([{ day, amount: E18 }], at + 3600), { due: true, tier: "urgent", late: 3600, warn: false });
  assert.equal(convertPlan([{ day, amount: E18 }], at + 7200).warn, true);
});

test("peg TWAP push alert: spot back at the peg, TWAP away", () => {
  assert.equal(twapPushAlert({ twap: null, spot: 0 }), null);
  assert.equal(twapPushAlert({ twap: -8, spot: 0 }), null, "inside the Allocator's 10-tick gate");
  assert.equal(twapPushAlert({ twap: -60, spot: -55 }), null, "a real move: both off");
  assert.equal(twapPushAlert({ twap: -60, spot: -30 }), null, "spot not back at the peg");
  assert.equal(twapPushAlert({ twap: -60, spot: 2 }).key, "peg-twap-push");
  assert.equal(twapPushAlert({ twap: 40, spot: -5 }).key, "peg-twap-push");
});

test("realize only for a retired token with a good price", () => {
  assert.equal(needsRealize({ isRetired: true, ok: true, high: 1 }), true);
  assert.equal(needsRealize({ isRetired: true, ok: false, high: 1 }), false);
  assert.equal(needsRealize({ isRetired: true, ok: true, high: 0 }), false);
  assert.equal(needsRealize({ isRetired: false, ok: true, high: 1 }), false);
});

// ---------------------------------------------------------------- guardian

const K = "0x00000000000000000000000000000000000000aa", GOV = "0x00000000000000000000000000000000000000bb", X = "0x00000000000000000000000000000000000000cc";
const lg = (x = {}) => logConditions({ acted: [], keeperAdds: [], known: [], keeper: K, governor: GOV, ownHashes: new Set(["0x1"]), ...x }).map((c) => c.key);
test("guardian: proof conditions", () => {
  assert.deepEqual(lg(), []);
  assert.deepEqual(lg({ acted: [{ from: K, hash: "0x1", action: "SWAP" }] }), [], "our own send");
  assert.deepEqual(lg({ acted: [{ from: GOV, hash: "0x9", action: "TO_TREASURY" }] }), [], "the governor");
  assert.deepEqual(lg({ acted: [{ from: X, to: GOV, hash: "0x9", action: "TO_TREASURY" }] }), [], "a Safe signer sending the Safe's transaction");
  assert.deepEqual(lg({ acted: [{ from: X, to: K, hash: "0x9", action: "SWAP" }] }), ["unknown-actor"]);
  assert.deepEqual(lg({ acted: [{ from: X, hash: "0x2", action: "SWAP" }] }), ["unknown-actor"]);
  assert.deepEqual(lg({ acted: [{ from: K, hash: "0x2", action: "SWAP" }] }), ["keeper-replayed"], "our address, a transaction we never signed");
  assert.deepEqual(lg({ acted: [{ from: K, hash: "0x2", action: "SWAP" }], ownHashes: null }), [], "no journal to compare with");
  assert.deepEqual(lg({ acted: [{ from: X, hash: "0x2", action: "SWAP" }], known: [X] }), []);
  assert.deepEqual(lg({ keeperAdds: [X] }), ["unknown-keeper"]);
  assert.deepEqual(lg({ keeperAdds: [K] }), []);
});

test("guardian: a reading fires only after holding, and resets when it stops", () => {
  const confirm = { a: 100 };
  let r = heldConditions({ readings: [["a", true, "x"]], confirm, since: {}, now: 1000 });
  assert.deepEqual(r.fire, []);
  assert.deepEqual(r.since, { a: 1000 });
  r = heldConditions({ readings: [["a", true, "x"]], confirm, since: r.since, now: 1099 });
  assert.deepEqual(r.fire, []);
  r = heldConditions({ readings: [["a", true, "x"]], confirm, since: r.since, now: 1100 });
  assert.equal(r.fire[0].key, "a");
  r = heldConditions({ readings: [["a", false, "x"]], confirm, since: r.since, now: 1101 });
  assert.deepEqual(r.since, {});
  r = heldConditions({ readings: [["a", true, "x"]], confirm, since: r.since, now: 1102 });
  assert.deepEqual(r.fire, [], "the clock starts again");
});

test("guardian: off the pool only while the leg is fresh", () => {
  const args = { fresh: true, value: P.mul(131).div(100), pool: P, bps: 3000 };
  assert.equal(offPool(args), true);
  assert.equal(offPool({ ...args, value: P.mul(130).div(100) }), false);
  assert.equal(offPool({ ...args, fresh: false }), false);
  assert.equal(offPool({ ...args, value: P.mul(69).div(100) }), true);
  assert.equal(offPool({ ...args, value: BigNumber.from(0) }), false);
});

test("guardian: there is no guardian key; one left in the environment is refused", () => {
  assert.doesNotThrow(() => refuseGuardianKey({}));
  assert.throws(() => refuseGuardianKey({ GUARDIAN_PRIVATE_KEY: KEY }), /no guardian key any more/);
});

test("journal scopes: one key's intents and hashes are not another's", () => {
  recordIntent({ nonce: 1, hash: "0xAA", signed: "0x", label: "keeper" });
  recordIntent({ nonce: 1, hash: "0xBB", signed: "0x", label: "guardian" }, "tx-guardian");
  assert.equal(pendingIntents()[0].label, "keeper");
  assert.equal(pendingIntents("tx-guardian")[0].label, "guardian");
  assert.ok(signedHashes().has("0xaa"));
  assert.ok(!signedHashes().has("0xbb"));
  assert.ok(signedHashes("tx-guardian").has("0xbb"));
  rmSync(statePath("tx"), { recursive: true, force: true });
  rmSync(statePath("tx-guardian"), { recursive: true, force: true });
});

// ---------------------------------------------------------------- allocator

test("allocator sale: sized by the sleeve's limit, the bucket and the config", () => {
  const price = E18.mul(2000); // USD per 1e18 raw
  const args = { coll: E18.mul(10), sleeveLevel: E18.mul(5), bucketUsd: E18.mul(4000), maxUsd: null, priceUsd: price };
  assert.equal(saleAmount(args).toString(), E18.mul(2).toString(), "the USD bucket binds");
  assert.equal(saleAmount({ ...args, bucketUsd: E18.mul(100_000) }).toString(), E18.mul(5).toString(), "the sleeve binds");
  assert.equal(saleAmount({ ...args, sleeveLevel: E18.mul(100), bucketUsd: E18.mul(100_000) }).toString(), E18.mul(10).toString(), "what it holds binds");
  assert.equal(saleAmount({ ...args, maxUsd: 2000 }).toString(), E18.toString(), "the config binds");
  assert.equal(saleAmount({ ...args, priceUsd: 0 }).toString(), "0");
  assert.equal(sleeveLevelNow({ max: 100, slope: 2, level: 10, updatedAt: 1000, now: 1010 }).toString(), "30");
  assert.equal(sleeveLevelNow({ max: 100, slope: 2, level: 10, updatedAt: 1000, now: 9000 }).toString(), "100");
});

// ---------------------------------------------------------------- the attestation preflight

test("preflight: consumed, wrong signer, stale, past the leaf's allowance", async () => {
  const wallet = new Wallet(ATTESTER);
  const leafAddr = "0x00000000000000000000000000000000000000a1";
  const domain = { name: "IdentityMD Oracle", version: "2", chainId: 1, verifyingContract: leafAddr };
  const body = bodyOf("price");
  const m = { requestId: `0x${"01".repeat(32)}`, chainId: "1", questionHash: questionHash(body, 900, 1000), answerType: "uint256", answer: utils.hexZeroPad(P.toHexString(), 32), figure: "0", fromBlock: "900", toBlock: "1000", blockHash: `0x${"11".repeat(32)}`, panelJobId: `0x${"22".repeat(32)}`, panelSize: "100", quorum: "67", agreed: "67", issuedAt: "1000000", expiresAt: "1003600" };
  const att = { domain, message: m, signature: "0x", signer: wallet.address };
  const leaf = (x = {}) => ({
    attester: async () => wallet.address, attestationChainId: async () => 1, attestationAnswerType: async () => 3, maxAge: async () => 3600, usedRequests: async () => false,
    DOMAIN_SEPARATOR: async () => utils._TypedDataEncoder.hashDomain(domain), MIN_PANEL_SIZE: async () => 100, minAgreed: async () => 67, latestValue: async () => ({ value: E18, updatedAt: 0 }), lastToBlock: async () => 0,
    expectedQuestionHash: async () => m.questionHash, accepts: async () => true, ...x,
  });
  const provider = { getBlock: async () => ({ number: 1001, timestamp: 1_000_100 }) };
  assert.deepEqual((await preflightAttestation(provider, leaf(), att)).fail, []);
  const used = await preflightAttestation(provider, leaf({ usedRequests: async () => true }), att);
  assert.equal(used.consumed, true);
  const bad = await preflightAttestation(provider, leaf({ attester: async () => X }), att);
  assert.equal(bad.terminal, true);
  const refused = await preflightAttestation(provider, leaf({ accepts: async () => false }), att);
  assert.match(refused.fail[0], /past what the leaf accepts/);
  assert.equal(refused.terminal, false, "the allowance may widen before the answer expires");
  const wrongQ = await preflightAttestation(provider, leaf({ expectedQuestionHash: async () => `0x${"33".repeat(32)}` }), att);
  assert.match(wrongQ.fail[0], /the leaf expects/);
  const old = await preflightAttestation({ getBlock: async () => ({ number: 2000, timestamp: 1_000_100 }) }, leaf(), att);
  assert.match(old.fail.join(), /past the leaf's life/);
});

test("NHI: a failed order retries only after the wait", () => {
  assert.equal(nhi({ lastBuyAt: 1000, now: 2000, minGapSeconds: 1800 }).kind, "wait");
  assert.equal(nhi({ lastBuyAt: 1000, now: 2800, minGapSeconds: 1800 }).buy, true);
  assert.equal(nhi({}).buy, true, "never bought: no wait");
});

test("state: one writer per dir, a dead holder's lock is replaced, report-only state is apart", () => {
  const release = takeLock();
  assert.throws(() => takeLock(), /holds .*keeper\.lock/);
  release();
  writeFileSync(statePath("keeper.lock"), "2147483646\n"); // no such pid
  const again = takeLock();
  assert.equal(Number(readFileSync(statePath("keeper.lock"), "utf8")), process.pid);
  again();
  assert.notEqual(reportStateDir(), stateDir());
  assert.ok(reportStateDir().startsWith(stateDir()));
});

test("allocator rules: start an auction when collateral waits; restart only after an hour at the floor", () => {
  const base = { coll: 5n, arrived: 5n, now: 10_000, duration: 7200 };
  assert.equal(collateralAuctionStep({ ...base, coll: 0n, start: 0 }), "wait", "nothing held");
  assert.equal(collateralAuctionStep({ ...base, start: 0 }), "start", "never run");
  assert.equal(collateralAuctionStep({ ...base, start: 10_000 - 7200 }), "wait", "just reached the floor: hold there");
  assert.equal(collateralAuctionStep({ ...base, start: 10_000 - 7200 - 3600 }), "start", "an hour at the floor: ask the top again");
  assert.equal(collateralAuctionStep({ ...base, coll: 100n, arrived: 106n, start: 10_000 - 60, offered: 100n }), "start", "new collateral (6%) mid-run: offer it from the top");
  assert.equal(collateralAuctionStep({ ...base, coll: 100n, arrived: 104n, start: 10_000 - 60, offered: 100n }), "wait", "dust (4%): the run goes on");
  assert.equal(collateralAuctionStep({ ...base, start: 10_000 - 60, offered: 5n }), "wait");
  // audit wave 2: an in-kind exit lowered the holding (5 -> 3) and 2 new arrived; the holding is back under the old figure,
  // but arrivals (collIn 7) passed the run's snapshot (5): restart.
  assert.equal(collateralAuctionStep({ ...base, coll: 5n, arrived: 7n, start: 10_000 - 60, offered: 5n }), "start", "arrival hidden by an exit (40%)");
});

test("allocator rules: unsold collateral warns after 12 h without a fall; any sale resets the clock", () => {
  let w = unsoldWatch({ coll: 10n, seen: undefined, now: 0 });
  assert.deepEqual([w.seen.coll, w.stuck], ["10", false]);
  w = unsoldWatch({ coll: 10n, seen: w.seen, now: 12 * 3600 - 1 });
  assert.equal(w.stuck, false);
  assert.equal(unsoldWatch({ coll: 10n, seen: w.seen, now: 12 * 3600 }).stuck, true);
  w = unsoldWatch({ coll: 9n, seen: w.seen, now: 13 * 3600 });
  assert.deepEqual([w.seen.since, w.stuck], [13 * 3600, false], "a sale restarts the watch");
  assert.deepEqual(unsoldWatch({ coll: 0n, seen: w.seen, now: 99 * 3600 }), { seen: null, stuck: false });
});

test("allocator rules: the auction key is the contract's keccak256(abi.encode(backstop, collateral))", () => {
  const a = "0x00000000000000000000000000000000000000aa", b = "0x00000000000000000000000000000000000000bb";
  assert.equal(auctionKey(a, b), utils.keccak256("0x" + "0".repeat(62) + "aa" + "0".repeat(62) + "bb"));
});

test("proven sIMD spot: silent while fresh, warns inside the prove margin, critical once stale, warns when unread", () => {
  assert.equal(provenSpotAlert({ stale: false, age: 600, maxAge: 21600, marginSeconds: 3600 }), null);
  assert.equal(provenSpotAlert({ stale: false, age: 18500, maxAge: 21600, marginSeconds: 3600 }), null, "the depth round's own prove window: not yet");
  const ageing = provenSpotAlert({ stale: false, age: 20000, maxAge: 21600, marginSeconds: 3600 });
  assert.equal(ageing.level, "warn");
  assert.equal(ageing.key, "feeds-proven-spot-ageing");
  const stale = provenSpotAlert({ stale: true, age: 22000, maxAge: 21600 });
  assert.equal(stale.level, "critical");
  assert.equal(stale.key, "feeds-proven-spot-stale");
  assert.equal(provenSpotAlert({ age: null }).key, "feeds-proven-spot-unread");
});
