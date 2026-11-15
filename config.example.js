// Copy to config.js (gitignored). NO PRIVATE KEYS HERE: --execute takes KEEPER_MNEMONIC from the environment.
export default {
  CHAIN_ID: 1,
  // Every state read goes to ALL of these at one block and must agree (lib/chain.mjs). Env: READ_RPC_URLS.
  READ_RPC_URLS: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
  READ_MAX_SPREAD_BLOCKS: 20, // nodes further apart than this: no reads (a stuck node would pin every read to its old block)
  READ_MAX_LAG_SECONDS: 180, // the common latest block older than this: critical rpc-stale
  LOOP_FAIL_ALERT: 5, // a loop failing this many passes in a row: critical loop-failing-<loop>
  // Where signed transactions go, in order: PRIVATE RPCs only (MEV Blocker, ...). --execute refuses to start without one. Env: SEND_RPC_URLS.
  SEND_RPC_URLS: [],
  DEPLOYMENT: "./deployment.json", // the launch record (beta.json). Env: DEPLOYMENT.
  KEEPER_ADDRESS: null, // report-only mode simulates from this

  INTERVALS: { feedsSeconds: 60, seatsSeconds: 300, positionsSeconds: 60, depthSeconds: 60, pegSeconds: 300, backstopSeconds: 300, allocatorSeconds: 300, guardianSeconds: 60, watchSeconds: 300 },
  // minDebt: dust (imdUSD) never acted on and never bought for. marginBps: price + spot are bought only while a loan would be under mat + this at the pool price (refresh rule 1).
  RISK: { minDebt: 15, marginBps: 1000 },

  // The control plane. Servers come from ENS (identitymd.eth, imd.servers) first, then these. Paying needs PLANE_BEARER in the environment: a random secret we make; the plane scopes orders to it.
  API_BASE: "https://api.imd.fun",
  API_FALLBACKS: [],
  // holdAfterBlocked: no answer is bought while the newest N settled requests were all blocked. payTo: the plane's own address (the Intake
  // treasury, every recorded challenge so far); a challenge naming any other is refused unpaid.
  PLANE: { holdAfterBlocked: 3, timeoutMs: 8000, payTo: "0x4e0fa57bde726079356537e2f34d671e9f41adbc" },

  // The keeper's own IMD (refresh rule 4). dailyCap covers NHI 0.5 + both seat legs 1 + three price + spot pairs 3 + 0.5 spare. Counted at the latch, one UTC day.
  IMD: {
    pricePerQuestion: 0.5, // the plane's price: a challenge above this is refused, nothing paid
    dailyCap: 5,
    reserveForFalls: 1, // seat legs and NHI never eat the last pair's worth of the cap
    warnBalance: 5,
    permit2Allowance: 30, // the one approval, never unlimited
    unpaidOrderMaxSeconds: 600, // an order still unpaid after this is dropped: its decision and guards are stale
    admissionTimeoutSeconds: 3600, // a paid order with no admission after this holds ALL buying until --clear-lost
    answerTimeoutSeconds: 3 * 3600,
  },
  FEEDS: {
    fallTriggerBps: 500, // a fall = the pool this far under what loans are measured at: v1's trigger, a quarter of the 20% cap
    minSecondsBetweenFalls: 1800, // v1's MIN_SECONDS_BETWEEN_REQUESTS
    minSecondsBetweenNhi: 1800, // a failed NHI retries, but cannot spend the day's cap in a run of failures
    nhiRefreshAfterSeconds: 22 * 3600, // life 24 h; 2 h for one retry
  },
  SEATS: { refreshAfterSeconds: 22 * 3600 }, // life 26 h: 4 h for a retry
  // Claims swept from sweepMinUsd a side, at once for USDC while the bid needs it. A simulated trade under minTradeUsd is left out.
  PEG: { sweepMinUsd: 25, minTradeUsd: 1 },
  BACKSTOP: { minRoomBps: 500, roomDropBps: 3000 },
  // sales: [{ sleeve: "blue" | "edge", token, route, maxUsd }] once the Safe has set the routes, buckets and feeds up; empty = the sleeves hold what they bought. fundBuffer: USDC at the Allocator pays the peg buffer.
  ALLOCATOR: { sales: [], minSaleUsd: 25, fundBuffer: false },
  // lib/guardian.mjs: alerts only (critical "the Safe should freeze the Allocator"); it holds no key and sends nothing.
  GUARDIAN: {
    knownKeepers: [], // Allocator keepers besides this keeper's own address
    unbackedConfirmSeconds: 120,
    quoteDepegConfirmSeconds: 900,
    simdOffPoolBps: 3000,
    simdOffPoolConfirmSeconds: 900,
  },
  LIQUIDATE: { toleranceBps: 50 }, // minSeized = the simulated seizure less this
  LOGS: { chunk: 9_000, lag: 3, indexTtlSeconds: 30 },

  // lib/tx.mjs guard rails
  MAX_GAS_GWEI: 100, // liquidations, ticks
  ROUTINE_MAX_GAS_GWEI: 15, // depth: late is fine, an hour's bucket just stays empty
  SEND_WAIT_SECONDS: 90, // how long one send may hold the single queue before its intent is left open
  URGENT_WAIT_SECONDS: 60, // urgent work waits this long on an open send, then raises its fees and goes out on the next nonce
  MIN_ETH: 0.003,
  ROUTINE_MIN_ETH: 0.02,
  WARN_ETH: 0.05,
  GAS_MARGIN_BPS: 2500,
  FEES: { urgent: { tipGwei: 0.3 }, routine: { tipGwei: 0.05 } },
};
