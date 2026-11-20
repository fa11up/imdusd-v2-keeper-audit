// Paying the plane's HTTP door from a script key, the flow black-box/sender/x402.mjs runs in production (ported from viem to ethers v5;
// test/x402-vector.json pins the signatures to what that code produces for the same inputs):
//   POST /requests/quote {requestKey, action, input}  -> order id
//   POST /requests/<id>/submit {}                      -> 402 challenge (accepts, quote, resource, requesterScopeHash)
//   sign Permit2 PermitWitnessTransferFrom + QuoteApproval
//   POST /requests/<id>/submit {quoteSignature} with PAYMENT-SIGNATURE: base64(payment)
// The plane settles the Permit2 transfer itself: the keeper sends no transaction per request, only the one Permit2 approval.
import crypto from "node:crypto";
import { BigNumber, utils } from "ethers";

export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const X402_SPENDER = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001"; // the plane's x402 escrow, not payTo
export const IMD = "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7";

/** Sorted keys, no whitespace: how the plane canonicalises (RFC 8785 subset). */
export function canon(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
}

export function planeClient(base, bearer, { fetchImpl = fetch } = {}) {
  async function call(method, path, body, headers = {}) {
    const r = await fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "user-agent": "imdusd-v2-keeper", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json };
  }
  return {
    quote: (requestKey, action, input) => call("POST", "/requests/quote", { requestKey, action, input }),
    challenge: (orderId) => call("POST", `/requests/${orderId}/submit`, {}),
    submit: (orderId, quoteSignature, paymentHeader) => call("POST", `/requests/${orderId}/submit`, { quoteSignature }, { "PAYMENT-SIGNATURE": paymentHeader }),
    order: (orderId) => call("GET", `/requests/${orderId}`),
    oracleRequest: (id) => call("GET", `/oracle/requests/${id}?members=0`),
    attestation: (id) => call("GET", `/oracle/requests/${id}/attestation`),
  };
}

const lc = (a) => String(a ?? "").toLowerCase();

/** The longest a signed payment may stay takeable (audit wave 4, P2): the plane settles within seconds, so 15 minutes is plenty. */
export const MAX_PERMIT_SECONDS = 900;
/** The plane's maxTimeoutSeconds as a positive whole number of seconds, or null. */
const timeoutOf = (accept) => {
  const t = Number(accept?.maxTimeoutSeconds);
  return Number.isSafeInteger(t) && t > 0 ? t : null;
};

/** The one amount the check, the spend record and the signature all use. */
export const challengeAmount = (challenge) => BigNumber.from(challenge.quote.payment.amount);

/**
 * What the challenge asks for, checked against what this order may cost and against the plane's own address, pinned in config
 * (`PLANE.payTo`): whoever answers as the plane must not choose who is paid. Returns the reason to refuse, or null.
 */
export function challengeProblem(challenge, questions, maxPerQuestionWei, payTo, maxPermitSecondsAsked = MAX_PERMIT_SECONDS) {
  // The bound is the keeper's, whatever the config says (wave-5 audit #23): never more than MAX_PERMIT_SECONDS.
  const maxPermitSeconds = Math.min(Number(maxPermitSecondsAsked ?? MAX_PERMIT_SECONDS), MAX_PERMIT_SECONDS);
  const accept = challenge?.accepts?.[0];
  const qp = challenge?.quote?.payment;
  if (!accept || !qp) return "the challenge has no payment terms";
  if (lc(qp.asset) !== IMD || lc(accept.asset ?? qp.asset) !== IMD) return `the plane asks for ${qp.asset}, not IMD`;
  if ((qp.network ?? "eip155:1") !== "eip155:1" || (accept.network ?? "eip155:1") !== "eip155:1") return `the plane asks for payment on ${qp.network ?? accept.network}, not Ethereum`;
  if (!lc(payTo)) return "no pinned payTo (PLANE.payTo): the keeper does not pay an address it was not told";
  if (lc(qp.payTo) !== lc(payTo) || lc(accept.payTo ?? qp.payTo) !== lc(payTo)) return `the plane asks to pay ${accept.payTo ?? qp.payTo}, not the pinned ${payTo}`;
  // The deadline of the permit is the plane's to ask, the keeper's to bound: a long one stays takeable after the order is over.
  if (accept.maxTimeoutSeconds !== undefined && (timeoutOf(accept) === null || timeoutOf(accept) > maxPermitSeconds)) return `the plane asks the payment to stay valid ${accept.maxTimeoutSeconds}s, over the keeper's ${maxPermitSeconds}s`;
  if (accept.amount !== undefined && String(accept.amount) !== String(qp.amount)) return `the challenge's amounts disagree (${accept.amount} vs ${qp.amount})`;
  let amount;
  try {
    amount = challengeAmount(challenge);
  } catch {
    return `the amount ${qp.amount} is not a number`;
  }
  if (amount.isZero()) return "the plane asks for nothing: refused, a zero would pass every cap";
  if (amount.gt(BigNumber.from(maxPerQuestionWei).mul(questions))) return `the plane asks ${utils.formatEther(amount)} IMD for ${questions} question(s), over the limit`;
  // A payment short of every question is refused AND spent (oracle.group: `short_payment`): never sign one.
  if (questions > 1 && !amount.mod(questions).isZero()) return `${utils.formatEther(amount)} IMD does not divide over ${questions} questions`;
  return null;
}

