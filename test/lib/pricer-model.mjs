// A test-only port of the contracts' src/Pricer.sol quote() (audit snapshot, wave-5 commit), the low leg only: what loans are measured at.
// The keeper never computes this (it reads Pricer.quote() on chain); the tests use it as the oracle the keeper must agree with.
//   priced: median fresh and nonzero (NHI aside). agree: spot fresh + nonzero, within skew of the median, AND both legs converged.
//   agree -> low = min(m, s); else a fresh proven spot -> low = m > s ? max(s, min(m, attested)) : s (the twin rule, audit wave 4;
//   `attested` = the median leaf's last attested target, default m: an unclamped median); else low = m.
export function pricerLow({ m, s, attested = m, skewBps, medianFresh = true, spotFresh = true, mConverged = true, sConverged = true, proven = true }) {
  m = BigInt(m); s = BigInt(s); const a = BigInt(attested);
  if (!medianFresh || m === 0n) return { priced: false, low: 0n, agree: false };
  const spotOk = s !== 0n && spotFresh;
  const gap = m > s ? m - s : s - m;
  let agree = spotOk && gap * 10_000n <= m * BigInt(skewBps);
  if (agree) agree = mConverged && sConverged;
  const max = (x, y) => (x > y ? x : y), min = (x, y) => (x < y ? x : y);
  const low = agree ? min(m, s) : spotOk && proven ? (m > s ? max(s, min(m, a)) : s) : m;
  return { priced: true, low, agree };
}
