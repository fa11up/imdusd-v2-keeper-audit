#!/usr/bin/env node
// The imdUSD v2 keeper: Ethereum by default, Robinhood Chain with `--chain 4663` (one process per chain, one shared config file:
// lib/chains.mjs says why). One process, one key, one queue: the loops take turns so two sends never race a nonce. Each loop is
// isolated: one that throws logs and waits for its next tick.
//
//   node keeper.mjs                      report only: reads, simulates, says what it would send
//   node keeper.mjs --execute            sends (KEEPER_MNEMONIC in the environment; SEND_RPC_URLS must be private RPCs)
//   node keeper.mjs --once [--only depth,watch]
//   node keeper.mjs --clear-lost         after a human has looked at a paid order the plane never admitted (lib/orders.mjs)
//   node keeper.mjs --chain 4663 [...]   the Robinhood Chain keeper: its own state dir (state-4663/), key (KEEPER_MNEMONIC_4663), RPCs
//                                        (READ_RPC_URLS_4663, SEND_RPC_URLS_4663 or CHAINS[4663]) and loops (ROBINHOOD_LOOPS)
//
// Order of a round: feeds, seats (an answer lands before anything acts on it), positions, depth, peg, backstop, allocator, guardian, watch.
import { existsSync } from "node:fs";
import { makeAlerts } from "./lib/alerts.mjs";
import { peerProviders, readProvider } from "./lib/chain.mjs";
import { applyStateDir, chainArg, chainConfig, evmBlockNumber, isMainnet } from "./lib/chains.mjs";
import { bridgeWatchOff, runBridge } from "./lib/bridge.mjs";
import { runImdFeeds } from "./lib/imdfeeds.mjs";
import { runPulse } from "./lib/pulse.mjs";
import { runRates } from "./lib/rates.mjs";
import { describeRobinhoodBook, loadRecord4663, makeRobinhoodBook } from "./lib/robinhood.mjs";
import { runStocks } from "./lib/stocks.mjs";
import { describeBook, loadRecord, makeBook } from "./lib/deployment.mjs";
import { runAllocator } from "./lib/allocator.mjs";
import { runBackstop } from "./lib/backstop.mjs";
import { runDepth } from "./lib/depth.mjs";
import { runFeeds } from "./lib/feeds.mjs";
import { runGuardian } from "./lib/guardian.mjs";
import { clearLost } from "./lib/orders.mjs";
import { runPeg } from "./lib/peg.mjs";
import { runPositions } from "./lib/positions.mjs";
import { runSeats } from "./lib/seats.mjs";
import { isUnreadable, reportStateDir, takeKeyLock, takeLock } from "./lib/state.mjs";
import { foreignPending, keeperSigner, refuseGuardianKey, sendUrls } from "./lib/tx.mjs";
import { runWatch } from "./lib/watch.mjs";

export const LOOPS = [
  { name: "feeds", run: runFeeds, every: (c) => c.INTERVALS?.feedsSeconds ?? 60 },
  { name: "seats", run: runSeats, every: (c) => c.INTERVALS?.seatsSeconds ?? 300 },
  { name: "positions", run: runPositions, every: (c) => c.INTERVALS?.positionsSeconds ?? 60 },
  { name: "depth", run: runDepth, every: (c) => c.INTERVALS?.depthSeconds ?? 60 },
  { name: "peg", run: runPeg, every: (c) => c.INTERVALS?.pegSeconds ?? 300 },
  { name: "backstop", run: runBackstop, every: (c) => c.INTERVALS?.backstopSeconds ?? 300 },
  { name: "allocator", run: runAllocator, every: (c) => c.INTERVALS?.allocatorSeconds ?? 300 },
  { name: "guardian", run: runGuardian, every: (c) => c.INTERVALS?.guardianSeconds ?? 60 },
  { name: "watch", run: runWatch, every: (c) => c.INTERVALS?.watchSeconds ?? 300 },
];

/** A shared duty on a 4663 record that lacks its contracts says so instead of throwing every pass. */
const needs = (keys, run) => async (ctx) => {
  const missing = keys.filter((k) => !ctx.book[k]);
  if (missing.length) return ctx.log(`${run.name.replace(/^run/, "").toLowerCase()} skipped: the record names no ${missing.join(", ")}`);
  return run(ctx);
};

