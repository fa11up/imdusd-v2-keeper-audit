// Proofs for ProvenPoolPrice (audit wave 2): a block header's RLP, the PoolManager's account proof and the storage proof of
// a v4 pool's slot0, all at one block, so the depth samplers' reference is the pool's END-OF-BLOCK price and a push inside the
// sampling transaction cannot move it. The header is re-encoded from eth_getBlockByNumber and must hash to the block's hash: if a
// fork adds a header field this refuses (and the keeper alerts) instead of sending a proof the contract would reject.
import { utils } from "ethers";

// Ethereum block header fields in order (through Prague's requestsHash). Fields are only ever appended by forks.
const FIELDS = [
  "parentHash", "sha3Uncles", "miner", "stateRoot", "transactionsRoot", "receiptsRoot", "logsBloom", "difficulty",
  "number", "gasLimit", "gasUsed", "timestamp", "extraData", "mixHash", "nonce", "baseFeePerGas", "withdrawalsRoot",
  "blobGasUsed", "excessBlobGas", "parentBeaconBlockRoot", "requestsHash",
];
const INTS = new Set(["difficulty", "number", "gasLimit", "gasUsed", "timestamp", "baseFeePerGas", "blobGasUsed", "excessBlobGas"]);
const POOLS_SLOT = 6; // v4-core StateLibrary.POOLS_SLOT

/** Pure: the header's RLP from an eth_getBlockByNumber result (integers minimal big-endian, 0 as the empty string). */
export function headerRlp(block) {
  const items = [];
  for (const f of FIELDS) {
    const v = block[f];
    if (v === undefined || v === null) break;
    if (INTS.has(f)) {
      const n = BigInt(v);
      const hex = n.toString(16);
      items.push(n === 0n ? "0x" : `0x${hex.length % 2 ? "0" : ""}${hex}`);
    } else items.push(v);
  }
  return utils.RLP.encode(items);
}

/** Pure: the PoolManager storage key of pools[poolId] (its first word is slot0). */
export const slot0Key = (poolId) => utils.keccak256(utils.defaultAbiCoder.encode(["bytes32", "uint256"], [poolId, POOLS_SLOT]));

/** The proof arguments of `ProvenPoolPrice.prove` for `blockNumber`. Throws when the header does not re-encode to the block's hash. */
export async function buildProof(provider, manager, poolId, blockNumber) {
  const tag = utils.hexValue(blockNumber);
  const block = await provider.send("eth_getBlockByNumber", [tag, false]);
  if (!block) throw new Error(`no block ${blockNumber}`);
  const header = headerRlp(block);
  if (utils.keccak256(header) !== block.hash.toLowerCase()) {
    throw new Error(`block ${blockNumber}: re-encoded header does not hash to the block (a new header field?)`);
  }
  const p = await provider.send("eth_getProof", [manager, [slot0Key(poolId)], tag]);
  return { blockNumber, header, accountProof: p.accountProof, storageProof: p.storageProof[0].proof };
}
