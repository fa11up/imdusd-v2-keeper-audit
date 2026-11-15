// The seat type.
//   CLOCK. An auction runs on priced time. `SeatJoin.tick(id)` after each median attestation, when SeatFeed reads 0, and hourly while it runs
//          keeps that clock exact (or at most an hour slow); without it the clock only runs slow.
//   POKE.  `SeatFeed.poke()` after each median attestation, so a fall steps from the right base (two unrecorded attestations count as one step).
//          A fresh SeatFeed prices nothing until the first attestation is poked (audit wave 1), and the figure (seats sold) is capped
//          like the median, so an equal-time replacement that changes only the figure is recorded too.
//          Stateless: the feed's own record says whether the live attestation has been taken, and whether today's ring slot is filled.
//   VOID.  An auction void after 24 h of priced time: `reopen` while the position is still unhealthy at a live price (it keeps the marker), `cancel` once it healed.
//   LEGS.  Both legs bought about daily (life 26 h), as one order when both are due, only once the owner has seeded the type and it has seats or debt.
// A seat answer cannot be previewed here: the recipe is a full scan of the collection's sales (plane-nft scan.mjs --nft-sales), so unlike
// price, spot and NHI the leaf's `accepts` is not asked first. At most IMD.dailyCap can go on one that is refused, and a refusal is alerted.
import { BigNumber, utils } from "ethers";
import { act, head } from "./act.mjs";
import { buildInput, leafProblems } from "./oracle.mjs";
import { advanceOrders, buyHold, costOf, ensureAllowance, openOrders, startOrder } from "./orders.mjs";
import { plane } from "./plane.mjs";
import { freshIndex } from "./positions.mjs";

const DAY = 86_400;
const RING = 32;

/** Pure: which legs to buy now. */
export function seatLegsDue({ median, spot, medianAge, spotAge, refreshAfter, line, seats, collateral, debt, hadOpenOrder }) {
  if (BigNumber.from(median).isZero() || BigNumber.from(spot).isZero()) return { legs: [], why: "not open: a leg holds no value, the first values are the deployment's" };
  if (BigNumber.from(line).isZero() && BigNumber.from(debt).isZero()) return { legs: [], why: "not open: line 0 and no debt" };
  if (BigNumber.from(seats).isZero() && BigNumber.from(collateral).isZero() && BigNumber.from(debt).isZero()) return { legs: [], why: "open, but no seat pledged and no debt" };
  const legs = [];
  if (medianAge >= refreshAfter) legs.push("seatMedian");
  if (spotAge >= refreshAfter) legs.push("seatSpot");
  if (legs.length && hadOpenOrder) return { legs: [], why: "an order for these legs is still open" };
  return { legs, why: legs.length ? `${legs.join(" + ")} due` : "fresh" };
}

/** Pure: does SeatFeed.poke() write anything? Mirrors `_record` and the ring. */
export function seatPokeNeeded({ median, medianAt, capAt, capRaw, figure = 0, capFigureRaw = 0, feedStale, usdNow, ringDay, today }) {
  const m = BigNumber.from(median);
  if (m.isZero()) return false;
  if (medianAt > capAt || (medianAt === capAt && (!m.eq(capRaw) || Number(figure) !== Number(capFigureRaw)))) return true;
  return !feedStale && !BigNumber.from(usdNow).isZero() && ringDay !== today;
}

/** Pure: the next step for an auction. `ethStaleSinceTick`: the ETH/USD leg went stale after the auction's last tick (its update + maxAge
 *  is past, and later than `lastTick`): a tick then records the gap, which SeatJoin otherwise cannot see once it has ended (audit
 *  wave 2: the clock treats an ETH/USD leg fresh at both ends of a stretch as fresh throughout). */
/*  `readsZero`: SeatFeed.latestValue() is 0 now (an accepted figure of 0 zeroes the liquidity term) and `zeroAtTick` says whether the
 *  auction's last tick recorded it; `sinceTick`: seconds since that tick. Audit wave 3: the clock counts nothing while the
 *  feed reads 0, but WHEN it fell to 0 is not on chain, so it loses the time since the last tick: an hourly tick bounds that loss to an
 *  hour, and a tick when it reads 0 records it (else a stretch at 0 that ended before the next tick would be counted). */
export const TICK_EVERY = 3600;
export function auctionStep({ startAt, isExpired, attestedAt, medianAt, healthy, priced, debt, ethStaleSinceTick = false, readsZero = false, zeroAtTick = false, sinceTick = 0 }) {
  if (startAt === 0) return "none";
  if (BigNumber.from(debt).isZero()) return "cancel";
  if (!priced) return attestedAt < medianAt || ethStaleSinceTick || (readsZero && !zeroAtTick) ? "tick" : "none";
  if (healthy) return "cancel";
  if (isExpired) return "reopen";
  return attestedAt < medianAt || zeroAtTick || sinceTick >= TICK_EVERY ? "tick" : "none";
}

