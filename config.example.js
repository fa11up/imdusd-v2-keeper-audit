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
  // blockedMaxAgeSeconds: only settled requests this recent count toward the hold; holdCriticalSeconds: a hold this long is critical.
  // maxPermitSeconds: a signed payment stays takeable at most this long (a challenge asking longer is refused). Audit wave 4.
  PLANE: { holdAfterBlocked: 3, blockedMaxAgeSeconds: 6 * 3600, holdCriticalSeconds: 2 * 3600, maxPermitSeconds: 900, timeoutMs: 8000, payTo: "0x4e0fa57bde726079356537e2f34d671e9f41adbc" },

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
  // The bridge watcher + AUTO-CLAIM on mainnet. ON: transfers 4663 -> mainnet above the instant cap are QUEUED on mainnet,
  // and only this keeper can claim them there (the 4663 keeper claims on 4663). Idle until the deployment record names a `bridge`;
  // then it needs peer.bridge (4663's ImdBridge) or the loop fails loudly every pass. With it off and a bridge in the record, the
  // keeper raises critical bridge-watch-off at startup. peer.{ledger, params, usd} add 4663's supply equation.
  BRIDGE_WATCH: { enabled: true, peer: { bridge: null, fromBlock: 0 }, directions: "both", stuckWarnSeconds: 1800, stuckCriticalSeconds: 7200, unverifiedSeconds: 1800, supplyToleranceWei: "1000000000000000000" },
  PEERS: { 4663: { READ_RPC_URLS: ["https://rpc.mainnet.chain.robinhood.com"] } },

  // lib/tx.mjs guard rails
  MAX_GAS_GWEI: 100, // liquidations, ticks
  ROUTINE_MAX_GAS_GWEI: 15, // depth: late is fine, an hour's bucket just stays empty
  SEND_WAIT_SECONDS: 90, // how long one send may hold the single queue before its intent is left open
  MAX_BUMPS: 4, // replacements one nonce may get under MAX_GAS_GWEI; the last is a 0-value cancel to self (audit wave 4)
  URGENT_WAIT_SECONDS: 60, // urgent work waits this long on an open send, then raises its fees and goes out on the next nonce
  MIN_ETH: 0.003,
  ROUTINE_MIN_ETH: 0.02,
  WARN_ETH: 0.05,
  GAS_MARGIN_BPS: 2500,
  FEES: { urgent: { tipGwei: 0.3 }, routine: { tipGwei: 0.05 } },

  // ------------------------------------------------------------------ other chains (lib/chains.mjs). Mainnet ignores everything below.
  // `node keeper.mjs --chain 4663` runs on the top level, then lib/chains.mjs CHAIN_DEFAULTS[4663], then CHAINS[4663] here. Mainnet's RPCs,
  // deployment, key address, sales and guardian list never carry over. Env names on 4663 carry the suffix: READ_RPC_URLS_4663,
  // LOG_RPC_URLS_4663, SEND_RPC_URLS_4663, DEPLOYMENT_4663, KEEPER_MNEMONIC_4663 (its OWN key: the per-key lock refuses the mainnet one).
  // URLs may hold ${NAME} placeholders filled from the environment (a keyed URL never sits here); one whose variable is unset is left out.
  CHAINS: {
    4663: {
      // Two agreeing read RPCs: the public one rate-limits and keeps no archive. Add a paid node here (or READ_RPC_URLS_4663).
      READ_RPC_URLS: ["https://rpc.mainnet.chain.robinhood.com"],
      // Logs (positions index, bridge events) may come from a log-only door: Blockscout's eth-rpc with BLOCKSCOUT_KEY (unset = left out).
      LOG_RPC_URLS: ["https://robinhoodchain.blockscout.com/api/eth-rpc?apikey=${BLOCKSCOUT_KEY}"],
      SEND_RPC_URLS: [], // the sequencer is first come first served; a private send buys nothing against a sandwich, but use a paid node
      DEPLOYMENT: "./deployment-4663.json", // { chainId: 4663, ledger, params, pricer, liquidator, usd, treasury, pegHook, backstopBlue, backstopEdge, backstopOracle, allocator, bridge, deployBlock }
      KEEPER_ADDRESS: null,
      // Reads of mainnet: the IMD legs' pool, the plane's payment (Permit2 + IMD on Ethereum) and the bridge's other end.
      PEERS: { 1: { READ_RPC_URLS: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"] } },
      // The IMD type opens at line 0: buying its answers is OFF until the operator turns it on. Paid from THIS key's IMD on Ethereum; its
      // one Permit2 approval is made by hand (README "4663"): this process never sends a mainnet transaction.
      IMD_FEEDS: { buy: false },
      PULSE: { pokeAfterSeconds: 480 }, // gap 15 min: poke when nobody has for 8 min
      STOCKS: { tickAfterSeconds: 240 }, // StockJoin TICK_SPAN 5 min: tick each live auction every 4 min
      RATES: { minMoveBps: 5, maxAgeHours: 24 },
      // peer.bridge: mainnet's ImdBridge; peer.{ledger, params, usd, pegHook, migrator} add mainnet's supply equation. directions "both"
      // checks mints on both chains from this one process.
      BRIDGE_WATCH: { peer: { bridge: null, fromBlock: 0 }, directions: "both", stuckWarnSeconds: 1800, stuckCriticalSeconds: 7200, unverifiedSeconds: 1800, supplyToleranceWei: "1000000000000000000" },
      ALLOCATOR: { sales: [], minSaleUsd: 25, fundBuffer: false },
      GUARDIAN: { knownKeepers: [], unbackedConfirmSeconds: 120, quoteDepegConfirmSeconds: 900 },
    },
  },
};
