// The Robinhood Chain (4663) deployment, read from the chain (the contracts' script/DeployRobinhood.s.sol with
// RobinhoodConfig, script/DeployChain.s.sol).
//
// THE RECORD. DeployRobinhood is one-shot and writes no launch record. The keeper takes a JSON
// file with the LaunchBase record's key names (chainId, ledger, params, pricer, liquidator, usd, treasury, pegHook, backstopBlue,
// backstopEdge, backstopOracle, allocator) plus `bridge` (ImdBridge) and optionally `deployBlock`. Everything else is read from the
// chain: the Pulse from Ledger.pulse(); each type's join, price feeds and token from Parameters.config; a stock type is one whose join
// answers TICK_SPAN() (StockJoin) and whose price is a RateFeed over a MarketHoursFeed (DeployChain.s.sol:56-60); the IMD type's swarm
// leaves are the `a()` legs of its PRODUCT price and spot (RobinhoodConfig F_IMD_USD = F_IMD_ETH x F_ETH). A record naming a Ledger
// with no code, or another chain, is refused.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { constants, Contract, utils } from "ethers";
import {
  ALLOCATOR_ABI, BACKSTOP_ABI, BACKSTOP_ORACLE_ABI, FEED_ABI, ilkName, LEAF_ABI, LEDGER_ABI, LIQUIDATOR_ABI, LIVE_POOL_ABI, PARAMS_ABI, PEG_HOOK_ABI,
  PRICER_ABI, PRODUCT_ABI, TOKEN_ABI,
} from "./deployment.mjs";

export const PULSE_ABI = [
  "function poke()",
  "function lastPulse() view returns (uint64)",
  "function graceUntil() view returns (uint64)",
  "function gap() view returns (uint256)",
  "function grace() view returns (uint256)",
  "function inGrace() view returns (bool)",
];
// StockJoin (wave 4: 4 fields, `ran` + `lastTick`; `tick` and `elapsed`).
export const STOCK_JOIN_ABI = [
  "error BadAuction()", "error AuctionLive()", "error NoAuction()", "error NotPriced()", "error PriceAboveMax()", "error StillUnhealthy()",
  "function auctions(uint256) view returns (uint64 startAt, address marker, uint32 ran, uint64 lastTick)",
  "function price(uint256) view returns (uint256)",
  "function elapsed(uint256) view returns (uint256)",
  "function auctionTime() view returns (uint256)",
  "function floor() view returns (uint256)",
  "function TICK_SPAN() view returns (uint256)",
  "function tick(uint256)",
  "function cancel(uint256)",
];
export const MARKET_FEED_ABI = [
  "error MultiplierPending()",
  "function stock() view returns (address)",
  "function calendar() view returns (address)",
  "function seenMultiplier() view returns (uint256)",
  "function seenAt() view returns (uint64)",
  "function frozen() view returns (bool)",
  "function isStale() view returns (bool)",
  "function latestValue() view returns (uint256, uint64)",
  "function sync()",
];
export const STOCK_TOKEN_ABI = ["function uiMultiplier() view returns (uint256)", "function newUIMultiplier() view returns (uint256)", "function paused() view returns (bool)", "function oraclePaused() view returns (bool)"];
export const CALENDAR_ABI = ["function isOpen(uint256) view returns (bool)", "function isOpenNow() view returns (bool)", "function openAt(uint256) view returns (uint256)"];
export const RATE_FEED_ABI = [
  "error RateUnavailable()",
  "function poke()",
  "function rate() view returns (uint256)",
  "function liveRate() view returns (uint256 rate, bool ok)",
  "function checkpointRate() view returns (uint192)",
  "function checkpointAt() view returns (uint64)",
  "function maxGrowthPerSecond() view returns (uint256)",
  "function rateSource() view returns (address)",
  "function underlying() view returns (address)",
];
export const VAULT_ABI = ["function convertToAssets(uint256) view returns (uint256)", "function asset() view returns (address)", "function worthless() view returns (bool)"];
export const LEDGER_4663_ABI = [
  ...LEDGER_ABI,
  "error NotWorthless()", "error NoDebt()",
  "error SequencerGrace()", // since wave 5: the seizing writeOff waits out the Pulse grace (arming is not held)
  "function pulse() view returns (address)",
  "function reserveBacked() view returns (uint256)",
  "function worthlessSince(bytes32) view returns (uint256)",
  "function worthlessLast(bytes32) view returns (uint256)",
  "function writeOff(uint256)",
];
export const BRIDGE_ABI = [
  "event Sent(bytes32 indexed guid, uint32 indexed dstEid, address indexed from, bytes32 to, uint256 amount, uint64 nonce)",
  "event Received(bytes32 indexed guid, uint32 indexed srcEid, address indexed to, uint256 amount, uint64 nonce)",
  "event Paused(uint32 indexed eid, address by)",
  "event Unpaused(uint32 indexed eid)",
  "event Voided(uint8 indexed kind, uint32 indexed srcEid, bytes32 sender, uint64 nonce, bytes32 payloadHash)",
  "event Unvoided(bytes32 indexed payloadHash)",
  "event HoldPlaced(uint32 indexed srcEid, bytes32 sender, uint64 indexed nonce, bytes32 payloadHash, uint256 until)",
  "event HoldReleased(uint32 indexed srcEid, bytes32 sender, uint64 indexed nonce, bytes32 payloadHash)",
  "event PathSet(uint32 indexed eid, bytes32 peer, uint256 outLimit, uint256 outWindow, uint256 inLimit, uint256 inWindow)",
  // Inbound delay (ImdBridge: a transfer over the path's instant allowance waits DELAY as a claim).
  "event Queued(bytes32 indexed guid, uint32 indexed srcEid, address indexed to, uint256 amount, uint64 nonce, uint256 claimableAt)",
  "event Claimed(bytes32 indexed guid, uint32 indexed srcEid, address indexed to, uint256 amount)",
  "event ClaimCancelled(bytes32 indexed guid, uint32 indexed srcEid)",
  "event ClaimRestored(bytes32 indexed guid, uint32 indexed srcEid)",
  "function queued() view returns (uint256)",
  // the governable delay: a claim is claimable at queuedAt + breakers(srcEid).delay AT CLAIM TIME, and
  // refused (CancelledSince) while breakers(srcEid).cancelledFrom != 0 and queuedAt >= it. Per-path settings, set by SET_DELAY
  // (48 h) or tightened at once by `tighten`; both emit DelaySet.
  "event DelaySet(uint32 indexed srcEid, uint256 instantCap, uint256 delay, uint256 queueBreaker, uint256 cancelFrom)",
  "event BreakerTripped(uint32 indexed srcEid, uint256 trip, address by)",
  "event BreakerReset(uint32 indexed srcEid, uint256 trip)",
  "function claims(uint32 srcEid, bytes32 guid) view returns (address to, uint48 amountSD, uint40 queuedAt, uint8 state)",
  "function breakerBuckets(uint32 srcEid) view returns (uint256)",
  "function instantIn(uint32 srcEid) view returns (uint128 used, uint64 lastUpdated, uint64 capSD)",
  "function claim(uint32 srcEid, bytes32 guid)",
  // The queue breaker: a tripped path runs no claim until the timelock's RESET_BREAKER.
  "function breakers(uint32 srcEid) view returns (uint40 day, uint16 trips, bool tripped, uint64 breakerSD, uint32 delay, uint40 cancelledFrom, uint16 version)",
  "function received() view returns (uint256)",
  "function sent() view returns (uint256)",
  "function netMinted() view returns (int256)",
  "function paused(uint32) view returns (bool)",
  "function peers(uint32) view returns (bytes32)",
  "function availableIn(uint32) view returns (uint256)",
  "function availableOut(uint32) view returns (uint256)",
  "function endpoint() view returns (address)",
];
/** EndpointV2 (lib/layerzero-v2 ILayerZeroEndpointV2 + IMessagingChannel): a packet the DVNs verified for a receiver, and what it still
 *  stores at a nonce (0 once executed or cleared; the NIL hash once nilified). */