// Robinhood Chain (4663). Order: the Pulse first (a poke past the gap opens the grace everything else reads), then the IMD answers, then
// positions (marks and bites), stock auctions (ticks, sync, writeOff), rate pokes, peg, sleeves, the Allocator, the guardian, the bridge
// watcher and the plain alerts. No depth, seats or proven price: 4663 has none.
export const ROBINHOOD_LOOPS = [
  { name: "pulse", run: runPulse, every: (c) => c.INTERVALS?.pulseSeconds ?? 60 },
  { name: "imdfeeds", run: runImdFeeds, every: (c) => c.INTERVALS?.imdFeedsSeconds ?? 120 },
  { name: "positions", run: runPositions, every: (c) => c.INTERVALS?.positionsSeconds ?? 60 },
  { name: "stocks", run: runStocks, every: (c) => c.INTERVALS?.stocksSeconds ?? 60 },
  { name: "rates", run: runRates, every: (c) => c.INTERVALS?.ratesSeconds ?? 900 },
  { name: "peg", run: runPeg, every: (c) => c.INTERVALS?.pegSeconds ?? 300 },
  { name: "backstop", run: needs(["blue", "edge", "backstopOracle"], runBackstop), every: (c) => c.INTERVALS?.backstopSeconds ?? 300 },
  { name: "allocator", run: needs(["allocator", "blue", "edge"], runAllocator), every: (c) => c.INTERVALS?.allocatorSeconds ?? 300 },
  { name: "guardian", run: needs(["allocator"], runGuardian), every: (c) => c.INTERVALS?.guardianSeconds ?? 60 },
  { name: "bridge", run: runBridge, every: (c) => c.INTERVALS?.bridgeSeconds ?? 120 },
  { name: "watch", run: runWatch, every: (c) => c.INTERVALS?.watchSeconds ?? 300 },
];
/** Mainnet's loops are exactly LOOPS; its bridge watcher runs only when BRIDGE_WATCH.enabled (the 4663 keeper watches both ends). */
export const loopsFor = (cfg) => (isMainnet(cfg) ? (cfg.BRIDGE_WATCH?.enabled ? [...LOOPS, { name: "bridge", run: runBridge, every: (c) => c.INTERVALS?.bridgeSeconds ?? 120 }] : LOOPS) : ROBINHOOD_LOOPS);

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/** One pass of the named loops (all by default), each isolated. Returns the names that threw. */
export async function runRound(ctx, only = null) {
  const failed = [];
  for (const l of ctx.loops ?? LOOPS) {
    if (only && !only.includes(l.name)) continue;
    if (ctx.cfg[`${l.name.toUpperCase()}_ENABLED`] === false) continue;
    ctx.fails ??= {};
    try {
      ctx.provider.unpin?.(); // each loop reads from a fresh common block
      await l.run(ctx);
      if (ctx.fails[l.name]) await ctx.alerts.settle(`loop-failing-${l.name}`, new Set());
      ctx.fails[l.name] = 0;
    } catch (e) {
      failed.push(l.name);
      ctx.log(`${l.name} loop error: ${String(e.message).slice(0, 200)}`);
      // A loop that throws every pass is a keeper doing nothing: after a few in a row it is an incident, not a log line.
      ctx.fails[l.name] = (ctx.fails[l.name] ?? 0) + 1;
      // A state file that cannot be read holds what depends on it until a human acts: say so at once, not after five passes.
      if (isUnreadable(e)) await ctx.alerts.raise("critical", "state-unreadable", e.message).catch(() => {});
      if (ctx.fails[l.name] >= (ctx.cfg.LOOP_FAIL_ALERT ?? 5)) {
        await ctx.alerts.raise("critical", `loop-failing-${l.name}`, `the ${l.name} loop has failed ${ctx.fails[l.name]} times in a row: ${String(e.message).slice(0, 200)}`).catch(() => {});
      }
    }
  }
  return failed;
}

