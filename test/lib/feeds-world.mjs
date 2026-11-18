// A fake chain for runFeeds (tests only): sIMD with its legs, every read able to fail on demand. `w.truth` is what the chain says;
// `w.fail` names the reads that throw this pass. Nothing here sends: execute is off unless a test turns it on.
import { BigNumber } from "ethers";

const E18 = BigNumber.from(10).pow(18);
const ILK = `0x${"5".repeat(64)}`;

export function feedsWorld() {
  const w = {
    truth: { medianConverged: true, nhiConverged: true, spotAge: 60, spotStale: false, debt: BigNumber.from(0), nhiAge: 3600 },
    fail: new Set(),
    swarm: { health: { agentsOnline: 5, seatsEnrolled: 10, verifierUp: true, publisherUp: true, deployerUp: true }, counts: { jobStates: { completed: 3 } } },
    now: 1_800_000_000,
  };
  const maybe = (name, v) => async () => {
    if (w.fail.has(name)) throw new Error(`${name}: read RPCs disagree`);
    return typeof v === "function" ? v() : v;
  };
  const median = {
    address: "0x00000000000000000000000000000000000000a1",
    converged: maybe("median.converged", () => w.truth.medianConverged), attested: maybe("median.attested", () => E18),
    latestValue: maybe("median.latestValue", () => ({ value: E18, updatedAt: BigNumber.from(w.now - 60) })), followOf: async (x) => x,
  };
  const nhi = {
    address: "0x00000000000000000000000000000000000000a2",
    converged: maybe("nhi.converged", () => w.truth.nhiConverged), attested: maybe("nhi.attested", () => E18),
    latestValue: maybe("nhi.latestValue", () => ({ value: E18.mul(9).div(10), updatedAt: BigNumber.from(w.now - w.truth.nhiAge) })),
    accepts: async (v) => { if (BigInt(v) < 0n) throw new Error("value out-of-bounds"); return true; },
  };
  const spot = {
    address: "0x00000000000000000000000000000000000000a3",
    latestValue: maybe("spot.latestValue", () => [E18, BigNumber.from(w.now - w.truth.spotAge)]),
    isStale: maybe("spot.isStale", () => w.truth.spotStale), maxAge: maybe("spot.maxAge", () => BigNumber.from(6 * 3600)),
  };
  const usd = { latestValue: async () => [E18.mul(4)] };
  const pool = { latestValue: async () => [E18] };
  const book = {
    ilks: [{ name: "SIMD", id: ILK, config: { nhi: nhi.address, liveSpot: "usd" } }],
    record: { feeds: { 12: median.address, 13: spot.address, 17: "pool" } },
    leaf: (a) => (a === median.address ? median : nhi), feed: (a) => (a === spot.address ? spot : usd), live: () => pool,
    ledger: { ilkDebt: async () => w.truth.debt, position: async () => ({ collateral: E18 }), debtOf: async () => E18 },
    pricer: { quote: maybe("pricer.quote", () => ({ priced: true, agree: true, low: E18.mul(4), mat: E18.mul(17).div(10) })) },
    token: () => ({ balanceOf: async () => E18.mul(50) }),
  };
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith("/health")) return { ok: true, json: async () => ({ status: "ok" }) };
    if (u.includes("/oracle/requests")) return { ok: true, json: async () => ({ requests: [] }) };
    if (u.endsWith("/swarm")) {
      if (w.fail.has("swarm")) throw new Error("plane down");
      return { ok: true, json: async () => w.swarm };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  w.ctx = (alerts, log = () => {}) => ({
    execute: false, cfg: { API_BASE: "https://plane.invalid", PLANE: { useEns: false, holdAfterBlocked: 0 } }, book, log, alerts, fetchImpl,
    provider: { getBlock: async () => ({ number: 100, timestamp: w.now }), unpin() {} },
    index: { [ILK]: [] }, indexAt: Date.now(),
  });
  return w;
}
