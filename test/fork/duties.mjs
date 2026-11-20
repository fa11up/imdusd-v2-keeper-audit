// The keeper's paid and peg duties against the real v2 beta on a local anvil fork (test/fork/up.sh deploys it), with a LOCAL mock plane. Rerunnable: the fork is restored at the end.
//
// REAL here: every v2 contract and its checks (the leaves' question binding on the actual bodies, epoch bounds, Pricer, Liquidator, SeatJoin auctions on a real seat, PegHook, Backstop bid, Allocator).
// NOT real, and said so in README "Not proven yet":
//   - the plane: test/lib/mock-plane.mjs answers everything. No panel, no real x402 settlement; IMD does not move on payment.
//   - the attester: each leaf's `attester` immutable is patched to a local key with anvil_setCode, so the answers are signed locally. Everything else in the leaf is its own bytecode.
//   - ImdDepth is stubbed deep and sIMD's stored line written to storage, so a loan can open without a week of samples and a 96 h governance path.
//   - ETH/USD and USDC/USD are a mock aggregator we control; the pool's price is written to its slot.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { swapProvenForStandIn } from "./proven-standin.mjs";
import { BigNumber, Contract, constants, providers, utils, Wallet } from "ethers";

const RPC = process.env.RPC ?? "http://127.0.0.1:8557";
const WORK = new URL("./.work/", import.meta.url);
const MNEMONIC = "test test test test test test test test test test test junk";
const wallet_ = (i) => Wallet.fromMnemonic(MNEMONIC, `m/44'/60'/0'/0/${i}`);
process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "v2-keeper-duties-"));
process.env.DEPLOYMENT = new URL("record.json", WORK).pathname;
process.env.KEEPER_MNEMONIC = MNEMONIC;
process.env.PLANE_BEARER = "local-mock-only";
delete process.env.GUARDIAN_PRIVATE_KEY;
const { makeContext, runRound } = await import("../../keeper.mjs");

const { buildInput, leafProblems } = await import("../../lib/oracle.mjs");
const { loadOrders, spentToday } = await import("../../lib/orders.mjs");
const { readState, writeState } = await import("../../lib/state.mjs");
const { IMD } = await import("../../lib/x402.mjs");
const { FEED_NODE } = await import("../../lib/deployment.mjs");
const { auctionKey } = await import("../../lib/allocator.mjs");
const { makeMockPlane } = await import("../lib/mock-plane.mjs");

const HELPERS = JSON.parse(readFileSync(new URL("./helpers.json", import.meta.url), "utf8"));
const AGG = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const PM = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const IDMD = "0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D";
const DRIVER = "0x00000000000000000000000000000000000d0001", ROUTE = "0x00000000000000000000000000000000000d0002", DOLLAR = "0x00000000000000000000000000000000000d0003";
const E18 = BigNumber.from(10).pow(18);
const ATTESTER_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"; // anvil account 3, public
const hx = (v) => utils.hexZeroPad(BigNumber.from(v).toHexString(), 32);
const b32 = utils.formatBytes32String;

const raw = new providers.StaticJsonRpcProvider({ url: RPC, timeout: 590_000 }, 1); // reverting past ~1,800 mined blocks takes minutes
raw.pollingInterval = 100;
const rpc = (m, p = []) => raw.send(m, p);
const mine = (n = 1) => rpc("anvil_mine", [utils.hexValue(n)]);
const lines = [];
const log = (s) => { lines.push(s); if (process.env.VERBOSE) console.log(s); };
const ok = (s) => console.log(`  ok  ${s}`);
const since = (mark) => lines.slice(mark).join("\n");
const nowOf = async () => (await raw.getBlock("latest")).timestamp;
const warp = async (s) => { await rpc("evm_increaseTime", [s]); await mine(); };
const impersonated = async (a) => {
  await rpc("anvil_impersonateAccount", [a]);
  await rpc("anvil_setBalance", [a, utils.hexValue(utils.parseEther("100"))]);
  return raw.getSigner(a);
};
const tokenAbi = ["function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function deposit(uint256,address) returns (uint256)"];
const ledgerAbi = ["function open(bytes32 ilk, uint256 salt, (int256 dCollateral,int256 dDebt,uint64 rate,uint256 prevHint,uint256 nextHint,bool viaAsset,uint256 maxUpfrontFee,address to) a) returns (uint256)", "function positionId(address,bytes32,uint256) view returns (uint256)", "function adjust(uint256 id,(int256 dCollateral,int256 dDebt,uint64 rate,uint256 prevHint,uint256 nextHint,bool viaAsset,uint256 maxUpfrontFee,address to) a)"];
const NFT_ABI = ["function ownerOf(uint256) view returns (address)", "function approve(address,uint256)"];
const SEATJOIN_FULL = ["function deposit(uint256) returns (address)"];
const GOV_ABI = ["function propose(bytes)", "function applyPending(uint8)", "function freeze()", "function unfreeze()"];
const enc = (types, vals) => utils.defaultAbiCoder.encode(types, vals);