export const ENDPOINT_ABI = [
  "event PacketVerified((uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver, bytes32 payloadHash)",
  "function inboundPayloadHash(address receiver, uint32 srcEid, bytes32 sender, uint64 nonce) view returns (bytes32)",
  "function inboundNonce(address receiver, uint32 srcEid, bytes32 sender) view returns (uint64)",
];
export const SUPPLY_ABI = ["function totalSupply() view returns (uint256)", "function outstanding() view returns (uint256)"];

/** LayerZero endpoint ids of the two chains (RobinhoodConfig EID / MAINNET_EID). */
export const EID = { 1: 30101, 4663: 30416 };
export const chainOfEid = (eid) => Number(Object.keys(EID).find((c) => EID[c] === Number(eid)) ?? 0);

const REQUIRED = ["ledger", "params", "pricer", "liquidator", "usd", "pegHook"];

export function loadRecord4663(path, chainId = 4663) {
  const r = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (Number(r.chainId) !== Number(chainId)) throw new Error(`record is for chain ${r.chainId}, this keeper runs on ${chainId}`);
  for (const k of REQUIRED) if (!r[k] || r[k] === constants.AddressZero) throw new Error(`record has no ${k}`);
  return r;
}

/** Probe: does `addr` answer `fn` (a view with no arguments)? Reverting or code-less means no. */
async function answers(provider, addr, sig) {
  try {
    await new Contract(addr, [`function ${sig}`], provider)[sig.slice(0, sig.indexOf("("))]();
    return true;
  } catch {
    return false;
  }
}

