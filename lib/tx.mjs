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
import { envName, hostOf } from "./chain.mjs";
import { expandUrls } from "./chains.mjs";
import { clearIntent, logStep, pendingIntents, recordIntent, settleIntents } from "./journal.mjs";
import { statePath } from "./state.mjs";

/** Mainnet: SEND_RPC_URLS (unchanged). Another chain: SEND_RPC_URLS_<chainId> or its config section, `${NAME}` placeholders filled. */
export const sendUrls = (cfg, env = process.env) => expandUrls(env[envName(cfg, "SEND_RPC_URLS")]?.split(",") ?? cfg.SEND_RPC_URLS ?? [], env).urls;

const URGENT_WAIT_MS = 60_000;
/** Replacements one nonce may get; the last is a 0-value send to self (a cancel), so a stuck action never wedges the key. */
const MAX_BUMPS = 4;
const gwei = (n) => utils.parseUnits(String(n), "gwei");
/** The most any transaction this keeper signs may offer per gas: the tier's gas ceiling. */
export const feeCeiling = (cfg, tier = "urgent") => gwei(tier === "routine" ? cfg.ROUTINE_MAX_GAS_GWEI ?? 15 : cfg.MAX_GAS_GWEI ?? 100);
const min = (a, b) => (a.lt(b) ? a : b);
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

/**
 * Before --execute takes a key: a transaction of this key in the public mempool that this state dir's journal does not hold means
 * someone else is sending with it (another keeper, another machine, a human). Returns the reason to refuse, or null. A private send
 * by the other writer is invisible here: this is a check, not a lock (audit wave 4, P3 residual).
 */
export async function foreignPending(provider, address, scope = "tx") {
  const [latest, pending] = await Promise.all([provider.getTransactionCount(address, "latest"), provider.getTransactionCount(address, "pending")]);
  if (pending <= latest) return null;
  const mine = new Set(pendingIntents(scope).map((i) => i.nonce));
  for (let n = latest; n < pending; n++) if (!mine.has(n)) return `nonce ${n} of ${address} is pending in the mempool and this state dir never signed it: another writer is using this key`;
  return null;
}

/** The key's environment variable: KEEPER_MNEMONIC on mainnet (unchanged), cfg.MNEMONIC_ENV elsewhere (4663: KEEPER_MNEMONIC_4663). A
 *  chain other than mainnet NEVER falls back to KEEPER_MNEMONIC: two chains on one key would share no journal and no spend cap. */
export const mnemonicEnv = (cfg) => (Number(cfg.CHAIN_ID ?? 1) === 1 ? "KEEPER_MNEMONIC" : cfg.MNEMONIC_ENV ?? `KEEPER_MNEMONIC_${Number(cfg.CHAIN_ID)}`);

export function keeperSigner(provider, cfg, env = process.env) {
  const name = mnemonicEnv(cfg);
  if (!env[name]) throw new Error(`--execute needs ${name} in the environment`);
  if (name !== "KEEPER_MNEMONIC" && env.KEEPER_MNEMONIC && env.KEEPER_MNEMONIC.trim() === env[name].trim()) {
    throw new Error(`${name} is the mainnet keeper's KEEPER_MNEMONIC: each chain runs on its own key`);
  }
  return guardedSigner(Wallet.fromMnemonic(env[name]).connect(provider), provider, cfg, "tx");
}

/** There is no guardian key: the Allocator's freezer is the Safe. A key left in the environment is refused, not ignored. */
export function refuseGuardianKey(env = process.env) {
  if (env.GUARDIAN_PRIVATE_KEY) throw new Error("GUARDIAN_PRIVATE_KEY is set, but the keeper has no guardian key any more (the Safe freezes the Allocator): unset it and destroy the key");
}

