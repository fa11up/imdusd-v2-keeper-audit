// Every transaction goes through here, so the guard rails live in one place (carried over from the v1 keeper).
//
//   - a KILL SWITCH: the file <state>/STOP makes every send refuse, without restarting the daemon;
//   - a GAS CEILING per tier: nothing is sent while the network's gas price is above it. Defence and liquidations get the
//     high ceiling, a depth sample the low one;
//   - TWO ETH FLOORS: routine sends stop at ROUTINE_MIN_ETH, so housekeeping never eats the gas defence needs;
//   - SIMULATE FIRST: a doomed transaction costs nothing and its revert reason is logged;
//   - A GAS MARGIN: estimate + GAS_MARGIN_BPS (the node estimates against an earlier timestamp);
//   - PRIVATE SEND: signed transactions go only to SEND_RPC_URLS. A public sample shows anyone where to sandwich,
//     and a public liquidation can be front-run. --execute refuses to start with none (test/fork sets ALLOW_PUBLIC_SEND).
//     A signed transaction may be handed to the next RPC: it is the same hash and nonce, so at most one copy is mined.
import { existsSync } from "node:fs";
import { providers, utils, Wallet } from "ethers";
import { hostOf } from "./chain.mjs";
import { clearIntent, logStep, pendingIntents, recordIntent, settleIntents } from "./journal.mjs";
import { statePath } from "./state.mjs";

export const sendUrls = (cfg, env = process.env) => (env.SEND_RPC_URLS?.split(",") ?? cfg.SEND_RPC_URLS ?? []).map((u) => u.trim()).filter(Boolean);

const URGENT_WAIT_MS = 60_000;
/** A replacement must beat the open transaction's fees by 10% to be accepted; 12.5% leaves room for rounding. */
const BUMP_BPS = 11_250;

/** Pure: fees for re-sending an open transaction on its own nonce: each at least 12.5% over the old, and no lower than now's. */
export function bumpFees(old, now) {
  const up = (v) => v.mul(BUMP_BPS).add(9_999).div(10_000);
  const tip = up(old.maxPriorityFeePerGas).gt(now.maxPriorityFeePerGas) ? up(old.maxPriorityFeePerGas) : now.maxPriorityFeePerGas;
  const max = up(old.maxFeePerGas).gt(now.maxFeePerGas) ? up(old.maxFeePerGas) : now.maxFeePerGas;
  return { maxPriorityFeePerGas: tip, maxFeePerGas: max.gt(tip) ? max : tip };
}

/** Pure: the nonce a NEW action takes: after every transaction this key still has open, whatever the read node can see. */
export const nextNonce = (chainPending, openNonces) => Math.max(chainPending, ...openNonces.map((n) => n + 1));
const REFUSED = /nonce too low|nonce has already been used|insufficient funds|underpriced|intrinsic gas|exceeds block gas limit|invalid sender|max fee per gas less than/i;
const KNOWN = /already known|known transaction|alreadyknown|already imported|already in (the )?(mempool|pool)/i;
const text = (e) => [e?.message, e?.error?.message, e?.body, e?.reason].filter(Boolean).join(" ");

export function sendProvider(cfg, { make = (url) => new providers.StaticJsonRpcProvider({ url, timeout: 20_000 }, cfg.CHAIN_ID ?? 1), log = console.log } = {}) {
  const outs = sendUrls(cfg).map((url) => ({ url, p: make(url) }));
  const scrub = (e) => {
    for (const k of ["message", "reason", "body", "url"]) {
      if (typeof e?.[k] !== "string") continue;
      for (const { url } of outs) e[k] = e[k].split(url).join(hostOf(url));
    }
    if (e?.error) scrub(e.error);
    return e;
  };
  return {
    urls: outs.map((o) => o.url),
    async sendTransaction(signed) {
      const hash = utils.keccak256(signed);
      let last;
      for (const [i, { url, p }] of outs.entries()) {
        try {
          const res = await p.sendTransaction(signed);
          if (i > 0) log(`send: ${hostOf(outs[0].url)} failed (${text(last).slice(0, 100)}); sent via ${hostOf(url)}`);
          return res;
        } catch (err) {
          const e = scrub(err);
          if (KNOWN.test(text(e))) return outs[0].p._wrapTransaction(utils.parseTransaction(signed), hash);
          if (REFUSED.test(text(e))) throw e;
          last = e;
        }
      }
      throw last;
    },
  };
}

