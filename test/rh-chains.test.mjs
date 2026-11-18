// Chain plumbing for the 12-07 two-chain keeper (lib/chains.mjs, lib/chain.mjs, lib/tx.mjs, lib/oracle.mjs, lib/orders.mjs) and the
// 4663 IMD legs (lib/imdfeeds.mjs) against fakes: mainnet's config is unchanged, 4663 never inherits mainnet's RPCs/key/state, answers
// are bought for consumer 4663 and paid (read) on Ethereum with no mainnet send, buying is off by default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, providers, utils } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-rh-chains-"));
const { applyStateDir, chainArg, chainConfig, CHAIN_DEFAULTS, evmBlockNumber, expandUrls } = await import("../lib/chains.mjs");
const { envName, urlList } = await import("../lib/chain.mjs");
const { keeperSigner, mnemonicEnv, sendUrls } = await import("../lib/tx.mjs");
const { buildInput, preflightAttestation } = await import("../lib/oracle.mjs");
const { ensureAllowance, loadOrders } = await import("../lib/orders.mjs");
const { questionPool, runImdFeeds } = await import("../lib/imdfeeds.mjs");
const { loopsFor, LOOPS, ROBINHOOD_LOOPS } = await import("../keeper.mjs");
const { makeWorld } = await import("./lib/rh-world.mjs");
const example = (await import("../config.example.js")).default;

const E18 = BigNumber.from(10).pow(18);
const PINNED = JSON.parse(readFileSync(new URL("./question-hashes.json", import.meta.url), "utf8"));

// ---------------------------------------------------------------- config

test("mainnet's config is the file's top level, unchanged; 4663 takes its defaults and never mainnet's RPCs, key address, sales or state dir", () => {
  const file = { ...example, READ_RPC_URLS: ["https://main"], KEEPER_ADDRESS: "0x1", ALLOCATOR: { sales: [1] }, PEERS: { 4663: {} }, BRIDGE_WATCH: { enabled: true } };
  const { CHAINS, ...top } = file;
  assert.deepEqual(chainConfig(file, 1), { ...top, CHAIN_ID: 1 });
  // Auto-claim: the example runs the mainnet bridge watcher (claims queued on mainnet need this keeper); without it, exactly LOOPS.
  assert.deepEqual(loopsFor(chainConfig(example, 1)).map((l) => l.name), [...LOOPS.map((l) => l.name), "bridge"], "mainnet runs its loops plus the bridge watcher");
  assert.deepEqual(loopsFor(chainConfig({ ...example, BRIDGE_WATCH: undefined }, 1)), LOOPS, "with the watcher off, mainnet keeps exactly its loops");
  const c = chainConfig(file, 4663);
  assert.equal(c.CHAIN_ID, 4663);
  assert.deepEqual(c.READ_RPC_URLS, ["https://rpc.mainnet.chain.robinhood.com"]);
  assert.equal(c.KEEPER_ADDRESS, null);
  assert.deepEqual(c.ALLOCATOR.sales, []);
  assert.equal(c.MAX_GAS_GWEI, CHAIN_DEFAULTS[4663].MAX_GAS_GWEI);
  assert.equal(c.ROUTINE_MAX_GAS_GWEI, 0.1);
  assert.match(c.STATE_DIR, /state-4663/);
  assert.ok(c.PEERS[1], "the 4663 process reads mainnet");
  assert.equal(c.IMD_FEEDS.buy, false, "IMD answers are not bought by default");
  assert.equal(c.FEEDS.fallTriggerBps, 500, "the refresh rules carry over");
  assert.deepEqual(loopsFor(c).map((l) => l.name), ROBINHOOD_LOOPS.map((l) => l.name));
  assert.equal(chainArg(["node", "keeper.mjs", "--chain", "4663"]), 4663);
  assert.equal(chainArg(["node", "keeper.mjs"]), null);
  assert.throws(() => chainArg(["x", "--chain", "abc"]));
});

