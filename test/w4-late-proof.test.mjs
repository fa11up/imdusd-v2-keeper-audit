// PROPERTY (price track wave 4, ProvenPoolPrice.prove refuses a block > PROVE_WINDOW = 32 behind the head: TooOld): a late-landing
// proof never costs the hour's samples. When a depth round or proveNow with proofs fails (refused at send, or mined after the proof
// went stale), it is rebuilt against the NEW head and sent once more, never in a loop; every proof sent is of head-1 at the moment it
// was built; a second failure raises depth-proof-late / depth-prove-now-failed and leaves the hour open.
// Seeded fuzz with a fake chain whose head moves between build and landing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, utils } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w4-late-"));
const { readState, statePath, writeState } = await import("../lib/state.mjs");
const { runDepth, proveNow } = await import("../lib/depth.mjs");
const { headerRlp } = await import("../lib/proof.mjs");
const { PROVEN_ABI } = await import("../lib/deployment.mjs");

const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const WINDOW = 32;
const PROVEN = new utils.Interface(PROVEN_ABI);

function world(r) {
  const w = { head: 1000, built: [], sends: [], lateFor: 0, alerts: [] };
  const now = 20_000 * 86_400 + 3 * 3600 + 3000;
  const blockOf = (n) => { const b = { parentHash: utils.hexZeroPad(utils.hexlify(n), 32) }; return { ...b, hash: utils.keccak256(headerRlp(b)) }; };
  const provider = {
    getBlock: async () => ({ number: w.head, timestamp: now, baseFeePerGas: 1n }),
    getBlockNumber: async () => w.head,
    send: async (m, [tag]) => {
      if (m === "eth_getBlockByNumber") { w.built.push({ block: Number(tag), head: w.head }); return blockOf(Number(tag)); }
      return { accountProof: ["0x01"], storageProof: [{ proof: ["0x02"] }] };
    },
    call: async () => utils.hexZeroPad("0x01000000000000000000000000", 32),
    getStorageAt: async () => "0x0", getGasPrice: async () => BigNumber.from(1), getBalance: async () => BigNumber.from(10).pow(18), unpin() {},
  };
  const feed = { address: "0x00000000000000000000000000000000000000f1", interface: PROVEN, latestValue: async () => [BigNumber.from(1), BigNumber.from(now - 100)], isStale: async () => true, maxAge: async () => BigNumber.from(7200) };
  const proofBlocks = (calls) => calls.filter((c) => c.target === feed.address).map((c) => {
    const [header] = PROVEN.decodeFunctionData("prove", c.callData);
    return BigNumber.from(utils.RLP.decode(header)[0]).toNumber();
  });
  const tooOld = () => Object.assign(new Error("TooOld"), { errorName: "TooOld" });
  const multicall = {
    address: "0xmc", interface: { encodeFunctionData: (f) => f },
    callStatic: {
      aggregate3: async (calls) => {
        // At send time (allowFailure false), a proof is late when the head moved more than the window since it was built.
        if (calls.every((c) => c.allowFailure === false) && w.lateFor > 0 && proofBlocks(calls).length) { w.lateFor -= 1; w.head += WINDOW + 5; throw tooOld(); }
        return calls.map((c) => ({ success: true, returnData: c.callData === "sampled" ? "0x01" : "0x" }));
      },
    },
    aggregate3: async (calls) => {
      w.sends.push({ head: w.head, proofs: proofBlocks(calls), samples: calls.filter((c) => c.callData === "sample").length });
      w.head += 1;
      return { hash: "0x1", wait: async () => ({ blockNumber: w.head, gasUsed: 1 }) };
    },
  };
  multicall.connect = () => multicall;
  const c = (name, fn) => { const x = { address: `0x${name}`, interface: { encodeFunctionData: (f) => f, parseError: () => { throw new Error(); } }, callStatic: { [fn]: async () => {} }, [fn]: async () => ({ hash: "0x2", wait: async () => ({ blockNumber: 1, gasUsed: 1 }) }) }; x.connect = () => x; return x; };
  const imdDepth = { ...c("depth", "poke"), lowOf: async () => ({ day: Math.floor(now / 86_400) }) };
  imdDepth.connect = () => imdDepth;
  w.ctx = { execute: true, log() {}, provider, multicall, cfg: {}, signer: { provider, address: "0xk" },
    book: { imdDepth, samplers: [c("s1", "sample")], proven: [{ feed, manager: "0x00000000000000000000000000000000000000aa", poolId: `0x${"11".repeat(32)}`, baseIsToken0: false }] },
    alerts: { raise: async (l, k) => w.alerts.push(`${l}:${k}`) } };
  w.now = now;
  return w;
}

test("property: a late proof is rebuilt on the new head and sent once more; it never costs the hour's samples (seeded fuzz, 200 rounds)", async () => {
  const r = rng(0x32);
  const failures = [];
  for (let i = 0; i < 200 && failures.length < 6; i++) {
    rmSync(statePath("depth.json"), { force: true });
    const w = world(r);
    writeState("depth.json", { hour: Math.floor(w.now / 3600), at: w.now - 1, done: false });
    w.lateFor = Math.floor(r() * 3); // 0: lands; 1: late once, the rebuild lands; 2: late twice
    await runDepth(w.ctx);
    const batches = w.sends.filter((s) => s.samples > 0);
    // Every proof that went out is of head-1 at the moment it was built, and within the window when it went.
    for (const s of batches) for (const b of s.proofs) if (s.head - b > WINDOW) failures.push(`round ${i}: proof of ${b} sent at head ${s.head}`);
    if (w.built.length > 3) failures.push(`round ${i}: ${w.built.length} proofs built (a loop)`);
    const done = readState("depth.json").done;
    if (w.lateFor === 0 && w.sends.length && !done) failures.push(`round ${i}: the rebuilt round landed but the hour is open`);
    if (batches.length === 0 && done) failures.push(`round ${i}: done with no samples`);
    if (batches.length === 0 && !w.alerts.includes("warn:depth-proof-late")) failures.push(`round ${i}: two late proofs, no alert (${w.alerts})`);
  }
  assert.deepEqual(failures, []);
});

test("property: proveNow rebuilds a late proof once, and alerts when the rebuild fails too", async () => {
  for (const late of [0, 1, 2]) {
    const w = world(rng(late + 1));
    w.lateFor = late;
    const ok = await proveNow(w.ctx, "test");
    assert.equal(ok, late < 2, `late ${late}`);
    assert.ok(w.built.length <= 2, `${w.built.length} proofs built`);
    for (const s of w.sends) for (const b of s.proofs) assert.ok(s.head - b <= WINDOW, `proof of ${b} sent at head ${s.head}`);
    assert.equal(w.alerts.includes("warn:depth-prove-now-failed"), late === 2);
  }
});
