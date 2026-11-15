// Fork suites only: anvil cannot produce a storage proof that verifies against its own headers (a forked state root covers only
// the touched state), so every ProvenPoolPrice in the record gets the code of the contracts' test/utils/ProvenPoolPriceForkStandIn
// (same ABI, constructor and storage; it checks the header against blockhash but reads slot0 live). The keeper's own proof path
// still runs (lib/proof.mjs builds the header and proofs; the stand-in ignores the proofs). Real proofs: test/live/prove-mainnet.mjs.
import { readFileSync } from "node:fs";
import { Contract, ContractFactory } from "ethers";
import { PROVEN_ABI } from "../../lib/deployment.mjs";

const CREATION = readFileSync(new URL("./proven-standin.hex", import.meta.url), "utf8").trim();

/** Swap each proven feed in `record.feeds` for the stand-in; returns how many were swapped. */
export async function swapProvenForStandIn(provider, signer, record) {
  let n = 0;
  for (const a of record.feeds ?? []) {
    const f = new Contract(a, PROVEN_ABI, provider);
    let args;
    try {
      args = [await f.manager(), await f.poolId(), await new Contract(a, ["function baseIsToken0() view returns (bool)"], provider).baseIsToken0(), await f.maxAge()];
      await f.provenBlock();
    } catch {
      continue; // not a ProvenPoolPrice
    }
    const standIn = await new ContractFactory(["constructor(address,bytes32,bool,uint256)"], CREATION, signer).deploy(...args);
    await standIn.deployed();
    await provider.send("anvil_setCode", [a, await provider.getCode(standIn.address)]);
    n++;
  }
  return n;
}