export async function makeContext(cfg, { execute = false, log = console.log } = {}) {
  const provider = readProvider(cfg);
  const main = isMainnet(cfg);
  const recordPath = main ? process.env.DEPLOYMENT ?? cfg.DEPLOYMENT ?? "./deployment.json" : process.env[`DEPLOYMENT_${cfg.CHAIN_ID}`] ?? cfg.DEPLOYMENT ?? `./deployment-${cfg.CHAIN_ID}.json`;
  const record = main ? loadRecord(recordPath, cfg.CHAIN_ID ?? 1) : loadRecord4663(recordPath, cfg.CHAIN_ID);
  const book = main ? await makeBook(record, provider) : await makeRobinhoodBook(record, provider);
  const stamped = (s) => log(`${stamp()} ${s}`);
  refuseGuardianKey();
  const ctx = { cfg, execute, provider, book, log: stamped, alerts: makeAlerts(stamped, cfg.ALERT_PREFIX ?? "imdUSD v2 keeper"), loops: loopsFor(cfg), peers: peerProviders(cfg) };
  const watchOff = bridgeWatchOff(cfg, record);
  if (watchOff) {
    stamped(`WARNING ${watchOff}`);
    await ctx.alerts.raise("critical", "bridge-watch-off", watchOff).catch(() => {});
  }
  if (!main) {
    // The plane is paid on Ethereum: the 4663 keeper reads its IMD and Permit2 there and never sends there (lib/orders.mjs).
    if (ctx.peers[1]) ctx.pay = { provider: ctx.peers[1], chainId: 1 };
    ctx.evmHead = () => evmBlockNumber(provider, cfg);
  }
  if (execute) {
    if (!sendUrls(cfg).length && !cfg.ALLOW_PUBLIC_SEND) throw new Error("--execute without SEND_RPC_URLS: samples and liquidations must go by private send");
    ctx.signer = keeperSigner(provider, cfg.ALLOW_PUBLIC_SEND && !sendUrls(cfg).length ? { ...cfg, SEND_RPC_URLS: provider.urls.slice(0, 1) } : cfg);
    ctx.keeperAddress = ctx.signer.address;
    // One writer per key (audit wave 4, P3): a machine-wide lock named by the address, and no start past a foreign pending send.
    const releaseKey = takeKeyLock(ctx.keeperAddress);
    process.on("exit", releaseKey);
    const foreign = await foreignPending(provider, ctx.keeperAddress);
    if (foreign) throw new Error(`--execute refused: ${foreign}`);
  } else {
    ctx.keeperAddress = process.env.KEEPER_ADDRESS ?? cfg.KEEPER_ADDRESS ?? null;
  }
  return ctx;
}

async function loadConfig() {
  const here = new URL("./config.js", import.meta.url);
  const url = existsSync(here) ? here : new URL("./config.example.js", import.meta.url);
  return { cfg: (await import(url)).default, example: url !== here };
}

async function main() {
  if (process.argv.includes("--clear-lost")) {
    const { cfg: file } = await loadConfig();
    applyStateDir(chainConfig(file, chainArg() ?? file.CHAIN_ID ?? 1));
    const release = takeLock();
    try {
      return console.log(`${stamp()} cleared ${clearLost()} lost order(s)`);
    } finally {
      release();
    }
  }
  const execute = process.argv.includes("--execute");
  const { cfg: file, example } = await loadConfig();
  const cfg = chainConfig(file, chainArg() ?? file.CHAIN_ID ?? 1);
  applyStateDir(cfg); // a chain other than mainnet: its own state dir, before any lock or state is touched
  if (execute) process.on("exit", takeLock());
  else process.env.STATE_DIR = reportStateDir();
  const once = process.argv.includes("--once");
  const i = process.argv.indexOf("--only");
  const only = i > 0 ? process.argv[i + 1].split(",") : null;
  if (example) console.log(`${stamp()} no config.js: running on config.example.js`);
  const ctx = await makeContext(cfg, { execute });
  console.log(`${stamp()} v2 keeper, chain ${cfg.CHAIN_ID}, ${execute ? "IN EXECUTE MODE" : "in report-only mode"}${ctx.keeperAddress ? `, keeper ${ctx.keeperAddress}` : ""}`);
  console.log(`${stamp()} reads ${ctx.provider.agree ? `${ctx.provider.urls.length} RPCs must agree` : "ONE RPC: nothing compared"}`);
  for (const line of (isMainnet(cfg) ? describeBook(ctx.book) : describeRobinhoodBook(ctx.book)).split("\n")) console.log(`${stamp()} ${line}`);
  if (once) {
    process.exitCode = (await runRound(ctx, only)).length ? 1 : 0;
    return;
  }
  for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { console.log(`${stamp()} ${s}, stopping`); process.exit(0); });
  const next = new Map(ctx.loops.map((l) => [l.name, 0]));
  for (;;) {
    for (const l of ctx.loops) {
      if ((only && !only.includes(l.name)) || Date.now() < next.get(l.name)) continue;
      await runRound(ctx, [l.name]);
      next.set(l.name, Date.now() + l.every(cfg) * 1000);
    }
    const wake = Math.min(...[...next.entries()].filter(([n]) => !only || only.includes(n)).map(([, t]) => t)) - Date.now();
    await new Promise((r) => setTimeout(r, Math.max(1000, wake)));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`${stamp()} ${e.message}`); process.exit(1); });
