// A fake Robinhood Chain (4663) for the duty tests: a book of plain objects with the methods the duties call, a fake provider for the
// position index, and an act hook that records every action. NOTHING here touches a chain; it models only what the duties read.
import { BigNumber, utils } from "ethers";
import { makeAlerts } from "../../lib/alerts.mjs";

const E18 = BigNumber.from(10).pow(18);
const OPENED = new utils.Interface(["event Opened(uint256 indexed id, bytes32 indexed ilk, address indexed owner, uint256 salt)"]);
export const LEDGER = "0x00000000000000000000000000000000000000Ed";
const addr = (n) => utils.getAddress(utils.hexZeroPad(utils.hexlify(n), 20));

/** A seeded PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * w.positions: id -> { ilk, collateral, debt, healthy, priced }; w.types: ilk -> { name, priced, auction, stock }; w.now; w.grace;
 * w.auctions: id -> { startAt, lastTick, ran, marker }; w.marks: id -> markedAt.
 */
export function makeWorld({ now = 1_800_000_000, types = [], positions = [] } = {}) {
  const w = { now, grace: false, lastPulse: now, types: new Map(), positions: new Map(), auctions: new Map(), marks: new Map(), acts: [], logs: [], clocks: new Map() };
  for (const t of types) w.types.set(t.id, { priced: true, ...t });
  for (const p of positions) w.positions.set(String(p.id), { healthy: false, debt: E18.mul(100), collateral: E18, ...p });
  const auctionTime = 3600;
  const quote = (ilk) => ({ priced: w.types.get(ilk).priced, lull: BigNumber.from(0), low: E18, mat: E18.mul(15).div(10), agree: true });
  const book = {
    chainId: 4663,
    record: { deployBlock: 1 },
    pulse: { address: addr(0x50), inGrace: async () => w.grace, lastPulse: async () => w.lastPulse, gap: async () => 900, graceUntil: async () => (w.grace ? w.now + 3600 : 0), poke: async () => {} },
    pricer: { quote: async (ilk) => quote(ilk) },
    ledger: {
      address: LEDGER,
      ilkDebt: async (ilk) => [...w.positions.values()].filter((p) => p.ilk === ilk).reduce((a, p) => a.add(p.debt), BigNumber.from(0)),
      ilkState: async (ilk) => ({ collateral: [...w.positions.values()].filter((p) => p.ilk === ilk).reduce((a, p) => a.add(p.collateral), BigNumber.from(0)), debt: BigNumber.from(0), badDebt: BigNumber.from(0) }),
      position: async (id) => ({ collateral: w.positions.get(String(id)).collateral }),
      healthy: async (id) => {
        const p = w.positions.get(String(id));
        return { ok: p.healthy, priced: w.types.get(p.ilk).priced };
      },
      debtOf: async (id) => w.positions.get(String(id)).debt,
      worthlessSince: async (ilk) => w.types.get(ilk).worthlessSince ?? 0,
    },
    liquidator: {
      address: addr(0x11),
      clocks: async (ilk) => ({ unpricedSince: w.clocks.get(ilk) ?? 0 }),
      marks: async (id) => ({ markedAt: w.marks.get(String(id)) ?? 0 }),
      graces: async () => ({ end: 0 }),
      markExpiresAt: async (id) => BigNumber.from((w.marks.get(String(id)) ?? 0) + 86_400),
      callStatic: { "liquidate(uint256,uint256)": async () => ({ seized: E18 }), "bite(uint256,uint256)": async () => ({ seized: E18 }) },
    },
    ilks: [],
    stocks: [],
  };
  for (const t of w.types.values()) {
    const entry = { id: t.id, name: t.name, config: { auction: Boolean(t.auction) }, edge: false };
    if (t.stock) {
      entry.stock = {
        auctionTime,
        join: {
          address: addr(0x60 + book.stocks.length),
          auctions: async (id) => w.auctions.get(String(id)) ?? { startAt: 0, lastTick: 0, ran: 0 },
          auctionTime: async () => BigNumber.from(auctionTime),
        },
        vault: { convertToAssets: async () => (t.worthless ? BigNumber.from(0) : E18) },
        token: { uiMultiplier: async () => BigNumber.from(t.mult ?? E18), newUIMultiplier: async () => BigNumber.from(t.nextMult ?? t.mult ?? E18) },
        market: { address: addr(0x70 + book.stocks.length), seenMultiplier: async () => BigNumber.from(t.seen ?? E18), frozen: async () => Boolean(t.frozen) },
      };
      book.stocks.push(entry);
    }
    book.ilks.push(entry);
  }
  const provider = {
    getBlockNumber: async () => 1000,
    getBlock: async () => ({ number: 1000, timestamp: w.now }),
    getLogs: async () => [...w.positions.entries()].map(([id, p]) => ({
      ...OPENED.encodeEventLog(OPENED.getEvent("Opened"), [id, p.ilk, addr(0x99), 0]), blockNumber: 10, transactionHash: utils.hexZeroPad("0x1", 32), logIndex: 0,
    })),
  };
  const ctx = {
    cfg: { RISK: { minDebt: 15 }, LOGS: { lag: 0 }, STOCKS: { tickAfterSeconds: 240 } },
    execute: false, provider, book, keeperAddress: addr(0xbeef), log: (s) => w.logs.push(s), alerts: makeAlerts(() => {}),
    actHook: async (label, contract, fn, args) => {
      w.acts.push({ label, to: contract.address, fn, args: args.map(String), at: w.now });
      return { hash: utils.hexZeroPad(utils.hexlify(w.acts.length), 32), block: 1, gas: "1" };
    },
  };
  return { w, book, provider, ctx };
}
