// PROPERTY (audit wave 4, C6): the plane-health hold rests only on recent evidence, and a hold that lasts is critical. Buying is held
// iff the newest `holdAfterBlocked` settled requests within blockedMaxAgeSeconds (6 h) are all blocked; old or undated rows never
// hold; and a hold standing past holdCriticalSeconds (2 h) is raised critical. Seeded fuzz over /oracle/requests documents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w4-plane-"));
const { plane } = await import("../lib/plane.mjs");
const { writeState } = await import("../lib/state.mjs");
const { runFeeds } = await import("../lib/feeds.mjs");
const { feedsWorld } = await import("./lib/feeds-world.mjs");

const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const STATUS = ["attested", "blocked", "blocked", "blocked", "disagreed", "mismatch", "assessing", "queued"];
const fetchOf = (rows) => async (url) => ({ ok: true, json: async () => (String(url).endsWith("/health") ? { status: "ok" } : { requests: rows }) });

test("property C6: the hold rests only on settled requests from the last 6 h (seeded fuzz, 2000 documents)", async () => {
  const r = rng(0xc6);
  const cfg = { API_BASE: "https://plane.invalid", PLANE: { useEns: false, holdAfterBlocked: 3 } };
  for (let i = 0; i < 2000; i++) {
    const rows = Array.from({ length: Math.floor(r() * 8) }, () => ({
      status: STATUS[Math.floor(r() * STATUS.length)],
      createdAt: r() < 0.1 ? "not a date" : new Date(Date.now() - Math.floor(r() * 12 * 3600_000)).toISOString(),
    }));
    // Newest first, as the plane lists them.
    rows.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
    const recent = rows.filter((x) => ["attested", "disagreed", "blocked", "mismatch"].includes(x.status) && Date.now() - Date.parse(x.createdAt) <= 6 * 3600_000).slice(0, 3);
    const want = !(recent.length === 3 && recent.every((x) => x.status === "blocked"));
    const got = await plane(null, cfg, fetchOf(rows));
    assert.equal(got.ok, want, `${JSON.stringify(rows)} -> ${got.why}`);
  }
});

test("property C6: a hold standing past 2 h is critical", async () => {
  const blocked = Array.from({ length: 3 }, () => ({ status: "blocked", createdAt: new Date().toISOString() }));
  const w = feedsWorld();
  const raised = [];
  const ctx = w.ctx({ raise: async (l, k) => raised.push(`${l}:${k}`), settle: async () => {} });
  ctx.cfg.PLANE.holdAfterBlocked = 3;
  ctx.fetchImpl = fetchOf(blocked);
  await runFeeds(ctx);
  assert.ok(raised.includes("warn:feeds-plane-hold"), raised.join(" "));
  writeState("plane-hold.json", { since: Date.now() - 2 * 3600_000 - 1000 });
  raised.length = 0;
  await runFeeds(ctx);
  assert.ok(raised.includes("critical:feeds-plane-hold"), raised.join(" "));
});
