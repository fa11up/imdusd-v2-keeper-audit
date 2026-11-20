// PROPERTY (audit wave 4, P2 low): only a fall may spend the reserve kept for falls. At every latch (a payment signed), the day's spend
// before it + its amount + (for any order but a fall) IMD.reserveForFalls is within IMD.dailyCap, however spend moved between the
// decision and the payment. Seeded fuzz over starting spend, purposes, sizes and interleavings, through the real pay().
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, utils, Wallet } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w4-reserve-"));
process.env.PLANE_BEARER = "x";
const { statePath, stateDir, writeState } = await import("../lib/state.mjs");
const { advanceOrders, spentToday, startOrder } = await import("../lib/orders.mjs");
const { IMD } = await import("../lib/x402.mjs");

const PAY_TO = "0x4e0fa57bde726079356537e2f34d671e9f41adbc";
const E18 = BigNumber.from(10).pow(18);
const UNIT = utils.parseEther("0.5");
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

test("property P2: no order but a fall pays into the reserve kept for falls (seeded fuzz, 50 days)", async () => {
  const r = rng(0x10);
  const failures = [];
  const wallet = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  for (let day = 0; day < 50 && failures.length < 5; day++) {
    for (const f of readdirSync(stateDir())) rmSync(statePath(f), { recursive: true, force: true });
    writeState("imd-spend.json", { day: new Date().toISOString().slice(0, 10), imd: utils.parseEther(String(Math.floor(r() * 10) / 2)).toString() });
    const orders = new Map();
    let latches = [];
    const client = {
      quote: async (_k, action, input) => { const id = `o${orders.size}`; orders.set(id, { ...input, action }); return { status: 201, body: { order: { id } } }; },
      challenge: async (id) => {
        const n = orders.get(id).questions?.length ?? 1;
        const amount = UNIT.mul(n).toString();
        return { status: 402, body: { resource: {}, resourceUrl: `https://api.imd.fun/requests/${id}/submit`, requesterScopeHash: "ab".repeat(32), accepts: [{ network: "eip155:1", amount, asset: IMD, payTo: PAY_TO, maxTimeoutSeconds: 300 }], quote: { id, quoteHash: "cd".repeat(32), action: orders.get(id).action, expiresAt: 1, payment: { network: "eip155:1", asset: IMD, amount, payTo: PAY_TO } } } };
      },
      submit: async () => ({ status: 200, body: {} }),
      order: async () => ({ status: 200, body: { status: "paid" } }),
    };
    const ctx = {
      execute: true, cfg: { PLANE: { payTo: PAY_TO }, IMD: { dailyCap: 5, reserveForFalls: 1 } }, signer: wallet, log() {}, planeClient: client, planeState: { ok: true },
      provider: { getBalance: async () => E18, getGasPrice: async () => BigNumber.from(1), getBlock: async () => ({ number: 1, timestamp: 1 }) },
      book: { token: () => ({ balanceOf: async () => E18.mul(100), allowance: async () => E18.mul(100) }) }, alerts: { raise: async () => {} },
    };
    for (let k = 0; k < 5; k++) {
      const purpose = ["fall", "nhi", "seats"][Math.floor(r() * 3)];
      const n = purpose === "seats" && r() < 0.5 ? 2 : 1;
      startOrder(purpose, Array.from({ length: n }, (_, i) => ({ role: `${purpose}${i}`, leaf: "0x01", input: {} })));
      // Spend can move between a decision and its payment: other orders pay first, in any order.
      const before = spentToday();
      await advanceOrders(ctx);
      const after = spentToday();
      if (after.gt(before)) latches.push({ purpose, before, paid: after.sub(before) });
    }
    for (const l of latches) {
      // Each round pays at most the orders open in it; check each latch against the spend it found.
      const reserve = l.purpose === "fall" ? 0 : 1;
      if (l.before.add(l.paid).add(utils.parseEther(String(reserve))).gt(utils.parseEther("5")) && l.purpose !== "fall") {
        failures.push(`day ${day}: ${l.purpose} paid ${utils.formatEther(l.paid)} with ${utils.formatEther(l.before)} spent: the fall reserve is gone`);
      }
    }
  }
  assert.deepEqual(failures, []);
});
