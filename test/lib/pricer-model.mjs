// A test-only port of the contracts' src/Pricer.sol quote() (wave-5b contracts snapshot: TWIN_STEP), the low leg only: what loans are measured at.
// The keeper never computes this (it reads Pricer.quote() on chain); the tests use it as the oracle the keeper must agree with.
//   priced: median fresh and nonzero (NHI aside). agree: spot fresh + nonzero, within skew of the median, AND both legs converged.
//   agree -> low = min(m, s); else a fresh proven spot -> low = m > s ? max(s, min(m, max(attested, m x (1 - TWIN_STEP)))) : s (the
//   twin rule, audit wave 4, bounded by TWIN_STEP = 20% below the stored median in wave 5; `attested` = the median leaf's last
//   attested target, default m: an unclamped median); else low = m.
export function pricerLow({ m, s, attested = m, skewBps, medianFresh = true, spotFresh = true, mConverged = true, sConverged = true, proven = true }) {
  m = BigInt(m); s = BigInt(s); const a = BigInt(attested);
  if (!medianFresh || m === 0n) return { priced: false, low: 0n, agree: false };
  const spotOk = s !== 0n && spotFresh;
  const gap = m > s ? m - s : s - m;
  let agree = spotOk && gap * 10_000n <= m * BigInt(skewBps);
  if (agree) agree = mConverged && sConverged;
  const max = (x, y) => (x > y ? x : y), min = (x, y) => (x < y ? x : y);
  const TWIN_STEP_BPS = 2_000n; // Pricer.TWIN_STEP 0.2e18
  const floor = m - (m * TWIN_STEP_BPS) / 10_000n;
  const low = agree ? min(m, s) : spotOk && proven ? (m > s ? max(s, min(m, max(a, floor))) : s) : m;
  return { priced: true, low, agree };
}