test("env names carry the chain suffix off mainnet; ${KEY} placeholders fill from the env, a URL with an unset one is left out", () => {
  const c = chainConfig(example, 4663);
  assert.equal(envName({ CHAIN_ID: 1 }, "READ_RPC_URLS"), "READ_RPC_URLS");
  assert.equal(envName(c, "SEND_RPC_URLS"), "SEND_RPC_URLS_4663");
  const env = { SEND_RPC_URLS: "https://mainnet-private", SEND_RPC_URLS_4663: "https://rh-paid/${RH_KEY}", RH_KEY: "k1" };
  assert.deepEqual(sendUrls(c, env), ["https://rh-paid/k1"]);
  assert.deepEqual(sendUrls({ CHAIN_ID: 1 }, env), ["https://mainnet-private"]);
  assert.deepEqual(expandUrls(["https://a/${X}", "https://b"], {}), { urls: ["https://b"], missing: ["X"] });
  assert.deepEqual(urlList(c, "LOG_RPC_URLS", {}), [], "the Blockscout door without BLOCKSCOUT_KEY is left out");
  assert.deepEqual(urlList(c, "LOG_RPC_URLS", { BLOCKSCOUT_KEY: "abc" }), ["https://robinhoodchain.blockscout.com/api/eth-rpc?apikey=abc"]);
});

test("the 4663 key is its own: KEEPER_MNEMONIC_4663, never a fallback to mainnet's, and refused if it IS mainnet's", () => {
  const c = chainConfig(example, 4663);
  assert.equal(mnemonicEnv(c), "KEEPER_MNEMONIC_4663");
  assert.equal(mnemonicEnv({ CHAIN_ID: 1 }), "KEEPER_MNEMONIC");
  const m = "test test test test test test test test test test test junk";
  const p = new providers.StaticJsonRpcProvider("http://127.0.0.1:1", 4663);
  assert.throws(() => keeperSigner(p, c, { KEEPER_MNEMONIC: m }), /KEEPER_MNEMONIC_4663/);
  assert.throws(() => keeperSigner(p, c, { KEEPER_MNEMONIC: m, KEEPER_MNEMONIC_4663: m }), /each chain runs on its own key/);
});

test("a chain's state dir is its own unless STATE_DIR is set (tests, forks)", () => {
  const env = {};
  assert.match(applyStateDir(chainConfig(example, 4663), env), /state-4663/);
  assert.equal(applyStateDir(chainConfig(example, 4663), { STATE_DIR: "/x" }), "/x");
  assert.equal(applyStateDir(chainConfig(example, 1), {}), null, "mainnet: unchanged (state/)");
});

// ---------------------------------------------------------------- consumer 4663, L1 head

const leaf = (over = {}) => ({ address: "0xAbCdEf0000000000000000000000000000000001", MIN_PANEL_SIZE: async () => 100, minAgreed: async () => 51, ...over });

test("an answer for a 4663 leaf is asked for consumer {4663, leaf}; the question (chain 1, Ethereum's pool) is unchanged", async () => {
  const input = await buildInput(leaf(), "price", { consumerChainId: 4663 });
  assert.deepEqual(input.consumer, { chainId: 4663, verifyingContract: "0xabcdef0000000000000000000000000000000001" });
  assert.equal(input.chainId, 1);
  assert.equal((await buildInput(leaf(), "price")).consumer.chainId, 1, "mainnet default unchanged");
});

