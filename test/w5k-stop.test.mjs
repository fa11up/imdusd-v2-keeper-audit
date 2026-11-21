// A review before wave 5b: THE KILL SWITCH.
// PROPERTY (P7): in report-only mode, or with state/STOP present, nothing is signed, broadcast, rebroadcast or paid, from any site.
// Enforced at the choke points: lib/tx.mjs sendProvider.sendTransaction (every broadcast: new sends, replacements, cancels,
// rebroadcasts), guardedSigner.sendTransaction and .bump (every signature of a transaction), lib/journal.mjs settleIntents (every
// rebroadcast of an open intent, incl. the bridge auto-claim's, which runs outside act()/send()), lib/orders.mjs pay (every payment).
// The SEND-SITE FIXTURE below lists every place in keeper.mjs + lib/ that signs, broadcasts or pays: a new one fails this test until
// it is reviewed against the choke points and added.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, providers, utils, Wallet } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5k-stop-"));
const { statePath } = await import("../lib/state.mjs");
const { recordIntent, settleIntents } = await import("../lib/journal.mjs");
const { guardedSigner, sendProvider } = await import("../lib/tx.mjs");

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const here = new URL("..", import.meta.url).pathname;
const STOP = () => { mkdirSync(process.env.STATE_DIR, { recursive: true }); writeFileSync(statePath("STOP"), ""); };

// pattern -> { file: count }. Every site is behind a choke point: the right-hand comment says which.
const SITES = {
  "sendTransaction(": { "lib/tx.mjs": 5 }, // sendProvider (STOP), guardedSigner.sendTransaction (STOP), relay calls inside sendProvider
  "signTransaction(": { "lib/tx.mjs": 2 }, // bump (STOP) and guardedSigner.sendTransaction (STOP)
  "_signTypedData(": { "lib/x402.mjs": 2 }, // signPayment, called only from orders.pay (STOP, report-only returns before)
  "rebroadcast(": { "lib/journal.mjs": 1 }, // settleIntents (STOP)
  ".submit(": { "lib/orders.mjs": 1 }, // orders.pay after signPayment (STOP)
  "settleIntents(": { "lib/bridge.mjs": 1, "lib/journal.mjs": 1, "lib/tx.mjs": 1 }, // the rebroadcast inside is held under STOP
  "act(ctx": { "lib/act.mjs": 1, "lib/backstop.mjs": 2, "lib/bridge.mjs": 1, "lib/allocator.mjs": 3, "lib/depth.mjs": 4, "lib/peg.mjs": 3, "lib/orders.mjs": 2, "lib/rates.mjs": 1, "lib/pulse.mjs": 1, "lib/stocks.mjs": 6, "lib/seats.mjs": 4, "lib/positions.mjs": 4 }, // send() (STOP) or report-only simulate
};

test("every send site is in the fixture (a new site fails until it is reviewed against the choke points)", () => {
  const files = ["keeper.mjs", ...readdirSync(join(here, "lib")).filter((f) => f.endsWith(".mjs")).map((f) => `lib/${f}`)];
  for (const [pat, want] of Object.entries(SITES)) {
    const got = {};
    for (const f of files) {
      const n = readFileSync(join(here, f), "utf8").split(pat).length - 1;
      if (n) got[f] = n;
    }
    assert.deepEqual(got, want, `send sites for ${JSON.stringify(pat)} changed: review each against STOP/report-only, then update the fixture`);
  }
});

test("STOP: an open intent is not rebroadcast (the bridge auto-claim's settle path included); its receipt is still read", async () => {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  recordIntent({ nonce: 3, hash: "0xaa", signed: "0x01", label: "bridge claim 1:0xbb" });
  STOP();
  let sent = 0;
  const open = await settleIntents({ getTransactionReceipt: async () => null, getTransactionCount: async () => 3 }, "0x00000000000000000000000000000000000000ee", async () => { sent++; });
  assert.equal(sent, 0);
  assert.equal(open.length, 1, "still open, not dropped");
});

test("STOP: the broadcast choke point and the signer refuse; nothing reaches a relay", async () => {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  let relayed = 0;
  providers.StaticJsonRpcProvider.prototype.sendTransaction = async () => { relayed++; return {}; };
  const out = sendProvider({ SEND_RPC_URLS: ["https://relay.invalid"] });
  STOP();
  await assert.rejects(out.sendTransaction("0x02"), /kill switch/);
  const provider = { getBlock: async () => ({ baseFeePerGas: BigNumber.from(1e9) }), getTransactionCount: async () => 1 };
  const w = Object.create(new Wallet(KEY));
  Object.defineProperty(w, "provider", { value: provider });
  w.populateTransaction = async (tx) => ({ chainId: 1, type: 2, gasLimit: 21000, nonce: 1, ...tx });
  const signer = guardedSigner(w, provider, { SEND_RPC_URLS: ["https://relay.invalid"] }, "tx");
  let signed = 0;
  const realSign = w.signTransaction;
  w.signTransaction = async (...a) => { signed++; return realSign.apply(w, a); };
  await assert.rejects(signer.sendTransaction({ to: "0x00000000000000000000000000000000000000aa", data: "0x" }), /kill switch/);
  assert.deepEqual(await signer.bump({ signed: "0x", label: "x" }), { stuck: "kill switch: state/STOP exists: nothing is signed" });
  assert.equal(signed, 0);
  assert.equal(relayed, 0);
});

