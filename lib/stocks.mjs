// The stock types on Robinhood Chain (the contracts' src/stocks/StockJoin.sol, src/feeds/MarketHoursFeed.sol,
// LedgerSettlement.writeOff; the operator duties after audit wave 4). Four duties, each the contract's own permissionless call:
//
//   TICK.     A stock auction's price falls only on TICKED takeable time (wave 4, medium): each read adds at most TICK_SPAN (5 min) since
//             the previous one, and only while a take could settle. So every live auction (opened, not past 2 x auctionTime of wall
//             clock) is ticked once its last read is STOCKS.tickAfterSeconds (150 s) old, priced or not: a tick while unpriced (market
//             closed, an issuer pause, a Pulse grace) counts nothing and moves `lastTick`, so the unpriced span is never counted later.
//             Without ticks the auction still works (a taker ticks), it only descends late. Urgent tier: it is the liquidation's clock.
//   CANCEL.   An auction whose position is healthy again (priced) or has no debt is void: `cancel` (routine).
//   SYNC.     A token multiplier step freezes the type until `MarketHoursFeed.sync()` records it (refused while a step is still scheduled)
//             and the feed prints after it: `sync` as soon as the live multiplier equals the scheduled one and differs from the feed's
//             `seenMultiplier`. A scheduled step is a warning (the type is frozen until it lands).
//   WRITEOFF. A type whose custody is WORTHLESS (`StockVault.worthless()`: under 10^-6 of the stock its shares claim, an issuer
//             adminBurn; the contract's own test, never `convertToAssets(1e18) == 0`, which a dust donation defeats: internal
//             review after wave 5) is realised by `Ledger.writeOff(id)`. CHAINED READINGS (the wave-5b LedgerSettlement):
//             every worthless call is a reading; the first arms (`worthlessSince`), a reading more than WRITEOFF_STEP (15 min) after the
//             previous one re-arms, and a reading >= WRITEOFF_DELAY (1 h) after the arming seizes. So while worthless and armed the
//             keeper calls writeOff every STOCKS.writeOffRecordSeconds (600 s) to keep the chain of readings, then writes off each
//             position with debt. A call that sees value again clears the record (sent only when the custody is NOT worthless).
//             Always a critical alert: the Safe should look. SEQUENCER GRACE: the seizing call reverts SequencerGrace while
//             Pulse.inGrace() (and its reading is reverted with it), so a grace longer than WRITEOFF_STEP re-arms the hour: said in
//             the alert; the keeper keeps recording until the hour is up and sends the seizure once the grace ends.
// Liquidator.tick at each market open and close is the positions loop's (lib/positions.mjs needsTick: the chain's own unpriced clock vs
// the live quote, read every minute, so an open or a close is ticked within a minute; OPEN_GRACE makes the open priced up to 5 min late).
import { BigNumber, utils } from "ethers";
import { act, head, landed } from "./act.mjs";
import { readStateOr, writeState } from "./state.mjs";
import { freshIndex } from "./positions.mjs";

const E18 = BigNumber.from(10).pow(18);
export const WRITEOFF_DELAY = 3600;
export const WRITEOFF_WINDOW = 7 * 86_400;
export const WRITEOFF_STEP = 900; // LedgerBase.WRITEOFF_STEP: the longest gap between two readings of one stretch