const snapshot = await rpc("evm_snapshot");
await rpc("evm_setTime", [await nowOf()]);
let failed = false;
let mock;
try {
  const answers = {};
  const swarm = { health: { agentsOnline: 99, seatsEnrolled: 100, verifierUp: true, publisherUp: true, deployerUp: true }, counts: { jobStates: { completed: 99, blocked: 1, cancelled: 0 } } };
  mock = makeMockPlane({
    answer: (input) => answers[input.consumer.verifyingContract],
    chain: async () => {
      const b = await raw.getBlock("latest");
      return { number: b.number, timestamp: b.timestamp, hash: b.hash };
    },
    attesterKey: ATTESTER_KEY,
    swarm,
  });
  const api = await mock.listen();
  const example = (await import("../../config.example.js")).default;
  const CFG = {
    ...example,
    READ_RPC_URLS: [RPC], SEND_RPC_URLS: [RPC], ALLOW_PUBLIC_SEND: true,
    API_BASE: api, API_FALLBACKS: [], PLANE: { ...example.PLANE, useEns: false, holdAfterBlocked: 3 },
    LOGS: { chunk: 9_000, lag: 0, indexTtlSeconds: 0 },
    MIN_ETH: 0.001, ROUTINE_MIN_ETH: 0.001, ROUTINE_MAX_GAS_GWEI: 1000, MAX_GAS_GWEI: 1000,
    BRIDGE_WATCH: { ...example.BRIDGE_WATCH, enabled: false }, // no 4663 peer on this fork
  };
  CFG.IMD = { ...CFG.IMD, dailyCap: 20 };
  CFG.GUARDIAN = { ...CFG.GUARDIAN, knownKeepers: [] };
  CFG.ALLOCATOR = { ...CFG.ALLOCATOR, sales: [] };
  const report = await makeContext(CFG, { log });
  const exec = await makeContext(CFG, { execute: true, log });
  // anvil cannot verify a storage proof against its own headers: the proven depth reference gets its fork stand-in (proven-standin.mjs).
  await swapProvenForStandIn(raw, exec.signer, JSON.parse(readFileSync(process.env.DEPLOYMENT, "utf8")));
  for (const c of [report, exec]) c.provider.pollingInterval = 100;
  const { book } = exec;
  const keeper = exec.keeperAddress;
  report.keeperAddress = keeper; // KEEPER_ADDRESS in config: simulate as the keeper, and the guardian knows it

  // --- every question the keeper would buy is the one the deployed leaf pins
  const simd = book.ilks.find((t) => t.name === "SIMD");
  const seat = book.ilks.find((t) => t.config.auction);
  const leafOf = {
    price: book.leaf(book.record.feeds[FEED_NODE.imdMedian]), nhi: book.leaf(simd.config.nhi),
    seatMedian: book.leaf(await book.seatFeed.median()), seatSpot: book.leaf(await book.seatFeed.spot()),
  };
  for (const [role, leaf] of Object.entries(leafOf)) assert.deepEqual(await leafProblems(leaf, role), [], role);
  assert.equal(simd.config.nhi.toLowerCase(), book.record.feeds[FEED_NODE.nhi].toLowerCase(), "the record's NHI node is the type's");
  ok("all four bodies hash to what the deployed leaves pin (real expectedQuestionHash, no patch yet)");

  // --- the local world: mocks, the attester, helpers
  const realAttester = (await leafOf.price.attester()).slice(2).toLowerCase();
  const localAttester = mock.attesterAddress.slice(2).toLowerCase();
  for (const leaf of Object.values(leafOf)) {
    const code = await raw.getCode(leaf.address);
    const patched = code.toLowerCase().split(realAttester).join(localAttester);
    assert.notEqual(patched, code.toLowerCase(), "the attester immutable is in the runtime");
    await rpc("anvil_setCode", [leaf.address, patched]);
  }
  assert.equal((await leafOf.price.attester()).slice(2).toLowerCase(), localAttester);
  await rpc("anvil_setCode", [DRIVER, HELPERS.PoolDriver]);
  await rpc("anvil_setCode", [ROUTE, HELPERS.MockRoute]);
  await rpc("anvil_setCode", [DOLLAR, HELPERS.DollarFeed]);
  const mockAgg = readFileSync(new URL("./mock-aggregator.hex", import.meta.url), "utf8").trim();
  const ethAgg = new Contract(AGG, ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], raw);
  const [, ethStart] = await ethAgg.latestRoundData();
  const usdcAgg = await new Contract(book.pegHook.address, ["function quoteUsdFeed() view returns (address)"], raw).quoteUsdFeed();
  await rpc("anvil_setCode", [AGG, mockAgg]);
  await rpc("anvil_setCode", [usdcAgg, mockAgg]);
  const setFeed = async (addr, answer, at) => {
    await rpc("anvil_setStorageAt", [addr, hx(0), hx(answer)]);
    await rpc("anvil_setStorageAt", [addr, hx(1), hx(at ?? await nowOf())]);
  };
  const USDC_OK = BigNumber.from(10).pow(8);
  let ethPrice = ethStart;
  const freshen = async () => {
    await setFeed(AGG, ethPrice);
    await setFeed(usdcAgg, USDC_OK);
    await mine();
  };
  await freshen();

  // Money for the actors: the PoolManager holds IMD and USDC.
  const pmSigner = await impersonated(PM);
  const imd = new Contract(IMD, tokenAbi, raw);
  const usdc = new Contract(USDC, tokenAbi, raw);
  const usd = new Contract(book.usd.address, tokenAbi, raw);
  const weth = new Contract(WETH, ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], raw);
  const pay = (t, to, n) => t.connect(pmSigner).transfer(to, n).then((x) => x.wait());
  await pay(imd, keeper, utils.parseEther("40"));
  const borrower = wallet_(4).connect(raw), whale = wallet_(5).connect(raw), stranger = wallet_(8).connect(raw);
  await pay(imd, borrower.address, utils.parseEther("400"));
  await pay(usdc, DRIVER, BigNumber.from(10).pow(6).mul(200_000));

  // The governor's setup, through the real timelocks: the same acts as Safe files 0 and 4 and the Allocator's targets, buckets and feeds. The
  // freezer is the Safe from genesis (no guardian key).
  const gov = await impersonated(await book.params.governor());
  const params = new Contract(book.params.address, GOV_ABI, gov);
  const allocatorGov = new Contract(book.allocator.address, GOV_ABI, gov);
  await (await params.propose(enc(["uint8", "uint256"], [14, BigNumber.from(10).pow(6).mul(5000)]))).wait(); // SET_BUFFER_TARGET
  await (await params.propose(enc(["uint8", "uint256"], [7, E18.mul(50_000)]))).wait(); // SET_KEEPER_CAP
  await (await params.propose(enc(["uint8", "bool", "address", "bool"], [27, false, WETH, true]))).wait(); // RETIRE_SLEEVE_TOKEN (applies only while unpriced)
  const BIG = BigNumber.from(10).pow(30);
  const SLOPE = BigNumber.from(10).pow(24); // SET_LIMIT starts a new bucket EMPTY: only its slope fills it
  const item = (types, vals) => enc(types, vals);
  await (await allocatorGov.propose(enc(["uint8", "bytes[]"], [7, [
    item(["uint8", "address"], [3, keeper]), // ADD_KEEPER
    item(["uint8", "address"], [3, stranger.address]), // a second keeper nobody told the guardian about
    item(["uint8", "bytes32", "address"], [2, b32("BACKSTOP_SALE"), book.blue.address]),
    item(["uint8", "bytes32", "address"], [2, b32("SWAP"), ROUTE]),
    item(["uint8", "bytes32", "address"], [2, b32("BUFFER_FUND"), book.pegHook.address]),
    item(["uint8", "bytes32", "address", "uint128", "uint128"], [1, b32("BACKSTOP_SALE"), book.blue.address, BIG, SLOPE]),
    item(["uint8", "bytes32", "address", "uint128", "uint128"], [1, b32("BUFFER_FUND"), book.pegHook.address, BIG, SLOPE]),
    item(["uint8", "address", "address"], [5, WETH, book.record.feeds[0]]),
    item(["uint8", "address", "address"], [5, book.usd.address, DOLLAR]),
  ]]))).wait();

  // A whale's ETH loan pays for the imdUSD everyone needs; part goes into the blue sleeve, whose deposit needs up to two days to count.
  const ledgerAs = (w) => new Contract(book.ledger.address, ledgerAbi, w);
  const adjust = (coll, debt, rate = "0.05") => [coll, debt, utils.parseEther(rate), 0, 0, false, constants.MaxUint256, constants.AddressZero];
  await (await weth.connect(whale).deposit({ value: utils.parseEther("100") })).wait();
  await (await weth.connect(whale).approve(book.ledger.address, constants.MaxUint256)).wait();
  await (await ledgerAs(whale).open(b32("ETH"), 0, adjust(utils.parseEther("100"), E18.mul(40_000)))).wait();
  const sleeveUser = new Contract(book.blue.address, ["function deposit(uint256,address)"], whale);
  await (await usd.connect(whale).approve(book.blue.address, constants.MaxUint256)).wait();
  await (await sleeveUser.deposit(E18.mul(6_000), whale.address)).wait();
  await (await usd.connect(whale).transfer(ROUTE, E18.mul(4_000))).wait();
  await (await usd.connect(whale).transfer(DRIVER, E18.mul(20_000))).wait();

  await warp(3 * 86_400);
  await freshen();
  await (await allocatorGov["applyPending(uint8)"](7)).wait();
  for (const k of [14, 7]) await (await params["applyPending(uint8)"](k)).wait();
  assert.equal((await book.allocator.freezer()).toLowerCase(), gov._address.toLowerCase(), "the Safe is the freezer from genesis");
  ok("the Safe's acts apply through the real 48 h timelocks (buffer target, keeper cap, Allocator keeper, targets, buckets, feeds); the Safe is the freezer");

  // --- backstop: a retire that applies, then a price again
  await setFeed(AGG, ethPrice, (await nowOf()) - 20_000);
  await mine();
  await (await params["applyPending(uint8)"](27)).wait();
  assert.equal(await book.blue.retired(WETH), true, "retired while unpriced");
  await freshen();
  let mark = lines.length;
  assert.deepEqual(await runRound(report, ["backstop"]), [], since(mark));
  assert.equal(await book.blue.retired(WETH), true, "report-only sent nothing");
  assert.match(since(mark), /would   realize/);
  assert.deepEqual(await runRound(exec, ["backstop"]), [], since(mark));
  assert.equal(await book.blue.retired(WETH), false, `realize cleared the flag: ${since(mark)}`);
  ok("backstop: a retired token priced again is un-retired by realize at once");
  assert.ok(lines.some((l) => /backstop blue: ETH \d+/.test(l)), "room read for each covered type");
  const roomNow = await book.blue.bidRoomNow(b32("ETH"));
  assert.ok(roomNow.gte(E18.mul(5_000)), `the deposit counts now (${utils.formatEther(roomNow)})`);
  ok(`backstop: room per sleeve and type on the real views (blue ETH ${Math.floor(Number(utils.formatEther(roomNow)))})`);

  // --- backstop: a matured deposit converts on the keeper's first round after maturity (audit wave 1)
  await (await sleeveUser.deposit(E18.mul(1_000), whale.address)).wait();
  const depDay = Math.floor((await nowOf()) / 86_400);
  await warp((depDay + 2) * 86_400 + 60 - (await nowOf()));
  await freshen();
  assert.equal((await book.blue.buckets(depDay)).converted, false, "matured, nobody has called yet");
  mark = lines.length;
  assert.deepEqual(await runRound(report, ["backstop"]), [], since(mark));
  assert.match(since(mark), /would   convert: blue sleeve's matured deposits/);
  assert.equal((await book.blue.buckets(depDay)).converted, false, "report-only sent nothing");
  assert.deepEqual(await runRound(exec, ["backstop"]), [], since(mark));
  assert.equal((await book.blue.buckets(depDay)).converted, true, `converted: ${since(mark)}`);
  mark = lines.length;
  await runRound(exec, ["backstop"]);
  assert.doesNotMatch(since(mark), /convert:/, "nothing left to convert");
  ok("backstop: a matured deposit converts on the first round after maturity, then nothing");

  // --- guardian: alerts the Safe to freeze; it holds no key and sends nothing
  const keeperNonce = () => raw.getTransactionCount(keeper);
  const n0 = await keeperNonce();
  mark = lines.length;
  assert.deepEqual(await runRound(exec, ["guardian"]), [], since(mark));
  assert.match(since(mark), /ALERT CRITICAL guardian-freeze-now.*unknown-keeper/s, "a keeper nobody knows is proof");
  assert.equal(await book.allocator.frozen(), false, "the guardian sends nothing");
  assert.equal(await keeperNonce(), n0, "and the keeper's key does not freeze either");
  await (await allocatorGov.freeze()).wait();
  await runRound(exec, ["guardian"]); // sees it frozen: the proof is answered
  assert.deepEqual(readState("guardian.json", {}).proofs, [], "a freeze answers the proof");
  await (await allocatorGov.unfreeze()).wait();
  mark = lines.length;
  await runRound(exec, ["guardian"]);
  assert.doesNotMatch(since(mark), /ALERT CRITICAL guardian-freeze-now/, "the same proof does not come back after the Safe unfreezes");
  ok("guardian: alerts the Safe to freeze (no key, nothing sent); the Safe's freeze answers the proof");

  // A held reading: USDC reading low says nothing until it has held.
  const fast = await makeContext({ ...CFG, GUARDIAN: { ...CFG.GUARDIAN, unbackedConfirmSeconds: 0, quoteDepegConfirmSeconds: 60, simdOffPoolConfirmSeconds: 0 } }, { execute: true, log });
  fast.provider.pollingInterval = 100;
  await setFeed(usdcAgg, USDC_OK.mul(90).div(100));
  await mine();
  mark = lines.length;
  await runRound(fast, ["guardian"]);
  assert.doesNotMatch(since(mark), /guardian-freeze-now/, "not yet held");
  await warp(61);
  await setFeed(usdcAgg, USDC_OK.mul(90).div(100));
  await mine();
  mark = lines.length;
  await runRound(fast, ["guardian"]);
  assert.match(since(mark), /ALERT CRITICAL guardian-freeze-now.*quote-depeg/s, "held past its confirm time");
  await freshen();
  await runRound(fast, ["guardian"]);
  ok("guardian: a reading alerts only after holding its confirm time");

  // An Acted from an address not known, seen in the real logs.
  await pay(usdc, book.allocator.address, BigNumber.from(10).pow(6).mul(100));
  const asStranger = new Contract(book.allocator.address, ["function fundBuffer(address,uint256)"], stranger);
  await (await asStranger.fundBuffer(book.pegHook.address, 1_000_000)).wait();
  await mine(3); // the guardian reads logs GUARDIAN.logLag (2) blocks behind the head
  mark = lines.length;
  await runRound(fast, ["guardian"]);
  assert.match(since(mark), /ALERT CRITICAL guardian-freeze-now.*unknown-actor/s, "unknown-actor from the logs");
  assert.equal(await book.allocator.frozen(), false);
  await (await allocatorGov.freeze()).wait();
  await runRound(fast, ["guardian"]);
  await (await allocatorGov.unfreeze()).wait();
  ok("guardian: an Allocator act by an unknown address, read from the real logs, alerts");

  // --- seed the legs, as the operator does once: first values have no bound on chain, and the keeper refuses to buy them
  const poolLive = book.live(book.record.feeds[FEED_NODE.imdLive]);
  const [poolStart] = await poolLive.latestValue();
  const poolId = await poolLive.poolId();
  const slot0 = utils.keccak256(enc(["bytes32", "uint256"], [poolId, 6]));
  const word0 = BigNumber.from(await raw.getStorageAt(PM, slot0));
  const sqrt0 = word0.and(BigNumber.from(1).shl(160).sub(1));
  /** Write the pool's price, as `factor` x its start (the tick word above the price is left; only the price is read here). */
  const setPool = async (factorPct, settle = false) => {
    const s = sqrt0.mul(Math.round(Math.sqrt(100 / factorPct) * 1e9)).div(1e9); // IMD is currency1: its ETH price is 1/sqrtP^2
    await rpc("anvil_setStorageAt", [PM, slot0, hx(word0.sub(sqrt0).add(s))]);
    await mine(settle ? 601 : 1); // settle: the keeper projects the panel's two-hour median from past blocks, so give the new price the whole window (601 blocks, about 10 minutes here)
    if (settle) await freshen();
  };
  const atPct = (pct) => poolStart.mul(pct).div(100);
  const answerPair = (pct) => {
    answers[leafOf.price.address.toLowerCase()] = { value: atPct(pct) };
  };
  mark = lines.length;
  assert.deepEqual(await runRound(exec, ["feeds", "seats"]), [], since(mark));
  assert.equal(mock.state.payments.length, 0, "an empty leg is never bought");
  ok("empty legs: nothing bought (first values are the owner's)");

  const relayAs = wallet_(6).connect(raw);
  const seedLeaf = async (role, value, figure = 0) => {
    const leaf = leafOf[role];
    const input = await buildInput(leaf, role);
    const att = await mock.attest(input, { value, figure });
    await mine();
    const { toTuple } = await import("../../lib/oracle.mjs");
    await (await leaf.connect(relayAs).submitAttestation(toTuple(att.message), att.signature)).wait();
    assert.equal((await leaf.latestValue()).value.toString(), BigNumber.from(value).toString(), `${role} seeded`);
  };
  await seedLeaf("price", poolStart);
  await seedLeaf("nhi", utils.parseEther("0.99"));
  ok("the keeper's body + a locally signed attestation clear the real submitAttestation (question binding, panel floors, window rules) on price and NHI (design C: sIMD's spot is proven, not bought)");

  // Design C: sIMD's spot IS the proven pool price, renewed only by the depth round's prove. One real depth round proves it here
  // (stand-in: the header is checked against blockhash, slot0 read live), so the legs can agree before the loan opens.
  {
    const t = await nowOf(); // the depth hour is a random second: make it due now, as e2e's forceDepth does
    writeState("depth.json", { hour: Math.floor(t / 3600), at: t - 1, done: false });
  }
  assert.deepEqual(await runRound(exec, ["depth"]), [], since(mark));
  {
    const spot = book.feed(book.record.feeds[FEED_NODE.imdProven]);
    const [[v], stale] = await Promise.all([spot.latestValue(), spot.isStale()]);
    assert.ok(!v.isZero() && !stale, "the depth round proved the sIMD spot");
  }
  ok("depth round: proves the reference sIMD's spot reads (design C), fresh after one round");

  // --- an sIMD loan: the depth stub and the stored line stand in for a week of samples and a 96 h raise
  await rpc("anvil_setCode", [book.imdDepth.address, HELPERS.DeepDepth]);
  const r0 = await book.params.storedRisk(simd.id);
  const word = BigNumber.from(r0.mat).or(BigNumber.from(r0.chop).shl(64)).or(BigNumber.from(r0.cut).shl(128)).or(BigNumber.from(r0.chip).shl(192));
  let riskBase = null;
  for (let s = 0; s < 400 && !riskBase; s++) {
    const base = utils.keccak256(enc(["bytes32", "uint256"], [simd.id, s]));
    if (BigNumber.from(await raw.getStorageAt(book.params.address, base)).eq(word)) riskBase = base;
  }
  assert.ok(riskBase, "found Parameters._risk(SIMD)");
  const lineSlot = hx(BigNumber.from(riskBase).add(2));
  const lineWord = BigNumber.from(await raw.getStorageAt(book.params.address, lineSlot));
  await rpc("anvil_setStorageAt", [book.params.address, lineSlot, hx(lineWord.shr(128).shl(128).or(E18.mul(20_000)))]);
  assert.ok((await book.params.storedRisk(simd.id)).line.eq(E18.mul(20_000)), "the line");
  await mine();
  const sToken = new Contract(simd.config.token, tokenAbi, borrower);
  await (await imd.connect(borrower).approve(sToken.address, constants.MaxUint256)).wait();
  await (await sToken.deposit(utils.parseEther("400"), borrower.address)).wait();
  await mine(2);
  const shares = await sToken.balanceOf(borrower.address);
  await (await sToken.approve(book.ledger.address, constants.MaxUint256)).wait();
  let q = await book.pricer.quote(simd.id);
  assert.equal(q.borrowable, true, "sIMD priced with agreeing legs");
  const valueUsd = shares.mul(q.low).div(E18);
  const rate = BigNumber.from((await book.params.risk(simd.id)).rateFloor).add(utils.parseEther("0.01"));
  const debt = valueUsd.mul(100).div(210); // 210%: over mat + 10% = 187%; under it after a 15% fall
  await (await ledgerAs(borrower).open(simd.id, 0, [shares, debt, rate, 0, 0, false, constants.MaxUint256, constants.AddressZero])).wait();
  const loanId = await ledgerAs(borrower).positionId(borrower.address, simd.id, 0);
  await mine();
  console.log(`      sIMD loan: ${Math.floor(Number(utils.formatEther(valueUsd)))} USD of collateral, ${Math.floor(Number(utils.formatEther(debt)))} imdUSD debt at mat ${utils.formatEther(q.mat)}`);

  // --- rises and flat buy nothing, in real figures, report-only or not
  const quietFeeds = async (label) => {
    const m = lines.length;
    const paid = mock.state.payments.length;
    assert.deepEqual(await runRound(report, ["feeds"]), [], since(m));
    assert.deepEqual(await runRound(exec, ["feeds"]), [], since(m));
    assert.equal(mock.state.payments.length, paid, `${label}: nothing paid\n${since(m)}`);
    return since(m);
  };
  assert.match(await quietFeeds("flat"), /price no-fall/);
  await setPool(120);
  assert.match(await quietFeeds("a rise"), /price no-fall/);
  await setPool(92);
  assert.match(await quietFeeds("a fall, loan safe"), /price no-risk/);
  ok("feeds: flat, a rise, and a fall with the loan safe buy nothing");

  // --- a fall that matters: 210% -> 178% at the pool, under 187%, and inside the leaf's 20%
  await setPool(85, true);
  const fallTo = atPct(85);
  answerPair(85);
  const nonceBefore = await keeperNonce();
  mark = lines.length;
  assert.deepEqual(await runRound(report, ["feeds"]), []);
  assert.match(since(mark), /would   buy price \(/, since(mark));
  assert.equal(mock.state.payments.length, 0, "report-only pays nothing");
  assert.equal(await keeperNonce(), nonceBefore, "and sends nothing");
  ok("feeds: report-only says it would buy, pays and sends nothing");
  mark = lines.length;
  assert.deepEqual(await runRound(exec, ["feeds"]), [], since(mark));
  assert.equal(mock.state.payments.length, 1, `one payment: ${since(mark)}`);
  const paid = mock.state.payments[0];
  assert.equal(paid.count, 1, "one order, one question: the median (design C)");
  assert.equal(paid.amount, utils.parseEther("0.5").toString());
  assert.equal(paid.from, keeper, "paid from the keeper's own key");
  const order = [...mock.state.orders.values()].at(-1);
  assert.equal(order.action, "oracle.request");
  assert.equal(order.input.consumer.verifyingContract, leafOf.price.address.toLowerCase(), "the consumer is the v2 leaf");
  assert.equal(order.input.quorum, 67);
  assert.ok(BigNumber.from(order.input.guards.min).lt(fallTo), "guards hold the fall");
  const relayedRound = lines.length;
  assert.deepEqual(await runRound(exec, ["feeds"]), [], since(relayedRound));
  assert.equal((await leafOf.price.latestValue()).value.toString(), fallTo.toString(), "price relayed");
  assert.equal(loadOrders().length, 0, "the order is done");
  assert.equal(mock.state.payments.length, 1, "still one payment");
  assert.equal(spentToday().toString(), utils.parseEther("0.5").toString(), "the day's ledger");
  q = await book.pricer.quote(simd.id);
  ok(`feeds: fall -> one oracle.request paid (mock), the answer relayed on the real leaf; sIMD low now ${utils.formatEther(q.low)} USD, priced ${q.priced}`);

  // The next round, still fallen: inside the gap between buys, nothing more.
  await runRound(exec, ["feeds"]);
  assert.equal(mock.state.payments.length, 1, "no second buy inside the gap");

  // --- design C: no answer is refused any more; a deeper fall inside the gap between buys still waits for the gap
  await setPool(25);
  mark = lines.length;
  await runRound(exec, ["feeds"]);
  assert.equal(mock.state.payments.length, 1, `inside the gap between buys: ${since(mark)}`);
  assert.doesNotMatch(since(mark), /feeds-gap/, since(mark));
  ok("feeds: a deeper fall inside the gap between buys waits (no 'refused' gap any more: the leaf clamps)");

  // The next step, once a new epoch opens on the value that landed: 85 -> 70 is inside 20% of 85.
  await warp(3100);
  await setPool(70, true);
  answerPair(70);
  mark = lines.length;
  await runRound(exec, ["feeds"]);
  assert.equal(mock.state.payments.length, 2, `the next step: ${since(mark)}`);
  await runRound(exec, ["feeds"]);
  assert.equal((await leafOf.price.latestValue()).value.toString(), atPct(70).toString(), `a second step walks the anchor: ${since(mark)}`);
  ok("feeds: a wider fall is walked in a second step, on the real epoch rule");

  // --- tick: stale legs make sIMD unpriced, the positions loop records it, an answer prices it again, the clock closes, and the keeper can act on the loan
  await warp(3700);
  await freshen();
  assert.equal((await book.pricer.quote(simd.id)).priced, false, "stale legs: unpriced");
  await runRound(exec, ["positions"]);
  assert.notEqual(Number((await book.liquidator.clocks(simd.id)).unpricedSince), 0, "tick recorded the span");
  await setPool(60, true);
  answerPair(60);
  mark = lines.length;
  await runRound(exec, ["feeds"]);
  await runRound(exec, ["feeds", "positions"]);
  assert.equal(mock.state.payments.length, 3, since(mark));
  assert.equal((await book.pricer.quote(simd.id)).priced, true, `priced again: ${since(mark)}`);
  assert.equal(Number((await book.liquidator.clocks(simd.id)).unpricedSince), 0, "tick closed it");
  assert.ok(Number((await book.liquidator.marks(loanId)).markedAt) > 0, `the loan the answer exposed is marked: ${since(mark)}`);
  ok("feeds + positions: stale -> tick; a bought fall lands -> priced -> tick closes the clock -> the under-water sIMD loan is marked");

  // --- NHI: a day on, with debt
  await warp(22 * 3600);
  await freshen();
  const live = (4n * (99n * 10n ** 16n) + 3n * 10n ** 18n + 3n * (99n * 10n ** 16n)) / 10n;
  answers[leafOf.nhi.address.toLowerCase()] = { value: BigNumber.from(live.toString()) };
  mark = lines.length;
  const paidBefore = mock.state.payments.length;
  await runRound(exec, ["feeds"]);
  const nhiPay = mock.state.payments.slice(paidBefore).find((p) => p.count === 1);
  assert.ok(nhiPay, `NHI paid as a single question: ${since(mark)}`);
  await runRound(exec, ["feeds"]);
  assert.equal((await leafOf.nhi.latestValue()).value.toString(), live.toString(), `NHI relayed: ${since(mark)}`);
  ok("feeds: NHI bought once a day while sIMD debt exists, checked against the live index first, relayed");

  // --- seats: the owner seeds, a real seat is pledged, an auction opens; the keeper keeps its clock and restarts it when void
  await seedLeaf("seatMedian", utils.parseEther("1"), 120);
  await seedLeaf("seatSpot", utils.parseEther("1"), 5);
  mark = lines.length;
  assert.deepEqual(await runRound(exec, ["seats"]), [], since(mark));
  let capRec = await book.seatFeed.cap();
  assert.equal(capRec.raw.toString(), utils.parseEther("1").toString(), `poke recorded the first median: ${since(mark)}`);
  const seatLine = (await book.params.storedRisk(seat.id)).line;
  console.log(`      SEAT stored line ${utils.formatEther(seatLine)}; seat value ${utils.formatEther((await book.seatFeed.latestValue())[0])} USD`);
  const nftRead = new Contract(IDMD, NFT_ABI, raw);
  let tokenId, holder;
  for (let id = 1; id <= 3000 && !tokenId; id++) {
    const o = await nftRead.ownerOf(id).catch(() => null);
    if (o && (await raw.getCode(o)) === "0x") { tokenId = id; holder = o; }
  }
  assert.ok(tokenId, "a seat held by an EOA");
  const holderS = await impersonated(holder);
  await (await new Contract(IDMD, NFT_ABI, holderS).approve(book.seatJoin.address, tokenId)).wait();
  await (await new Contract(book.seatJoin.address, SEATJOIN_FULL, holderS).deposit(tokenId)).wait();
  q = await book.pricer.quote(seat.id);
  const seatDebt = q.low.mul(100).div(300);
  const seatRate = BigNumber.from((await book.params.risk(seat.id)).rateFloor);
  await (await ledgerAs(holderS).open(seat.id, 0, [E18, seatDebt, seatRate, 0, 0, false, constants.MaxUint256, constants.AddressZero])).wait();
  const seatPos = await ledgerAs(raw).positionId(holder, seat.id, 0);
  mark = lines.length;
  ethPrice = ethPrice.mul(60).div(100);
  await freshen();
  assert.equal((await book.ledger.healthy(seatPos)).ok, false, "ETH fell: the seat is under");
  await runRound(exec, ["positions"]);
  const a0 = await book.seatJoin.auctions(seatPos);
  assert.notEqual(Number(a0.startAt), 0, `liquidate opened the auction: ${since(mark)}`);
  const beforeSecond = await keeperNonce();
  await runRound(exec, ["positions"]);
  assert.equal(await keeperNonce(), beforeSecond, `a live auction: no second mark, no doomed send: ${since(mark)}`);
  ok("seats: a real seat, liquidate opens the auction, and the positions loop leaves a live auction alone");

  // A day on: both legs are due, bought as one order; the median lands, poke records it, tick moves the auction's clock.
  await warp(22 * 3600);
  await freshen();
  answers[leafOf.seatMedian.address.toLowerCase()] = { value: utils.parseEther("0.95"), figure: 118 };
  answers[leafOf.seatSpot.address.toLowerCase()] = { value: utils.parseEther("0.95"), figure: 4 };
  const payCount = mock.state.payments.length;
  mark = lines.length;
  assert.deepEqual(await runRound(exec, ["seats"]), [], since(mark));
  const legPay = mock.state.payments.slice(payCount).find((p) => p.count === 2);
  assert.ok(legPay, `both legs in one order: ${since(mark)}`);
  await runRound(exec, ["feeds"]);
  await mine();
  assert.equal((await leafOf.seatMedian.latestValue()).value.toString(), utils.parseEther("0.95").toString(), `median relayed: ${since(mark)}`);
  await runRound(exec, ["seats"]);
  capRec = await book.seatFeed.cap();
  assert.equal(capRec.raw.toString(), utils.parseEther("0.95").toString(), "poke took the new median");
  const a1 = await book.seatJoin.auctions(seatPos);
  assert.equal(Number(a1.attestedAt), Number((await leafOf.seatMedian.latestValue()).updatedAt), "tick moved the clock to it");
  const n2 = await keeperNonce();
  await runRound(exec, ["seats"]);
  assert.equal(await keeperNonce(), n2, "then silence");
  ok("seats: daily legs as one order, relayed; SeatFeed.poke and SeatJoin.tick(id) after the median; then nothing");

  // Void: 24 h of priced time on, still under. The seat clock counts only time in which the ETH/USD leg was fresh too
  // (audit wave 2), so warp hour by hour with Chainlink updating as it does on mainnet (heartbeat 1 h).
  for (let h = 0; h < 25; h++) {
    await warp(3600);
    await freshen();
  }
  assert.equal((await book.ledger.healthy(seatPos)).priced, true, "the median is within its 26 h");
  const a24 = await book.seatJoin.auctions(seatPos);
  assert.equal(await book.seatJoin.expired(seatPos), true, `void after 24 h of priced time (elapsed ${await book.seatJoin.elapsed(seatPos)} s; ran ${a24.ran} lastTick ${a24.lastTick} attestedAt ${a24.attestedAt} ethAt ${a24.ethAt}; median at ${(await leafOf.seatMedian.latestValue()).updatedAt}; now ${await nowOf()})`);
  const startedAt = Number((await book.seatJoin.auctions(seatPos)).startAt);
  mark = lines.length;
  answers[leafOf.seatMedian.address.toLowerCase()] = { value: utils.parseEther("0.95"), figure: 118 };
  assert.deepEqual(await runRound(exec, ["seats"]), [], since(mark));
  const a2 = await book.seatJoin.auctions(seatPos);
  assert.ok(Number(a2.startAt) > startedAt, `reopened: ${since(mark)}`);
  assert.equal(await book.seatJoin.expired(seatPos), false);
  assert.equal(a2.marker, a0.marker, "the marker is kept");
  ok("seats: a void auction restarts with reopen; the marker keeps its chip");

  // --- the standing bid and an Allocator sale: an ETH loan closes against the blue sleeve; its collateral sells through the real sale interface
  const victim = wallet_(7).connect(raw);
  await (await weth.connect(victim).deposit({ value: utils.parseEther("1") })).wait();
  await (await weth.connect(victim).approve(book.ledger.address, constants.MaxUint256)).wait();
  ethPrice = ethStart;
  await freshen();
  await (await ledgerAs(victim).open(b32("ETH"), 0, adjust(utils.parseEther("1"), ethPrice.mul(BigNumber.from(10).pow(10)).mul(60).div(100)))).wait();
  const vId = await ledgerAs(victim).positionId(victim.address, b32("ETH"), 0);
  const vDebt = await book.ledger.debtOf(vId);
  ethPrice = ethPrice.mul(70).div(100);
  await freshen();
  assert.equal((await book.ledger.healthy(vId)).ok, false, "ETH fell further");
  const keeperUsd0 = await usd.balanceOf(keeper);
  const roomBefore = await book.blue.bidRoomNow(b32("ETH"));
  assert.ok(roomBefore.gte(vDebt), `room ${roomBefore} for debt ${vDebt}`);
  mark = lines.length;
  assert.deepEqual(await runRound(exec, ["positions"]), [], since(mark));
  const coll = await book.blue.coll(WETH);
  assert.ok(coll.gt(0), `the standing bid bought the collateral: ${since(mark)}`);
  assert.equal((await usd.balanceOf(keeper)).toString(), keeperUsd0.toString(), "the caller paid nothing");
  ok(`positions: the STANDING BID closes a loan on the real sleeve (caller pays nothing, sleeve took ${utils.formatEther(coll)} WETH)`);

  // Half by the keeper's route sale, so the rule-driven auction below has collateral left (the same round starts it).
  const halfUsd = Math.floor(Number(utils.formatEther(coll.mul(ethPrice).mul(BigNumber.from(10).pow(10)).div(E18))) / 2);
  const saleCtx = await makeContext({ ...CFG, ALLOCATOR: { sales: [{ sleeve: "blue", token: WETH, route: ROUTE, maxUsd: halfUsd }], minSaleUsd: 1 } }, { execute: true, log });
  saleCtx.provider.pollingInterval = 100;
  const usdBefore = await usd.balanceOf(book.blue.address);
  mark = lines.length;
  await runRound(saleCtx, ["allocator"]);
  assert.ok((await book.blue.coll(WETH)).lt(coll), `sold through Allocator.sellForBackstop -> Backstop.sell -> onBackstopSell: ${since(mark)}`);
  assert.ok((await usd.balanceOf(book.blue.address)).gt(usdBefore), "imdUSD back to the sleeve");
  // The keeper's own Allocator act is in its journal, so the guardian does not call it a stolen key.
  await mine(3);
  mark = lines.length;
  await runRound(fast, ["guardian"]);
  assert.doesNotMatch(since(mark), /guardian-freeze-now/, "our own sale does not trip keeper-replayed");
  ok("allocator: a sale runs on the real interface, with a mock route; the guardian reads it as ours");

  // --- the rule-driven auction: the same allocator round started it (no Allocator role needed); a stranger buys at the sleeve's own price
  const left = await book.blue.coll(WETH);
  assert.ok(left.gt(0), "collateral left after the route sale");
  assert.ok((await book.allocator.auctionStart(auctionKey(book.blue.address, WETH))).gt(0), `the rules pass started the auction: ${since(mark)}`);
  await warp(7200);
  await freshen();
  const floorPrice = await book.allocator.auctionPrice(book.blue.address, WETH);
  const buyAmt = left.div(10);
  await (await usd.connect(victim).approve(book.allocator.address, constants.MaxUint256)).wait();
  const [sleeveUsd0, wethBefore] = await Promise.all([usd.balanceOf(book.blue.address), weth.balanceOf(victim.address)]);
  await (await book.allocator.connect(victim).buyCollateral(book.blue.address, WETH, buyAmt, constants.MaxUint256)).wait();
  assert.ok((await weth.balanceOf(victim.address)).sub(wethBefore).eq(buyAmt), "the buyer got the collateral");
  const auctionPaid = (await usd.balanceOf(book.blue.address)).sub(sleeveUsd0);
  assert.ok(auctionPaid.eq(buyAmt.mul(floorPrice).add(E18.sub(1)).div(E18)), `the sleeve got the floor price: ${auctionPaid}`);
  await mine(3);
  mark = lines.length;
  await runRound(fast, ["guardian"]);
  assert.doesNotMatch(since(mark), /guardian-freeze-now/, "a stranger's buy emits Bought, not Acted: unknown-actor stays quiet");
  ok(`allocator: the rule-driven auction on the real sleeve (started by the keeper with no role, ${utils.formatEther(buyAmt)} WETH bought by a stranger at ${utils.formatEther(floorPrice)})`);

  // --- peg: real pool, real hook
  const hookFull = new Contract(book.pegHook.address, ["function poolKey() view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks))", "function pegTick() view returns (int24)", "function stableIsToken0() view returns (bool)"], raw);
  const key = await hookFull.poolKey();
  const pegTick = await hookFull.pegTick();
  const driver = new Contract(DRIVER, ["function swap((address,address,uint24,int24,address),bool,int256,uint160)", "function addLiquidity((address,address,uint24,int24,address),int24,int24,int256)"], wallet_(6).connect(raw));
  const keyT = [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];
  await (await driver.addLiquidity(keyT, pegTick - 200, pegTick + 200, BigNumber.from(10).pow(18))).wait(); // about $10k a side over +-2%: thin, as the beta pool will be, but a real book
  const stable0 = await hookFull.stableIsToken0();
  const MIN_SQRT = BigNumber.from("4295128740"), MAX_SQRT = BigNumber.from("1461446703485210103287273052203988822378723970341");
  const sell = async (n) => { // sell imdUSD for USDC: pushes the stable down
    const zeroForOne = stable0;
    const tx = await driver.swap(keyT, zeroForOne, E18.mul(n).mul(-1), zeroForOne ? MIN_SQRT : MAX_SQRT);
    await tx.wait();
  };
  await sell(5_000);
  await mine();
  const spot = await book.pegHook.spotTicks();
  assert.ok(spot < -25 && spot > -200, `the pool pushed below the band, inside the book (${spot} ticks)`);
  const pmRead = new Contract(PM, ["function balanceOf(address,uint256) view returns (uint256)"], raw);
  const claims = await pmRead.balanceOf(book.pegHook.address, BigNumber.from(USDC));
  const claimsStable = await pmRead.balanceOf(book.pegHook.address, BigNumber.from(book.usd.address));
  console.log(`      peg: spot ${spot} ticks; toll claims ${utils.formatUnits(claims, 6)} USDC, ${utils.formatEther(claimsStable)} imdUSD`);
  assert.ok(claims.gt(0) || claimsStable.gt(0), "the toll took something");
  await warp(31 * 60);
  await freshen();
  const treasuryUsd0 = await usd.balanceOf(book.record.treasury);
  mark = lines.length;
  assert.deepEqual(await runRound(report, ["peg"]), [], since(mark));
  assert.match(since(mark), /would   sweep/, since(mark));
  const n3 = await keeperNonce();
  assert.deepEqual(await runRound(exec, ["peg"]), [], since(mark));
  assert.ok((await keeperNonce()) > n3, since(mark));
  assert.ok((await pmRead.balanceOf(book.pegHook.address, BigNumber.from(USDC))).isZero(), `USDC claims swept: ${since(mark)}`);
  const twapNow = await book.pegHook.twapTicks();
  assert.ok((await usd.balanceOf(book.record.treasury)).gt(treasuryUsd0), `the toll's USDC became the bid and the buffer bought imdUSD for the Treasury (twap ${twapNow}): ${since(mark)}`);
  ok(`peg: sweep moved the toll claims; withdraw at TWAP ${twapNow}: the buffer bought for the Treasury, on the real hook and pool`);

  // Above the peg: provide mints against the keeper cap and pays the caller its reward.
  const buy = async (n) => {
    const zeroForOne = !stable0;
    await (await driver.swap(keyT, zeroForOne, BigNumber.from(10).pow(6).mul(n).mul(-1), zeroForOne ? MIN_SQRT : MAX_SQRT)).wait();
  };
  await buy(8_000);
  await warp(31 * 60);
  await freshen();
  const spotUp = await book.pegHook.spotTicks();
  assert.ok(spotUp > 25 && spotUp < 200, `pushed above the band, inside the book (${spotUp})`);
  const usdcBefore = await usdc.balanceOf(keeper);
  mark = lines.length;
  await runRound(exec, ["peg"]);
  const outstanding = await book.pegHook.outstanding();
  assert.ok(outstanding.gt(0), `provide minted: ${since(mark)}`);
  const afterProvide = await book.pegHook.spotTicks();
  assert.ok(afterProvide <= 6, `provide sold down to about +5 ticks (${afterProvide})`);
  const rewardUp = (await usdc.balanceOf(keeper)).sub(usdcBefore);
  console.log(`      peg: spot ${spotUp} -> ${afterProvide}; provide minted ${utils.formatEther(outstanding)} imdUSD, caller's reward ${utils.formatUnits(rewardUp, 6)} USDC`);
  ok("peg: provide at the real gates, within the real cap, sells back to the target");

  // Back below: withdraw buys the outstanding imdUSD back and burns it.
  await sell(Number(utils.formatEther(outstanding).split(".")[0]) + 3_000);
  await warp(31 * 60);
  await freshen();
  const spotDown = await book.pegHook.spotTicks();
  assert.ok(spotDown < -25 && spotDown > -200, `pushed below again, inside the book (${spotDown})`);
  const usdcBefore2 = await usdc.balanceOf(keeper);
  mark = lines.length;
  await runRound(exec, ["peg"]);
  const outstandingAfter = await book.pegHook.outstanding();
  assert.ok(outstandingAfter.lt(outstanding), `withdraw burned outstanding imdUSD: ${since(mark)}`);
  const rewardDown = (await usdc.balanceOf(keeper)).sub(usdcBefore2);
  console.log(`      peg: spot ${spotDown} -> ${await book.pegHook.spotTicks()}; outstanding ${utils.formatEther(outstanding)} -> ${utils.formatEther(outstandingAfter)}, caller's reward ${utils.formatUnits(rewardDown, 6)} USDC`);
  ok("peg: withdraw burns outstanding imdUSD below the band");

  // --- a full report-only round on everything built: reads every view, sends nothing
  const n4 = await keeperNonce();
  const payN = mock.state.payments.length;
  mark = lines.length;
  assert.deepEqual(await runRound(report), [], since(mark));
  assert.equal(await keeperNonce(), n4);
  assert.equal(mock.state.payments.length, payN);
  ok("report-only: a full round on every loop, no transaction, no payment");
} catch (e) {
  failed = true;
  console.error(`FAILED: ${e.message}`);
  console.error(lines.slice(-30).join("\n"));
} finally {
  await mock?.close();
  await rpc("evm_revert", [snapshot]);
}
process.exit(failed ? 1 : 0);
