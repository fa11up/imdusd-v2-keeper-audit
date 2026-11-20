// wave-5 keeper audit #12, #23, #24: PAID ORDERS AND THE CHALLENGE.
//   #12 PROPERTY (P1/P2): no answer from whoever speaks as the plane can keep a PAID order out of the path that ends it: an admission
//       that fits the questions admits it, one that does not is a paid refusal (critical, all buying held), and anything else (throws,
//       garbage) leaves it paying until the admission timeout makes it lost (critical). advanceOrders never leaves it stuck silently.
//   #23 PROPERTY (P2): no permit is ever signed for longer than MAX_PERMIT_SECONDS (900), whatever PLANE.maxPermitSeconds says.
//   #24 PROPERTY (P2): a payment approval is only signed for a challenge naming THIS order's action and submit resource.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, Wallet } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5k-orders-"));
process.env.PLANE_BEARER = "x";
const { statePath, stateDir, writeState } = await import("../lib/state.mjs");
const { advanceOrders, loadOrders } = await import("../lib/orders.mjs");
const { IMD, MAX_PERMIT_SECONDS, challengeProblem, signPayment } = await import("../lib/x402.mjs");

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PAY_TO = "0x4e0fa57bde726079356537e2f34d671e9f41adbc";
const E18 = BigNumber.from(10).pow(18);
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const clean = () => { for (const f of readdirSync(stateDir())) rmSync(statePath(f), { recursive: true, force: true }); };
const challenge = (id, { action = "oracle.request", url = `https://api.imd.fun/requests/${id}/submit`, timeout = 300 } = {}) => ({
  resource: {}, resourceUrl: url, requesterScopeHash: "ab".repeat(32),
  accepts: [{ scheme: "exact", network: "eip155:1", amount: "500000000000000000", asset: IMD, payTo: PAY_TO, maxTimeoutSeconds: timeout }],
  quote: { id, quoteHash: "cd".repeat(32), action, expiresAt: 1, payment: { network: "eip155:1", asset: IMD, amount: "500000000000000000", payTo: PAY_TO } },
});

function ctxWith(client, raised, cfg = {}) {
  const wallet = new Wallet(KEY);
  return {
    execute: true, cfg: { PLANE: { payTo: PAY_TO }, IMD: { dailyCap: 1000, admissionTimeoutSeconds: 3600 }, ...cfg }, signer: wallet, keeperAddress: wallet.address, log: (s) => process.env.DBG && console.log(s),
    provider: { getBlock: async () => ({ number: 1, timestamp: Math.floor(Date.now() / 1000) }), getBalance: async () => E18, getGasPrice: async () => BigNumber.from(10).pow(9), unpin() {} }, permit2: { nonceBitmap: async () => BigNumber.from(0) },
    planeState: { ok: true, base: "https://api.imd.fun" }, planeClient: client,
    book: { token: () => ({ balanceOf: async () => E18.mul(1000), allowance: async () => E18.mul(1000) }), leaf: () => ({}) },
    alerts: { raise: async (l, k, m) => raised.push({ l, k, m }), settle: async () => {} },
  };
}
const paying = (paidAgoS, n = 1) => ({ key: "k-1", purpose: "fall", action: "oracle.request", stage: "paying", planeOrder: "po-1", at: new Date().toISOString(), paidAt: new Date(Date.now() - paidAgoS * 1000).toISOString(), amount: "500000000000000000", permitNonce: "1", permitDeadline: Math.floor(Date.now() / 1000) + 600, questions: [...Array(n)].map((_, i) => ({ role: `r${i}`, leaf: "0x01" })) });

test("#12 judge proof shape: an admission listing more requests than questions is a paid refusal, not a silent 'paying'", async () => {
  clean();
  writeState("orders.json", { list: [paying(7200)] });
  const raised = [];
  const ctx = ctxWith({ order: async () => ({ status: 200, body: { admission: { result: { requests: [{ requestId: "a" }, { requestId: "b" }] } } } }) }, raised);
  for (let i = 0; i < 5; i++) await advanceOrders(ctx);
  const o = loadOrders().find((x) => x.key === "k-1");
  assert.equal(o?.stage, "refused-paid");
  assert.ok(raised.some((a) => a.l === "critical" && a.k === "feeds-order-refused-fall"), JSON.stringify(raised));
});

