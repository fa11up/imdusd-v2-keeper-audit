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

/**
 * FEED SILENCE (a review before wave 5b: redesigned). Every 4663 stock feed's maxAge is STOCK_MAX_AGE, 6 CALENDAR days (144 h, the
 * wave-5b contracts snapshot; `STOCKS.feedMaxAgeHours`), so a dead feed prices at its last print for up to 6 days. The alert must be CRITICAL while the
 * feed still prices, early enough for the Safe, and silent on the honest cadence. So it measures calendar time inside the 24/5 MARKET
 * WEEK (Sunday 20:00 to Friday 20:00 New York, the window the feeds print in; a weekday with no regular session per the MarketCalendar
 * is closed from 20:00 the evening before): `marketAge`. The DON's heartbeat (the measured schedule model: 20:00 New York on the eve
 * of each trading day, none before a holiday) is then one print per 24 h of market-week time on every week, holidays included.
 * Thresholds are per ticker, from the measured cadence (honest worst age inside the market week over 108
 * sessions): warn at max(1.5 x honest, honest + 1 h), critical at max(2 x honest, honest + 2 h), critical capped at 34 h and warn at
 * least 4 h under it. Margin: in any 144 calendar hours at most 72 are closed (a weekend plus a holiday, e.g. Christmas 2026 on a
 * Friday, Thanksgiving), so a dead feed's market age when maxAge unprices it is at least 72 h: critical comes about 38 h before that
 * (37.5 h measured, the worst case dying the Wednesday before Thanksgiving 2026: test/w5k-stock-feed).
 */
export const FEED_CADENCE_HOURS = { SPY: 24.0, SGOV: 19.9, USO: 5.5, NVDA: 8.7, CRCL: 3.3, MSTR: 2.7, SPCX: 4.8, TSLA: 18.6, AAPL: 23.6 };
export const FEED_CRITICAL_CAP_HOURS = 34;

/** Pure: warn/critical hours for a ticker's honest worst market age (hours). */
export function feedThresholds(honest = 24, cap = FEED_CRITICAL_CAP_HOURS) {
  const critical = Math.min(Math.max(2 * honest, honest + 2), cap);
  const warn = Math.min(Math.max(1.5 * honest, honest + 1), critical - Math.min(4, critical / 4));
  return { warn, critical };
}

const NY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
/** New York weekday (0 Sun .. 6 Sat), hour (fractional) and date (YYYY-MM-DD) of unix time t. */
export function nyTime(t) {
  const parts = Object.fromEntries(NY.formatToParts(new Date(t * 1000)).map((p) => [p.type, p.value]));
  return { dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday), hour: Number(parts.hour) + Number(parts.minute) / 60, date: `${parts.year}-${parts.month}-${parts.day}` };
}

/** Is unix time t inside the 24/5 market week? `holiday(t)` says whether the session that t's overnight belongs to is a holiday. */
export async function inMarketWeek(t, holiday = async () => false) {
  const { dow, hour } = nyTime(t);
  if (dow === 6 || (dow === 5 && hour >= 20) || (dow === 0 && hour < 20)) return false;
  // From 20:00 the window belongs to the NEXT day's session.
  return !(await holiday(hour >= 20 ? t + 4 * 3600 + 60 : t));
}

/** Market-week seconds between two times, in `step`-second slices. */
export async function marketSeconds(from, to, holiday, step = 1800) {
  let n = 0;
  for (let t = from; t < to; t += step) if (await inMarketWeek(t, holiday)) n += Math.min(step, to - t);
  return n;
}

/** A weekday (New York) with no regular session per the calendar is a holiday. Read once per date. */
function holidayOf(calendar, cache = new Map()) {
  return async (t) => {
    const { dow, date } = nyTime(t);
    if (dow === 0 || dow === 6 || typeof calendar?.isOpen !== "function") return false;
    if (!cache.has(date)) {
      // 15:00 UTC is inside the regular session (10:00 EST / 11:00 EDT) on every trading day
      const noon = Math.floor(Date.parse(`${date}T15:00:00Z`) / 1000);
      cache.set(date, !(await calendar.isOpen(noon)));
    }
    return cache.get(date);
  };
}

/** The feed-silence alert for one stock type, or null. Cleared only by a pass that read a NEWER round (the age restarts with it). */
export async function feedSilence(S, t, now, { feedCadenceHours = {}, feedCriticalCapHours = FEED_CRITICAL_CAP_HOURS, feedMaxAgeHours = 144 } = {}) {
  const [, upd] = await S.market.latestValue();
  const updatedAt = Number(upd);
  if (updatedAt === 0) return { level: "warn", key: `stocks-feed-silent-${t.name}`, msg: `${t.name}: its Chainlink feed cannot be read (latestValue answers 0): the type is unpriced` };
  const ticker = String(t.name).replace(/^STOCK-/, "");
  const honest = feedCadenceHours[ticker] ?? FEED_CADENCE_HOURS[ticker] ?? 24;
  const { warn, critical } = feedThresholds(honest, feedCriticalCapHours);
  S.holidays ??= new Map();
  const age = (await marketSeconds(updatedAt, now, holidayOf(S.calendar, S.holidays))) / 3600;
  if (age <= warn) return null;
  const unpricedAt = new Date((updatedAt + feedMaxAgeHours * 3600) * 1000).toISOString();
  return { level: age > critical ? "critical" : "warn", key: `stocks-feed-silent-${t.name}`, msg: `${t.name}: its Chainlink feed has not printed for ${age.toFixed(1)} h of market-week time (last round ${new Date(updatedAt * 1000).toISOString()}; honest worst ${honest} h; warn ${warn.toFixed(1)} h, critical ${critical.toFixed(1)} h). The feed's maxAge (${feedMaxAgeHours / 24} days) keeps it PRICED at its last print until ${unpricedAt}: check the feed; the Safe can lowerLine the type` };
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
    // FEED SILENCE (feedSilence above: market-week time against each ticker's measured cadence, critical while the feed prices).
    if (typeof S.market.latestValue === "function") {
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
