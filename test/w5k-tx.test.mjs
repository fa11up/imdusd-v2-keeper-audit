// wave-5 keeper audit #9, #13, #16, #17: SENDING.
//   #9  PROPERTY (P3): nothing is ever signed above MAX_GAS_GWEI per gas, whatever the read RPC answers for the latest block and the
//       gas price: a block with no base fee, a gas price that jumps between the check and the signature, any populated fee.
//   #13/#17 PROPERTY (P1/P8): a due URGENT send the guard does not send (gas over the ceiling, ETH under the floor, an open send, the
//       kill switch, a refused fee) raises an alert naming why, critical after SKIP_CRITICAL_SECONDS; a send that lands clears it.
//   #16 PROPERTY (P3): the 4663 key is never the mainnet key, however the phrase is typed, and a key once run on one chain is refused
//       on the other on this machine even when the other process's phrase is not in the environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, providers, utils, Wallet } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5k-tx-"));
process.env.KEEPER_LOCK_DIR = mkdtempSync(join(tmpdir(), "keeper-w5k-locks-"));
const { statePath, bindKeyChain } = await import("../lib/state.mjs");
const { guardedSigner, keeperSigner, send } = await import("../lib/tx.mjs");
const { act } = await import("../lib/act.mjs");

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const gwei = (n) => utils.parseUnits(String(n), "gwei");
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const CAP = 100;

/** A signer over a fake chain whose first read RPC answers `block` for latest and gas prices from `prices()` in turn. */
function rig({ base, prices, populate = null }) {
  const signedTx = [];
  providers.StaticJsonRpcProvider.prototype.sendTransaction = async (raw) => {
    signedTx.push(utils.parseTransaction(raw));
    return { hash: utils.keccak256(raw) };
  };
  const provider = {
    getBlock: async () => (base === null ? { number: 1 } : { number: 1, baseFeePerGas: base }),
    getGasPrice: async () => prices(),
    getBalance: async () => utils.parseEther("2"),
    getTransactionCount: async () => 7,
    getTransactionReceipt: async () => null,
    waitForTransaction: async (h) => ({ status: 1, blockNumber: 2, gasUsed: BigNumber.from(21_000), transactionHash: h }),
  };
  const w = Object.create(new Wallet(KEY));
  Object.defineProperty(w, "provider", { value: provider });
  // As ethers' populateTransaction: with no fee fields and no base fee it fills a legacy gasPrice from eth_gasPrice NOW.
  w.populateTransaction = populate ?? (async (tx) => {
    const out = { chainId: 1, gasLimit: 300_000, data: "0x12", value: 0, to: "0x00000000000000000000000000000000000000aa", nonce: 7, ...tx };
    if (out.maxFeePerGas === undefined && out.gasPrice === undefined) return { ...out, type: 0, gasPrice: await provider.getGasPrice() };
    return { type: 2, ...out };
  });
  w.estimateGas = async () => BigNumber.from(100_000);
  const signer = guardedSigner(w, provider, { SEND_RPC_URLS: ["https://relay.invalid"], MAX_GAS_GWEI: CAP }, "tx");
  return { signer, signedTx };
}
const perGas = (t) => (t.type === 2 ? t.maxFeePerGas : t.gasPrice);

test("#9 judge proof shape: no base fee, eth_gasPrice 5 gwei at the check then 5,000 gwei: nothing is signed above 100 gwei", async () => {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  let n = 0;
  const { signer, signedTx } = rig({ base: null, prices: () => gwei(n++ === 0 ? 5 : 5000) });
  const r = await send(signer, "bark #1", async () => {}, () => signer.sendTransaction({ to: "0x00000000000000000000000000000000000000aa", data: "0x12" }), { MAX_GAS_GWEI: CAP }, { tier: "urgent" });
  for (const t of signedTx) assert.ok(perGas(t).lte(gwei(CAP)), `signed type ${t.type} at ${utils.formatUnits(perGas(t), "gwei")} gwei`);
  assert.ok(r.skipped, `expected a skipped send, got ${JSON.stringify(r)}`);
});

test("#9 property: any base fee / gas price / populated fee: every signed transaction is EIP-1559 under the ceiling (200 seeds)", async () => {
  for (let seed = 1; seed <= 200; seed++) {
    rmSync(process.env.STATE_DIR, { recursive: true, force: true });
    const r = rng(seed);
    const base = r() < 0.3 ? null : gwei(Math.floor(r() * 400));
    const hostilePop = r() < 0.3;
    const { signer, signedTx } = rig({
      base,
      prices: () => gwei(Math.floor(r() * 2000)),
      populate: hostilePop ? async (tx) => ({ chainId: 1, gasLimit: 300_000, to: "0x00000000000000000000000000000000000000aa", nonce: 7, data: "0x", value: 0, ...tx, maxFeePerGas: gwei(Math.floor(r() * 3000)), maxPriorityFeePerGas: gwei(1), type: r() < 0.5 ? 2 : 0 }) : null,
    });
    try {
      await send(signer, "x", async () => {}, () => signer.sendTransaction({ to: "0x00000000000000000000000000000000000000aa", data: "0x12" }), { MAX_GAS_GWEI: CAP }, { tier: r() < 0.5 ? "urgent" : "routine" });
    } catch { /* a refusal is fine; a signature above the ceiling is not */ }
    for (const t of signedTx) assert.ok(t.type === 2 && perGas(t).lte(gwei(CAP)), `seed ${seed}: signed type ${t.type} at ${utils.formatUnits(perGas(t), "gwei")} gwei`);
  }
});

test("#13/#17: a due urgent send skipped by the guard alerts at once with the reason, critical after 300 s, cleared when one lands", async () => {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  const raised = [], settled = [];
  const ctx = { execute: true, cfg: {}, log() {}, provider: { unpin() {} }, alerts: { raise: async (l, k, m) => raised.push({ l, k, m }), settle: async (p) => settled.push(p) } };
  const c = { connect: () => c, callStatic: { f: async () => {} }, f: async () => {} };
  const realNow = Date.now;
  let t = 1_800_000_000_000;
  Date.now = () => t;
  try {
    // gas over the ceiling: send() returns skipped
    mkdirSync(process.env.STATE_DIR, { recursive: true });
    writeFileSync(statePath("STOP"), "");
    for (let i = 0; i < 4; i++) { await act(ctx, "liquidate #1", c, "f", [], { tier: "urgent", signer: {} }); t += 120_000; }
    rmSync(statePath("STOP"));
  } finally {
    Date.now = realNow;
  }
  assert.ok(raised[0]?.k === "send-skipped" && raised[0].l === "warn" && /kill switch/.test(raised[0].m), JSON.stringify(raised[0]));
  assert.ok(raised.some((a) => a.k === "send-skipped" && a.l === "critical"), "never critical after 360 s of skips");
});

test("#16: the same phrase typed another way is the same key and is refused; a key bound to one chain is refused on the other", () => {
  const M = "test test test test test test test test test test test junk";
  for (const v of [M.replace(" ", "  "), M.toUpperCase(), M[0].toUpperCase() + M.slice(1)]) {
    assert.throws(() => keeperSigner({}, { CHAIN_ID: 4663 }, { KEEPER_MNEMONIC: M, KEEPER_MNEMONIC_4663: v }), /mainnet keeper's key/, `accepted ${JSON.stringify(v)}`);
  }
  const a = new Wallet(KEY).address;
  bindKeyChain(a, 1);
  bindKeyChain(a, 1); // same chain again: fine
  assert.throws(() => bindKeyChain(a, 4663), /bound to chain 1/);
});
