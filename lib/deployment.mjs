// The launch record (deploy/mainnet/out/<config>.json, written by the launch tooling) and what hangs off it. The record names the addresses; the
// types are read from Parameters at every start, so a type listed later appears by itself. The keeper refuses to run on a
// record that is not on this chain, not fully launched, or whose Ledger has no code.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { constants, Contract, utils } from "ethers";

// Output names are ours, and none may be `at`, `length` or another Array member: ethers results are arrays, so `r.at` would be
// Array.prototype.at, silently.
export const LEDGER_ABI = [
  "event Opened(uint256 indexed id, bytes32 indexed ilk, address indexed owner, uint256 salt)",
  "function ilkOf(uint256) view returns (bytes32)",
  "function ilkState(bytes32) view returns (uint128 debt, uint128 collateral, uint256 weighted, uint64 lastAccrual, uint128 badDebt)",
  "function ilkDebt(bytes32) view returns (uint256)",
  "function debtOf(uint256) view returns (uint256)",
  "function healthy(uint256) view returns (bool ok, bool priced)",
  "function position(uint256) view returns ((uint128 collateral,uint128 debt,uint64 rate,uint40 lastUpdate,uint40 lastRateChange,uint64 premiumRate,uint16 ilkIndex,uint32 version,uint192 yieldMark))",
  "function unbacked() view returns (uint256)",
  "function totalBadDebt() view returns (uint256)",
];
export const PARAMS_ABI = [
  "function ilkCount() view returns (uint256)",
  "function ilks(uint256) view returns (bytes32)",
  "function config(bytes32) view returns ((address token,address join,address median,address spot,address nhi,address yieldRate,address pegAggregator,address liveSpot,bool redeemable,bool auction))",
  "function risk(bytes32) view returns ((uint64 mat,uint64 chop,uint64 cut,uint64 chip,uint64 rateFloor,uint64 yieldFee,uint64 skew,uint64 pegFloor,uint128 line,uint128 dust,uint64 redeemFloor,uint64 redeemDivisor,uint128 redeemCap))",
  "function storedRisk(bytes32) view returns ((uint64 mat,uint64 chop,uint64 cut,uint64 chip,uint64 rateFloor,uint64 yieldFee,uint64 skew,uint64 pegFloor,uint128 line,uint128 dust,uint64 redeemFloor,uint64 redeemDivisor,uint128 redeemCap))",
  "function edgeIlk(bytes32) view returns (bool)",
  "function depthIMD() view returns (uint256)",
  "function unbackedBrake() view returns (uint64)",
  "function keeperCap() view returns (uint256)",
  "function governor() view returns (address)",
  "function pendingOf(uint8) view returns (bytes payload, uint256 eta)",
  "function RETIRE_SLEEVE_TOKEN() view returns (uint8)",
];
export const PRICER_ABI = [
  "function quote(bytes32) view returns ((uint256 low,uint256 high,uint256 payout,uint256 mat,uint256 lull,bool priced,bool borrowable,uint256 borrow,bool agree))",
];
export const LIQUIDATOR_ABI = [
  "error NotPriced()", "error Healthy()", "error NotMarked()", "error InGrace(uint256 until)", "error MarkExpired()", "error AlreadyMarked()", "error SeizedTooLow(uint256 seized, uint256 minSeized)",
  "function bark(uint256)",
  "function bite(uint256,uint256) returns (uint256 repaid, uint256 seized, uint256 bad)",
  "function liquidate(uint256,uint256) returns (uint256 repaid, uint256 seized, uint256 bad)",
  "function tick(bytes32)",
  "function marks(uint256) view returns (uint64 markedAt, address marker)",
  "function graces(uint256) view returns (uint64 markedAt, uint64 end, uint64 pausedAtMark)",
  "function clocks(bytes32) view returns (uint64 unpricedSince, uint64 paused)",
  "function markExpiresAt(uint256) view returns (uint256)",
  "function edgeInAuction() view returns (uint256)",
];
export const SAMPLER_ABI = [
  "error StaleFeed()", "error PoolOffReference(int24 poolTick, int24 referenceTick)", "error WalkTooLong()", "error ManagerUnlocked()",
  "function sample() returns (uint256,uint256)",
  "function feed1() view returns (address)",
  "function depth() view returns (uint256)",
  "function sampleAge() view returns (uint256)",
  "function filledBuckets() view returns (uint256)",
  "function bucket(uint256) view returns ((uint32 hour, uint112 sell0, uint112 sell1))",
  "function soldIsToken0() view returns (bool)",
];
export const IMD_DEPTH_ABI = [
  "function poke() returns (uint256)",
  "function depth() view returns (uint256)",
  "function sampled() view returns (uint256)",
  "function lowOf(uint256) view returns (uint32 day, uint256 usd)",
];
export const FEED_ABI = ["function latestValue() view returns (uint256, uint64)", "function isStale() view returns (bool)", "function maxAge() view returns (uint256)"];
// A SwarmFeed leaf. The refusals are named so a refused relay logs why.
export const ATTESTATION_TUPLE = "(bytes32 requestId,uint256 chainId,bytes32 questionHash,uint8 answerType,bytes answer,uint256 figure,uint64 fromBlock,uint64 toBlock,bytes32 blockHash,bytes32 panelJobId,uint16 panelSize,uint16 quorum,uint16 agreed,uint64 issuedAt,uint64 expiresAt)";
export const LEAF_ABI = [
  "error InvalidConfiguration()", "error ZeroValue()", "error ExcessDeviation()", "error InvalidSignature()", "error UnauthorizedRelayer()",
  "error WrongQuestion(bytes32 expected, bytes32 given)", "error WindowSpanOutOfRange(uint64 span)", "error WindowNotAdvancing(uint64 toBlock, uint64 lastAccepted)",
  "error InvalidWindow()", "error WindowInFuture(uint64 toBlock, uint256 head)", "error WindowTooOld(uint64 toBlock, uint256 head)", "error InvalidAttestationChain()",
  "error InvalidAnswerType()", "error InvalidTimestamp()", "error ExpiredAttestation()", "error StaleAttestation()", "error ReplayedAttestation()",
  "error PanelTooSmall()", "error NotEnoughAgreement()", "error InvalidAnswer()", "error AnswerMismatch()",
  "function attester() view returns (address)",
  "function relayer() view returns (address)",
  "function attestationChainId() view returns (uint256)",
  "function attestationAnswerType() view returns (uint8)",
  "function maxAge() view returns (uint256)",
  "function latestFigure() view returns (uint256)",
  "function maxDeviationBps() view returns (uint256)",
  "function usedRequests(bytes32) view returns (bool)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function MIN_PANEL_SIZE() view returns (uint16)",
  "function minAgreed() view returns (uint16)",
  "function latestValue() view returns (uint256 value, uint64 updatedAt)",
  "function isStale() view returns (bool)",
  "function lastToBlock() view returns (uint64)",
  "function expectedQuestionHash(uint64,uint64) pure returns (bytes32)",
  "function epoch() view returns (uint256 anchor, uint64 openedAt, uint256 allowanceBps)",
  "function accepts(uint256) view returns (bool)",
  // design C: every answer is a TARGET; the stored value follows it within the epoch's allowance
  "function followOf(uint256) view returns (uint256)",
  "function attested() view returns (uint256)",
  "function converged() view returns (bool)",
  `function submitAttestation(${ATTESTATION_TUPLE} a, bytes sig)`,
];
export const PRODUCT_ABI = [...FEED_ABI, "function a() view returns (address)", "function b() view returns (address)"];
export const PROVEN_ABI = [
  ...FEED_ABI,
  "error BadHeader()", "error NotNewer(uint256 block, uint256 provenBlock)", "error TooOld(uint256 block, uint256 head)", "error BadAccount()", "error EmptySlot()",
  "function manager() view returns (address)", "function poolId() view returns (bytes32)", "function provenBlock() view returns (uint64)",
  "function baseIsToken0() view returns (bool)",
  "function prove(bytes header, bytes[] accountProof, bytes[] storageProof) returns (uint256)",
];
export const LIVE_POOL_ABI = [...FEED_ABI, "function manager() view returns (address)", "function poolId() view returns (bytes32)", "function baseIsToken0() view returns (bool)"];
export const SEAT_JOIN_ABI = [
  "error NoAuction()", "error AuctionLive()", "error AuctionExpired()", "error Healthy()", "error NotPriced()", "error NotAtFloor()", "error NothingNew()", "error StillUnhealthy()",
  "function auctions(uint256) view returns (uint136 startPrice, uint40 startAt, uint40 lastTick, uint40 ethAt, address marker, uint40 attestedAt, uint40 ran, bool zeroAtTick)",
  "function expired(uint256) view returns (bool)",
  "function elapsed(uint256) view returns (uint256)",
  "function seatCount() view returns (uint256)",
  "function tick(uint256)",
  "function reopen(uint256)",
  "function cancel(uint256)",
];
export const SEAT_FEED_ABI = [
  "function poke()",
  "function median() view returns (address)",
  "function spot() view returns (address)",
  "function ethUsd() view returns (address)",
  "function cap() view returns (uint128 base, uint128 raw, uint64 attestedAt, uint32 figureBase, uint32 figureRaw)",
  "function ring(uint256) view returns (uint192 value, uint64 day)",
  "function isStale() view returns (bool)",
  "function latestValue() view returns (uint256, uint64)",
];
export const PEG_HOOK_ABI = [
  "error NoTwap()", "error TwapInBand(int24 twapTicks)", "error NothingToDo()", "error CapReached()", "error Undercollateralised()", "error QuoteUnsound()",
  "function poolManager() view returns (address)",
  "function stable() view returns (address)",
  "function quote() view returns (address)",
  "function twapTicks() view returns (int24)",
  "function spotTicks() view returns (int24)",
  "function outstanding() view returns (uint256)",
  "function buffer() view returns (uint256)",
  "function surplus() view returns (uint256)",
  "function bufferRoom() view returns (uint256)",
  "function quoteSound() view returns (bool)",
  "function sweep(address) returns (uint256)",
  "function provide() returns (uint256)",
  "function withdraw() returns (uint256 burned, uint256 bought)",
];
export const POOL_MANAGER_ABI = ["function balanceOf(address owner, uint256 id) view returns (uint256)"];
export const BACKSTOP_ABI = [
  "error BidOpen()",
  "function bidRoom(bytes32) view returns (uint256)",
  "function bidRoomNow(bytes32) view returns (uint256)",
  "function ilks(bytes32) view returns (address token, uint64 listedAt, uint128 genesisLine, bool on)",
  "function tokenCount() view returns (uint256)",
  "function tokens(uint256) view returns (address)",
  "function retired(address) view returns (bool)",
  "function coll(address) view returns (uint256)",
  "function collIn(address) view returns (uint256)",
  "function saleLimit(address) view returns (uint128 max, uint128 slope, uint128 level, uint64 updatedAt)",
  "function seller() view returns (address)",
  "function oracle() view returns (address)",
  "function imdUSD() view returns (address)",
  "function realize(address)",
  "function openHead() view returns (uint256)",
  "function openDaysLength() view returns (uint256)",
  "function openDays(uint256) view returns (uint256)",
  "function buckets(uint256) view returns (uint128 amount, uint256 shares, bool listed, bool converted)",
];
export const BACKSTOP_ORACLE_ABI = ["function priceOf(address) view returns (uint256 low, uint256 high, bool ok)"];
export const ALLOCATOR_ABI = [
  "error NotKeeper()", "error NotFreezer()", "error Frozen()", "error NotAllowed(bytes32 action, address target)", "error RateLimited(bytes32 action, address target, uint256 amount, uint256 available)",
  "error NoFeed(address token)", "error StaleFeed(address token)", "error Slippage(uint256 got, uint256 minOut)",
  "event Acted(bytes32 indexed action, address indexed target, uint256 amount, uint256 result)",
  "event KeeperSet(address indexed keeper, bool isKeeper)",
  "function governor() view returns (address)",
  "function freezer() view returns (address)",
  "function frozen() view returns (bool)",
  "function isKeeper(address) view returns (bool)",
  "function allowed(bytes32) view returns (bool)",
  "function key(bytes32,address) pure returns (bytes32)",
  "function available(bytes32,address) view returns (uint256)",
  "function feedOf(address) view returns (address)",
  "function oracleMinOut(address,address,uint256) view returns (uint256)",
  "function freeze()",
  "function fundBuffer(address,uint256)",
  "function sellForBackstop(address backstop, address route, address collateral, uint256 amount, uint256 keeperMinOut) returns (uint256)",
  // Rule-driven (anyone): the contract picks amount, price and route.
  "error AuctionIdle()", "error AuctionRunning()", "error PriceAbove(uint256 pay, uint256 maxPay)", "error NothingToDo()", "error OffTwap(int24 spot, int24 twap)",
  "function AUCTION_DURATION() view returns (uint256)",
  "function auctionStart(bytes32) view returns (uint64)",
  "function auctionColl(bytes32) view returns (uint256)", "error AuctionStale()",
  "function auctionPrice(address backstop, address collateral) view returns (uint256)",
  "function autoVault(address asset) view returns (address)",
  "function lpTarget(address lpVault) view returns (uint256)",
  "function startAuction(address backstop, address collateral)",
  "function buyCollateral(address backstop, address collateral, uint256 amount, uint256 maxPay) returns (uint256)",
  "function rebalanceVault(address asset) returns (uint256)",
  "function topUpBuffer(address hook) returns (uint256)",
  "function rebalanceLp(address lpVault) returns (uint256)",
];
export const TOKEN_ABI = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function circulating() view returns (uint256)"];

