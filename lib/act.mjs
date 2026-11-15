// One way to act, for every loop: report-only mode simulates and says what would be sent; --execute sends through lib/tx.mjs,
// then forgets the pinned read block so the next reads see the transaction.
import { describe, send } from "./tx.mjs";

/**
 * `contract[fn](...args)` as `label`. `fn` may be a full signature for an overloaded function.
 * Returns the lib/tx.mjs result, or { watch, ok, reason } in report-only mode. opts: { tier, signer, from }: another
 * signer than the keeper's (the guardian) and, in report-only mode, who to simulate as.
 */
export async function act(ctx, label, contract, fn, args = [], opts = {}) {
  const { log } = ctx;
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
  const r = await send(signer, label, () => c.callStatic[fn](...args), () => c[fn](...args), ctx.cfg, sendOpts);
  ctx.provider.unpin?.();
  log(`${label.padEnd(28)} ${describe(r)}`);
  return r;
}

export const reasonOf = (e) => e.errorName || e.reason || String(e.shortMessage ?? e.message).slice(0, 120);
export const landed = (r) => Boolean(r?.hash) || (r?.watch && r.ok);

/** The chain's own clock: the latest block. */
export async function head(provider) {
  const b = await provider.getBlock("latest");
  return { number: b.number, now: b.timestamp };
}