/**
 * Build and sign the payment for a 402 challenge with an ethers v5 wallet. Returns { paymentHeader, quoteSignature, amount, nonce,
 * deadline }: the Permit2 nonce and deadline are what the chain can later be asked about (was it taken, can it still be).
 * The deadline is never more than MAX_PERMIT_SECONDS away, whatever the challenge asks.
 */
export async function signPayment(wallet, challenge, { nonce, deadline, maxPermitSeconds: asked = MAX_PERMIT_SECONDS } = {}) {
  const maxPermitSeconds = Math.min(Number(asked ?? MAX_PERMIT_SECONDS), MAX_PERMIT_SECONDS); // wave-5 audit #23
  const accept = challenge.accepts[0];
  const q = challenge.quote, qp = q.payment;
  const payTo = qp.payTo; // challengeProblem has held accept.payTo and qp.payTo to the pinned address
  const amount = challengeAmount(challenge);
  const chainId = Number(String(qp.network || "eip155:1").replace("eip155:", ""));
  const n = nonce ?? BigNumber.from(`0x${crypto.randomBytes(32).toString("hex")}`).toString();
  const dl = deadline ?? Math.floor(Date.now() / 1000) + Math.min(timeoutOf(accept) ?? 300, maxPermitSeconds);

  const p2sig = await wallet._signTypedData(
    { name: "Permit2", chainId, verifyingContract: PERMIT2 },
    {
      PermitWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions" }, { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "witness", type: "Witness" },
      ],
      TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
      Witness: [{ name: "to", type: "address" }, { name: "validAfter", type: "uint256" }],
    },
    { permitted: { token: IMD, amount }, spender: X402_SPENDER, nonce: n, deadline: dl, witness: { to: payTo, validAfter: 0 } },
  );
  const payment = {
    x402Version: 2,
    payload: {
      signature: p2sig,
      permit2Authorization: {
        from: wallet.address, permitted: { token: IMD, amount: amount.toString() }, spender: X402_SPENDER,
        nonce: String(n), deadline: String(dl), witness: { to: payTo, validAfter: "0" },
      },
    },
    resource: challenge.resource,
    accepted: accept,
  };
  const paymentHash = `0x${crypto.createHash("sha256").update(canon(payment)).digest("hex")}`;
  const quoteSignature = await wallet._signTypedData(
    { name: "IdentityMD Paid Action", version: "1", chainId },
    {
      QuoteApproval: [
        { name: "resource", type: "string" }, { name: "requesterScopeHash", type: "bytes32" }, { name: "quoteId", type: "string" },
        { name: "quoteHash", type: "bytes32" }, { name: "paymentHash", type: "bytes32" }, { name: "action", type: "string" },
        { name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "payTo", type: "address" },
        { name: "expiresAt", type: "uint256" },
      ],
    },
    {
      resource: challenge.resourceUrl || "",
      requesterScopeHash: `0x${String(challenge.requesterScopeHash || "").replace(/^0x/, "")}`,
      quoteId: String(q.id),
      quoteHash: `0x${String(q.quoteHash || "").replace(/^0x/, "")}`,
      paymentHash,
      action: String(q.action),
      asset: qp.asset,
      amount: BigNumber.from(qp.amount),
      payTo: qp.payTo,
      expiresAt: BigNumber.from(q.expiresAt),
    },
  );
  return { paymentHeader: Buffer.from(JSON.stringify(payment)).toString("base64"), quoteSignature, amount, nonce: String(n), deadline: Number(dl) };
}