test("on 4663 the window is checked against the L1 block the leaf sees (l1BlockNumber), not the L2 block", async () => {
  const fake = { send: async () => ({ number: "0x6de371e", l1BlockNumber: "0x1932e25" }), getBlock: async () => ({ number: 115_226_398 }) };
  assert.equal(await evmBlockNumber(fake, { L1_BLOCK_NUMBER: true }), 26_422_821);
  assert.equal(await evmBlockNumber(fake, {}), 115_226_398);
  await assert.rejects(evmBlockNumber({ send: async () => ({}) }, { L1_BLOCK_NUMBER: true }), /l1BlockNumber/);
  // preflight: a window ending at L1 block 26,422,800 is fresh against the L1 head, "past the leaf's life" against the L2 head.
  const m = { requestId: "0x" + "11".repeat(32), chainId: 1, questionHash: "0x" + "22".repeat(32), answerType: 3, answer: utils.hexZeroPad("0x05", 32), figure: 0, fromBlock: 26_422_200, toBlock: 26_422_800, blockHash: "0x" + "00".repeat(32), panelJobId: "0x" + "00".repeat(32), panelSize: 100, quorum: 51, agreed: 60, issuedAt: 1000, expiresAt: 5000 };
  const domain = { name: "IdentityMD Oracle", version: "2", chainId: 4663, verifyingContract: "0xabcdef0000000000000000000000000000000001" };
  const l = leaf({
    attester: async () => "0x00000000000000000000000000000000000000a7", attestationChainId: async () => 1, attestationAnswerType: async () => 3, maxAge: async () => 3600,
    usedRequests: async () => false, DOMAIN_SEPARATOR: async () => utils._TypedDataEncoder.hashDomain(domain), latestValue: async () => ({ value: E18, updatedAt: 0 }),
    lastToBlock: async () => 0, expectedQuestionHash: async () => m.questionHash, accepts: async () => true,
  });
  const p = { getBlock: async () => ({ number: 115_226_398, timestamp: 2000 }) };
  const att = { domain, message: m, signature: "0x", signer: "0x00000000000000000000000000000000000000a7" };
  assert.deepEqual((await preflightAttestation(p, l, att, { evmHead: async () => 26_422_821 })).fail, []);
  assert.match((await preflightAttestation(p, l, att)).fail.join(), /past the leaf's life/, "with the L2 number it would be refused");
});

test("the 4663 keeper never sends a mainnet Permit2 approval: short allowance -> false + alert, nothing acted", async () => {
  const acts = [], alerts = [];
  const pay = { provider: fakeMainnet({ allowance: 0n }) };
  const ctx = { pay, signer: { address: "0x00000000000000000000000000000000000000b1" }, cfg: {}, actHook: async (...a) => acts.push(a), alerts: { raise: async (l, k) => alerts.push(k) } };
  assert.equal(await ensureAllowance(ctx, E18), false);
  assert.deepEqual(acts, []);
  assert.deepEqual(alerts, ["feeds-permit2-unapproved"]);
});

// ---------------------------------------------------------------- the IMD legs on 4663

/** A mainnet stand-in answering the reads imdfeeds/orders make: extsload (the pool), IMD balanceOf/allowance, the head. */
function fakeMainnet({ price = 4n * 10n ** 15n, balance = 10n ** 20n, allowance = 10n ** 20n } = {}) {
  // sqrtPriceX96 for `price` wei of ETH per 1e18 IMD: price = 1e18 * 2^192 / sqrt^2
  const target = (10n ** 18n * (1n << 192n)) / price;
  let x = target, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + target / x) / 2n; }
  const SEL = { extsload: utils.id("extsload(bytes32)").slice(0, 10), balanceOf: utils.id("balanceOf(address)").slice(0, 10), allowance: utils.id("allowance(address,address)").slice(0, 10) };
  class P extends providers.StaticJsonRpcProvider {
    async perform(method, params) {
      if (method === "getBlockNumber") return 23_000_000;
      if (method === "getBlock") return { number: "0x" + (23_000_000).toString(16), timestamp: "0x1", hash: "0x" + "00".repeat(32), parentHash: "0x" + "00".repeat(32), transactions: [], gasLimit: "0x1", gasUsed: "0x0", difficulty: "0x0", nonce: "0x0000000000000000", miner: "0x" + "00".repeat(20), extraData: "0x" };
      if (method === "call") {
        const s = params.transaction.data.slice(0, 10);
        if (s === SEL.extsload) return utils.hexZeroPad(BigNumber.from(x).toHexString(), 32);
        if (s === SEL.balanceOf) return utils.hexZeroPad(BigNumber.from(balance).toHexString(), 32);
        if (s === SEL.allowance) return utils.hexZeroPad(BigNumber.from(allowance).toHexString(), 32);
      }
      throw new Error(`fake mainnet: ${method}`);
    }
  }
  return new P("http://127.0.0.1:1", { chainId: 1, name: "homestead" });
}