export async function runSeats(ctx) {
  const { book, cfg, log, provider } = ctx;
  const t = book.ilks.find((x) => x.config.auction);
  if (!t) return log("seats   no auction type");
  const raised = [];
  ctx.planeState ??= await plane(provider, cfg, ctx.fetchImpl ?? fetch);
  const { now } = await head(provider);
  const [medianAddr, spotAddr] = await Promise.all([book.seatFeed.median(), book.seatFeed.spot()]);
  const median = book.leaf(medianAddr), spot = book.leaf(spotAddr);
  const [m, sp, capRec, feedStale, seats, state, risk, figure] = await Promise.all([median.latestValue(), spot.latestValue(), book.seatFeed.cap(), book.seatFeed.isStale(), book.seatJoin.seatCount(), book.ledger.ilkState(t.id), book.params.storedRisk(t.id), median.latestFigure()]);
  const today = Math.floor(now / DAY);

  // --- the feed's record of the live attestation
  const ring = await book.seatFeed.ring(today % RING);
  const usd = m.value.isZero() ? BigNumber.from(0) : (await book.seatFeed.latestValue())[0];
  if (seatPokeNeeded({ median: m.value, medianAt: Number(m.updatedAt), capAt: Number(capRec.attestedAt), capRaw: capRec.raw, figure: Number(figure), capFigureRaw: Number(capRec.figureRaw), feedStale, usdNow: usd, ringDay: Number(ring.day), today })) {
    await act(ctx, "poke SeatFeed", book.seatFeed, "poke", [], { tier: "routine" });
  }

  // --- auctions
  const index = await freshIndex(ctx);
  const ethLeg = book.feed(await book.seatFeed.ethUsd());
  const [ethV, ethLife] = await Promise.all([ethLeg.latestValue(), ethLeg.maxAge()]);
  const ethStaleAt = Number(ethV[1]) + ethLife.toNumber(); // when the ETH/USD leg reads stale
  let live = 0;
  for (const id of index[t.id] ?? []) {
    const a = await book.seatJoin.auctions(id);
    const startAt = Number(a.startAt);
    if (startAt === 0) continue;
    live += 1;
    const [isExpired, h, debt] = await Promise.all([book.seatJoin.expired(id), book.ledger.healthy(id), book.ledger.debtOf(id)]);
    const ethStaleSinceTick = now > ethStaleAt && ethStaleAt > Number(a.lastTick);
    const step = auctionStep({ startAt, isExpired, attestedAt: Number(a.attestedAt), medianAt: Number(m.updatedAt), healthy: h.ok, priced: h.priced, debt, ethStaleSinceTick, readsZero: !m.value.isZero() && usd.isZero(), zeroAtTick: Boolean(a.zeroAtTick), sinceTick: now - Number(a.lastTick) });
    const short = `#${String(id).slice(0, 10)}`;
    if (step === "tick") await act(ctx, `tick seat auction ${short}`, book.seatJoin, "tick", [id], { tier: "routine" });
    if (step === "reopen") await act(ctx, `reopen void seat auction ${short}`, book.seatJoin, "reopen", [id], { tier: "urgent" });
    if (step === "cancel") await act(ctx, `cancel seat auction ${short} (healed)`, book.seatJoin, "cancel", [id], { tier: "routine" });
    if (isExpired && step === "none") raised.push({ level: "warn", key: `seats-auction-void-${id}`, msg: `seat auction ${short} is void and the type is unpriced: it restarts when a median lands` });
  }

  // --- legs
  const refreshAfter = cfg.SEATS?.refreshAfterSeconds ?? 22 * 3600;
  const ageOf = (x) => (Number(x.updatedAt) === 0 ? Infinity : now - Number(x.updatedAt));
  const due = seatLegsDue({ median: m.value, spot: sp.value, medianAge: ageOf(m), spotAge: ageOf(sp), refreshAfter, line: risk.line, seats, collateral: state.collateral, debt: state.debt, hadOpenOrder: openOrders("seats").length > 0 });
  log(`seats   ${seats} seat(s), ${live} auction(s); legs: ${due.why}`);
  if (due.legs.length) {
    const cost = costOf(cfg, due.legs.length);
    const leaves = { seatMedian: median, seatSpot: spot };
    const problems = (await Promise.all(due.legs.map((r) => leafProblems(leaves[r], r)))).flat();
    if (problems.length) {
      raised.push({ level: "critical", key: "seats-question-mismatch", msg: problems.join("; ") });
    } else if (!ctx.execute) {
      log(`would   buy ${due.legs.join(" + ")} (${utils.formatEther(cost)} IMD)`);
    } else {
      // Falls come first: legs stay out of what must remain for one pair.
      const hold = await buyHold(ctx, cost, { reserve: utils.parseEther(String(cfg.IMD?.reserveForFalls ?? 1)) });
      if (hold) raised.push({ level: "warn", key: "seats-buy-held", msg: `seat legs due and held: ${hold}` });
      else if (await ensureAllowance(ctx, cost)) {
        const questions = await Promise.all(due.legs.map(async (role) => ({ role, leaf: leaves[role].address, input: await buildInput(leaves[role], role) })));
        startOrder("seats", questions);
        await advanceOrders(ctx);
      }
    }
  }
  for (const a of raised) await ctx.alerts.raise(a.level, a.key, a.msg);
  await ctx.alerts.settle("seats-", new Set(raised.map((a) => a.key)));
}

