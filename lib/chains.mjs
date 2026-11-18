// Which chain this process keeps, and everything that differs per chain (12-07 launch: Ethereum + Robinhood Chain 4663).
//
// ONE PROCESS PER CHAIN, ONE SHARED CONFIG FILE. `node keeper.mjs --chain 4663` runs the 4663 keeper; with no flag the process is the
// mainnet keeper exactly as before (CHAIN_ID 1, the same state dir, the same loops). Why not one process for both:
//   - the state module, the send journal and the key lock are process-wide (STATE_DIR); two chains in one process would share the
//     orders latch, the day's spend and the nonce journal unless every module took a chain argument, i.e. a rewrite of the audited
//     wave-4 code. One process per chain keeps those guarantees as they are: each chain has its own state dir, lock and journal;
//   - one chain's RPC failing, rate-limiting (the 4663 public RPC) or stalling a send never holds the other chain's liquidations;
//   - one writer per KEY still holds machine-wide (takeKeyLock by address): the two processes must use DIFFERENT keys, and the second
//     one on the same key refuses to start. So nonces, spend caps and the Permit2 allowance of one key are never counted twice.
// A process may READ other chains (`PEERS`): the bridge watcher reads both ends, and the 4663 feeds read the mainnet pool and pay on
// mainnet (the plane's payment is a Permit2 signature on Ethereum; the 4663 process never sends a mainnet transaction).
//
// Config: the top-level keys are the mainnet keeper's (unchanged); `CHAINS[<id>]` overrides them for that chain, over the defaults
// below. Nothing here is a key or a secret.
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Defaults per chain, under the config file's own `CHAINS[<id>]`. Mainnet has none: its config is the file's top level, unchanged.
 *
 * 4663 GAS (read 2026-11-15: base fee 0.0202 gwei, eth_maxPriorityFeePerGas 0). Robinhood Chain is an Arbitrum Orbit chain: the
 * sequencer orders first come first served and ignores the priority fee, the base fee floats a little above its floor and rises only
 * under congestion. The tier ceilings are set to ~50x (urgent) and ~5x (routine) of the observed base fee, the same STRATEGY as mainnet
 * (a high ceiling for liquidations, pulse, ticks and relays; a low one for housekeeping), only scaled to this market. tx.mjs is
 * unchanged: a new send still offers at most ceiling / 1.125, bumps are still bounded at MAX_BUMPS. The tip is a token 0.001 gwei so
 * a replacement can still raise it by 12.5% (a 0 tip cannot be raised); Arbitrum does not charge it.
 * ETH floors are scaled the same way: a poke costs ~2e-6 ETH at the base fee; a bite with a cover needs a > 2M gas limit (COVER_MIN_GAS),
 * i.e. at most 2.5M x 1 gwei = 0.0025 ETH of headroom at the ceiling.
 */
export const CHAIN_DEFAULTS = {
  4663: {
    NAME: "robinhood",
    STATE_DIR: fileURLToPath(new URL("../state-4663/", import.meta.url)),
    ALERT_PREFIX: "imdUSD v2 keeper [4663]",
    MNEMONIC_ENV: "KEEPER_MNEMONIC_4663",
    // block.number inside the EVM on an Arbitrum chain is the L1 (Ethereum) block: the swarm leaves' windows are checked against it.
    L1_BLOCK_NUMBER: true,
    READ_RPC_URLS: ["https://rpc.mainnet.chain.robinhood.com"],
    READ_MAX_SPREAD_BLOCKS: 240, // ~4 blocks/s: 240 blocks is about a minute
    READ_MAX_LAG_SECONDS: 120,
    MAX_GAS_GWEI: 1,
    ROUTINE_MAX_GAS_GWEI: 0.1,
    FEES: { urgent: { tipGwei: 0.001 }, routine: { tipGwei: 0.001 } },
    MIN_ETH: 0.003,
    ROUTINE_MIN_ETH: 0.004,
    WARN_ETH: 0.01,
    SEND_WAIT_SECONDS: 60,
    URGENT_WAIT_SECONDS: 30,
    LOGS: { chunk: 50_000, lag: 20, indexTtlSeconds: 30 },
    INTERVALS: { pulseSeconds: 60, positionsSeconds: 60, stocksSeconds: 60, ratesSeconds: 900, imdFeedsSeconds: 120, pegSeconds: 300, backstopSeconds: 300, allocatorSeconds: 300, guardianSeconds: 60, bridgeSeconds: 120, watchSeconds: 300 },
    PEG: { sweepMinUsd: 25, minTradeUsd: 1, quoteName: "USDG" },
  },
};

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
/** Deep merge of plain objects (arrays and values replace). */
export function merge(base, over) {
  if (!isObj(over)) return over === undefined ? base : over;
  const out = { ...(isObj(base) ? base : {}) };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
  return out;
}

