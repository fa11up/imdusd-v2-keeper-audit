// PROPERTY (audit wave 4, C9): safety state that exists but cannot be read is never treated as empty. Orders, the day's spend, the buy
// gap and the send journal: buying is held, nothing is signed, the unreadable file is never written over (its bytes survive every
// operation), and a write after a crash between temp and rename leaves the old file or the new one. Advisory state (alerts, cursors)
// is moved aside and kept, never silently overwritten.
//
// A small seeded fuzz: every iteration draws each safety file as absent, valid or one of several corruptions, then runs a random
// sequence of the operations that read or write them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, utils } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w4-state-"));
process.env.PLANE_BEARER = "x";
const state = await import("../lib/state.mjs");
const { statePath, writeState } = state;
const { buyHold, clearLost, lostOrders, spentToday, startOrder } = await import("../lib/orders.mjs");
const { pendingIntents } = await import("../lib/journal.mjs");
const { send } = await import("../lib/tx.mjs");
const { makeAlerts } = await import("../lib/alerts.mjs");
await import("../lib/feeds.mjs"); // declares the feeds.json shape, as the keeper does

const E18 = BigNumber.from(10).pow(18);
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const today = () => new Date().toISOString().slice(0, 10);
const holdCtx = (raised) => ({
  cfg: {}, planeState: { ok: true }, signer: { address: "0x00000000000000000000000000000000000000ee" },
  provider: { getBalance: async () => E18, getGasPrice: async () => BigNumber.from(10).pow(9) },
  book: { token: () => ({ balanceOf: async () => E18.mul(50) }) }, alerts: { raise: async (l, k) => raised.push(`${l}:${k}`) },
});

const CORRUPT = [
  () => '{"list":[{"key":"k","stage":"refused-paid"', // torn
  () => "\u0000garbage",
  () => "",
  () => "[]",
  () => "null",
  () => '{"list":"x"}',
  () => '{"day":1,"imd":"x"}',
  () => '{"list":[{"stage":"lost"}]}',
];
const VALID = {
  "orders.json": (r) => JSON.stringify({ list: r() < 0.5 ? [] : [{ key: "k", purpose: "fall", stage: r() < 0.5 ? "lost" : "admitted", planeOrder: "o" }] }),
  "imd-spend.json": (r) => JSON.stringify({ day: today(), imd: utils.parseEther(String(Math.floor(r() * 6))).toString() }),
  "feeds.json": () => JSON.stringify({ lastFallAt: 1 }),
};
const FILES = Object.keys(VALID);

function clean() {
  for (const f of readdirSync(state.stateDir())) rmSync(statePath(f), { recursive: true, force: true });
}

