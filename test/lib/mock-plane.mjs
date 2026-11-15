// A local stand-in for the plane's paid door and oracle reads: the routes lib/x402.mjs and lib/orders.mjs use, in the shapes of plane master
// (apps/control-plane/src/http/routes/{paid-requests,oracle}.ts). It checks the payment signatures against the payer, resolves a request's window from the chain head,
// hashes the question from the body it was sent (so a body that is not the leaf's question fails ON the real leaf), and signs attestations with a local key.
// NOTHING here reaches the real plane. Bearer tokens are whatever the test sets.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { utils, Wallet } from "ethers";
import { IMD, PERMIT2, X402_SPENDER, canon } from "../../lib/x402.mjs";
import { questionHash } from "../../lib/oracle.mjs";

const UNIT = "500000000000000000";
const PAY_TO = "0x4e0fa57bde726079356537e2f34d671e9f41adbc";
const TYPES = {
  OracleAttestation: [
    { name: "requestId", type: "bytes32" }, { name: "chainId", type: "uint256" }, { name: "questionHash", type: "bytes32" }, { name: "answerType", type: "uint8" },
    { name: "answer", type: "bytes" }, { name: "figure", type: "uint256" }, { name: "fromBlock", type: "uint64" }, { name: "toBlock", type: "uint64" },
    { name: "blockHash", type: "bytes32" }, { name: "panelJobId", type: "bytes32" }, { name: "panelSize", type: "uint16" }, { name: "quorum", type: "uint16" },
    { name: "agreed", type: "uint16" }, { name: "issuedAt", type: "uint64" }, { name: "expiresAt", type: "uint64" },
  ],
};

/**
 * answer(input) -> { value, figure? } or null (the panel never answers). chain() -> { number, timestamp, hash }.
 * attesterKey signs. Hold `admit` false to model a plane that takes the money and never admits.
 */
