// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test-only contracts for test/fork/duties.mjs, set with anvil_setCode (constructor-less, so their runtime is all they are).
// Built with: forge build, solc 0.8.26, no optimizer settings beyond the defaults. helpers.json holds the runtime hex.

interface IERC20 {
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IPM {
    function unlock(bytes calldata) external returns (bytes memory);
    function swap(PoolKey memory, SwapParams memory, bytes calldata) external returns (int256);
    function modifyLiquidity(PoolKey memory, ModifyLiquidityParams memory, bytes calldata) external returns (int256, int256);
    function sync(address) external;
    function settle() external payable returns (uint256);
    function take(address, address, uint256) external;
}

/// @notice Moves a v4 pool on a fork: adds liquidity and swaps from its own token balances.
contract PoolDriver {
    IPM internal constant PM = IPM(0x000000000004444c5dc75cB358380D2e3dE08A90);

    function swap(PoolKey calldata key, bool zeroForOne, int256 amount, uint160 limit) external returns (bytes memory) {
        return PM.unlock(abi.encode(uint8(0), key, zeroForOne, amount, limit, int24(0), int24(0), int256(0)));
    }

    function addLiquidity(PoolKey calldata key, int24 lower, int24 upper, int256 liquidity) external returns (bytes memory) {
        return PM.unlock(abi.encode(uint8(1), key, false, int256(0), uint160(0), lower, upper, liquidity));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (uint8 what, PoolKey memory key, bool z, int256 amount, uint160 limit, int24 lower, int24 upper, int256 liq) =
            abi.decode(data, (uint8, PoolKey, bool, int256, uint160, int24, int24, int256));
        int256 delta;
        if (what == 0) delta = PM.swap(key, SwapParams(z, amount, limit), "");
        else (delta,) = PM.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, liq, bytes32(0)), "");
        _settle(key.currency0, int128(delta >> 128));
        _settle(key.currency1, int128(delta));
        return "";
    }

    function _settle(address token, int128 d) private {
        if (d < 0) {
            PM.sync(token);
            IERC20(token).transfer(address(PM), uint256(uint128(-d)));
            PM.settle();
        } else if (d > 0) {
            PM.take(token, address(this), uint256(uint128(d)));
        }
    }
}

/// @notice An Allocator route: pays 101% of the least it is asked for, from its own imdUSD.
contract MockRoute {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient) external returns (uint256 out) {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        out = minOut + minOut / 100;
        IERC20(tokenOut).transfer(recipient, out);
    }
}

/// @notice imdUSD's $1 for the Allocator's slippage bound: nothing in the launch provides one.
contract DollarFeed {
    function latestValue() external view returns (uint256, uint64) {
        return (1e18, uint64(block.timestamp));
    }

    function isStale() external pure returns (bool) {
        return false;
    }

    function maxAge() external pure returns (uint256) {
        return type(uint64).max;
    }
}

/// @notice Stands in for ImdDepth on a fork: a deep market, so a line can open without a week of samples.
contract DeepDepth {
    function depth() external pure returns (uint256) {
        return 10_000_000e18;
    }

    function sampled() external pure returns (uint256) {
        return 10_000_000e18;
    }

    function poke() external pure returns (uint256) {
        return 10_000_000e18;
    }

    function lowOf(uint256) external view returns (uint32, uint256) {
        return (uint32(block.timestamp / 1 days), 10_000_000e18);
    }
}
