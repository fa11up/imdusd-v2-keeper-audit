// A review before wave 5b: every 4663 stock feed's maxAge is STOCK_MAX_AGE, 6 CALENDAR
// days (144 h, the wave-5b contracts snapshot), so a dead feed prices at its last print for up to 6 days. PROPERTY: a dead stock feed raises
// CRITICAL `stocks-feed-silent-*` while it still prices, at least 36 h before its 144 h end, whatever weekday and hour it died
// (Thursday 20:00 New York, Thanksgiving with its Friday half day, Christmas 2026 on a Friday, MLK and every other closure of
// the NYSE calendar model to end-2027); the honest cadence never alerts: the DON heartbeat of the measured schedule model (20:00 New York on
// the eve of each trading day, none before a holiday) for the quiet tickers, and each ticker's measured worst (the measured cadence); the
// alert clears only on a pass that read a newer round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utils } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5k-stockfeed-"));
const { FEED_CADENCE_HOURS, feedSilence, feedThresholds, inMarketWeek, nyTime, runStocks } = await import("../lib/stocks.mjs");
const { makeWorld, rng } = await import("./lib/rh-world.mjs");

const H = 3600, DAY = 86_400, MAX_AGE = 6 * DAY;
// The NYSE calendar model (DeployConfig nyse2026to2028): closed days and early closes, as days since 1970-01-01.
const CLOSED_DAYS = [20783, 20812, 20819, 20836, 20864, 20903, 20969, 20987, 21004, 21067, 21147, 21176, 21200, 21235, 21288, 21333, 21354, 21369, 21431, 21511, 21543];
const EARLY_DAYS = [20784, 20811, 21148, 21368, 21512];
const iso = (d) => new Date(d * DAY * 1000).toISOString().slice(0, 10);
const T = (iso) => Math.floor(Date.parse(iso) / 1000);
const HOLIDAYS = new Set(CLOSED_DAYS.map(iso));
const EARLY = new Set(EARLY_DAYS.map(iso)); // Thanksgiving Friday, Christmas Eve, ...: the session closes at 13:00
// MarketCalendar: the regular session, Mon-Fri 9:30-16:00 New York (13:00 on an early close), not on a holiday
const isOpen = (t) => { const n = nyTime(t); return n.dow >= 1 && n.dow <= 5 && !HOLIDAYS.has(n.date) && n.hour >= 9.5 && n.hour < (EARLY.has(n.date) ? 13 : 16); };
const trading = (date) => { const d = new Date(`${date}T12:00:00Z`).getUTCDay(); return d >= 1 && d <= 5 && !HOLIDAYS.has(date); };
/** The schedule model's heartbeat: 20:00 New York on evening D exactly when D+1 is a trading day. */
function heartbeats(fromIso, toIso) {
  const out = [];
  for (let d = Date.parse(`${fromIso}T12:00:00Z`) / 1000; d <= Date.parse(`${toIso}T12:00:00Z`) / 1000; d += DAY) {
    const next = new Date((d + DAY) * 1000).toISOString().slice(0, 10);
    if (!trading(next)) continue;
    const date = new Date(d * 1000).toISOString().slice(0, 10);
    // 20:00 New York that evening: try both offsets, keep the one that reads 20:00 there
    for (const off of ["-05:00", "-04:00"]) { const t = T(`${date}T20:00:00${off}`); const n = nyTime(t); if (n.hour === 20 && n.date === date) { out.push(t); break; } }
  }
  return out;
}
const calendar = { isOpen: async (t) => isOpen(Number(t)), isOpenNow: async () => true };
const holiday = async (t) => { const n = nyTime(t); return n.dow >= 1 && n.dow <= 5 && HOLIDAYS.has(n.date); };
const S0 = (prints) => ({ calendar, market: { latestValue: async () => [1n, 0n] }, at: (now) => prints.filter((p) => p <= now).at(-1) });
async function silence(ticker, prints, now) {
  const S = S0(prints);
  S.market.latestValue = async () => [1n, BigInt(S.at(now))];
  return feedSilence(S, { name: `STOCK-${ticker}` }, now, {});
}

test("the DON heartbeat (schedule model) over its whole span, incl. Thanksgiving, Christmas 2026 and New Year: SPY, AAPL, SGOV never alert", async () => {
  const beats = heartbeats("2026-11-15", "2027-12-31");
  const r = rng(4242);
  for (const ticker of ["SPY", "AAPL", "SGOV"]) {
    for (let i = 0; i < 1500; i++) {
      const now = beats[0] + Math.floor(r() * (beats.at(-1) - beats[0]));
      const a = await silence(ticker, beats, now);
      assert.equal(a, null, `${ticker}: alerted on the heartbeat at ${new Date(now * 1000).toISOString()}: ${a?.msg}`);
    }
  }
});