// script/DeployConfig.sol MainnetConfig: where the launch record's `feeds` list holds the sIMD legs. A wrong index cannot buy a wrong
// answer: each leaf's expectedQuestionHash is checked against its payload before anything is paid.
// Price design C: node 13 is the proven pool price (sIMD's spot leg = it x ETH/USD x share rate); there
// is no swarm spot leaf on mainnet any more.
export const FEED_NODE = { imdMedian: 12, imdProven: 13, nhi: 16, imdLive: 17 };

const REQUIRED = ["ledger", "params", "pricer", "liquidator", "imdDepth", "usd", "backstopBlue", "backstopEdge", "pegHook", "seatJoin", "seatFeed", "allocator", "backstopOracle"];

export const ilkName = (b) => {
  try {
    return utils.parseBytes32String(b);
  } catch {
    return b;
  }
};

export function loadRecord(path, chainId) {
  const r = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (Number(r.chainId) !== Number(chainId)) throw new Error(`record is for chain ${r.chainId}, this keeper runs on ${chainId}`);
  if (Number(r.lastStage) < 4) throw new Error(`record stops at stage ${r.lastStage}: the beta is not fully launched`);
  for (const k of REQUIRED) if (!r[k] || r[k] === constants.AddressZero) throw new Error(`record has no ${k}`);
  if (!r.depthSamplers?.length) throw new Error("record lists no depth samplers");
  return r;
}