export function guardedSigner(signer, provider, cfg, scope) {
  const out = sendProvider(cfg);
  // ethers' Contract wraps `wait` and passes on only the confirmations, so the bound must be the default here, not an argument.
  const waitMs = (cfg.SEND_WAIT_SECONDS ?? 90) * 1000;
  // Never more per gas than the tier's ceiling (audit wave 4, P3): base x 2 + tip, capped. A NEW transaction stays one replacement
  // step (12.5%) under it, so a cancel at or under the ceiling can always replace it.
  const feesNow = async (tier, { headroom = false } = {}) => {
    const fees = cfg.FEES?.[tier ?? "urgent"] ?? {};
    const full = feeCeiling(cfg, tier ?? "urgent");
    const cap = headroom ? full.mul(10_000).div(BUMP_BPS) : full;
    const base = (await provider.getBlock("latest")).baseFeePerGas;
    if (!base) return null;
    const max = min(base.mul(2).add(gwei(fees.tipGwei ?? 0.3)), cap);
    return { maxPriorityFeePerGas: min(gwei(fees.tipGwei ?? 0.3), max), maxFeePerGas: max };
  };
  const maxBumps = cfg.MAX_BUMPS ?? MAX_BUMPS;
  signer.journalScope = scope;
  signer.rebroadcast = (raw) => out.sendTransaction(raw);
  /**
   * Re-send an open transaction on its own nonce, at fees a node takes as its replacement (audit wave 4, P3: bounded).
   * Every replacement stays under the urgent ceiling, and a nonce gets at most `MAX_BUMPS`. The last one, or the first when the
   * action would now revert (a revert-protected relay never includes it), is a CANCEL: a 0-value send to self, which any relay
   * includes, so the key moves on. Returns { hash, cancel } when a replacement went, { stuck } when none can go now (no replacement
   * under the ceiling, or the cancel itself is waiting), or null when this transaction cannot be replaced (not type 2).
   */
  signer.bump = async (intent) => {
    const t = utils.parseTransaction(intent.signed);
    const bumps = intent.bumps ?? 0;
    if (intent.cancel) return { stuck: `nonce ${t.nonce}: its cancel (${intent.hash}) is waiting to be mined; nothing more is signed on it` };
    const now = await feesNow("urgent");
    if (t.type !== 2 || !now) return null;
    const cap = feeCeiling(cfg, "urgent");
    const fees = bumpFees(t, now);
    if (fees.maxFeePerGas.gt(cap)) return { stuck: `nonce ${t.nonce} (${intent.label}): a replacement needs ${utils.formatUnits(fees.maxFeePerGas, "gwei")} gwei, over the ${utils.formatUnits(cap, "gwei")} ceiling` };
    let reverts = false;
    if (provider.call) {
      try {
        await provider.call({ from: signer.address, to: t.to, data: t.data, value: t.value });
      } catch (e) {
        reverts = e?.code === "CALL_EXCEPTION";
      }
    }
    // The last replacement this nonce may get, or the last one the ceiling leaves room for, is the cancel.
    const cancel = reverts || bumps + 1 >= maxBumps || bumpFees(fees, now).maxFeePerGas.gt(cap);
    const body = cancel ? { to: signer.address, data: "0x", value: 0, gasLimit: 21_000 } : { to: t.to, data: t.data, value: t.value, gasLimit: t.gasLimit };
    const signed = await signer.signTransaction({ type: 2, chainId: t.chainId, nonce: t.nonce, ...body, ...fees });
    const hash = utils.keccak256(signed);
    const label = cancel ? `cancel nonce ${t.nonce} (was ${intent.cancelOf ?? intent.label}${reverts ? ", now reverts" : ""})` : intent.label;
    recordIntent({ nonce: t.nonce, hash, signed, label, bumps: bumps + 1, firstAt: intent.firstAt ?? intent.at, ...(cancel ? { cancel: true, cancelOf: intent.label } : {}) }, scope);
    try {
      await out.sendTransaction(signed);
    } catch (e) {
      if (REFUSED.test(text(e))) recordIntent(intent, scope); // refused: the original stays the open one
      throw e;
    }
    return { hash, cancel };
  };
  signer.sendTransaction = async (tx) => {
    if (tx.maxPriorityFeePerGas === undefined && tx.gasPrice === undefined) {
      const fees = await feesNow(signer.feeTier, { headroom: true });
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
    // Urgent work past a stuck send: raise the stuck one's fees on its own nonce, so it can mine, then go out after it. Bounded per
    // nonce and under the ceiling; a nonce nothing more can be done for stops new work (it could not mine behind it) and says so.
    for (const it of open) {
      if (!signer.bump) break;
      try {
        const b = await signer.bump(it);
        if (b?.hash) logStep(b.cancel ? "cancel-sent" : "fee-raised", { nonce: it.nonce, from: it.hash, to: b.hash, label: it.label, scope: signer.journalScope ?? "tx" });
        if (b?.stuck) {
          logStep("nonce-stuck", { nonce: it.nonce, hash: it.hash, why: b.stuck, scope: signer.journalScope ?? "tx" });
          return { skipped: `${b.stuck}: ${label} not sent`, stuck: { nonce: it.nonce, why: b.stuck } };
        }
      } catch (e) {
        logStep("fee-raise-refused", { nonce: it.nonce, hash: it.hash, why: String(e?.message ?? e).slice(0, 200) });
      }
    }
  }
  const [gasPrice, balance] = await Promise.all([provider.getGasPrice(), provider.getBalance(signer.address)]);
  const routine = tier === "routine";
  // A new send must leave one replacement step under the ceiling (P3): above ceiling / 1.125 it could only ever be cancelled.
  const sendCap = feeCeiling(cfg, tier).mul(10_000).div(BUMP_BPS);
  if (gasPrice.gt(sendCap)) {
    return { skipped: `gas ${utils.formatUnits(gasPrice, "gwei")} gwei above the ${tier} sending ceiling ${utils.formatUnits(sendCap, "gwei")} (${tier === "routine" ? "ROUTINE_MAX_GAS_GWEI" : "MAX_GAS_GWEI"} / 1.125)` };
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
