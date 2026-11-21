// One way to act, for every loop: report-only mode simulates and says what would be sent; --execute sends through lib/tx.mjs,
// then forgets the pinned read block so the next reads see the transaction.
import { readStateOr, writeState } from "./state.mjs";
import { describe, send } from "./tx.mjs";

/**
 * `contract[fn](...args)` as `label`. `fn` may be a full signature for an overloaded function.
 * Returns the lib/tx.mjs result, or { watch, ok, reason } in report-only mode. opts: { tier, signer, from }: another
 * signer than the keeper's (the guardian) and, in report-only mode, who to simulate as.
 */
export async function act(ctx, label, contract, fn, args = [], opts = {}) {
  const { log } = ctx;
  // Test seam: the 4663 duty tests record every act here instead of simulating against a fake contract. Never set in production.
  if (ctx.actHook) return ctx.actHook(label, contract, fn, args, opts);
  const { signer = ctx.signer, from = ctx.keeperAddress, ...sendOpts } = opts;
  if (!ctx.execute) {
    try {
      await contract.callStatic[fn](...args, from ? { from } : {});
      log(`would   ${label}`);
      return { watch: true, ok: true };
    } catch (e) {
      const reason = reasonOf(e);
      log(`would   ${label}: simulation refuses (${reason})`);
      return { watch: true, ok: false, refused: reason };
    }
  }
  const c = contract.connect(signer);
  const r = await withSendLock(ctx, () => send(signer, label, () => c.callStatic[fn](...args), () => c[fn](...args), ctx.cfg, sendOpts));
  ctx.provider.unpin?.();
  log(`${label.padEnd(28)} ${describe(r)}`);
  // A nonce the keeper can do nothing more for holds every send behind it: that is an incident (audit wave 4, P3).
  if (r.stuck) await ctx.alerts?.raise?.("critical", "send-stuck", `${r.stuck.why}: every send waits behind nonce ${r.stuck.nonce}`)?.catch(() => {});
  else if (r.hash) await ctx.alerts?.settle?.("send-stuck", new Set())?.catch(() => {});
  // A DUE urgent send the guard did not send (gas over the ceiling, ETH under the floor, an earlier send open, the kill switch, a fee
  // that could not be bounded) is an incident, not a log line (wave-5 audit #13/#17): warn at once with the reason, critical once
  // urgent sends have been skipped for SKIP_CRITICAL_SECONDS (300) with none landing; cleared by the next send that lands.
  if ((sendOpts.tier ?? "urgent") === "urgent" && r.skipped && !r.pending && !r.stuck) {
    const now = Math.floor(Date.now() / 1000);
    const st = readStateOr("send-skips.json", {});
    // A new run of skips after a quiet gap starts its own clock (internal review after wave 5: an old `since` made the first skip critical).
    if (st.last !== undefined && now - st.last > (ctx.cfg.SKIP_CRITICAL_SECONDS ?? 300)) delete st.since;
    st.since ??= now;
    st.last = now;
    writeState("send-skips.json", st);
    const level = now - st.since >= (ctx.cfg.SKIP_CRITICAL_SECONDS ?? 300) ? "critical" : "warn";
    await ctx.alerts?.raise?.(level, "send-skipped", `urgent sends are not going out (for ${now - st.since}s): ${label}: ${r.skipped}`)?.catch(() => {});
  } else if (r.hash && (sendOpts.tier ?? "urgent") === "urgent") {
    // Only a landed URGENT send shows urgent sends going out again (a review before wave 5b: a routine one proves less).
    if (readStateOr("send-skips.json", {}).since !== undefined) writeState("send-skips.json", {});
    await ctx.alerts?.settle?.("send-skipped", new Set())?.catch(() => {});
  }
  return r;
}

/** Run `fn` holding the send lock: one send (or journal settlement) at a time across every lane (keeper.mjs runLanes); the nonce
 *  journal and the fee bumps assume it. */
export async function withSendLock(ctx, fn) {
  const prev = ctx.sendLock ?? Promise.resolve();
  let release;
  ctx.sendLock = prev.then(() => new Promise((res) => (release = res)));
  await prev;
  try {
    return await fn();
  } finally {
    release?.();
  }
}

export const reasonOf = (e) => e.errorName || e.reason || String(e.shortMessage ?? e.message).slice(0, 120);
export const landed = (r) => Boolean(r?.hash) || Boolean(r?.watch && r.ok);

/** The chain's own clock: the latest block. */
export async function head(provider) {
  const b = await provider.getBlock("latest");
  return { number: b.number, now: b.timestamp };
}