function imdWorld({ buy, execute }) {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  const IMD = utils.formatBytes32String("IMD");
  const { w, ctx, book } = makeWorld({ types: [{ id: IMD, name: "IMD" }], positions: [{ id: 1, ilk: IMD, collateral: E18.mul(1000), debt: E18.mul(7000) }] });
  const lf = (role, value) => ({
    address: utils.getAddress(utils.hexZeroPad(utils.hexlify(role.length * 17), 20)),
    latestValue: async () => ({ value, updatedAt: w.now - 60 }), converged: async () => true, attested: async () => value, followOf: async (v) => v, maxDeviationBps: async () => BigNumber.from(2000),
    epoch: async () => ({ anchor: value, allowanceBps: BigNumber.from(2000) }), accepts: async () => true,
    expectedQuestionHash: async () => PINNED[role === "median" ? "price" : role], attestationChainId: async () => 1, attestationAnswerType: async () => 3, MIN_PANEL_SIZE: async () => 100, minAgreed: async () => 51,
  });
  const t = book.ilks[0];
  t.leaves = { median: lf("median", 5n * 10n ** 15n), spot: lf("spot", 5n * 10n ** 15n), nhi: lf("nhi", E18), ethUsd: { latestValue: async () => [E18.mul(3000), w.now] } };
  book.imd = t;
  // the Pricer measures IMD loans at $14; the pool is 0.004 ETH x $3,000 = $12 (a 14% fall); the loan (1,000 IMD, 7,000 debt) is under 1.7 x 1.1
  book.pricer.quote = async () => ({ priced: true, low: E18.mul(14), mat: E18.mul(17).div(10), lull: BigNumber.from(0), agree: true });
  ctx.provider.getBalance = async () => E18;
  ctx.provider.getGasPrice = async () => utils.parseUnits("0.02", "gwei");
  ctx.pay = { provider: fakeMainnet() };
  ctx.peers = { 1: ctx.pay.provider };
  ctx.execute = execute;
  ctx.signer = { address: ctx.keeperAddress };
  ctx.cfg = { ...ctx.cfg, CHAIN_ID: 4663, IMD_FEEDS: { buy }, API_BASE: "https://plane.test", PLANE: { useEns: false, holdAfterBlocked: 0, payTo: "0x4e0fa57bde726079356537e2f34d671e9f41adbc" }, IMD: { dailyCap: 5, pricePerQuestion: 0.5 } };
  ctx.fetchImpl = async () => ({ ok: true, json: async () => ({ status: "ok" }) });
  ctx.planeClient = { quote: async () => ({ status: 503, body: {} }) };
  return { w, ctx };
}

test("4663 IMD fall: decided and logged, but nothing is ordered while IMD_FEEDS.buy is off (the default)", async () => {
  const { w, ctx } = imdWorld({ buy: false, execute: true });
  process.env.PLANE_BEARER = "test";
  await runImdFeeds(ctx);
  assert.ok(w.logs.some((l) => /would\s+buy 4663 IMD price \+ spot.*IMD_FEEDS\.buy is off/.test(l)), w.logs.join("\n"));
  assert.deepEqual(loadOrders(), []);
});

test("4663 IMD fall with buying on: ONE oracle.group order, price + spot, consumer {4663, each leaf}, guards set", async () => {
  const { ctx, w } = imdWorld({ buy: true, execute: true });
  process.env.PLANE_BEARER = "test";
  await runImdFeeds(ctx);
  const orders = loadOrders();
  assert.equal(orders.length, 1, w.logs.join("\n"));
  const o = orders[0];
  assert.equal(o.purpose, "fall");
  assert.equal(o.action, "oracle.group");
  assert.deepEqual(o.input.questions.map((q) => q.consumer.chainId), [4663, 4663]);
  assert.deepEqual(o.questions.map((q) => q.role), ["price", "spot"]);
  assert.ok(o.input.questions.every((q) => q.guards?.min && q.guards?.max));
  assert.equal(o.stage, "new", "the plane stub answered 503: nothing paid");
});

test("the questions' pool is read from the frozen price body (Ethereum's v4 IMD/ETH pool)", () => {
  const p = questionPool();
  assert.equal(p.manager.toLowerCase(), "0x000000000004444c5dc75cb358380d2e3de08a90");
  assert.equal(p.poolId, "0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3");
});
