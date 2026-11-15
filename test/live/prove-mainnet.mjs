// Live check of the depth reference's proof path against REAL mainnet, read-only: the keeper's own proof builder (lib/proof.mjs) for the
// block before the head, then ProvenPoolPrice.prove(...) run by eth_call with the contract's runtime code overridden at an unused
// address. Nothing is sent. The runtime comes from a ProvenPoolPrice deployed on a local fork with mainnet's constructor arguments
// (its immutables: PoolManager, pool 0xb07d, base token1, max age), so the call is exactly what the deployed feed would run.
//   RPC=<mainnet archive rpc> FORK=http://127.0.0.1:8557 FEED=<ProvenPoolPrice on the fork> node test/live/prove-mainnet.mjs
import { providers, Contract, utils, BigNumber } from "ethers";
import { buildProof } from "../../lib/proof.mjs";
import { PROVEN_ABI, LIVE_POOL_ABI } from "../../lib/deployment.mjs";

const mainnet = new providers.StaticJsonRpcProvider(process.env.RPC, 1);
const fork = new providers.StaticJsonRpcProvider(process.env.FORK ?? "http://127.0.0.1:8557", 1);
const feedOnFork = new Contract(process.env.FEED, PROVEN_ABI, fork);
const code = await fork.getCode(feedOnFork.address);
if (code === "0x") throw new Error("no ProvenPoolPrice at FEED on the fork");
const [manager, poolId] = await Promise.all([feedOnFork.manager(), feedOnFork.poolId()]);

const head = await mainnet.getBlockNumber();
const pr = await buildProof(mainnet, manager, poolId, head - 1);
const iface = new utils.Interface(PROVEN_ABI);
const at = "0x00000000000000000000000000000000000ba5e1"; // unused address; the override puts the feed's code there
const data = iface.encodeFunctionData("prove", [pr.header, pr.accountProof, pr.storageProof]);
const callArgs = { to: at, data, gas: utils.hexValue(5_000_000) };
const t0 = Date.now();
const ret = await mainnet.send("eth_call", [callArgs, "latest", { [at]: { code } }]);
const proven = BigNumber.from(iface.decodeFunctionResult("prove", ret)[0]);
const gas = await mainnet.send("eth_estimateGas", [callArgs, "latest", { [at]: { code } }]).catch((e) => `n/a (${e.message.slice(0, 60)})`);

// The same price read directly at that block: slot0 through StateLibrary's view (LivePoolPrice's formula on getSlot0).
const sv = new Contract("0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227", ["function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24, uint24, uint24)"], mainnet);
const { sqrtPriceX96 } = await sv.getSlot0(poolId, { blockTag: head - 1 });
const q = BigInt(sqrtPriceX96.toString()) ** 2n / (1n << 64n);
const direct = (10n ** 18n * (1n << 128n)) / q;

console.log(`block ${head - 1}: proven ${proven.toString()} | direct getSlot0 ${direct} | ${proven.toString() === direct.toString() ? "MATCH" : "MISMATCH"}`);
console.log(`account nodes ${pr.accountProof.length}, storage nodes ${pr.storageProof.length}, calldata ${(data.length - 2) / 2} B, gas ${gas}, ${Date.now() - t0} ms`);
if (proven.toString() !== direct.toString()) process.exit(1);