test("honest cadence: prints whose market-week gaps stay within each ticker's measured worst never alert (108 sessions per ticker)", async () => {
  const start = T("2027-01-03T20:00:00-05:00"); // a Sunday evening: the market week opens
  for (const [ticker, honest] of Object.entries(FEED_CADENCE_HOURS)) {
    const r = rng(ticker.length * 7919 + Math.round(honest * 10));
    const prints = [start];
    let t = start, open = 0;
    const end = start + 22 * 7 * DAY; // ~108 sessions
    const gap = () => (0.3 + 0.7 * r()) * honest * H;
    let next = gap();
    while (t < end) { // walk market-week time; print when the drawn gap is used up
      t += 900;
      if (await inMarketWeek(t, holiday)) open += 900;
      if (open >= next) { prints.push(t); open = 0; next = gap(); }
    }
    for (let i = 0; i < 600; i++) {
      const now = start + Math.floor(r() * (end - start));
      const a = await silence(ticker, prints, now);
      assert.equal(a, null, `${ticker}: alerted on the honest cadence at ${new Date(now * 1000).toISOString()}: ${a?.msg}`);
    }
  }
});

async function criticalAt(died, critical) {
  let t = died, age = 0;
  while (age <= critical * H && t < died + MAX_AGE) { t += 1800; if (await inMarketWeek(t - 1800, holiday)) age += 1800; }
  return t;
}

test("a dead feed (34 h critical: SPY, AAPL, SGOV, TSLA) is CRITICAL >= 36 h before maxAge, dying at every hour of every week to end-2027", async () => {
  const { critical } = feedThresholds(24);
  let worst = Infinity, worstAt = null;
  for (let died = T("2026-11-22T00:00:00-05:00"); died < T("2027-12-31T00:00:00-05:00"); died += H) {
    const t = await criticalAt(died, critical);
    if (died + MAX_AGE - t < worst) { worst = died + MAX_AGE - t; worstAt = died; }
  }
  console.log(`smallest margin ${worst / H} h (dead after ${new Date(worstAt * 1000).toISOString()})`);
  assert.ok(worst >= 36 * H, `smallest margin ${worst / H} h, dead after ${new Date(worstAt * 1000).toISOString()}`);
  const a = await silence("SPY", [worstAt], worstAt + MAX_AGE - worst);
  assert.equal(a?.level, "critical", "feedSilence agrees at the computed time");
});

test("every ticker: CRITICAL >= 36 h before maxAge dying at every hour of the closure weeks (Thanksgiving 2026, Christmas 2026, New Year, MLK, Good Friday, July 4, Thanksgiving 2027)", async () => {
  const weeks = ["2026-11-22", "2026-12-20", "2026-12-27", "2027-01-17", "2027-03-21", "2027-06-27", "2027-11-21"].map((d) => T(`${d}T00:00:00-05:00`));
  for (const [ticker, honest] of Object.entries(FEED_CADENCE_HOURS)) {
    const { critical } = feedThresholds(honest);
    for (const w of weeks) for (let h = 0; h < 168; h++) {
      const died = w + h * H;
      const t = await criticalAt(died, critical);
      assert.ok(died + MAX_AGE - t >= 36 * H, `${ticker} dead after ${new Date(died * 1000).toISOString()}: critical ${(t - died) / H} h after, maxAge at 144 h`);
    }
  }
});

test("Thursday 20:00 New York, SPY: warn then critical, both long before maxAge (the reviewer's case), and a new round clears it", async () => {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  const died = T("2027-01-21T20:00:00-05:00"); // Thursday
  const resume = died + 4 * DAY + 12 * H; // Tuesday 08:00: still priced (unpriced Wednesday 20:00, 144 h)
  const SPY = utils.formatBytes32String("STOCK-SPY");
  const { w, ctx } = makeWorld({ now: died, types: [{ id: SPY, name: "STOCK-SPY", auction: true, stock: true, isOpen, lastPrint: (now) => (now >= resume ? resume : died) }] });
  const log = [];
  const standing = new Map();
  ctx.alerts = { raise: async (l, k) => { standing.set(k, l); log.push({ t: w.now, l, k }); }, settle: async (p, held) => { for (const k of [...standing.keys()]) if (k.startsWith(p) && !held.has(k)) { standing.delete(k); log.push({ t: w.now, l: "cleared", k }); } } };
  for (; w.now < resume + H; w.now += 1800) await runStocks(ctx);
  const mine = log.filter((x) => x.k === "stocks-feed-silent-STOCK-SPY");
  const warn = mine.find((x) => x.l === "warn"), crit = mine.find((x) => x.l === "critical");
  assert.ok(warn && crit && warn.t < crit.t, JSON.stringify(mine.slice(0, 3)));
  assert.ok(crit.t <= died + MAX_AGE - 36 * H, `critical ${(crit.t - died) / H} h after the print`);
  assert.ok(mine.some((x) => x.l === "cleared" && x.t >= resume), "a newer round did not clear it");
});