/** What one type is, read from its Parameters config. */
async function classify(provider, t) {
  const c = (a, abi) => new Contract(a, abi, provider);
  const out = { stock: null, rates: [], leaves: null };
  const priceFeeds = [...new Set([t.config.median, t.config.spot, t.config.yieldRate].filter((a) => a && a !== constants.AddressZero))];
  for (const f of priceFeeds) if (await answers(provider, f, "checkpointAt() view returns (uint64)")) out.rates.push(f);
  if (t.config.auction && (await answers(provider, t.config.join, "TICK_SPAN() view returns (uint256)"))) {
    const rate = c(t.config.median, RATE_FEED_ABI);
    const market = c(await rate.underlying(), MARKET_FEED_ABI);
    const token = c(await market.stock(), STOCK_TOKEN_ABI);
    out.stock = { join: c(t.config.join, STOCK_JOIN_ABI), vault: c(t.config.token, VAULT_ABI), market, token, calendar: c(await market.calendar(), CALENDAR_ABI) };
  }
  if (t.name === "IMD" && t.config.nhi !== constants.AddressZero) {
    const mp = c(t.config.median, PRODUCT_ABI), sp = c(t.config.spot, PRODUCT_ABI);
    out.leaves = { median: c(await mp.a(), LEAF_ABI), spot: c(await sp.a(), LEAF_ABI), nhi: c(t.config.nhi, LEAF_ABI), ethUsd: c(await mp.b(), FEED_ABI) };
  }
  return out;
}

/** The 4663 book: the same shape as lib/deployment.mjs makeBook where a duty is shared (positions, peg, backstop, allocator, guardian),
 *  plus pulse, stocks, rate feeds, the IMD leaves and the bridge. Mainnet-only parts (depth, seats, proven price) are absent (null). */
export async function makeRobinhoodBook(record, provider) {
  if ((await provider.getCode(record.ledger)) === "0x") throw new Error(`no code at the record's Ledger ${record.ledger}`);
  const c = (a, abi) => new Contract(a, abi, provider);
  const ledger = c(record.ledger, LEDGER_4663_ABI);
  const params = c(record.params, PARAMS_ABI);
  const pulseAddr = await ledger.pulse();
  const n = (await params.ilkCount()).toNumber();
  const ilks = [];
  for (let i = 0; i < n; i++) {
    const id = await params.ilks(i);
    const config = await params.config(id);
    const t = { id, name: ilkName(id), config, edge: await params.edgeIlk(id) };
    Object.assign(t, await classify(provider, t));
    ilks.push(t);
  }
  const opt = (k, abi) => (record[k] && record[k] !== constants.AddressZero ? c(record[k], abi) : null);
  return {
    chainId: 4663,
    record,
    ledger,
    params,
    pricer: c(record.pricer, PRICER_ABI),
    liquidator: c(record.liquidator, LIQUIDATOR_ABI),
    pulse: pulseAddr === constants.AddressZero ? null : c(pulseAddr, PULSE_ABI),
    usd: c(record.usd, [...TOKEN_ABI, ...SUPPLY_ABI.slice(0, 1)]),
    pegHook: c(record.pegHook, PEG_HOOK_ABI),
    blue: opt("backstopBlue", BACKSTOP_ABI),
    edge: opt("backstopEdge", BACKSTOP_ABI),
    backstopOracle: opt("backstopOracle", BACKSTOP_ORACLE_ABI),
    allocator: opt("allocator", ALLOCATOR_ABI),
    bridge: opt("bridge", BRIDGE_ABI),
    migrator: opt("migrator", SUPPLY_ABI),
    pegLPVault: null,
    imdDepth: null,
    samplers: [],
    proven: [],
    seatJoin: null,
    ilks,
    stocks: ilks.filter((t) => t.stock),
    rates: [...new Map(ilks.flatMap((t) => t.rates.map((a) => [a.toLowerCase(), { feed: c(a, RATE_FEED_ABI), ilks: ilks.filter((x) => x.rates.includes(a)).map((x) => x.name) }]))).values()],
    imd: ilks.find((t) => t.leaves) ?? null,
    feed: (a) => c(a, FEED_ABI),
    leaf: (a) => c(a, LEAF_ABI),
    live: (a) => c(a, LIVE_POOL_ABI),
    token: (a) => c(a, TOKEN_ABI),
    sleeve: (a) => c(a, BACKSTOP_ABI),
  };
}

export const describeRobinhoodBook = (b) => [
  `ledger ${b.ledger.address}, pulse ${b.pulse?.address ?? "none"}, bridge ${b.bridge?.address ?? "none"}`,
  `types ${b.ilks.map((t) => t.name).join(", ")}`,
  `${b.stocks.length} stock types, ${b.rates.length} rate feeds, IMD leaves ${b.imd ? "found" : "none"}`,
].join("\n");

export const toBytes32Addr = (a) => utils.hexZeroPad(a, 32).toLowerCase();
