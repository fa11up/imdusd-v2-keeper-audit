// The Allocator's keeper actions (src/peg/Allocator.sol). Nothing moves unless the owner configures it AND the Safe has set the Allocator up (its keeper,
// targets, buckets and feeds are all empty at genesis):
//   SALES.  ALLOCATOR.sales = [{ sleeve: "blue"|"edge", token, route, maxUsd? }]: sell a sleeve's held collateral through an allowlisted route, for imdUSD back to the sleeve. The
//           Allocator's own bound (max of the keeper's figure and feed value less maxSlippageBps) and the sleeve's (>= 98% of the low price) both hold on top of the figure passed here.
//           It needs a feed for imdUSD too (`oracleMinOut` prices both sides): the operator duties list only "per token the sleeves hold". An unset feed is an alert, not a send.
//   BUFFER. ALLOCATOR.fundBuffer true: USDC the Allocator holds pays into the peg buffer while the buffer has room and the bucket allows.
//   RULES.  Needs no Allocator role (the contract picks amount, price and route; anyone may call), on unless ALLOCATOR.rules is false:
//           start the descending auction of any collateral a sleeve holds (once a run has reached its floor, restart it), then
//           topUpBuffer, rebalanceVault for each asset with an auto vault, and rebalanceLp, each only when its simulation says
//           there is something to do. The keeper never BUYS at the auction: buyers are the market.
// NOT BUILT: swap, return to Treasury (keeper-only calls, no rule).
import { BigNumber, utils } from "ethers";
import { act, reasonOf } from "./act.mjs";
import { readState, writeState } from "./state.mjs";

const b32 = utils.formatBytes32String;
const E18 = BigNumber.from(10).pow(18);

/** Pure: how much of `coll` to sell: bounded by the sleeve's limit and by the Allocator's bucket and config (both USD, at the feed price). */
export function saleAmount({ coll, sleeveLevel, bucketUsd, maxUsd, priceUsd }) {
  let amount = BigNumber.from(coll);
  if (amount.gt(sleeveLevel)) amount = BigNumber.from(sleeveLevel);
  const price = BigNumber.from(priceUsd);
  if (price.isZero()) return BigNumber.from(0);
  const byBucket = BigNumber.from(bucketUsd).mul(E18).div(price);
  if (amount.gt(byBucket)) amount = byBucket;
  if (maxUsd !== undefined && maxUsd !== null) {
    const byCfg = E18.mul(maxUsd).mul(E18).div(price);
    if (amount.gt(byCfg)) amount = byCfg;
  }
  return amount;
}

/** The Allocator's auction key: keccak256(abi.encode(backstop, collateral)). */
export const auctionKey = (backstop, token) => utils.keccak256(utils.defaultAbiCoder.encode(["address", "address"], [backstop, token]));

/** Pure: whether to (re)start one sleeve's auction of one token. Start when it holds collateral and none has run, when more than
 *  5% of the holding has arrived since the run started (`arrived`: Backstop.collIn, everything the standing bid ever credited; `offered`:
 *  Allocator.auctionColl, collIn at the run's start; the contract stops such a run's price until a restart), or when the last
 *  run has held at its floor for `floorHold` s (the floor tracks the sleeve's live low price, so holding there is safe; a restart asks
 *  the top again in case the market has moved above it). */
export function collateralAuctionStep({ coll, arrived, start, offered = arrived, now, duration, floorHold = 3600, restartBps = 500 }) {
  const c = BigNumber.from(coll);
  if (c.isZero()) return "wait";
  // Allocator.RESTART_ARRIVAL_BPS: a running sale restarts only once arrivals pass 5% of the holding (audit wave 2).
  const fresh = BigNumber.from(arrived).sub(offered);
  return start === 0 || fresh.mul(10_000).gt(c.mul(restartBps)) || now >= start + duration + floorHold ? "start" : "wait";
}

/** Pure: the unsold-collateral watch. `seen` = { coll, since } from the last round; the holding is "stuck" when it has not fallen for
 *  `stuckAfter` s (nobody buys even at 98% of the sleeve's low price: the market is below it, or a bucket or sale limit is empty). */
