// PROPERTY (audit wave 4, C8): once a payment is signed and handed over, only the chain ends it unpaid. An order in `paying` or `lost`
// is finished unpaid only when, at a block past its permit's deadline, the permit's Permit2 nonce is unused (nothing was or can be
// taken); the plane's word ('expired', 'payment_failed') never ends it nor lifts a hold; and a hold (lost / refused-paid) is lifted only by
// admission, the chain's proof, or a human: no payment is signed past it.
//
// Seeded fuzz over a hostile plane (any status at any time, taking the permit or not, admitting or never), chain time, admission
// timeouts and restarts, driving the real advanceOrders / buyHold / startOrder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, utils, Wallet } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w4-orders-"));
process.env.PLANE_BEARER = "x";
const { statePath, stateDir } = await import("../lib/state.mjs");
const { advanceOrders, buyHold, loadOrders, startOrder } = await import("../lib/orders.mjs");
const { IMD } = await import("../lib/x402.mjs");

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PAY_TO = "0x4e0fa57bde726079356537e2f34d671e9f41adbc";
const E18 = BigNumber.from(10).pow(18);
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const STATUSES = ["quoted", "paid", "expired", "payment_failed", "settling", "admitted", "refused"];

function world(seed) {
  const r = rng(seed);
  const wallet = new Wallet(KEY);
  const chain = { number: 100, now: Math.floor(Date.now() / 1000), used: new Set() };
  const plane = { orders: new Map(), signed: [] }; // signed: every payment header the keeper handed over
  const client = {
    quote: async () => {
      const id = `o${plane.orders.size + 1}`;
      plane.orders.set(id, { id, status: "quoted", admission: null, permit: null });
      return { status: 201, body: { order: { id } } };
    },
    challenge: async (id) => ({
      status: 402,
      body: {
        resource: {}, resourceUrl: `https://api.imd.fun/requests/${id}/submit`, requesterScopeHash: "ab".repeat(32),
        accepts: [{ scheme: "exact", network: "eip155:1", amount: "500000000000000000", asset: IMD, payTo: PAY_TO, maxTimeoutSeconds: 300 }],
        quote: { id, quoteHash: "cd".repeat(32), action: "oracle.request", expiresAt: chain.now + 600, payment: { network: "eip155:1", asset: IMD, amount: "500000000000000000", payTo: PAY_TO } },
      },
    }),
    submit: async (id, _sig, header) => {
      const auth = JSON.parse(Buffer.from(header, "base64").toString()).payload.permit2Authorization;
      const o = plane.orders.get(id);
      o.permit = { nonce: auth.nonce, deadline: Number(auth.deadline) };
      plane.signed.push({ id, ...o.permit });
      if (r() < 0.2) throw new Error("socket hang up"); // the payment may still have arrived
      return { status: r() < 0.5 ? 200 : 500, body: {} };
    },
    order: async (id) => {
      const o = plane.orders.get(id);
      if (!o) return { status: 404, body: {} };
      if (r() < 0.1) throw new Error("plane down");
      return { status: 200, body: { status: o.status, admission: o.admission } };
    },
    oracleRequest: async () => ({ status: 200, body: { status: "assessing" } }),
    attestation: async () => ({ status: 404, body: {} }),
  };
  const provider = {
    getBlock: async () => ({ number: chain.number, timestamp: chain.now }),
    getBalance: async () => E18, getGasPrice: async () => BigNumber.from(10).pow(9), unpin() {},
  };
  const permit2 = {
    nonceBitmap: async (owner, wordPos) => {
      let word = BigNumber.from(0);
      for (const n of chain.used) {
        const b = BigNumber.from(n);
        if (b.shr(8).eq(wordPos)) word = word.or(BigNumber.from(1).shl(b.and(255).toNumber()));
      }
      return word;
    },
  };
  const cfg = { PLANE: { payTo: PAY_TO }, IMD: { dailyCap: 1000, admissionTimeoutSeconds: 3600 } };
  const ctx = {
    execute: true, cfg, provider, permit2, signer: wallet, keeperAddress: wallet.address, log() {}, planeState: { ok: true, base: "http://plane.invalid" },
    planeClient: client, book: { token: () => ({ balanceOf: async () => E18.mul(1000), allowance: async () => E18.mul(1000) }), leaf: () => ({}) },
    alerts: { raise: async () => {}, settle: async () => {} },
  };
  return { r, chain, plane, ctx, cfg };
}

test("property C8: only the chain ends a signed payment unpaid; a hold is lifted only by admission or the chain (seeded fuzz, 30 runs x 30 rounds)", async () => {
  const failures = [];
  for (let seed = 1; seed <= 30 && failures.length < 6; seed++) {
    for (const f of readdirSync(stateDir())) rmSync(statePath(f), { recursive: true, force: true });
    const w = world(seed);
    let seen = new Map(); // key -> order as last seen
    for (let k = 0; k < 30; k++) {
      const x = w.r();
      // The world moves: chain time, a hostile plane taking the permit while it can, statuses, admission.
      w.chain.now += Math.floor(w.r() * 200);
      w.chain.number += 1;
      for (const o of w.plane.orders.values()) {
        if (o.permit && w.r() < 0.15 && w.chain.now <= o.permit.deadline) w.chain.used.add(o.permit.nonce);
        if (w.r() < 0.3) o.status = STATUSES[Math.floor(w.r() * STATUSES.length)];
        if (o.status === "admitted" && o.permit && w.chain.used.has(o.permit.nonce) && !o.admission) o.admission = { result: { kind: "oracle", requestId: `r-${o.id}` } };
      }
      w.cfg.IMD.admissionTimeoutSeconds = w.r() < 0.2 ? 0 : 3600;
      // A fall decided, as decideFall does: only when nothing holds.
      if (x < 0.4 && (await buyHold(w.ctx, E18.div(2))) === null) startOrder("fall", [{ role: "price", leaf: "0x01", input: {} }]);
      const before = w.plane.signed.length;
      await advanceOrders(w.ctx);
      const now = new Map(loadOrders().map((o) => [o.key, o]));
      // (1) a paying/lost order that vanished was ended by the chain, or admitted first.
      for (const [key, o] of seen) {
        if (!["paying", "lost"].includes(o.stage) || now.has(key)) continue;
        const nonce = o.permitNonce;
        const dead = nonce && !w.chain.used.has(nonce) && w.chain.now > Number(o.permitDeadline);
        if (!dead) failures.push(`seed ${seed} round ${k}: order ${o.planeOrder} (${o.stage}) ended without the chain's proof (used ${w.chain.used.has(nonce)}, now ${w.chain.now} vs deadline ${o.permitDeadline})`);
      }
      // (2) a hold (lost / refused-paid) is lifted only by admission, the chain's proof, or a human: no new payment past it.
      if (w.plane.signed.length > before) {
        for (const o of seen.values()) {
          if (!["lost", "refused-paid"].includes(o.stage)) continue;
          const p = w.plane.orders.get(o.planeOrder);
          const dead = !w.chain.used.has(o.permitNonce) && w.chain.now > Number(o.permitDeadline);
          const admitted = now.get(o.key)?.stage === "admitted";
          if (!dead && !admitted) failures.push(`seed ${seed} round ${k}: paid again past the ${o.stage} hold of ${o.planeOrder} (taken ${w.chain.used.has(o.permitNonce)}, plane says ${p.status})`);
        }
      }
      seen = now;
    }
  }
  assert.deepEqual(failures, []);
});
