// The sleeves. The standing bid needs no keeper: `Liquidator.bite` opens it. Three duties:
//   ROOM.    Alerts on each sleeve's room for each type it covers, read as `bidRoomNow` (matured buckets count inside a bid; `bidRoom` alone understates).
//            No room is not an incident in itself (a liquidation then goes to the caller path), so empty reads as info while a covered type has debt;
//            a thin sleeve or a large fall in room is a warn. A bid is all-or-nothing: past the room a liquidation goes to the caller.
//   REALIZE. A retired token with a good price again must be un-retired before anyone converts at 0: `realize(any user)` at once, on the urgent tier. The first
//            conversion step that sees a good price clears the flag.
//   CONVERT. A deposit bucket converts to shares at the asset value of the FIRST call after it matures (00:00 UTC of day + 2), so whoever calls first
//            picks the moment (audit wave 1: ops, not code: a contract cannot read its value at a past instant). Once a non-empty bucket
//            has matured, `realize` converts it at once: routine tier for the first hour, urgent after. Still unconverted 2 h past maturity = warn (the
//            Backstop waits while held collateral is unpriced or a booked loss exceeds the room).
import { BigNumber, utils } from "ethers";
import { act, head, landed } from "./act.mjs";
import { readStateOr, writeState } from "./state.mjs";

const FILE = "backstop.json";

/** Pure: the alerts one sleeve's room on one type calls for. */
export function roomAlerts({ sleeve, name, room, debt, previous, minRoomBps = 500, dropBps = 3000 }) {
  const out = [];
  const r = BigNumber.from(room), d = BigNumber.from(debt);
  if (!d.isZero() && r.isZero()) out.push({ level: "info", key: `backstop-room-empty-${sleeve}-${name}`, msg: `${sleeve} sleeve has no room for ${name}, which carries ${utils.formatEther(d)} imdUSD: liquidations go to the caller path` });
  else if (!d.isZero() && r.mul(10_000).lt(d.mul(minRoomBps))) out.push({ level: "warn", key: `backstop-room-thin-${sleeve}-${name}`, msg: `${sleeve} sleeve room for ${name} is ${utils.formatEther(r)} imdUSD, under ${minRoomBps / 100}% of its ${utils.formatEther(d)} debt` });
  if (previous !== undefined && previous !== null && !BigNumber.from(previous).isZero() && r.mul(10_000).lt(BigNumber.from(previous).mul(10_000 - dropBps))) {
    out.push({ level: "warn", key: `backstop-room-fell-${sleeve}-${name}`, msg: `${sleeve} sleeve room for ${name} fell from ${utils.formatEther(previous)} to ${utils.formatEther(r)} imdUSD` });
  }
  return out;
}

/** Pure: the operator's condition. */
export const needsRealize = ({ isRetired, ok, high }) => isRetired && ok && !BigNumber.from(high).isZero();

const DAY = 86_400;

/** Pure: given the matured open buckets ({ day, amount }, oldest first) and chain time, whether a conversion is due, its tier and how late. */
export function convertPlan(open, now, { urgentAfter = 3600, warnAfter = 7200 } = {}) {
  const today = Math.floor(now / DAY);
  const matured = open.filter((b) => b.day + 2 <= today);
  if (!matured.some((b) => !BigNumber.from(b.amount).isZero())) return { due: false };
  const late = now - (matured[0].day + 2) * DAY;
  return { due: true, tier: late >= urgentAfter ? "urgent" : "routine", late, warn: late >= warnAfter };
}

async function maturedBuckets(sleeve, today) {
  const [h, n] = (await Promise.all([sleeve.openHead(), sleeve.openDaysLength()])).map((x) => x.toNumber());
  const out = [];
  for (let i = h; i < n; i++) {
    const day = (await sleeve.openDays(i)).toNumber();
    if (day + 2 > today) break; // oldest first: nothing later has matured either
    out.push({ day, amount: (await sleeve.buckets(day)).amount });
  }
  return out;
}

export async function runBackstop(ctx) {
  const { book, cfg, log, provider } = ctx;
  const raised = [];
  const seen = readStateOr(FILE, {});
  const next = {};
  const { now } = await head(provider);
  const today = Math.floor(now / DAY);
  for (const [name, sleeve] of [["blue", book.blue], ["edge", book.edge]]) {
    const plan = convertPlan(await maturedBuckets(sleeve, today), now, cfg.BACKSTOP ?? {});
    if (plan.due) {
      const r = await act(ctx, `convert: ${name} sleeve's matured deposits (${plan.late}s past maturity)`, sleeve, "realize", [ctx.keeperAddress ?? book.record.treasury], { tier: plan.tier });
      const waits = landed(r) && convertPlan(await maturedBuckets(sleeve, today), now).due;
      if (plan.warn && (!landed(r) || waits)) {
        raised.push({ level: "warn", key: `backstop-unconverted-${name}`, msg: `${name} sleeve: matured deposits unconverted ${Math.floor(plan.late / 60)} min past maturity${waits ? " (the Backstop waits: unpriced collateral or a loss over the room)" : ""}` });
      }
    }
    const n = (await sleeve.tokenCount()).toNumber();
    for (let i = 0; i < n; i++) {
      const token = await sleeve.tokens(i);
      if (!(await sleeve.retired(token))) continue;
      const { high, ok } = await book.backstopOracle.priceOf(token);
      if (needsRealize({ isRetired: true, ok, high })) await act(ctx, `realize: ${name} sleeve's retired ${token} is priced again`, sleeve, "realize", [ctx.keeperAddress ?? book.record.treasury], { tier: "urgent" });
    }
    const rooms = [];
    for (const t of book.ilks) {
      const k = await sleeve.ilks(t.id);
      if (!k.on) continue;
      const [room, debt] = await Promise.all([sleeve.bidRoomNow(t.id), book.ledger.ilkDebt(t.id)]);
      const key = `${name}-${t.name}`;
      raised.push(...roomAlerts({ sleeve: name, name: t.name, room, debt, previous: seen[key], minRoomBps: cfg.BACKSTOP?.minRoomBps ?? 500, dropBps: cfg.BACKSTOP?.roomDropBps ?? 3000 }));
      next[key] = room.toString();
      rooms.push(`${t.name} ${Math.floor(Number(utils.formatEther(room)))}`);
      // PricerOracle refuses a value only one leg shows (wave-5b contracts snapshot): while the legs disagree with the proven spot
      // above the median, ok = false and the sleeve's nav, sales and auctions wait. Say so, with what ends it (internal review after wave 5).
      const token = t.config?.token;
      if (token && book.pricer?.quote) {
        const q = await book.pricer.quote(t.id);
        if (q.priced && !q.agree) {
          const po = await book.backstopOracle.priceOf(token);
          if (!po.ok) raised.push({ level: "warn", key: `backstop-unpriced-legs-${t.name}`, msg: `${t.name}: the Backstop's price is refused while the legs disagree (PricerOracle.priceOf ok = false: a value only the proven spot shows): ${name} sleeve nav, sales and auctions on it wait. Prove the latest block (ProvenPoolPrice, the depth round) or buy a median` });
        }
      }
    }
    log(`backstop ${name}: ${rooms.join(", ") || "covers nothing"}`);
  }
  writeState(FILE, next);
  for (const a of raised) await ctx.alerts.raise(a.level, a.key, a.msg);
  await ctx.alerts.settle("backstop-", new Set(raised.map((a) => a.key)));
}
