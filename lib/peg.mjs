// The peg hook's permissionless acts (src/peg/PegHook.sol). All on the routine gas tier: the hook's TWAP and its toll claims wait for a cheap block.
//   SWEEP.    Toll claims are nobody's until swept: USDC fills the buffer first (the toll a pusher paid is the bid against him), the rest and imdUSD go to the
//             Treasury. Swept once a side's claims reach PEG.sweepMinUsd, or at once for USDC while the TWAP is below the band and the buffer has room.
//   WITHDRAW. TWAP below -25 ticks: folds surplus into the buffer, buys back outstanding imdUSD and burns it to $0.9995 (the caller gets 10% of the profit), then
//             the buffer buys for the Treasury (no reward). Useful without a reward: it is the bid.
//   PROVIDE.  TWAP above +25 ticks, room under the keeper cap, quote sound: mints imdUSD and sells it down to $1.0005 (10% of the realised profit to the caller).
// Each gate is the hook's own; the plan only avoids a doomed simulation and says why nothing happens. The call is simulated and left out under PEG.minTradeUsd.
import { BigNumber, Contract, utils } from "ethers";
import { act, reasonOf } from "./act.mjs";
import { POOL_MANAGER_ABI } from "./deployment.mjs";

const TRIGGER = 25, TARGET = 5;

/** Pure: which of the hook's trades can act, mirroring its gates. `twap` null = no TWAP yet. */
export function pegPlan({ twap, spot, outstanding, buffer, surplus, bufferRoom, cap, quoteSound }) {
  if (twap === null) return { provide: false, withdraw: false, noBid: false, why: "no TWAP yet" };
  const provide = quoteSound && twap > TRIGGER && spot > TARGET && BigNumber.from(outstanding).lt(cap);
  const below = twap < -TRIGGER && spot < -TARGET;
  const fold = BigNumber.from(surplus).lt(bufferRoom) ? BigNumber.from(surplus) : BigNumber.from(bufferRoom);
  const hasOutstanding = !BigNumber.from(outstanding).isZero();
  const bid = quoteSound && BigNumber.from(buffer).add(fold).gt(0);
  const withdraw = below && (hasOutstanding || bid);
  return { provide, withdraw, noBid: below && !withdraw, why: `twap ${twap}, spot ${spot}` };
}

/** Pure: a TWAP away from the peg while spot is back near it = a one-block push (audit wave 1: accepted griefing, no loss). It holds the
 *  Allocator's LP acts (spot more than 10 ticks off the TWAP: OffTwap) and LoopVault's lever (TWAP under -25) until the TWAP catches up (~30 min).
 *  A real depeg moves both, and the alerts above cover it. */
export function twapPushAlert({ twap, spot, maxGap = 10 }) {
  if (twap === null) return null;
  const gap = Math.abs(spot - twap);
  if (gap <= maxGap || Math.abs(spot) > TARGET) return null;
  return { level: "warn", key: "peg-twap-push", msg: `peg TWAP ${twap} ticks vs spot ${spot}: the spot is back at $1 but the TWAP is not (a one-block push, or the tail of a real move): Allocator LP acts refuse and LoopVault lever may wait until it catches up (~30 min)` };
}

/** Pure: sweep a side's claims? USDC first when the bid needs it. */
export function sweepDue({ claims, decimals, minUsd, bidNeeded, feedsBuffer }) {
  const c = BigNumber.from(claims);
  if (c.isZero()) return false;
  if (bidNeeded && feedsBuffer) return true;
  return c.gte(BigNumber.from(10).pow(decimals).mul(minUsd));
}

export async function runPeg(ctx) {
  const { book, cfg, log, provider } = ctx;
  const hook = book.pegHook;
  const raised = [];
  let twap = null;
  try {
    twap = await hook.twapTicks();
  } catch (e) {
    if (reasonOf(e) !== "NoTwap") throw e;
  }
  const [spot, outstanding, buffer, surplus, bufferRoom, sound, cap, stable, quote, pmAddr] = await Promise.all([hook.spotTicks(), hook.outstanding(), hook.buffer(), hook.surplus(), hook.bufferRoom(), hook.quoteSound(), book.params.keeperCap(), hook.stable(), hook.quote(), hook.poolManager()]);
  const pm = new Contract(pmAddr, POOL_MANAGER_ABI, provider);

  // Sweep first: the toll's USDC becomes the buffer the withdraw below may spend.
  const minUsd = cfg.PEG?.sweepMinUsd ?? 25;
  const bidNeeded = twap !== null && twap < -TRIGGER;
  for (const [token, decimals, feedsBuffer] of [[quote, 6, !bufferRoom.isZero()], [stable, 18, false]]) {
    const claims = await pm.balanceOf(hook.address, BigNumber.from(token));
    if (sweepDue({ claims, decimals, minUsd, bidNeeded, feedsBuffer })) await act(ctx, `sweep ${token === quote ? "USDC" : "imdUSD"} toll (${utils.formatUnits(claims, decimals)})`, hook, "sweep", [token], { tier: "routine" });
  }

  const plan = pegPlan({ twap, spot, outstanding, buffer, surplus, bufferRoom, cap, quoteSound: sound });
  log(`peg     ${plan.why}, outstanding ${utils.formatEther(outstanding)}, buffer ${utils.formatUnits(buffer, 6)} USDC`);
  const min = utils.parseEther(String(cfg.PEG?.minTradeUsd ?? 1));
  if (plan.withdraw) {
    const r = await hook.callStatic.withdraw(ctx.keeperAddress ? { from: ctx.keeperAddress } : {}).catch((e) => ({ refused: reasonOf(e) }));
    if (r.refused) log(`peg     withdraw refuses (${r.refused})`);
    else if (r.burned.add(r.bought).gte(min)) await act(ctx, `withdraw (burn ${utils.formatEther(r.burned)}, buffer buys ${utils.formatEther(r.bought)})`, hook, "withdraw", [], { tier: "routine" });
  }
  if (plan.provide) {
    const r = await hook.callStatic.provide(ctx.keeperAddress ? { from: ctx.keeperAddress } : {}).catch((e) => ({ refused: reasonOf(e) }));
    if (r.refused) log(`peg     provide refuses (${r.refused})`);
    else if (r.gte(min)) await act(ctx, `provide (mint ${utils.formatEther(r)})`, hook, "provide", [], { tier: "routine" });
  }
  if (plan.noBid) raised.push({ level: "warn", key: "peg-no-bid", msg: `imdUSD TWAP ${twap} ticks below the peg and the hook has nothing to buy with (buffer ${utils.formatUnits(buffer, 6)} USDC, outstanding ${utils.formatEther(outstanding)})` });
  const push = twapPushAlert({ twap, spot });
  if (push) raised.push(push);
  if (!sound) raised.push({ level: "warn", key: "peg-quote-unsound", msg: "PegHook.quoteSound() is false: no mint, no buffer buy" });
  for (const a of raised) await ctx.alerts.raise(a.level, a.key, a.msg);
  await ctx.alerts.settle("peg-", new Set(raised.map((a) => a.key)));
}