export function keeperSigner(provider, cfg) {
  if (!process.env.KEEPER_MNEMONIC) throw new Error("--execute needs KEEPER_MNEMONIC in the environment");
  return guardedSigner(Wallet.fromMnemonic(process.env.KEEPER_MNEMONIC).connect(provider), provider, cfg, "tx");
}

/** There is no guardian key: the Allocator's freezer is the Safe. A key left in the environment is refused, not ignored. */
export function refuseGuardianKey(env = process.env) {
  if (env.GUARDIAN_PRIVATE_KEY) throw new Error("GUARDIAN_PRIVATE_KEY is set, but the keeper has no guardian key any more (the Safe freezes the Allocator): unset it and destroy the key");
}

export function guardedSigner(signer, provider, cfg, scope) {
  const out = sendProvider(cfg);
  // ethers' Contract wraps `wait` and passes on only the confirmations, so the bound must be the default here, not an argument.
  const waitMs = (cfg.SEND_WAIT_SECONDS ?? 90) * 1000;
  const feesNow = async (tier) => {
    const fees = cfg.FEES?.[tier ?? "urgent"] ?? {};
    const tip = utils.parseUnits(String(fees.tipGwei ?? 0.3), "gwei");
    const base = (await provider.getBlock("latest")).baseFeePerGas;
    return base ? { maxPriorityFeePerGas: tip, maxFeePerGas: base.mul(2).add(tip) } : null;
  };
  signer.journalScope = scope;
  signer.rebroadcast = (raw) => out.sendTransaction(raw);
  /** Re-send an open transaction, the same action on its own nonce, at fees a node will take as its replacement. */
  signer.bump = async (intent) => {
    const t = utils.parseTransaction(intent.signed);
    const now = await feesNow("urgent");
    if (t.type !== 2 || !now) return null;
    const fees = bumpFees(t, now);
    const signed = await signer.signTransaction({ type: 2, chainId: t.chainId, nonce: t.nonce, to: t.to, data: t.data, value: t.value, gasLimit: t.gasLimit, ...fees });
    const hash = utils.keccak256(signed);
    recordIntent({ nonce: t.nonce, hash, signed, label: intent.label }, scope);
    try {
      await out.sendTransaction(signed);
    } catch (e) {
      if (REFUSED.test(text(e))) recordIntent(intent, scope); // refused: the original stays the open one
      throw e;
    }
    return hash;
  };
  signer.sendTransaction = async (tx) => {
    if (tx.maxPriorityFeePerGas === undefined && tx.gasPrice === undefined) {
      const fees = await feesNow(signer.feeTier);
      if (fees) tx = { ...tx, type: 2, ...fees };
    }
    // A new action never takes the nonce of a send still open: that would replace it, and drop what it did.
    const open = pendingIntents(scope);
    if (open.length && tx.nonce === undefined) {
      tx = { ...tx, nonce: nextNonce(await provider.getTransactionCount(signer.address, "pending"), open.map((i) => i.nonce)) };
    }
    const signed = await signer.signTransaction(await signer.populateTransaction(tx));
    const { nonce } = utils.parseTransaction(signed);
    const hash = utils.keccak256(signed);
    const replaced = pendingIntents(scope).find((i) => i.nonce === nonce);
    recordIntent({ nonce, hash, signed, label: signer.sendLabel }, scope);
    let res;
    try {
      res = await out.sendTransaction(signed);
    } catch (e) {
      // Refused outright, it can never be mined as signed. Anything else may have reached a node, so the intent stays to be settled.
      if (REFUSED.test(text(e))) {
        clearIntent(nonce, "refused", { hash, why: text(e).slice(0, 200) }, scope);
        if (replaced) recordIntent(replaced, scope); // the replacement lost: the original is still the open one
      }
      throw e;
    }
    res.wait = async (confirms = 1, timeoutMs = waitMs) => {
      const rc = await provider.waitForTransaction(res.hash, confirms, timeoutMs);
      if (!rc) throw new Error(`${res.hash}: no receipt within ${timeoutMs / 1000}s`);
      clearIntent(nonce, rc.status === 0 ? "reverted" : "mined", { hash, block: rc.blockNumber }, scope);
      if (rc.status === 0) throw new Error(`${res.hash} reverted`);
      return rc;
    };
    return res;
  };
  const bps = 10_000 + Number(cfg.GAS_MARGIN_BPS ?? 2_500);
  const estimate = signer.estimateGas.bind(signer);
  signer.estimateGas = async (tx) => (await estimate(tx)).mul(bps).div(10_000);
  return signer;
}

