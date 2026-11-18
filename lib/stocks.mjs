// The stock types on Robinhood Chain (the contracts' src/stocks/StockJoin.sol, src/feeds/MarketHoursFeed.sol,
// LedgerSettlement.writeOff; the operator duties after audit wave 4). Four duties, each the contract's own permissionless call:
//
//   TICK.     A stock auction's price falls only on TICKED takeable time (wave 4, medium): each read adds at most TICK_SPAN (5 min) since
//             the previous one, and only while a take could settle. So every live auction (opened, not past 2 x auctionTime of wall
//             clock) is ticked once its last read is STOCKS.tickAfterSeconds (240 s) old, priced or not: a tick while unpriced (market
//             closed, an issuer pause, a Pulse grace) counts nothing and moves `lastTick`, so the unpriced span is never counted later.
//             Without ticks the auction still works (a taker ticks), it only descends late. Urgent tier: it is the liquidation's clock.
//   CANCEL.   An auction whose position is healthy again (priced) or has no debt is void: `cancel` (routine).
//   SYNC.     A token multiplier step freezes the type until `MarketHoursFeed.sync()` records it (refused while a step is still scheduled)
//             and the feed prints after it: `sync` as soon as the live multiplier equals the scheduled one and differs from the feed's
//             `seenMultiplier`. A scheduled step is a warning (the type is frozen until it lands).
//   WRITEOFF. A type whose custody redeems for nothing (`StockVault.convertToAssets(1e18) == 0`, an issuer adminBurn) is realised by
//             `Ledger.writeOff(id)`: the first call arms (`worthlessSince`), a call >= WRITEOFF_DELAY (1 h) later inside WRITEOFF_WINDOW
//             (7 d) writes each position with debt off; a call that sees value again clears the record (else a later zero inside the
//             window would be written off at its first reading, without the hour). Always a critical alert: the Safe should look.
//             SEQUENCER GRACE (since wave 5): the seizing call reverts SequencerGrace while Pulse.inGrace(), like every other
//             seizure; arming and clearing seize nothing and are not held. So no seizing writeOff is sent in grace: it waits (said in
//             the alert, not a failure) and goes in the first pass after the grace ends.
// Liquidator.tick at each market open and close is the positions loop's (lib/positions.mjs needsTick: the chain's own unpriced clock vs
// the live quote, read every minute, so an open or a close is ticked within a minute; OPEN_GRACE makes the open priced up to 5 min late).
import { BigNumber, utils } from "ethers";
import { act, head } from "./act.mjs";
import { freshIndex } from "./positions.mjs";

const E18 = BigNumber.from(10).pow(18);
export const WRITEOFF_DELAY = 3600;
export const WRITEOFF_WINDOW = 7 * 86_400;

/** Pure: what one stock auction needs now. `a` = auctions(id). Returns { live, tick, lapsed }. */
export function auctionStep({ a, now, auctionTime, tickAfter = 240 }) {
  const startAt = Number(a.startAt);
  if (startAt === 0) return { live: false, tick: false, lapsed: false };
  const live = now <= startAt + 2 * Number(auctionTime);
  return { live, lapsed: !live, tick: live && now - Number(a.lastTick) >= tickAfter };
}

/** Pure: should the feed be synced? `pending` = a step is scheduled (sync would revert MultiplierPending). */
export function syncStep({ current, next, seen }) {
  const c = BigNumber.from(current), n = BigNumber.from(next), s = BigNumber.from(seen);
  if (!c.eq(n)) return { sync: false, pending: true };
  return { sync: !c.eq(s), pending: false };
}

/** Pure: the writeOff step for a type. `worth` = convertToAssets(1e18), `since` = Ledger.worthlessSince(ilk). */
export function writeOffStep({ worth, since, now }) {
  const w = BigNumber.from(worth), s = Number(since);
  if (!w.isZero()) return s !== 0 ? { act: "clear" } : { act: "none" };
  if (s === 0 || now > s + WRITEOFF_WINDOW) return { act: "arm" };
  if (now < s + WRITEOFF_DELAY) return { act: "wait", until: s + WRITEOFF_DELAY };
  return { act: "writeoff" };
}