/** Pure: what one stock auction needs now. `a` = auctions(id). Returns { live, tick, lapsed }. */
export function auctionStep({ a, now, auctionTime, tickAfter = 150 }) {
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

/** Session seconds between two times, sampled on the calendar every `step` s (MarketCalendar.isOpen; one read per step). */
export async function sessionSeconds(calendar, from, to, step = 1800) {
  let n = 0;
  for (let t = from; t < to; t += step) if (await calendar.isOpen(t)) n += Math.min(step, to - t);
  return n;
}

/** The feed-silence alert for one stock type, or null. Keeps per type { updatedAt, inSession, lastAt } in state/stocks-feed.json:
 *  a new round resets it; each pass in session adds the time since the last pass. */
export async function feedSilence(S, t, now, { feedWarnHours = 25, feedCriticalHours = 49 } = {}) {
  const [, upd] = await S.market.latestValue();
  const updatedAt = Number(upd);
  if (updatedAt === 0) return { level: "warn", key: `stocks-feed-silent-${t.name}`, msg: `${t.name}: its Chainlink feed cannot be read (latestValue answers 0): the type is unpriced` };
  const open = await S.calendar.isOpenNow();
  const st = readStateOr("stocks-feed.json", {});
  let r = st[t.id];
  if (!r || r.updatedAt !== updatedAt) r = { updatedAt, inSession: typeof S.calendar.isOpen === "function" ? await sessionSeconds(S.calendar, updatedAt, now) : 0, lastAt: now };
  else {
    if (open) r.inSession += Math.max(0, now - r.lastAt);
    r.lastAt = now;
  }
  st[t.id] = r;
  writeState("stocks-feed.json", st);
  const h = r.inSession / 3600;
  if (h <= feedWarnHours) return null;
  return { level: h > feedCriticalHours ? "critical" : "warn", key: `stocks-feed-silent-${t.name}`, msg: `${t.name}: its Chainlink feed has not printed for ${h.toFixed(1)} h of market-session time (last round ${new Date(updatedAt * 1000).toISOString()}); the feed's maxAge is 5 days, so it still reads fresh. Check the feed: a dead feed prices the type at its last print` };
}

/**
 * Pure: the writeOff step for a type. `worthless` = StockVault.worthless(), `since` = Ledger.worthlessSince(ilk), `lastCall` = this
 * keeper's last landed writeOff on the type (chain time; null if none known). Returns { act: none | clear | arm | record | wait | writeoff }.
 * A reading the chain would treat as a re-arm (no reading for more than WRITEOFF_STEP) is "arm".
 */
export function writeOffStep({ worthless, since, now, lastCall = null, recordEvery = 600 }) {
  const s = Number(since);
  if (!worthless) return s !== 0 ? { act: "clear" } : { act: "none" };
  if (s === 0 || now > s + WRITEOFF_WINDOW) return { act: "arm" };
  if (lastCall !== null && now - lastCall > WRITEOFF_STEP && lastCall >= s) return { act: "arm", rearm: true };
  if (now < s + WRITEOFF_DELAY) return lastCall === null || now - lastCall >= recordEvery ? { act: "record", until: s + WRITEOFF_DELAY } : { act: "wait", until: s + WRITEOFF_DELAY };
  return { act: "writeoff" };
}

export async function runStocks(ctx) {
  const { book, cfg, log, provider } = ctx;
  if (!book.stocks?.length) return log("stocks  no stock types");
  const raised = [];
  const index = await freshIndex(ctx);
  const { now } = await head(provider);
  // 150 s (was 240, wave-5 audit #18): a tick decided on a pass up to stocksSeconds + a round's other work + a send wait later still
  // lands inside TICK_SPAN (300 s). A read found older than TICK_SPAN at its tick is said (stocks-tick-late-*).
  const tickAfter = cfg.STOCKS?.tickAfterSeconds ?? 150;
  const tickSpan = cfg.STOCKS?.tickSpanSeconds ?? 300;
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
      if (st.tick && now - Number(a.lastTick) > tickSpan) {
        const late = readStateOr("stocks-late.json", {});
        late[t.id] = { at: now, msg: `${t.name} #${String(id).slice(0, 10)}: the auction's last read was ${now - Number(a.lastTick)}s ago, over TICK_SPAN ${tickSpan}s (the price fell late): a loop held the queue or a send waited` };
        writeState("stocks-late.json", late);
      }
      if (st.tick) await act(ctx, `stock auction tick ${t.name} #${String(id).slice(0, 10)} (${now - Number(a.lastTick)}s since its last read)`, S.join, "tick", [id], { tier: "urgent" });
    }
    // SYNC
    const [current, next, seen] = await Promise.all([S.token.uiMultiplier(), S.token.newUIMultiplier(), S.market.seenMultiplier()]);
    const sy = syncStep({ current, next, seen });
    if (sy.pending) raised.push({ level: "warn", key: `stocks-multiplier-pending-${t.name}`, msg: `${t.name}: a multiplier step is scheduled (${current} -> ${next}): the type is frozen until it lands, then this keeper syncs the feed` });
    if (sy.sync) await act(ctx, `sync ${t.name} feed: multiplier ${seen} -> ${current}`, S.market, "sync", [], { tier: "urgent" });
    // WRITEOFF
    const [worthless, since] = await Promise.all([S.vault.worthless(), book.ledger.worthlessSince(t.id)]);
    // The chain's own last worthless reading (Ledger.worthlessLast, public in the wave-5b contracts snapshot) when it has the getter (any
    // caller's reading counts); else this keeper's last landed call (state/stocks-writeoff.json).
    let lastCall = readStateOr("stocks-writeoff.json", {})[t.id] ?? null;
    if (typeof book.ledger.worthlessLast === "function") {
      try {
        const l = Number(await book.ledger.worthlessLast(t.id));
        lastCall = l !== 0 ? l : null;
      } catch { /* an older Ledger: the keeper's own record */ }
    }
    const w = writeOffStep({ worthless, since, now, lastCall, recordEvery: cfg.STOCKS?.writeOffRecordSeconds ?? 600 });
    if (w.act !== "none") {
      inGrace ??= book.pulse ? await book.pulse.inGrace() : false;
      const held = w.act === "writeoff" && inGrace;
      const what = held ? "the write-off waits out the Pulse grace (it would revert SequencerGrace, and a grace past 15 min re-arms the hour); it goes once the grace ends"
        : w.act === "writeoff" ? "writing positions off" : w.act === "arm" ? `${w.rearm ? "re-arming" : "arming"} writeOff (readings every ${cfg.STOCKS?.writeOffRecordSeconds ?? 600} s, seizure >= 1 h later)`
        : `recording readings; writeOff from ${new Date(w.until * 1000).toISOString()}`;
      if (w.act !== "clear") raised.push({ level: "critical", key: `stocks-worthless-${t.name}`, msg: `${t.name}: the custody is WORTHLESS (StockVault.worthless(); issuer burn?): ${what}; the Safe should look at the issuer's act` });
      const withDebt = [];
      for (const id of ids) if (!(await book.ledger.debtOf(id)).isZero()) withDebt.push(id);
      const any = withDebt[0] ?? ids[0];
      const noteCall = (r) => { if (landed(r)) { const c = readStateOr("stocks-writeoff.json", {}); c[t.id] = now; writeState("stocks-writeoff.json", c); } };
      if (any !== undefined && (w.act === "arm" || w.act === "record")) noteCall(await act(ctx, `writeOff ${t.name} ${w.act}`, book.ledger, "writeOff", [any], { tier: "urgent" }));
      if (any !== undefined && w.act === "clear") await act(ctx, `writeOff ${t.name} clear (worth again)`, book.ledger, "writeOff", [any], { tier: "routine" });
      if (w.act === "writeoff" && !held) for (const id of withDebt) noteCall(await act(ctx, `writeOff ${t.name} #${String(id).slice(0, 10)}`, book.ledger, "writeOff", [id], { tier: "urgent" }));
    }
    // FEED SILENCE (the wave-5b contracts snapshot: every 4663 stock feed's maxAge is 5 days, so staleness no longer catches a dead feed): the
    // Chainlink feed silent more than 25 h of MARKET-SESSION time (MarketCalendar; weekends and holidays do not count) is warn, 49 h
    // critical. Measured cadence: SPY's quietest days print within 24 h of session time. Cleared only by a
    // pass that read a NEWER round (the record resets with the round's time).
    if (typeof S.market.latestValue === "function" && typeof S.calendar?.isOpenNow === "function") {
      const silent = await feedSilence(S, t, now, cfg.STOCKS ?? {});
      if (silent) raised.push(silent);
    }
    // A late tick stands an hour (internal review after wave 5: it flapped warn / cleared on every pass between ticks).
    const lateRec = readStateOr("stocks-late.json", {})[t.id];
    if (lateRec && now - lateRec.at < 3600) raised.push({ level: "warn", key: `stocks-tick-late-${t.name}`, msg: lateRec.msg });
    // Frozen with debt (issuer pause, oracle pause, blocked custody): nothing here can act; a human should know.
    const [frozen, debt] = await Promise.all([S.market.frozen(), book.ledger.ilkDebt(t.id)]);
    // A worthless custody also reads frozen (MarketHoursFeed.frozen() reads holder.worthless() in the wave-5b contracts snapshot): the worthless alert speaks.
    if (frozen && !debt.isZero() && !sy.pending && !worthless) raised.push({ level: "warn", key: `stocks-frozen-${t.name}`, msg: `${t.name} is frozen by an issuer act (pause, oracle pause, blocked custody or an unsynced multiplier) with ${utils.formatEther(debt)} imdUSD of debt` });
    log(`stocks  ${t.name}: ${ids.length} positions, ${live} live auction(s)${frozen ? ", FROZEN" : ""}`);
  }
  for (const a of raised) await ctx.alerts.raise(a.level, a.key, a.msg);
  await ctx.alerts.settle("stocks-", new Set(raised.map((a) => a.key)));
}