/** The config this process runs on: the file's top level for mainnet (byte for byte what it was), else the file's top level, then this
 *  chain's defaults, then the file's CHAINS[id]. CHAINS itself is dropped from the result. Chain-specific keys of the mainnet keeper
 *  that must never leak to another chain (its RPCs, deployment, key address, sales) are cleared first. */
export function chainConfig(file, chainId) {
  const id = Number(chainId ?? file.CHAIN_ID ?? 1);
  const { CHAINS, ...top } = file;
  if (id === Number(file.CHAIN_ID ?? 1)) return { ...top, CHAIN_ID: id };
  const neutral = { ...top };
  for (const k of ["READ_RPC_URLS", "LOG_RPC_URLS", "SEND_RPC_URLS", "DEPLOYMENT", "KEEPER_ADDRESS", "LEDGER_FROM_BLOCK", "ALLOCATOR", "GUARDIAN", "STATE_DIR", "PEERS", "BRIDGE_WATCH", "ALERT_PREFIX", "MNEMONIC_ENV"]) delete neutral[k];
  return { ...merge(merge(neutral, CHAIN_DEFAULTS[id] ?? {}), CHAINS?.[id] ?? {}), CHAIN_ID: id };
}

/** `--chain N` from argv, else null (the config's CHAIN_ID). */
export function chainArg(argv = process.argv) {
  const i = argv.indexOf("--chain");
  if (i < 0) return null;
  const n = Number(argv[i + 1]);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`--chain needs a chain id, got ${argv[i + 1]}`);
  return n;
}

/** A process for another chain than mainnet runs on its own state dir, never mainnet's (an env STATE_DIR still wins: tests, forks). */
export function applyStateDir(cfg, env = process.env) {
  if (env.STATE_DIR) return env.STATE_DIR;
  if (cfg.STATE_DIR) env.STATE_DIR = cfg.STATE_DIR;
  return env.STATE_DIR ?? null;
}

/**
 * RPC URLs with `${NAME}` placeholders filled from the environment, so a keyed URL (BLOCKSCOUT_KEY, an Alchemy key) never sits in
 * the config file. A URL whose placeholder is unset is DROPPED (it would only fail), and the caller is told which.
 */
export function expandUrls(urls, env = process.env) {
  const out = [];
  const missing = [];
  for (const u of urls ?? []) {
    let bad = null;
    const v = String(u).replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => (env[n] ? env[n] : ((bad = n), "")));
    if (bad) missing.push(bad);
    else out.push(v.trim());
  }
  return { urls: out.filter(Boolean), missing };
}

/** Robinhood Chain's Blockscout serves an eth-RPC door (`/api/eth-rpc`); without a key Cloudflare answers a browser challenge (read
 *  2026-11-15), so it is usable only with BLOCKSCOUT_KEY set. Put this in LOG_RPC_URLS once the key exists. NOT exercised. */
export const BLOCKSCOUT_4663 = "https://robinhoodchain.blockscout.com/api/eth-rpc?apikey=${BLOCKSCOUT_KEY}";

/**
 * The block number the EVM sees on this chain. On Arbitrum chains `block.number` inside a contract is the L1 block, and the RPC
 * returns it as `l1BlockNumber` on the block (ethers v5's formatter drops it, so the raw block is read). Mainnet: the block number.
 */
export async function evmBlockNumber(provider, cfg) {
  if (!cfg?.L1_BLOCK_NUMBER) return (await provider.getBlock("latest")).number;
  const raw = await provider.send("eth_getBlockByNumber", ["latest", false]);
  const n = Number(raw?.l1BlockNumber);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("the 4663 RPC returned no l1BlockNumber: the swarm leaves' windows cannot be checked");
  return n;
}

export const isMainnet = (cfg) => Number(cfg.CHAIN_ID ?? 1) === 1;
export const repoPath = (p) => join(fileURLToPath(new URL("../", import.meta.url)), p);