test("STOP: a quoted order is not signed or paid", async () => {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  process.env.PLANE_BEARER = "x";
  const { writeState } = await import("../lib/state.mjs");
  const { advanceOrders, loadOrders } = await import("../lib/orders.mjs");
  writeState("orders.json", { list: [{ key: "k", purpose: "fall", action: "oracle.request", stage: "quoted", planeOrder: "po-1", at: new Date().toISOString(), questions: [{ role: "price", leaf: "0x01" }] }] });
  STOP();
  let submitted = 0;
  const ctx = { execute: true, cfg: { PLANE: { payTo: "0x4e0fa57bde726079356537e2f34d671e9f41adbc" } }, signer: new Wallet(KEY), log() {}, planeState: { ok: true },
    planeClient: { challenge: async () => { submitted++; return { status: 402, body: {} }; }, submit: async () => { submitted++; } }, alerts: { raise: async () => {} } };
  await advanceOrders(ctx);
  assert.equal(submitted, 0);
  assert.equal(loadOrders()[0].stage, "quoted");
});

test("STOP checked immediately before every payment signature and every hand-over to the plane (orders.mjs source)", () => {
  const lines = readFileSync(join(here, "lib/orders.mjs"), "utf8").split("\n");
  const sites = lines.map((l, i) => [l, i]).filter(([l]) => /await signPayment\(|plane\.submit\(/.test(l));
  assert.equal(sites.length, 2);
  for (const [l, i] of sites) assert.ok(lines.slice(Math.max(0, i - 3), i).some((x) => x.includes("stopped()")), `no STOP check right before: ${l.trim().slice(0, 80)}`);
});

test("STOP set DURING the payment's last reads (the allowance read): nothing is signed or handed to the plane", async () => {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  process.env.PLANE_BEARER = "x";
  const { writeState } = await import("../lib/state.mjs");
  const { advanceOrders } = await import("../lib/orders.mjs");
  const { IMD } = await import("../lib/x402.mjs");
  const PAY_TO = "0x4e0fa57bde726079356537e2f34d671e9f41adbc";
  writeState("orders.json", { list: [{ key: "k", purpose: "fall", action: "oracle.request", stage: "quoted", planeOrder: "po-1", at: new Date().toISOString(), questions: [{ role: "price", leaf: "0x01" }] }] });
  const wallet = new Wallet(KEY);
  let signatures = 0, submitted = 0;
  const real = wallet._signTypedData.bind(wallet);
  wallet._signTypedData = async (...a) => { signatures++; return real(...a); };
  const ch = { resource: {}, resourceUrl: "https://api.imd.fun/requests/po-1/submit", requesterScopeHash: "ab".repeat(32),
    accepts: [{ scheme: "exact", network: "eip155:1", amount: "500000000000000000", asset: IMD, payTo: PAY_TO, maxTimeoutSeconds: 300 }],
    quote: { id: "po-1", quoteHash: "cd".repeat(32), action: "oracle.request", expiresAt: 1, payment: { network: "eip155:1", asset: IMD, amount: "500000000000000000", payTo: PAY_TO } } };
  const E = BigNumber.from(10).pow(18);
  const ctx = { execute: true, cfg: { PLANE: { payTo: PAY_TO }, IMD: { dailyCap: 1000 } }, signer: wallet, keeperAddress: wallet.address, log() {}, planeState: { ok: true },
    provider: { getBlock: async () => ({ number: 1, timestamp: Math.floor(Date.now() / 1000) }), getBalance: async () => E, getGasPrice: async () => BigNumber.from(1e9) },
    book: { token: () => ({ balanceOf: async () => E.mul(1000), allowance: async () => { STOP(); return E.mul(1000); } }) },
    planeClient: { challenge: async () => ({ status: 402, body: ch }), submit: async () => { submitted++; return { status: 200, body: {} }; } }, alerts: { raise: async () => {}, settle: async () => {} } };
  await advanceOrders(ctx);
  assert.equal(signatures, 0, "a payment was signed after STOP was set");
  assert.equal(submitted, 0, "a payment was handed to the plane after STOP was set");
});
