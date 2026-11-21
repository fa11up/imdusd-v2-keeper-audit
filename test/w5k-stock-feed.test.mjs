// Stocks, the wave-5b contracts snapshot: every 4663 stock feed's maxAge is 5 days (STOCK_MAX_AGE), so a dead stock feed
// is no longer caught by staleness for 5 days. PROPERTY: a stock type's Chainlink feed silent more than 25 h of MARKET-SESSION time
// (weekends, holidays and closed hours do not count) raises warn `stocks-feed-silent-*`, more than 49 h critical; the measured cadence
// (measured: SPY's quietest days print within 24 h of session time, incl. sessions with no in-session print) never
// alerts; the alert clears only on a pass that read a NEWER round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utils } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5k-stockfeed-"));
const { runStocks } = await import("../lib/stocks.mjs");
const { makeWorld, rng } = await import("./lib/rh-world.mjs");

const SPY = utils.formatBytes32String("STOCK-SPY");
const DAY = 86_400;
const MON = 1_800_316_800; // a Monday 00:00 UTC
// Regular session 13:30-20:00 UTC, Mon-Fri, one holiday (the 2nd Wednesday)
const isOpen = (t) => {
  const d = Math.floor((t - MON) / DAY), dow = ((d % 7) + 7) % 7, s = (t - MON) % DAY;
  return dow < 5 && d !== 9 && s >= 13.5 * 3600 && s < 20 * 3600;
};

function run(prints, until, every = 600) {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  const { w, ctx } = makeWorld({ now: MON, types: [{ id: SPY, name: "STOCK-SPY", auction: true, stock: true, isOpen, lastPrint: (now) => prints.filter((p) => p <= now).at(-1) ?? MON - DAY }] });
  const standing = new Map(), log = [];
  ctx.alerts = { raise: async (l, k) => { standing.set(k, l); log.push({ t: w.now, l, k }); }, settle: async (p, held) => { for (const k of [...standing.keys()]) if (k.startsWith(p) && !held.has(k)) { standing.delete(k); log.push({ t: w.now, l: "cleared", k }); } } };
  return (async () => {
    for (; w.now < until; w.now += every) await runStocks(ctx);
    return log.filter((x) => x.k === "stocks-feed-silent-STOCK-SPY");
  })();
}

test("the measured cadence never alerts: one print per session at a random time, some only outside the session (4 weeks, 5 seeds)", async () => {
  for (let seed = 1; seed <= 5; seed++) {
    const r = rng(seed);
    const prints = [];
    for (let d = 0; d < 28; d++) {
      const day = MON + d * DAY;
      if (!isOpen(day + 15 * 3600)) continue;
      // in session, or (as SPY's quiet days) just after the close
      prints.push(Math.floor(day + (r() < 0.25 ? 20.2 * 3600 + r() * 3600 : 13.6 * 3600 + r() * 6 * 3600)));
    }
    const out = await run(prints, MON + 28 * DAY, 3600);
    assert.deepEqual(out, [], `seed ${seed}: alerted on an honest cadence at ${out[0] && new Date(out[0].t * 1000).toISOString()}`);
  }
});

test("a feed that stops: warn past 25 h of session time, critical past 49 h; weekends do not count; a new round clears it", async () => {
  const prints = [MON + 14 * 3600]; // Monday's print, then silence until the third Monday
  const resume = MON + 21 * DAY + 14 * 3600;
  prints.push(resume);
  const out = await run(prints, MON + 21 * DAY + 15 * 3600, 1800);
  const warn = out.find((x) => x.l === "warn"), crit = out.find((x) => x.l === "critical"), cleared = out.find((x) => x.l === "cleared");
  // 6.5 h a session: 25 h = the 5th session after Monday's (Mon 6h + Tue..Fri 26 h), 49 h = 8 sessions on (the holiday Wednesday skipped)
  assert.ok(warn && !isNaN(warn.t), "never warned");
  assert.ok(isOpen(warn.t), "warned outside a session");
  assert.ok(crit && crit.t > warn.t + 2 * DAY, `critical ${crit && (crit.t - warn.t) / 3600} h after the warn`);
  assert.ok(cleared && cleared.t >= resume, "not cleared by the new round");
  assert.ok(!out.some((x) => x.l !== "cleared" && x.t > resume), "raised after the new round");
});
