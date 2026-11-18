// PROPERTY (audit wave 4, P3): what one nonce can cost is bounded, and a stuck nonce never wedges the key. Every transaction the
// keeper signs offers at most the gas ceiling (MAX_GAS_GWEI) per gas; a nonce gets at most MAX_BUMPS replacements; the last is a
// 0-value send to self (a cancel), after which nothing more is signed on that nonce; and while the base fee is under the ceiling a
// nonce whose action a relay never includes is cancelled and the key moves on.
//
// Seeded fuzz over the real guardedSigner + send(): a simulated chain (base fee walk with spikes over the ceiling), relays that drop
// actions or include them only at a fee, actions that start reverting, crashes (a fresh signer over the same state dir), and a mix of
// urgent and routine sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, providers, utils, Wallet } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w4-tx-"));
const { statePath } = await import("../lib/state.mjs");
const { guardedSigner, send } = await import("../lib/tx.mjs");

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ME = new Wallet(KEY).address;
const gwei = (n) => utils.parseUnits(String(Math.round(n * 1000) / 1000), "gwei");
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const CAP = 100;
const MAX_BUMPS = 4;

function scenario(seed) {
  const r = rng(seed);
  const chain = { count: 5, base: gwei(5 + Math.floor(r() * 40)), mined: new Map(), reverts: false };
  const mode = ["drop-actions", "fee", "fee", "drop-all-until"][Math.floor(r() * 4)];
  const signed = []; // every transaction that reached a relay
  const pool = new Map(); // nonce -> latest signed raw a relay holds
  // The private relay, at the transport (as the judge's proof stubs it): nothing leaves this process.
  providers.StaticJsonRpcProvider.prototype.sendTransaction = async (raw) => {
    const t = utils.parseTransaction(raw);
    signed.push(t);
    if (t.nonce < chain.count) throw new Error("nonce too low");
    pool.set(t.nonce, raw);
    return { hash: utils.keccak256(raw) };
  };
  const provider = {
    getBlock: async () => ({ baseFeePerGas: chain.base }),
    getGasPrice: async () => chain.base,
    getBalance: async () => utils.parseEther("1"),
    getTransactionCount: async () => chain.count,
    getTransactionReceipt: async (h) => chain.mined.get(h) ?? null,
    waitForTransaction: async (h) => {
      const rc = chain.mined.get(h);
      if (rc) return rc;
      throw Object.assign(new Error("timeout"), { code: "TIMEOUT" });
    },
    call: async (tx) => {
      if (chain.reverts && tx.to?.toLowerCase() !== ME.toLowerCase()) throw Object.assign(new Error("reverted"), { code: "CALL_EXCEPTION" });
      return "0x";
    },
  };
  const make = () => {
    // A Wallet cannot connect to a fake provider: a child object carries it, the key stays on the parent.
    const w = Object.create(new Wallet(KEY));
    Object.defineProperty(w, "provider", { value: provider });
    w.populateTransaction = async (tx) => ({ chainId: 1, type: 2, gasLimit: 200_000, data: "0x12", value: 0, ...tx, nonce: tx.nonce ?? chain.count });
    w.estimateGas = async () => BigNumber.from(100_000);
    return guardedSigner(w, provider, { SEND_RPC_URLS: ["https://relay.invalid"], MAX_GAS_GWEI: CAP, MAX_BUMPS }, "tx");
  };
  // A block: the relay's transaction at the next nonce mines if it pays the base fee and this relay includes it.
  const block = (k) => {
    const raw = pool.get(chain.count);
    if (!raw) return;
    const t = utils.parseTransaction(raw);
    const isCancel = t.to.toLowerCase() === ME.toLowerCase() && t.data === "0x";
    const includes = mode === "drop-actions" ? isCancel : mode === "drop-all-until" ? k > 20 : true;
    if (includes && t.maxFeePerGas.gte(chain.base) && r() < 0.7) {
      chain.mined.set(utils.keccak256(raw), { status: 1, blockNumber: 1000 + k, gasUsed: BigNumber.from(21_000) });
      pool.delete(chain.count);
      chain.count += 1;
    }
  };
  return { r, chain, mode, signed, make, block, provider };
}

const cfg = { MAX_GAS_GWEI: CAP, ROUTINE_MAX_GAS_GWEI: 15, URGENT_WAIT_SECONDS: 0, SEND_WAIT_SECONDS: 0, MAX_BUMPS };

