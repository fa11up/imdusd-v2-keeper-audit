// Liquidations + the priced clock.
//
// TICK. `Liquidator.tick(ilk)` when a type with debt turns unpriced and when it is priced again, so marks age only through priced
//   time. Stateless: the chain's own clock says which it thinks: `clocks(ilk).unpricedSince != 0` must equal `!quote.priced`.
// LIQUIDATE. Always the guarded form `liquidate(id, minSeized)` / `bite(id, minSeized)`, by private send, with minSeized from the
//   quote just simulated, less LIQUIDATE.toleranceBps. It reverts `SeizedTooLow` if the price moved ahead. The
//   standing bid path ignores it and costs the caller nothing; the caller path burns the keeper's imdUSD, so the simulation
//   refuses it while the keeper holds too little, and then the keeper still marks (the marker earns the chip whoever closes it).
// DUST. A position under RISK.minDebt is never acted on: nobody will close it, a mark would be bought again every 24 h.
// PULSE (4663 only; mainnet has none). While the Ledger's Pulse is in grace nothing seizes: `bite` returns zeros (HeldByGrace, so the
//   grace its own poke opened is not undone) and a stock `take` reverts SequencerGrace. A simulated bite then "succeeds" seizing 0, so the
//   keeper must not read that as a close: in grace it never sends bite or liquidate. It still marks (`bark` is allowed and seizes
//   nothing), so the mark's grace runs and the bite can go the moment the Pulse grace ends.
// STOCK AUCTIONS (4663). A stock type's bite opens a StockJoin auction; while it runs (2 x auctionTime of wall clock from its opening)
//   the position is the auction's and lib/stocks.mjs ticks it. A lapsed one is replaced by marking and biting again here.
import { BigNumber } from "ethers";
import { act, head, landed, reasonOf } from "./act.mjs";
import { refreshIndex, resetIndex, shortfalls } from "./index.mjs";

const SIG = { liquidate: "liquidate(uint256,uint256)", bite: "bite(uint256,uint256)" };

/** Pure: mark state to next step. "close" = liquidate/bite now; "mark" = bark; "wait" = grace running. */
export function liqStep({ now, markAt, markExpiresAt, graceEnd, lull }) {
  const live = markAt > 0 && now <= markExpiresAt;
  if (!live) return lull === 0 ? { step: "close", fn: "liquidate" } : { step: "mark" };
  const until = Math.min(graceEnd, markAt + lull);
  return now < until ? { step: "wait", until } : { step: "close", fn: "bite" };
}

export const minSeized = (seized, toleranceBps = 50) => BigNumber.from(seized).mul(10_000 - toleranceBps).div(10_000);
export const needsTick = (unpricedSince, priced) => (unpricedSince !== 0) === priced;

/** Refresh ctx.index (type -> ids), keyed by the id as the Parameters give it. Rebuilds once on a shortfall. SINGLE-FLIGHT (a review
 *  before wave 5b): the positions, stocks and imdfeeds lanes call this concurrently; one refresh runs, the others wait for it, so
 *  no lane writes the index file across another's await or resets it mid-refresh. */
export function loadIndex(ctx) {
  if (ctx.indexInflight) return ctx.indexInflight;
  ctx.indexInflight = loadIndexOnce(ctx).finally(() => { ctx.indexInflight = null; });
  return ctx.indexInflight;
}

async function loadIndexOnce(ctx) {
  const { book, cfg, provider } = ctx;
  const from = Number(cfg.LEDGER_FROM_BLOCK ?? book.record.stage1SimulatedAtBlock ?? 0);
  let { ids, top } = await refreshIndex(provider, book.ledger.address, from, cfg.LOGS);
  let short = await shortfalls(book, ids, top);
  if (short.length) {
    ctx.log(`index   does not add up (${JSON.stringify(short)}): rebuilding from block ${from}`);
    resetIndex(book.ledger.address);
    ({ ids, top } = await refreshIndex(provider, book.ledger.address, from, cfg.LOGS));
    short = await shortfalls(book, ids, top);
  }
  if (short.length) await ctx.alerts.raise("critical", "index-incomplete", `position index misses collateral: ${JSON.stringify(short)}`);
  await ctx.alerts.settle("index-", new Set(short.length ? ["index-incomplete"] : []));
  ctx.index = Object.fromEntries(book.ilks.map((t) => [t.id, ids[t.id.toLowerCase()] ?? []]));
  ctx.indexAt = Date.now();
  return ctx.index;
}

/** The index for a loop that only reads it: reloaded at most every LOGS.indexTtlSeconds, so one round does not rescan it per loop. */
export const freshIndex = async (ctx) => (ctx.index && Date.now() - (ctx.indexAt ?? 0) < (ctx.cfg.LOGS?.indexTtlSeconds ?? 30) * 1000 ? ctx.index : loadIndex(ctx));

