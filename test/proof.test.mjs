import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { utils } from "ethers";
import { headerRlp, slot0Key } from "../lib/proof.mjs";

// A real mainnet header (eth_getBlockByNumber, transactions dropped): re-encoded, it must hash to the block, as ProvenPoolPrice checks.
test("proof: a real block's header re-encodes to its hash", () => {
  const block = JSON.parse(readFileSync(new URL("./data/block-0x192f1fa.json", import.meta.url)));
  assert.equal(utils.keccak256(headerRlp(block)), block.hash);
  const tampered = { ...block, gasUsed: utils.hexValue(BigInt(block.gasUsed) + 1n) };
  assert.notEqual(utils.keccak256(headerRlp(tampered)), block.hash);
});

// The storage key of pools[0xb07d].slot0 in the PoolManager: the same key the contracts' ProvenPoolPrice computes (its test fixture).
test("proof: slot0 key of pool 0xb07d matches the contract's", () => {
  assert.equal(slot0Key("0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3"), "0xe4a8e4d1df3c332e13da9c3aae6f71f683236197cd0651438608c26f09255dd3");
});

const { proveNeeded } = await import("../lib/depth.mjs");
test("depth: prove only when the reference is stale, near its age limit, drifted, or refused", () => {
  const base = { stale: false, age: 600, maxAge: 6 * 3600, proven: 1_000_000n, live: 1_000_000n, refused: false };
  assert.equal(proveNeeded(base), false, "fresh and on the market: no proof (~887k gas saved)");
  assert.equal(proveNeeded({ ...base, stale: true }), true);
  assert.equal(proveNeeded({ ...base, refused: true }), true, "a sampler refused the reference");
  assert.equal(proveNeeded({ ...base, age: 5 * 3600 }), true, "within the margin of the max age");
  assert.equal(proveNeeded({ ...base, live: 1_014_000n }), false, "1.4% drift: under 1.5%");
  assert.equal(proveNeeded({ ...base, live: 1_016_000n }), true, "1.6% drift");
  assert.equal(proveNeeded({ ...base, live: 984_000n }), true, "a fall drifts too");
  assert.equal(proveNeeded({ ...base, proven: 0n }), true, "never proven");
});
