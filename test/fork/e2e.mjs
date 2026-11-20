// The keeper against the real v2 beta on a local anvil fork (test/fork/up.sh deploys it). Rerunnable: the fork is restored at the end.
// Proves on real contracts: the ABIs, report-only sends nothing, the depth hour, mark when
// the keeper cannot pay, no double mark, guarded bite when it can, tick on unpriced and priced again.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { swapProvenForStandIn } from "./proven-standin.mjs";
import { BigNumber, Contract, constants, providers, utils, Wallet } from "ethers";
import { pokeNeeded, readLow } from "../../lib/depth.mjs";

const RPC = process.env.RPC ?? "http://127.0.0.1:8557";
const WORK = new URL("./.work/", import.meta.url);
const MNEMONIC = "test test test test test test test test test test test junk";
process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "v2-keeper-e2e-"));
process.env.DEPLOYMENT = new URL("record.json", WORK).pathname;
process.env.KEEPER_MNEMONIC = MNEMONIC;
delete process.env.PLANE_BEARER;
delete process.env.GUARDIAN_PRIVATE_KEY;
const { makeContext, runRound } = await import("../../keeper.mjs");
const { writeState, readState } = await import("../../lib/state.mjs");

const cfg = (await import("../../config.example.js")).default;
// No plane in this file: nothing answers here, so the feeds and seats loops hold (test/fork/duties.mjs drives them against a local mock).
// No 4663 peer on this fork: the bridge watcher is off here (it raises bridge-watch-off; the watcher is proven on fake chains only).
const CFG = { ...cfg, READ_RPC_URLS: [RPC], SEND_RPC_URLS: [RPC], ALLOW_PUBLIC_SEND: true, API_BASE: "http://127.0.0.1:1", API_FALLBACKS: [], PLANE: { useEns: false, timeoutMs: 500 }, BRIDGE_WATCH: { ...cfg.BRIDGE_WATCH, enabled: false } };

const raw = new providers.StaticJsonRpcProvider(RPC, 1);
raw.pollingInterval = 100;
const rpc = (m, p = []) => raw.send(m, p);
const mine = (n) => rpc("anvil_mine", [utils.hexValue(n)]);
const lines = [];
const log = (s) => { lines.push(s); if (process.env.VERBOSE) console.log(s); };
const ok = (s) => console.log(`  ok  ${s}`);
const AGG = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ETH_ILK = utils.formatBytes32String("ETH");
const slot = (i) => utils.hexZeroPad(BigNumber.from(i).toHexString(), 32);

