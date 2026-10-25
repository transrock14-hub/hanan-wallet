import type { Provider } from "ethers";
import { encodeV2Swap, quoteV2 } from "./uniswapV2";

/**
 * SushiSwap's classic router is a Uniswap V2 fork with an identical ABI, so it
 * reuses the V2 helpers. Kept as its own module so Sushi-specific behaviour
 * (e.g. RouteProcessor support) can be added without touching V2 code.
 */

/**
 * Quotes an exact-input swap on the SushiSwap router.
 * @param provider RPC provider.
 * @param router SushiSwap router address.
 * @param path Token path.
 * @param amountIn Input amount.
 * @returns Output amount or null if no route.
 */
export function quoteSushi(
  provider: Provider,
  router: string,
  path: string[],
  amountIn: bigint,
): Promise<bigint | null> {
  return quoteV2(provider, router, path, amountIn);
}

/**
 * Encodes SushiSwap `swapExactTokensForTokens` calldata.
 * @param amountIn Exact input.
 * @param amountOutMin Minimum output.
 * @param path Token path.
 * @param recipient Output receiver.
 * @param deadline Unix timestamp.
 * @returns ABI-encoded calldata.
 */
export function encodeSushiSwap(
  amountIn: bigint,
  amountOutMin: bigint,
  path: string[],
  recipient: string,
  deadline: bigint,
): string {
  return encodeV2Swap(amountIn, amountOutMin, path, recipient, deadline);
}