export function unsoldWatch({ coll, seen, now, stuckAfter = 12 * 3600 }) {
  const c = BigNumber.from(coll);
  if (c.isZero()) return { seen: null, stuck: false };
  if (!seen || c.lt(seen.coll)) return { seen: { coll: c.toString(), since: now }, stuck: false };
  return { seen, stuck: now - seen.since >= stuckAfter };
}

/** Pure: the sleeve's sale limit now (Backstop.sell's own arithmetic). */
export function sleeveLevelNow({ max, slope, level, updatedAt, now }) {
  const refilled = BigNumber.from(level).add(BigNumber.from(slope).mul(Math.max(0, now - Number(updatedAt))));
  return refilled.gt(max) ? BigNumber.from(max) : refilled;
}

export async function runAllocator(ctx) {
  const { book, cfg, keeperAddress, log, provider } = ctx;
  const al = book.allocator;
  const raised = [];
  const [frozen, keeperIn] = await Promise.all([al.frozen(), keeperAddress ? al.isKeeper(keeperAddress) : false]);
  log(`allocator ${frozen ? "FROZEN" : "live"}; this keeper ${keeperIn ? "is" : "is not"} its keeper`);
  const sales = cfg.ALLOCATOR?.sales ?? [];
  if (keeperIn && !frozen) {
    const { timestamp: now } = await provider.getBlock("latest");
    for (const s of sales) await saleOne(ctx, s, now, raised);
    if (cfg.ALLOCATOR?.fundBuffer) await fundBuffer(ctx);
  } else if (sales.length && !frozen && !keeperIn) {
    raised.push({ level: "info", key: "allocator-not-keeper", msg: "ALLOCATOR.sales is set but this keeper is not an Allocator keeper: Safe file 4" });
  }
  if (!frozen && cfg.ALLOCATOR?.rules !== false) await runRules(ctx, raised);
  if (frozen) raised.push({ level: "warn", key: "allocator-frozen", msg: "the Allocator is frozen: every keeper action stops until the Safe unfreezes it" });
  for (const a of raised) await ctx.alerts.raise(a.level, a.key, a.msg);
  await ctx.alerts.settle("allocator-", new Set(raised.map((a) => a.key)));
}

async function saleOne(ctx, s, now, raised) {
  const { book, cfg, log } = ctx;
  const al = book.allocator;
  const sleeve = s.sleeve === "edge" ? book.edge : book.blue;
  const coll = await sleeve.coll(s.token);
  if (coll.isZero()) return;
  const [saleKey, swapKey, seller, imdUSD] = await Promise.all([al.key(b32("BACKSTOP_SALE"), sleeve.address), al.key(b32("SWAP"), s.route), sleeve.seller(), sleeve.imdUSD()]);
  const [saleOk, routeOk] = await Promise.all([al.allowed(saleKey), al.allowed(swapKey)]);
  const missing = [];
  if (seller.toLowerCase() !== al.address.toLowerCase()) missing.push(`the sleeve's seller is ${seller}`);
  if (!saleOk) missing.push("BACKSTOP_SALE target");
  if (!routeOk) missing.push("SWAP target for the route");
  const [feedIn, feedOut] = await Promise.all([al.feedOf(s.token), al.feedOf(imdUSD)]);
  if (feedIn === "0x0000000000000000000000000000000000000000") missing.push(`feed for ${s.token}`);
  if (feedOut === "0x0000000000000000000000000000000000000000") missing.push("feed for imdUSD");
  if (missing.length) {
    raised.push({ level: "info", key: `allocator-sale-setup-${s.token}`, msg: `sale of ${s.token} not set up: ${missing.join(", ")}` });
    return;
  }
  const [limit, bucketUsd, feed] = await Promise.all([sleeve.saleLimit(s.token), al.available(b32("BACKSTOP_SALE"), sleeve.address), book.feed(feedIn).latestValue()]);
  const amount = saleAmount({ coll, sleeveLevel: sleeveLevelNow({ ...limit, now }), bucketUsd, maxUsd: s.maxUsd, priceUsd: feed[0] });
  const minUsd = cfg.ALLOCATOR?.minSaleUsd ?? 25;
  if (amount.mul(feed[0]).div(E18).lt(E18.mul(minUsd))) return log(`allocator sale of ${s.token}: under the ${minUsd} USD floor`);
  const minOut = await al.oracleMinOut(s.token, imdUSD, amount);
  await act(ctx, `sell ${utils.formatEther(amount)} of ${s.token} from the ${s.sleeve} sleeve`, al, "sellForBackstop", [sleeve.address, s.route, s.token, amount, minOut], { tier: "urgent" });
}