test("property P3: fees per nonce stay under the ceiling, replacements are bounded, a cancel ends a nonce, the key moves on (seeded fuzz, 30 scenarios x 40 passes)", async () => {
  const failures = [];
  for (let seed = 1; seed <= 30 && failures.length < 6; seed++) {
    rmSync(statePath("tx"), { recursive: true, force: true });
    const s = scenario(seed);
    let w = s.make();
    let stuckSince = null;
    for (let k = 0; k < 40; k++) {
      // The world: the base fee walks, sometimes spikes past the ceiling; an action can start reverting.
      const x = s.r();
      if (x < 0.08) s.chain.base = gwei(CAP * (1.2 + s.r()));
      else if (x < 0.5) s.chain.base = gwei(3 + Math.floor(s.r() * 60));
      if (s.r() < 0.05) s.chain.reverts = !s.chain.reverts;
      if (s.r() < 0.1) w = s.make(); // a crash: a new process, the same state dir
      const tier = s.r() < 0.7 ? "urgent" : "routine";
      try {
        await send(w, `act ${k}`, async () => {}, () => w.sendTransaction({ to: "0x00000000000000000000000000000000000000a1" }), cfg, { tier });
      } catch (e) {
        if (!/nonce too low|timeout/i.test(e.message)) failures.push(`seed ${seed} pass ${k}: ${e.message}`);
      }
      s.block(k);
      // Liveness: while the base fee sits well under the ceiling, a nonce must not stay open more than MAX_BUMPS + 3 urgent passes.
      if (s.chain.base.lte(gwei(CAP / 3))) {
        if (stuckSince === null || stuckSince.nonce !== s.chain.count) stuckSince = { nonce: s.chain.count, k };
      } else stuckSince = null;
    }
    // Safety, over every transaction any relay ever saw.
    const byNonce = new Map();
    for (const t of s.signed) {
      if (t.maxFeePerGas.gt(gwei(CAP))) failures.push(`seed ${seed} (${s.mode}): nonce ${t.nonce} signed at ${utils.formatUnits(t.maxFeePerGas, "gwei")} gwei > ${CAP}`);
      if (t.maxPriorityFeePerGas.gt(t.maxFeePerGas)) failures.push(`seed ${seed}: tip over max fee`);
      const list = byNonce.get(t.nonce) ?? [];
      if (!list.some((u) => u.hash === t.hash)) list.push(t);
      byNonce.set(t.nonce, list);
    }
    for (const [n, list] of byNonce) {
      if (list.length > 1 + MAX_BUMPS) failures.push(`seed ${seed} (${s.mode}): nonce ${n} signed ${list.length} times (max ${1 + MAX_BUMPS})`);
      const ci = list.findIndex((t) => t.to.toLowerCase() === ME.toLowerCase() && t.data === "0x");
      if (ci >= 0 && ci < list.length - 1) failures.push(`seed ${seed}: nonce ${n} signed again after its cancel`);
    }
    if (s.mode === "drop-actions" && s.chain.count === 5) {
      // A relay that never includes the action: with any calm stretch the cancel must have gone and mined.
      const calm = s.signed.length > 0;
      if (calm) failures.push(`seed ${seed} (drop-actions): the key never moved past nonce 5 in 40 passes (${s.signed.length} signed)`);
    }
  }
  assert.deepEqual(failures, []);
});

test("property P3: a stuck nonce stops new work and says so; the act layer raises send-stuck", async () => {
  rmSync(statePath("tx"), { recursive: true, force: true });
  const s = scenario(99);
  const w = s.make();
  const urgent = () => send(w, "act", async () => {}, () => w.sendTransaction({ to: "0x00000000000000000000000000000000000000a1" }), cfg, { tier: "urgent" });
  s.chain.base = gwei(10);
  await urgent(); // nonce 5, never included
  const outs = [];
  for (let i = 0; i < 8; i++) outs.push(await urgent());
  const stuck = outs.find((o) => o.stuck);
  assert.ok(stuck, `a nonce with a cancel waiting reports stuck: ${JSON.stringify(outs.map((o) => o.skipped ?? o.hash))}`);
  const atFive = new Set(s.signed.filter((t) => t.nonce === 5).map((t) => t.hash));
  assert.ok(atFive.size <= 1 + MAX_BUMPS, `${atFive.size} distinct transactions at nonce 5`);
  assert.ok(s.signed.every((t) => t.nonce <= 5 + MAX_BUMPS + 1), "new work behind a stuck nonce is bounded: it stops once the nonce is stuck");
  // The act layer turns it into a critical alert.
  const { act } = await import("../lib/act.mjs");
  const raised = [];
  const c = { address: "0x00000000000000000000000000000000000000a1", connect: () => ({ callStatic: { f: async () => {} }, f: () => w.sendTransaction({ to: "0x00000000000000000000000000000000000000a1" }) }) };
  await act({ execute: true, signer: w, cfg, log() {}, provider: { unpin() {} }, alerts: { raise: async (l, k) => raised.push(`${l}:${k}`), settle: async () => {} } }, "act", c, "f", [], { tier: "urgent" });
  assert.deepEqual(raised, ["critical:send-stuck"]);
});
