// PROPERTY (audit wave 4, P4, feeds): a pass never reports cleared a condition it could not read. Whenever the feeds pass says an alert
// is "cleared", that pass READ the condition and found it false. Seeded fuzz over passes of runFeeds with random truth (converged or
// not, the proven spot stale/ageing/fresh) and random reads failing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w4-feeds-"));
const { statePath } = await import("../lib/state.mjs");
const { makeAlerts } = await import("../lib/alerts.mjs");
const { runFeeds } = await import("../lib/feeds.mjs");
const { feedsWorld } = await import("./lib/feeds-world.mjs");

const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const READS = ["median.converged", "median.attested", "median.latestValue", "nhi.converged", "nhi.latestValue", "spot.latestValue", "spot.isStale", "spot.maxAge"];

test("property P4 (feeds): nothing is reported cleared that this pass could not read (seeded fuzz, 60 runs x 12 passes)", async () => {
  const r = rng(0x94);
  const failures = [];
  for (let run = 0; run < 60 && failures.length < 6; run++) {
    rmSync(statePath("alerts.json"), { force: true });
    const w = feedsWorld();
    for (let pass = 0; pass < 12; pass++) {
      w.now += 300;
      w.truth.medianConverged = r() < 0.5;
      w.truth.nhiConverged = r() < 0.7;
      w.truth.spotStale = r() < 0.3;
      w.truth.spotAge = Math.floor(r() * 7 * 3600);
      w.fail = new Set(READS.filter(() => r() < 0.15));
      const logs = [];
      try {
        await runFeeds(w.ctx(makeAlerts((s) => logs.push(s))));
      } catch (e) {
        if (!/disagree/.test(e.message)) failures.push(`run ${run} pass ${pass}: ${e.message}`);
      }
      const read = (role) => !["converged", "attested", "latestValue"].some((f) => w.fail.has(`${role}.${f}`)) && !(role === "nhi" && w.fail.has("nhi.attested"));
      const spotRead = !["spot.latestValue", "spot.isStale", "spot.maxAge"].some((f) => w.fail.has(f));
      for (const line of logs) {
        const m = /ALERT INFO (\S+): cleared/.exec(line);
        if (!m) continue;
        const key = m[1];
        const ok =
          key === "feeds-not-converged-median" ? read("median") && w.truth.medianConverged
          : key === "feeds-not-converged-nhi" ? read("nhi") && w.truth.nhiConverged
          : key.startsWith("feeds-proven-spot-") && key !== "feeds-proven-spot-unread" ? spotRead
          : true;
        if (!ok) failures.push(`run ${run} pass ${pass}: ${key} cleared while ${[...w.fail].join(", ")} failed (truth ${JSON.stringify(w.truth)})`);
      }
    }
  }
  assert.deepEqual(failures, []);
});