test("#12 property: any plane answer (300 seeds): a paid order ends admitted (fitting), refused-paid or lost (past the timeout), each loud", async () => {
  for (let seed = 1; seed <= 300; seed++) {
    clean();
    const r = rng(seed);
    const n = 1 + Math.floor(r() * 3);
    const ago = Math.floor(r() * 7200);
    writeState("orders.json", { list: [paying(ago, n)] });
    const kinds = [
      () => { throw new Error("plane down"); },
      () => ({ status: 200, body: null }),
      () => ({ status: 200, body: { admission: { result: { requests: [...Array(Math.floor(r() * 5))].map((_, i) => ({ requestId: r() < 0.2 ? null : `q${i}` })) } } } }),
      () => ({ status: 200, body: { admission: { result: { requestId: "only" } } } }),
      () => ({ status: 200, body: { admission: { result: "garbage" } } }),
      () => ({ status: 200, body: { status: "paid" } }),
    ];
    const kind = Math.floor(r() * kinds.length);
    let answer;
    const raised = [];
    const ctx = ctxWith({ order: async () => (answer = kinds[kind]()) }, raised);
    await advanceOrders(ctx);
    const o = loadOrders().find((x) => x.key === "k-1");
    const where = `seed ${seed} kind ${kind} n ${n} paid ${ago}s ago: ${JSON.stringify(answer)?.slice(0, 120)}`;
    if (o.stage === "admitted") assert.equal(o.children.length, n, where);
    else if (o.stage === "refused-paid" || o.stage === "lost") assert.ok(raised.some((a) => a.l === "critical"), `${where}: ${o.stage} without a critical`);
    else {
      assert.equal(o.stage, "paying", where);
      assert.ok(ago <= 3600, `${where}: still paying past the admission timeout`);
    }
  }
});

test("#23: whatever PLANE.maxPermitSeconds says, the challenge check and the signature hold the permit to 900 s", async () => {
  const ch = challenge("po-1", { timeout: 86400 });
  assert.ok(challengeProblem(ch, 1, E18.div(2), PAY_TO, 86400), "a day-long permit was accepted");
  const ch2 = challenge("po-1", { timeout: 300 });
  const now = Math.floor(Date.now() / 1000);
  for (const asked of [60, 300, 900, 901, 3600, 86400]) {
    const { deadline } = await signPayment(new Wallet(KEY), { ...ch2, accepts: [{ ...ch2.accepts[0], maxTimeoutSeconds: 86400 }] }, { maxPermitSeconds: asked });
    assert.ok(deadline - now <= MAX_PERMIT_SECONDS + 1, `asked ${asked}: signed for ${deadline - now}s`);
  }
});

test("#24: a challenge for another order, action or resource is refused unpaid; this order's is paid (judge proof shape + variants)", async () => {
  const cases = [
    [{ action: "agent.run" }, false],
    [{ url: "https://api.imd.fun/requests/SOMEONE-ELSES-ORDER/submit" }, false],
    [{ url: "not a url" }, false],
    [{}, true],
  ];
  for (const [c, ok] of cases) {
    clean();
    const order = { ...paying(0), stage: "quoted", paidAt: undefined, permitNonce: undefined, permitDeadline: undefined };
    writeState("orders.json", { list: [order] });
    const raised = [];
    let submitted = 0;
    const ctx = ctxWith({ challenge: async (id) => ({ status: 402, body: challenge(id, c) }), submit: async () => { submitted++; return { status: 200, body: {} }; }, order: async () => ({ status: 200, body: {} }) }, raised);
    await advanceOrders(ctx);
    assert.equal(submitted, ok ? 1 : 0, `${JSON.stringify(c)}: submitted ${submitted}`);
    if (!ok) assert.ok(raised.some((a) => a.k === "feeds-order-refused-fall"), `${JSON.stringify(c)}: refused silently`);
  }
});