async function fundBuffer(ctx) {
  const { book } = ctx;
  const al = book.allocator, hook = book.pegHook;
  const [quote, room] = await Promise.all([hook.quote(), hook.bufferRoom()]);
  const key = await al.key(b32("BUFFER_FUND"), hook.address);
  if (room.isZero() || !(await al.allowed(key))) return;
  const [held, bucket] = await Promise.all([book.token(quote).balanceOf(al.address), al.available(b32("BUFFER_FUND"), hook.address)]);
  const amount = [held, room, bucket].reduce((a, b) => (a.lt(b) ? a : b));
  if (amount.isZero()) return;
  await act(ctx, `fund peg buffer ${utils.formatUnits(amount, 6)} USDC from the Allocator`, al, "fundBuffer", [hook.address, amount], { tier: "routine" });
}

// Rule-driven calls that report "nothing to do" (or a target the Safe has not set up) are skipped quietly: that is the normal state.
const QUIET = new Set(["NothingToDo", "NotAllowed", "AuctionRunning", "AuctionIdle", "OffTwap", "RateLimited"]);

async function tryRule(ctx, label, contract, fn, args) {
  try {
    await contract.callStatic[fn](...args, ctx.keeperAddress ? { from: ctx.keeperAddress } : {});
  } catch (e) {
    const why = reasonOf(e);
    if (!QUIET.has(why)) ctx.log(`allocator ${label}: refused (${why})`);
    return;
  }
  await act(ctx, label, contract, fn, args, { tier: "routine" });
}

async function runRules(ctx, raised) {
  const { book, cfg, provider } = ctx;
  const al = book.allocator;
  const { timestamp: now } = await provider.getBlock("latest");
  const duration = (await al.AUCTION_DURATION()).toNumber();
  const unsold = readState("allocator-unsold.json", {});
  for (const [name, sleeve] of [["blue", book.blue], ["edge", book.edge]]) {
    if (!sleeve) continue;
    if (!(await al.allowed(await al.key(b32("BACKSTOP_SALE"), sleeve.address)))) continue;
    const n = (await sleeve.tokenCount()).toNumber();
    for (let i = 0; i < n; i++) {
      const token = await sleeve.tokens(i);
      const key = auctionKey(sleeve.address, token);
      const [coll, arrived, start, offered] = await Promise.all([sleeve.coll(token), sleeve.collIn(token), al.auctionStart(key), al.auctionColl(key)]);
      const w = unsoldWatch({ coll, seen: unsold[`${name}-${token}`], now });
      unsold[`${name}-${token}`] = w.seen;
      if (w.stuck) raised.push({ level: "warn", key: `allocator-unsold-${name}-${token}`, msg: `the ${name} sleeve's ${utils.formatEther(coll)} of ${token} has not sold for 12 h of auctions: nobody buys even at 98% of its low price (market below it?), or a bucket or sale limit is empty` });
      if (collateralAuctionStep({ coll, arrived, start: start.toNumber(), offered, now, duration }) === "start") await tryRule(ctx, `start auction of ${token} (${name} sleeve)`, al, "startAuction", [sleeve.address, token]);
    }
  }
  writeState("allocator-unsold.json", unsold);
  if (book.pegHook) await tryRule(ctx, "top up the peg buffer", al, "topUpBuffer", [book.pegHook.address]);
  const assets = cfg.ALLOCATOR?.autoVaultAssets ?? (book.pegHook ? [await book.pegHook.quote()] : []);
  for (const asset of assets) {
    if ((await al.autoVault(asset)) === "0x0000000000000000000000000000000000000000") continue;
    await tryRule(ctx, `rebalance the ${asset} vault`, al, "rebalanceVault", [asset]);
  }
  if (book.pegLPVault) {
    const [target, held] = await Promise.all([al.lpTarget(book.pegLPVault.address), book.pegLPVault.balanceOf(al.address)]);
    if (!target.eq(held)) await tryRule(ctx, "rebalance protocol peg LP", al, "rebalanceLp", [book.pegLPVault.address]);
  }
}