export async function runPositions(ctx) {
  const { book, cfg, log, provider } = ctx;
  await loadIndex(ctx);
  const { now } = await head(provider);
  const minDebt = BigNumber.from(10).pow(18).mul(cfg.RISK?.minDebt ?? 15);
  const tolerance = cfg.LIQUIDATE?.toleranceBps ?? 50;
  const liq = book.liquidator;
  const inGrace = book.pulse ? await book.pulse.inGrace() : false;
  if (inGrace) log("pos     Pulse grace: no bite or liquidation is sent (they would seize nothing), marks only");
  // cannot-close-<id> clears only for a position read this pass (a review before wave 5b): an unpriced type's positions are not read.
  const readIds = new Set();
  const raisedNow = new Set();
  const local = { ...ctx, alerts: { ...ctx.alerts, raise: async (l, k, m) => { raisedNow.add(k); return ctx.alerts.raise(l, k, m); } } };
  for (const t of book.ilks) {
    const [quote, clock, debt] = await Promise.all([book.pricer.quote(t.id), liq.clocks(t.id), book.ledger.ilkDebt(t.id)]);
    if (debt.isZero()) continue;
    if (needsTick(Number(clock.unpricedSince), quote.priced)) {
      await act(ctx, `tick ${t.name} (${quote.priced ? "priced again" : "unpriced"})`, liq, "tick", [t.id]);
    }
    if (!quote.priced) {
      log(`pos     ${t.name} unpriced: nothing can act`);
      continue;
    }
    const ids = ctx.index[t.id];
    let unhealthy = 0;
    for (const id of ids) {
      readIds.add(String(id));
      const [{ ok }, owed] = await Promise.all([book.ledger.healthy(id), book.ledger.debtOf(id)]);
      if (ok || owed.lt(minDebt)) continue;
      // An auction type's bite opens a sale and leaves the position unhealthy: while a sale is open another mark or bite only reverts AuctionLive. lib/seats.mjs restarts a void one.
      if (t.config.auction && (await auctionRunning(book, t, id, now))) continue;
      unhealthy += 1;
      await closeOne(local, t, id, owed, quote, now, tolerance, inGrace);
    }
    log(`pos     ${t.name} ${ids.length} positions, ${unhealthy} to act on`);
  }
  await ctx.alerts.settle("cannot-close-", (k) => raisedNow.has(k) || !readIds.has(k.slice("cannot-close-".length)));
}

/** An auction type's sale for `id` still owns the position: a seat auction while it exists (lib/seats.mjs restarts a void one), a stock
 *  auction until it lapses (StockJoin: 2 x auctionTime from its opening; a lapsed one may be replaced by a new bite). */
export async function auctionRunning(book, t, id, now) {
  if (t.stock) {
    const [a, span] = await Promise.all([t.stock.join.auctions(id), t.stock.auctionTime ?? t.stock.join.auctionTime()]);
    return Number(a.startAt) !== 0 && now <= Number(a.startAt) + 2 * Number(span);
  }
  return Number((await book.seatJoin.auctions(id)).startAt) !== 0;
}

async function closeOne(ctx, t, id, owed, quote, now, tolerance, inGrace = false) {
  const { book, keeperAddress } = ctx;
  const liq = book.liquidator;
  const short = `${t.name} #${String(id).slice(0, 10)}`;
  const [mark, grace, exp] = await Promise.all([liq.marks(id), liq.graces(id), liq.markExpiresAt(id)]);
  const plan = liqStep({ now, markAt: Number(mark.markedAt), markExpiresAt: exp.toNumber(), graceEnd: Number(grace.end), lull: quote.lull.toNumber() });
  if (plan.step === "wait") return ctx.log(`pos     ${short} in grace until ${plan.until}`);
  if (plan.step === "close" && inGrace) {
    // The Pulse holds every seizure: a live mark waits; with none (or an expired one) mark now, so its own grace runs meanwhile.
    if (Number(mark.markedAt) > 0 && now <= exp.toNumber()) return ctx.log(`pos     ${short} marked; the Pulse grace holds the bite`);
    return act(ctx, `bark ${short} (Pulse grace: mark only)`, liq, "bark", [id], { tier: "urgent" });
  }
  if (plan.step === "close") {
    const fn = SIG[plan.fn];
    try {
      const q = await liq.callStatic[fn](id, 0, keeperAddress ? { from: keeperAddress } : {});
      // A close that would seize NOTHING because the Pulse grace opened during this pass (the pass read inGrace once) is never sent
      // (wave-5 audit #19): the grace is read again, and in it the position is held like a grace (marked if no mark is live). A
      // seize-0 close outside the grace (an auction type's liquidate opens a sale and seizes nothing) goes as before.
      const zero = q.seized !== undefined && q.seized !== null && BigNumber.from(q.seized).isZero();
      if (zero && book.pulse && (await book.pulse.inGrace())) {
        ctx.log(`pos     ${short} would seize 0 and the Pulse grace is open now: not closed, marked instead`);
      } else {
        const r = await act(ctx, `${plan.fn} ${short} (seize ${q.seized})`, liq, fn, [id, minSeized(q.seized, tolerance)], { tier: "urgent" });
        if (landed(r) || r.pending) return r; // still open: a bark now would replace it
      }
    } catch (e) {
      // The caller path needs imdUSD this keeper does not hold. Marking still earns the chip, and is what lets a liquidator act.
      ctx.log(`pos     ${short} cannot close (${reasonOf(e)}), debt ${owed}`);
      await ctx.alerts.raise("warn", `cannot-close-${id}`, `${short} is unhealthy, debt ${owed}, and this keeper cannot close it: ${reasonOf(e)}`);
    }
    if (Number(mark.markedAt) > 0 && now <= exp.toNumber()) return undefined;
  }
  return act(ctx, `bark ${short}`, liq, "bark", [id], { tier: "urgent" });
}