const snapshot = await rpc("evm_snapshot");
// Anvil's pending block follows the wall clock, so a fork left up for an hour estimates gas past the feeds' maxAge while calls at latest still pass.
await rpc("evm_setTime", [(await raw.getBlock("latest")).timestamp]);
let failed = false;
try {
  const report = await makeContext(CFG, { log });
  report.provider.pollingInterval = 100;
  const exec = await makeContext(CFG, { execute: true, log });
  // anvil cannot verify a storage proof against its own headers: the proven depth reference gets its fork stand-in (proven-standin.mjs).
  await swapProvenForStandIn(raw, exec.signer, JSON.parse(readFileSync(process.env.DEPLOYMENT, "utf8")));
  exec.provider.pollingInterval = 100;
  const { book } = exec;
  const keeper = exec.keeperAddress;
  assert.ok(book.ilks.some((t) => t.name === "ETH"), "ETH type listed");
  assert.equal(book.ilks.find((t) => t.name === "SIMD").config.liveSpot === constants.AddressZero, false, "sIMD has a live leg");
  ok(`book: ${book.ilks.map((t) => t.name).join(", ")}`);

  const nonce = () => raw.getTransactionCount(keeper);
  const forceDepth = async () => {
    const { timestamp } = await raw.getBlock("latest");
    writeState("depth.json", { hour: Math.floor(timestamp / 3600), at: timestamp - 1, done: false });
  };

  // --- report-only sends nothing
  await forceDepth();
  const n0 = await nonce();
  const failedLoops = await runRound(report);
  assert.deepEqual(failedLoops, [], lines.slice(-20).join("\n"));
  assert.equal(await nonce(), n0, "report-only sent a transaction");
  // From POKE_URGENT_AFTER (18:00 UTC) with no poke yet today, the poke goes alone first and the samples follow in their own batch.
  const said = (re) => lines.some((l) => re.test(l));
  assert.ok(said(/would   depth round: (\d+ proof\(s\) \+ )?\d+ samples/) && (said(/would   depth round: (\d+ proof\(s\) \+ )?\d+ samples \+ poke/) || said(/would   poke ImdDepth/)), "report-only says what it would do");
  ok("report-only: full round, no transaction");

  // --- depth
  await forceDepth();
  const before = await Promise.all(book.samplers.map((s) => s.filledBuckets()));
  assert.deepEqual(await runRound(exec, ["depth"]), []);
  const after = await Promise.all(book.samplers.map((s) => s.filledBuckets()));
  const ages = await Promise.all(book.samplers.map((s) => s.sampleAge()));
  const refused = lines.filter((l) => /depth   sample .* refuses/.test(l));
  console.log(`      samplers: ${ages.map((a, i) => `age ${a.gt(1e9) ? "never" : a} buckets ${before[i]}->${after[i]}`).join(" | ")}${refused.length ? `; refused: ${refused.join("; ")}` : ""}`);
  assert.ok(ages.some((a) => a.lt(120)), "at least one sampler took a sample");
  assert.equal(readState("depth.json").done, true, "the hour is closed once the poke landed");
  const n1 = await nonce();
  await runRound(exec, ["depth"]);
  assert.equal(await nonce(), n1, "second run in the hour sends nothing");
  ok("depth: samplers sampled, poke landed, one action per hour");

  // --- the poke skip reads the real layout, and a poke it would skip really writes nothing
  const { timestamp: tNow } = await raw.getBlock("latest");
  const low = await readLow({ provider: raw, book }, tNow);
  const today = await book.imdDepth.lowOf(0);
  assert.equal(low.day, Number(today.day), "readLow: the day");
  assert.equal(low.n, 1, "readLow: one hour poked");
  assert.equal(low.hours[0], Math.floor((tNow % 86_400) / 3600), "readLow: the hour");
  assert.equal(low.usd[low.n - 1].toString(), today.usd.toString(), "readLow: the figure");
  const v = BigInt((await book.imdDepth.sampled()).toString());
  if (!pokeNeeded(low, tNow, v)) {
    const rc = await (await book.imdDepth.connect(exec.signer).poke()).wait();
    assert.equal(rc.logs.length, 0, "a poke the keeper would skip writes nothing");
    assert.equal(JSON.stringify(await readLow({ provider: raw, book }, tNow), (_, x) => (typeof x === "bigint" ? x.toString() : x)), JSON.stringify(low, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
    ok("depth: a skipped poke would have written nothing");
  } else ok("depth: readLow matches the chain (the reading fell, so no skip to check)");

  // --- positions: a real loan on the real Ledger, ETH/USD replaced by a mock we control
  const { timestamp } = await raw.getBlock("latest");
  const live = new Contract(AGG, ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], raw);
  const [, startAnswer] = await live.latestRoundData();
  await rpc("anvil_setCode", [AGG, readFileSync(new URL("./mock-aggregator.hex", import.meta.url), "utf8").trim()]);
  const setAgg = async (answer, at) => {
    await rpc("anvil_setStorageAt", [AGG, slot(0), slot(answer)]);
    await rpc("anvil_setStorageAt", [AGG, slot(1), slot(at)]);
    await mine(1);
  };
  await setAgg(startAnswer, timestamp);

  const ledgerAbi = ["function open(bytes32 ilk, uint256 salt, (int256 dCollateral,int256 dDebt,uint64 rate,uint256 prevHint,uint256 nextHint,bool viaAsset,uint256 maxUpfrontFee,address to) a) returns (uint256)", "function positionId(address,bytes32,uint256) view returns (uint256)"];
  const wallet = (i) => Wallet.fromMnemonic(MNEMONIC, `m/44'/60'/0'/0/${i}`).connect(raw);
  const wethAbi = ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];
  const openLoan = async (w, weth, debt) => {
    const t = new Contract(WETH, wethAbi, w);
    await (await t.deposit({ value: utils.parseEther(String(weth)) })).wait();
    await (await t.approve(book.ledger.address, constants.MaxUint256)).wait();
    const l = new Contract(book.ledger.address, ledgerAbi, w);
    const a = [utils.parseEther(String(weth)), utils.parseEther(String(debt)), utils.parseEther("0.05"), 0, 0, false, constants.MaxUint256, constants.AddressZero];
    await (await l.open(ETH_ILK, 0, a)).wait();
    return l.positionId(w.address, ETH_ILK, 0);
  };
  const victim = wallet(1), whale = wallet(2);
  const id = await openLoan(victim, 10, 5000);
  const idWhale = await openLoan(whale, 100, 5000);
  await mine(5);
  exec.index = null;
  assert.deepEqual(await runRound(exec, ["positions"]), [], lines.slice(-8).join("\n"));
  assert.equal(Number((await book.liquidator.marks(id)).markedAt), 0, "a healthy loan is left alone");
  assert.ok(exec.index[ETH_ILK].includes(id.toString()), "the index found the position from Opened");
  ok("positions: found by the Opened index and collateral sum; healthy left alone");

  const q0 = await book.pricer.quote(ETH_ILK);
  const owed = await book.ledger.debtOf(id);
  const unhealthyPrice = owed.mul(q0.mat).mul(9).div(10).div(utils.parseEther("10")); // 90% of the price at mat, USD 1e18
  const answer = unhealthyPrice.div(BigNumber.from(10).pow(10));
  const fresh = async () => (await raw.getBlock("latest")).timestamp;
  await setAgg(answer, await fresh());
  assert.equal((await book.ledger.healthy(id)).ok, false, "price crash makes the loan unhealthy");
  assert.equal((await book.ledger.healthy(idWhale)).ok, true, "the big loan stays healthy");

  // The keeper holds no imdUSD and no sleeve has room: the caller path refuses, and it marks instead.
  const mainLines = lines.length;
  assert.deepEqual(await runRound(exec, ["positions"]), [], lines.slice(-8).join("\n"));
  const mark = await book.liquidator.marks(id);
  assert.ok(Number(mark.markedAt) > 0, `marked: ${lines.slice(mainLines).join("\n")}`);
  assert.equal(mark.marker, keeper);
  assert.ok(lines.slice(mainLines).some((l) => /cannot close/.test(l)), "says why it could not close");
  const n2 = await nonce();
  await runRound(exec, ["positions"]);
  assert.equal(await nonce(), n2, "no second mark, no doomed send");
  ok("liquidation: no imdUSD -> marks once, earns the chip, does not re-send");

  // With imdUSD it closes through the guarded form.
  const usd = new Contract(book.usd.address, ["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], raw);
  for (const w of [victim, whale]) await (await usd.connect(w).transfer(keeper, await usd.balanceOf(w.address))).wait();
  const wethBefore = await new Contract(WETH, wethAbi, raw).balanceOf(keeper);
  const m = lines.length;
  await setAgg(answer, await fresh());
  assert.deepEqual(await runRound(exec, ["positions"]), [], lines.slice(-8).join("\n"));
  const sent = lines.slice(m).find((l) => /^.{20}bite ETH/.test(l) && l.includes("sent"));
  assert.ok(sent, `a guarded bite was sent: ${lines.slice(m).join("\n")}`);
  const wethAfter = await new Contract(WETH, wethAbi, raw).balanceOf(keeper);
  assert.ok(wethAfter.gt(wethBefore), "the keeper took the collateral");
  const left = await book.ledger.debtOf(id);
  console.log(`      seized ${utils.formatEther(wethAfter.sub(wethBefore))} WETH; debt ${utils.formatEther(owed)} -> ${utils.formatEther(left)}`);
  assert.ok(left.lt(owed), "debt fell");
  ok("liquidation: with imdUSD -> bite(id, minSeized) closes it");

  // Tick: stale ETH/USD with debt open.
  await setAgg(answer, (await fresh()) - 8000);
  assert.equal((await book.pricer.quote(ETH_ILK)).priced, false, "ETH unpriced");
  await runRound(exec, ["positions"]);
  assert.notEqual(Number((await book.liquidator.clocks(ETH_ILK)).unpricedSince), 0, "tick recorded the unpriced span");
  await setAgg(answer, await fresh());
  await runRound(exec, ["positions"]);
  const clock = await book.liquidator.clocks(ETH_ILK);
  assert.equal(Number(clock.unpricedSince), 0, "tick closed it");
  assert.ok(Number(clock.paused) > 0, "the paused time was booked");
  const n3 = await nonce();
  await runRound(exec, ["positions"]);
  assert.equal(await nonce(), n3, "no needless tick");
  ok("tick: on unpriced, on priced again, then silent");

  // Watch reads every view it depends on.
  assert.deepEqual(await runRound(exec, ["watch"]), [], lines.slice(-8).join("\n"));
  console.log(`      watch: ${lines.filter((l) => l.includes("watch   ")).at(-1)?.slice(20)}`);
  ok("watch: runs on the real views");

  // A stuck send, through a real Contract (ethers' wrapper passes `wait` the confirmations only): it must leave the queue within
  // SEND_WAIT_SECONDS, and the next urgent send must raise its fees on its own nonce and go out on the next one, dropping nothing.
  const { act } = await import("../../lib/act.mjs");
  const { pendingIntents } = await import("../../lib/journal.mjs");
  const fast = await makeContext({ ...CFG, SEND_WAIT_SECONDS: 2, URGENT_WAIT_SECONDS: 1 }, { execute: true, log });
  fast.provider.pollingInterval = 100;
  await rpc("evm_setAutomine", [false]);
  try {
    const n0 = await raw.getTransactionCount(fast.signer.address, "latest");
    const t0 = Date.now();
    const r1 = await act(fast, "tick (left pending)", book.liquidator, "tick", [ETH_ILK], { tier: "urgent" });
    assert.ok(r1.pending, `left the queue as pending: ${JSON.stringify(r1)}`);
    assert.ok(Date.now() - t0 < 20_000, `within its wait, not 15 minutes (${Date.now() - t0} ms)`);
    await new Promise((r) => setTimeout(r, 1_200));
    const r2 = await act(fast, "tick (after the stuck one)", book.liquidator, "tick", [ETH_ILK], { tier: "urgent" });
    assert.ok(r2.pending, `the second send went out: ${JSON.stringify(r2)}`);
    const open = pendingIntents().map((i) => i.nonce).sort((x, y) => x - y);
    assert.deepEqual(open, [n0, n0 + 1], "the stuck send kept its nonce, the new one took the next");
    const bumped = pendingIntents().find((i) => i.nonce === n0).hash;
    assert.notEqual(bumped, r1.pending, "the stuck send was replaced by a fee-raised copy");
    await rpc("evm_mine", []);
    assert.equal((await raw.getTransactionReceipt(bumped))?.status, 1, "the fee-raised copy mined");
    assert.equal(await raw.getTransactionReceipt(r1.pending), null, "the original did not");
    assert.equal((await raw.getTransactionReceipt(r2.pending))?.status, 1, "the new action mined after it");
  } finally {
    await rpc("evm_setAutomine", [true]);
  }
  ok("send: a stuck send leaves the queue in its wait; the next urgent one raises its fees and goes out after it");
} catch (e) {
  failed = true;
  console.error(`FAILED: ${e.message}`);
  console.error(lines.slice(-25).join("\n"));
} finally {
  await rpc("evm_revert", [snapshot]);
}
process.exit(failed ? 1 : 0);