/** tier "routine" (depth, peg, seat clock) or "urgent" (liquidations, ticks, relays, freeze). */
export async function send(signer, label, simulate, sendIt, cfg, { tier = "urgent" } = {}) {
  if (existsSync(statePath("STOP"))) return { skipped: `kill switch: state/STOP exists, ${label} not sent` };
  const provider = signer.provider;
  // What a previous run left comes first: deciding again while its transaction is open is how a step gets paid for twice.
  if (signer.rebroadcast) {
    const open = await settleIntents(provider, signer.address, signer.rebroadcast, signer.journalScope ?? "tx");
    // A stuck low-fee send must not hold defence or a liquidation back: past the wait, an urgent send replaces it on the same nonce, so only one is ever mined.
    const urgentWaitMs = (cfg.URGENT_WAIT_SECONDS ?? URGENT_WAIT_MS / 1000) * 1000;
    const held = tier === "urgent" ? open.filter((i) => Date.now() - Date.parse(i.at) < urgentWaitMs) : open;
    if (held.length) return { skipped: `waiting on ${held[0].label ?? "an earlier send"} (${held[0].hash}, nonce ${held[0].nonce}): ${label} not sent` };
    // Urgent work past a stuck send: raise the stuck one's fees on its own nonce, so it can mine, then go out after it.
    for (const it of open) {
      if (!signer.bump) break;
      try {
        const h = await signer.bump(it);
        if (h) logStep("fee-raised", { nonce: it.nonce, from: it.hash, to: h, label: it.label, scope: signer.journalScope ?? "tx" });
      } catch (e) {
        logStep("fee-raise-refused", { nonce: it.nonce, hash: it.hash, why: String(e?.message ?? e).slice(0, 200) });
      }
    }
  }
  const [gasPrice, balance] = await Promise.all([provider.getGasPrice(), provider.getBalance(signer.address)]);
  const routine = tier === "routine";
  const maxGwei = routine ? cfg.ROUTINE_MAX_GAS_GWEI ?? 15 : cfg.MAX_GAS_GWEI ?? 100;
  if (gasPrice.gt(utils.parseUnits(String(maxGwei), "gwei"))) {
    return { skipped: `gas ${utils.formatUnits(gasPrice, "gwei")} gwei above the ${tier} ceiling ${maxGwei}` };
  }
  const floor = routine ? cfg.ROUTINE_MIN_ETH ?? 0.02 : cfg.MIN_ETH ?? 0.003;
  if (balance.lt(utils.parseEther(String(floor)))) {
    return { skipped: `keeper holds ${utils.formatEther(balance)} ETH, below the ${tier} floor ${floor}: ${label} not sent; top it up` };
  }
  try {
    await simulate();
  } catch (e) {
    return { refused: e.errorName || e.reason || (e.shortMessage ?? e.message).slice(0, 140) };
  }
  signer.feeTier = tier;
  signer.sendLabel = label;
  const tx = await sendIt();
  // One queue runs every loop, the guardian's included, so a stuck send must not hold it. The intent stays open: the next send settles it, and an urgent one replaces it.
  const waitSeconds = cfg.SEND_WAIT_SECONDS ?? 90;
  let rc;
  try {
    rc = await tx.wait(1);
  } catch (e) {
    if (e.code !== "TIMEOUT") throw e;
    return { pending: tx.hash, skipped: `${label}: ${tx.hash} not mined within ${waitSeconds}s, still open` };
  }
  return { hash: tx.hash, block: rc.blockNumber, gas: rc.gasUsed.toString() };
}

export function describe(r) {
  if (r.skipped) return `skipped ${r.skipped}`;
  if (r.refused) return `refused ${r.refused}`;
  return `sent    ${r.hash} (block ${r.block}, gas ${r.gas})`;
}