/** Contracts + the types, read from the chain. */
export async function makeBook(record, provider) {
  if ((await provider.getCode(record.ledger)) === "0x") throw new Error(`no code at the record's Ledger ${record.ledger}`);
  const c = (a, abi) => new Contract(a, abi, provider);
  const params = c(record.params, PARAMS_ABI);
  const pricer = c(record.pricer, PRICER_ABI);
  const n = (await params.ilkCount()).toNumber();
  const ilks = [];
  for (let i = 0; i < n; i++) {
    const id = await params.ilks(i);
    const config = await params.config(id);
    ilks.push({ id, name: ilkName(id), config, edge: await params.edgeIlk(id) });
  }
  const samplers = record.depthSamplers.map((a) => c(a, SAMPLER_ABI));
  return {
    record,
    ledger: c(record.ledger, LEDGER_ABI),
    params,
    pricer,
    liquidator: c(record.liquidator, LIQUIDATOR_ABI),
    imdDepth: c(record.imdDepth, IMD_DEPTH_ABI),
    samplers,
    proven: await provenReferences(samplers, c),
    blue: c(record.backstopBlue, BACKSTOP_ABI),
    edge: c(record.backstopEdge, BACKSTOP_ABI),
    usd: c(record.usd, TOKEN_ABI),
    seatJoin: c(record.seatJoin, SEAT_JOIN_ABI),
    seatFeed: c(record.seatFeed, SEAT_FEED_ABI),
    pegHook: c(record.pegHook, PEG_HOOK_ABI),
    allocator: c(record.allocator, ALLOCATOR_ABI),
    pegLPVault: record.pegLPVault ? c(record.pegLPVault, TOKEN_ABI) : null,
    backstopOracle: c(record.backstopOracle, BACKSTOP_ORACLE_ABI),
    ilks,
    feed: (a) => c(a, FEED_ABI),
    leaf: (a) => c(a, LEAF_ABI),
    live: (a) => c(a, LIVE_POOL_ABI),
    token: (a) => c(a, TOKEN_ABI),
    sleeve: (a) => c(a, BACKSTOP_ABI),
  };
}

/** The ProvenPoolPrice feeds the samplers' references read (sampler.feed1() = ProductFeed(proven, ETH/USD)), each once. A sampler
 *  whose reference is not proven (an older deploy) adds nothing: the depth round then samples as before. */
async function provenReferences(samplers, c) {
  const seen = new Map();
  for (const s of samplers) {
    try {
      const product = c(await s.feed1(), PRODUCT_ABI);
      const leg = c(await product.a(), PROVEN_ABI);
      await leg.provenBlock(); // reverts unless it is a ProvenPoolPrice
      if (!seen.has(leg.address)) seen.set(leg.address, { feed: leg, manager: await leg.manager(), poolId: await leg.poolId(), baseIsToken0: await leg.baseIsToken0() });
    } catch {
      /* not a proven reference */
    }
  }
  return [...seen.values()];
}

export const describeBook = (b) => [
  `ledger ${b.ledger.address}`,
  `types ${b.ilks.map((t) => t.name).join(", ")}`,
  `depth ${b.imdDepth.address}, ${b.samplers.length} samplers, ${b.proven.length} proven reference(s)`,
].join("\n");