export async function runStocks(ctx) {
  const { book, cfg, log, provider } = ctx;
  if (!book.stocks?.length) return log("stocks  no stock types");
  const raised = [];
  const index = await freshIndex(ctx);
  const { now } = await head(provider);
  const tickAfter = cfg.STOCKS?.tickAfterSeconds ?? 240;
  let inGrace; // read once, only when a write-off is due
  for (const t of book.stocks) {
    const S = t.stock;
    S.auctionTime ??= Number(await S.join.auctionTime());
    const ids = index[t.id] ?? [];
    let live = 0;
    for (const id of ids) {
      const a = await S.join.auctions(id);
      const st = auctionStep({ a, now, auctionTime: S.auctionTime, tickAfter });
      if (!st.live && !st.lapsed) continue;
      const [owed, { ok, priced }] = await Promise.all([book.ledger.debtOf(id), book.ledger.healthy(id)]);
      if (owed.isZero() || (priced && ok)) {
        await act(ctx, `stock auction cancel ${t.name} #${String(id).slice(0, 10)} (healed)`, S.join, "cancel", [id], { tier: "routine" });
        continue;
      }
      if (st.live) live += 1;
      if (st.tick) await act(ctx, `stock auction tick ${t.name} #${String(id).slice(0, 10)} (${now - Number(a.lastTick)}s since its last read)`, S.join, "tick", [id], { tier: "urgent" });
    }
    // SYNC
    const [current, next, seen] = await Promise.all([S.token.uiMultiplier(), S.token.newUIMultiplier(), S.market.seenMultiplier()]);
    const sy = syncStep({ current, next, seen });
    if (sy.pending) raised.push({ level: "warn", key: `stocks-multiplier-pending-${t.name}`, msg: `${t.name}: a multiplier step is scheduled (${current} -> ${next}): the type is frozen until it lands, then this keeper syncs the feed` });
    if (sy.sync) await act(ctx, `sync ${t.name} feed: multiplier ${seen} -> ${current}`, S.market, "sync", [], { tier: "urgent" });
    // WRITEOFF
    const [worth, since] = await Promise.all([S.vault.convertToAssets(E18), book.ledger.worthlessSince(t.id)]);
    const w = writeOffStep({ worth, since, now });
    if (w.act !== "none") {
      inGrace ??= book.pulse ? await book.pulse.inGrace() : false;
      const held = w.act === "writeoff" && inGrace;
      if (w.act !== "clear") raised.push({ level: "critical", key: `stocks-worthless-${t.name}`, msg: `${t.name}: one vault share redeems for ${worth} (issuer burn?): ${held ? "the write-off waits out the Pulse grace (it would revert SequencerGrace); it goes once the grace ends" : w.act === "writeoff" ? "writing positions off" : w.act === "arm" ? "arming writeOff (2nd reading >= 1 h later)" : `writeOff from ${new Date(w.until * 1000).toISOString()}`}; the Safe should look at the issuer's act` });
      const withDebt = [];
      for (const id of ids) if (!(await book.ledger.debtOf(id)).isZero()) withDebt.push(id);
      const any = withDebt[0] ?? ids[0];
      if (any !== undefined && (w.act === "arm" || w.act === "clear")) await act(ctx, `writeOff ${t.name} ${w.act === "arm" ? "arm" : "clear (worth again)"}`, book.ledger, "writeOff", [any], { tier: w.act === "arm" ? "urgent" : "routine" });
      if (w.act === "writeoff" && !held) for (const id of withDebt) await act(ctx, `writeOff ${t.name} #${String(id).slice(0, 10)}`, book.ledger, "writeOff", [id], { tier: "urgent" });
    }
    // Frozen with debt (issuer pause, oracle pause, blocked custody): nothing here can act; a human should know.
    const [frozen, debt] = await Promise.all([S.market.frozen(), book.ledger.ilkDebt(t.id)]);
    if (frozen && !debt.isZero() && !sy.pending) raised.push({ level: "warn", key: `stocks-frozen-${t.name}`, msg: `${t.name} is frozen by an issuer act (pause, oracle pause, blocked custody or an unsynced multiplier) with ${utils.formatEther(debt)} imdUSD of debt` });
    log(`stocks  ${t.name}: ${ids.length} positions, ${live} live auction(s)${frozen ? ", FROZEN" : ""}`);
  }
  for (const a of raised) await ctx.alerts.raise(a.level, a.key, a.msg);
  await ctx.alerts.settle("stocks-", new Set(raised.map((a) => a.key)));
}
