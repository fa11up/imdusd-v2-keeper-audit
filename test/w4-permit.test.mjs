// PROPERTY (audit wave 4, P2 low): a payment the keeper signs is takeable for at most MAX_PERMIT_SECONDS (900 s) after it is signed,
// whatever the plane's challenge asks; a challenge asking longer (or nonsense) is refused unpaid. Seeded fuzz over maxTimeoutSeconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { IMD, challengeProblem, signPayment } from "../lib/x402.mjs";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PAY_TO = "0x4e0fa57bde726079356537e2f34d671e9f41adbc";
const BOUND = 900;
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const challenge = (t) => ({
  resource: {}, resourceUrl: "", requesterScopeHash: "ab".repeat(32),
  accepts: [{ scheme: "exact", network: "eip155:1", amount: "500000000000000000", asset: IMD, payTo: PAY_TO, ...(t === undefined ? {} : { maxTimeoutSeconds: t }) }],
  quote: { id: "q", quoteHash: "cd".repeat(32), action: "oracle.request", expiresAt: 1, payment: { network: "eip155:1", asset: IMD, amount: "500000000000000000", payTo: PAY_TO } },
});
const deadlineOf = (header) => Number(JSON.parse(Buffer.from(header, "base64").toString()).payload.permit2Authorization.deadline);

test("property P2: every signed permit dies within 900 s; a challenge asking longer or nonsense is refused (seeded fuzz, 300 cases)", async () => {
  const r = rng(0x402);
  const w = new Wallet(KEY);
  const pool = [undefined, 0, -1, -86400, 1, 30, 300, 899, 900, 901, 3600, 315_360_000, 1e300, NaN, Infinity, 1.5, "300", "abc", "", null, true, {}];
  for (let i = 0; i < 300; i++) {
    const t = r() < 0.6 ? pool[Math.floor(r() * pool.length)] : Math.floor((r() - 0.2) * 10 ** (1 + Math.floor(r() * 9)));
    const ch = challenge(t);
    const problem = challengeProblem(ch, 1, "500000000000000000", PAY_TO);
    const now = Math.floor(Date.now() / 1000);
    const { paymentHeader, deadline, nonce } = await signPayment(w, ch);
    const dl = deadlineOf(paymentHeader);
    assert.equal(dl, deadline, "the deadline returned is the one signed");
    assert.ok(/^\d+$/.test(nonce));
    assert.ok(dl > now && dl - now <= BOUND + 1, `maxTimeoutSeconds ${String(t)}: permit valid ${dl - now}s`);
    const sane = Number.isSafeInteger(Number(t)) && Number(t) > 0 && Number(t) <= BOUND;
    if (t !== undefined && !sane) assert.ok(problem, `maxTimeoutSeconds ${String(t)} not refused`);
    if (t === undefined || (sane && typeof t !== "object")) assert.equal(problem, null, `maxTimeoutSeconds ${String(t)} refused: ${problem}`);
  }
});