export function makeMockPlane({ answer, chain, attesterKey, swarm = null, price = UNIT }) {
  const attester = new Wallet(attesterKey);
  const state = {
    orders: new Map(), requests: new Map(), payments: [], quotes: 0, challenges: 0, admit: true, attest: true, recent: [],
    bearers: new Set(),
  };
  const respond = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const openRequest = async (order, input) => {
    const head = await chain();
    const blocks = Number(input.window.hours) * 300;
    const window = { fromBlock: head.number - blocks, toBlock: head.number };
    const id = randomUUID();
    const a = answer(input);
    const hash = questionHash(input, window.fromBlock, window.toBlock);
    state.requests.set(id, { id, input, window, a, hash, head, status: a && state.attest ? "attested" : "assessing", signed: null });
    return { requestId: id, jobId: randomUUID(), questionHash: hash, statusUrl: `/oracle/requests/${id}`, attestationUrl: `/oracle/requests/${id}/attestation` };
  };
  const signed = async (r) => {
    const domain = { name: "IdentityMD Oracle", version: "2", chainId: r.input.consumer.chainId, verifyingContract: r.input.consumer.verifyingContract };
    const hex = (id) => `0x${id.replaceAll("-", "").padEnd(64, "0")}`;
    const message = {
      requestId: hex(r.id), chainId: String(r.input.chainId), questionHash: r.hash, answerType: 3, answer: utils.hexZeroPad(utils.hexlify(r.a.value), 32), figure: String(r.a.figure ?? 0),
      fromBlock: String(r.window.fromBlock), toBlock: String(r.window.toBlock), blockHash: r.head.hash, panelJobId: hex(randomUUID()), panelSize: String(r.a.panelSize ?? r.input.panelSize), quorum: String(r.input.quorum),
      agreed: String(r.a.agreed ?? r.input.quorum), issuedAt: String(r.head.timestamp), expiresAt: String(r.head.timestamp + 3600),
    };
    const signature = await attester._signTypedData(domain, TYPES, message);
    return { requestId: r.id, domain, types: TYPES, primaryType: "OracleAttestation", message: { ...message, answerType: "uint256" }, signature, signer: attester.address.toLowerCase(), attestedAt: new Date().toISOString() };
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      let raw = "";
      for await (const c of req) raw += c;
      const body = raw ? JSON.parse(raw) : {};
      const path = url.pathname;
      if (req.method === "GET" && path === "/health") return respond(res, 200, { status: "ok" });
      if (req.method === "GET" && path === "/swarm") return respond(res, swarm ? 200 : 503, swarm ?? {});
      if (req.method === "GET" && path === "/oracle/requests") return respond(res, 200, { count: state.recent.length, requests: state.recent });
      if (!path.startsWith("/oracle/") && !req.headers.authorization?.startsWith("Bearer ")) return respond(res, 401, { error: "request_token_required" });
      if (req.method === "POST" && path === "/requests/quote") {
        state.quotes += 1;
        const count = body.input.questions?.length ?? 1;
        const id = randomUUID();
        state.orders.set(id, { id, action: body.action, input: body.input, count, status: "quoted", admission: null, payer: null });
        return respond(res, 201, { order: { id } });
      }
      let m = /^\/requests\/([^/]+)\/submit$/.exec(path);
      if (req.method === "POST" && m) {
        const o = state.orders.get(m[1]);
        if (!o) return respond(res, 404, { error: "unknown" });
        const amount = (BigInt(price) * BigInt(o.count)).toString();
        const payment = { network: "eip155:1", asset: IMD, amount, payTo: PAY_TO, decimals: 18 };
        o.expiresAt ??= Math.floor(Date.now() / 1000) + 600;
        const challenge = {
          resource: { url: `http://x/requests/${o.id}/submit`, description: o.action }, resourceUrl: `http://x/requests/${o.id}/submit`, requesterScopeHash: "ab".repeat(32),
          accepts: [{ scheme: "exact", network: "eip155:1", amount, asset: IMD, payTo: PAY_TO, maxTimeoutSeconds: 300 }],
          quote: { id: o.id, quoteHash: "cd".repeat(32), action: o.action, expiresAt: o.expiresAt, payment },
        };
        const header = req.headers["payment-signature"];
        if (!header) {
          state.challenges += 1;
          return respond(res, 402, challenge);
        }
        const paid = JSON.parse(Buffer.from(header, "base64").toString());
        const auth = paid.payload.permit2Authorization;
        const recovered = utils.verifyTypedData(
          { name: "Permit2", chainId: 1, verifyingContract: PERMIT2 },
          {
            PermitWitnessTransferFrom: [{ name: "permitted", type: "TokenPermissions" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "witness", type: "Witness" }],
            TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
            Witness: [{ name: "to", type: "address" }, { name: "validAfter", type: "uint256" }],
          },
          { permitted: auth.permitted, spender: X402_SPENDER, nonce: auth.nonce, deadline: auth.deadline, witness: auth.witness },
          paid.payload.signature,
        );
        if (recovered.toLowerCase() !== auth.from.toLowerCase()) return respond(res, 402, { error: "payment_rejected", reason: "signature" });
        const hash = `0x${(await import("node:crypto")).createHash("sha256").update(canon(paid)).digest("hex")}`;
        const approved = utils.verifyTypedData(
          { name: "IdentityMD Paid Action", version: "1", chainId: 1 },
          { QuoteApproval: [{ name: "resource", type: "string" }, { name: "requesterScopeHash", type: "bytes32" }, { name: "quoteId", type: "string" }, { name: "quoteHash", type: "bytes32" }, { name: "paymentHash", type: "bytes32" }, { name: "action", type: "string" }, { name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "payTo", type: "address" }, { name: "expiresAt", type: "uint256" }] },
          { resource: challenge.resourceUrl, requesterScopeHash: `0x${challenge.requesterScopeHash}`, quoteId: o.id, quoteHash: `0x${challenge.quote.quoteHash}`, paymentHash: hash, action: o.action, asset: IMD, amount, payTo: PAY_TO, expiresAt: challenge.quote.expiresAt },
          body.quoteSignature,
        );
        if (approved.toLowerCase() !== auth.from.toLowerCase()) return respond(res, 402, { error: "payment_rejected", reason: "quote approval" });
        state.payments.push({ order: o.id, from: auth.from, amount, count: o.count });
        o.status = "paid";
        if (state.refuseAfterPayment) {
          o.admission = { result: { kind: "refused", problems: [{ code: "test_refusal" }] } }; // the plane keeps the money
        } else if (state.admit) {
          const requests = [];
          for (const q of o.input.questions ?? [o.input]) requests.push(await openRequest(o, q));
          o.admission = { result: o.input.questions ? { kind: "oracle-group", requests } : { kind: "oracle", ...requests[0] } };
          o.status = "admitted";
        }
        return respond(res, 200, { status: o.status });
      }
      m = /^\/requests\/([^/]+)$/.exec(path);
      if (req.method === "GET" && m) {
        const o = state.orders.get(m[1]);
        if (!o) return respond(res, 404, { error: "unknown" });
        return respond(res, 200, { status: o.status, order: { id: o.id }, payment: {}, admission: o.admission });
      }
      m = /^\/oracle\/requests\/([^/]+)\/attestation$/.exec(path);
      if (req.method === "GET" && m) {
        const r = state.requests.get(m[1]);
        if (!r) return respond(res, 404, { error: "unknown_request" });
        if (r.status !== "attested") return respond(res, 404, { error: "not_attested", detail: `the request is ${r.status}` });
        r.signed ??= await signed(r);
        return respond(res, 200, r.signed);
      }
      m = /^\/oracle\/requests\/([^/]+)$/.exec(path);
      if (req.method === "GET" && m) {
        const r = state.requests.get(m[1]);
        return r ? respond(res, 200, { id: r.id, status: r.status }) : respond(res, 404, { error: "unknown_request" });
      }
      respond(res, 404, { error: "not_mocked", path });
    } catch (e) {
      respond(res, 500, { error: String(e.message) });
    }
  });
  return {
    state,
    attesterAddress: attester.address,
    /** An attestation for `input` answering `a`, as if a request had been bought: the owner's seed of a first value. */
    attest: async (input, a) => {
      const head = await chain();
      const blocks = Number(input.window.hours) * 300;
      const window = { fromBlock: head.number - blocks, toBlock: head.number };
      return signed({ id: randomUUID(), input, window, a, hash: questionHash(input, window.fromBlock, window.toBlock), head });
    },
    listen: () => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }),
  };
}