function draw(r) {
  const out = {};
  for (const f of FILES) {
    const x = r();
    if (x < 0.3) out[f] = { kind: "absent" };
    else if (x < 0.55) out[f] = { kind: "valid", text: VALID[f](r) };
    else if (x < 0.65) out[f] = { kind: "dir" };
    else {
      const text = CORRUPT[Math.floor(r() * CORRUPT.length)]();
      // A shape that happens to be valid for this file is not a corruption of it.
      const shapeOk = f === "feeds.json" ? text.startsWith("{") && (() => { try { JSON.parse(text); return true; } catch { return false; } })()
        : f === "orders.json" ? /^\{"list":\[\]/.test(text) : false;
      out[f] = shapeOk ? { kind: "valid", text } : { kind: "corrupt", text };
    }
  }
  return out;
}

function lay(files) {
  for (const [f, s] of Object.entries(files)) {
    if (s.kind === "valid" || s.kind === "corrupt") writeFileSync(statePath(f), s.text);
    if (s.kind === "dir") mkdirSync(statePath(f));
  }
}
const bytes = (f) => (existsSync(statePath(f)) ? (() => { try { return readFileSync(statePath(f), "utf8"); } catch { return "<unreadable>"; } })() : "<absent>");

test("property C9: an unreadable orders/spend/feeds file holds buying and is never written over (seeded fuzz, 400 cases)", async () => {
  const r = rng(0xc9);
  const failures = [];
  for (let i = 0; i < 400; i++) {
    clean();
    const files = draw(r);
    lay(files);
    const bad = (f) => files[f].kind === "corrupt" || files[f].kind === "dir";
    const before = Object.fromEntries(FILES.map((f) => [f, bytes(f)]));
    const raised = [];
    const ops = Array.from({ length: 1 + Math.floor(r() * 4) }, () => Math.floor(r() * 5));
    let hold = "not asked";
    for (const op of ops) {
      try {
        if (op === 0) hold = await buyHold(holdCtx(raised), E18.div(2));
        if (op === 1) startOrder("fall", [{ role: "price", leaf: "0x01", input: {} }]);
        if (op === 2) clearLost();
        if (op === 3) writeState("feeds.json", { lastFallAt: 2 });
        if (op === 4) writeState("imd-spend.json", { day: today(), imd: "0" });
      } catch (e) {
        if (e.code !== "STATE_UNREADABLE") failures.push(`case ${i} op ${op}: unexpected ${e.message}`);
      }
    }
    if (hold === "not asked") hold = await buyHold(holdCtx(raised), E18.div(2)).catch((e) => `threw ${e.message}`);
    if ((bad("orders.json") || bad("imd-spend.json")) && hold === null) failures.push(`case ${i}: buyHold null with ${JSON.stringify(files)}`);
    for (const f of FILES) if (bad(f) && bytes(f) !== before[f]) failures.push(`case ${i}: unreadable ${f} was written over`);
    if (failures.length > 5) break;
  }
  assert.deepEqual(failures, []);
});

test("property C9: with readable state the hold is exactly what the files say", async () => {
  const r = rng(7);
  for (let i = 0; i < 100; i++) {
    clean();
    const lost = r() < 0.5;
    const spent = Math.floor(r() * 7);
    writeState("orders.json", { list: lost ? [{ key: "k", stage: "lost", planeOrder: "o" }] : [] });
    writeState("imd-spend.json", { day: today(), imd: utils.parseEther(String(spent)).toString() });
    const hold = await buyHold(holdCtx([]), E18.div(2));
    assert.equal(hold !== null, lost || spent + 0.5 > 5, `lost ${lost} spent ${spent}: ${hold}`);
    assert.equal(lostOrders().length, lost ? 1 : 0);
    assert.equal(spentToday().toString(), utils.parseEther(String(spent)).toString());
  }
});

test("property C9: an unreadable intent in the send journal: nothing is signed, the file stays", async () => {
  const r = rng(11);
  for (let i = 0; i < 40; i++) {
    clean();
    mkdirSync(statePath("tx"), { recursive: true });
    const text = CORRUPT[Math.floor(r() * CORRUPT.length)]();
    writeFileSync(statePath("tx/7.json"), text);
    let signed = 0;
    const signer = {
      address: "0x00000000000000000000000000000000000000ee", journalScope: "tx", rebroadcast: async () => {},
      provider: { getTransactionReceipt: async () => null, getTransactionCount: async () => 7, getGasPrice: async () => BigNumber.from(1), getBalance: async () => E18 },
    };
    let threw = false;
    try {
      await send(signer, "x", async () => {}, async () => { signed += 1; return { hash: "0x", wait: async () => ({ blockNumber: 1, gasUsed: 1 }) }; }, {}, { tier: r() < 0.5 ? "urgent" : "routine" });
    } catch (e) {
      threw = e.code === "STATE_UNREADABLE";
    }
    assert.equal(signed, 0, `case ${i} (${JSON.stringify(text)}): a send went out past an unreadable intent`);
    assert.ok(threw, `case ${i}: not refused as unreadable`);
    assert.throws(() => pendingIntents(), /cannot be read/);
    assert.equal(readFileSync(statePath("tx/7.json"), "utf8"), text);
  }
});

test("property C9: a crash between the temp write and the rename leaves the old file; advisory state is moved aside, not lost", async () => {
  clean();
  writeState("orders.json", { list: [{ key: "k", stage: "lost", planeOrder: "o" }] });
  writeFileSync(`${statePath("orders.json")}.123.tmp`, '{"list":[]}'); // a write that died before its rename
  writeFileSync(`${statePath("orders.json")}.tmp`, "{");
  assert.equal(lostOrders().length, 1);
  // Advisory: alerts.json garbled. The raise still works, and the garbled bytes are kept beside it for a human.
  writeFileSync(statePath("alerts.json"), "\u0000\u0001");
  const a = makeAlerts(() => {});
  await a.raise("warn", "k", "m");
  const aside = readdirSync(state.stateDir()).filter((f) => f.startsWith("alerts.json.unreadable-"));
  assert.equal(aside.length, 1, "moved aside");
  assert.equal(readFileSync(statePath(aside[0]), "utf8"), "\u0000\u0001");
  assert.ok(JSON.parse(readFileSync(statePath("alerts.json"), "utf8")).k);
});

test("property C9: a state file the keeper may not read (EACCES) holds buying", { skip: process.getuid?.() === 0 }, async () => {
  clean();
  writeState("orders.json", { list: [] });
  chmodSync(statePath("orders.json"), 0o000);
  try {
    assert.notEqual(await buyHold(holdCtx([]), E18.div(2)), null);
  } finally {
    chmodSync(statePath("orders.json"), 0o600);
  }
});
