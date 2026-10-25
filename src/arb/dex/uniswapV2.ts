import { Contract, Interface, type Provider } from "ethers";

/** Minimal Uniswap V2 router ABI (also valid for SushiSwap and other forks). */
export const UNISWAP_V2_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
] as const;

const v2Interface = new Interface(UNISWAP_V2_ROUTER_ABI);

/**
 * Quotes an exact-input swap on a V2-style router.
 * @param provider RPC provider.
 * @param router Router address.
 * @param path Token path, e.g. [tokenIn, tokenOut].
 * @param amountIn Input amount in base units.
 * @returns Output of the final hop, or null if the pool doesn't exist / reverts.
 */
export async function quoteV2(
  provider: Provider,
  router: string,
  path: string[],
  amountIn: bigint,
): Promise<bigint | null> {
  const contract = new Contract(router, UNISWAP_V2_ROUTER_ABI, provider);
  try {
    const getAmountsOut = contract.getFunction("getAmountsOut");
    const amounts = (await getAmountsOut.staticCall(amountIn, path)) as bigint[];
    const out = amounts[amounts.length - 1];
    return out !== undefined && out > 0n ? out : null;
  } catch {
    return null;
  }
}

/**
 * Encodes `swapExactTokensForTokens` calldata.
 * @param amountIn Exact input.
 * @param amountOutMin Slippage-protected minimum output.
 * @param path Token path.
 * @param recipient Receiver of output tokens (the arbitrage contract).
 * @param deadline Unix timestamp after which the swap reverts.
 * @returns ABI-encoded calldata.
 */
export function encodeV2Swap(
  amountIn: bigint,
  amountOutMin: bigint,
  path: string[],
  recipient: string,
  deadline: bigint,
): string {
  return v2Interface.encodeFunctionData("swapExactTokensForTokens", [
    amountIn,
    amountOutMin,
    path,
    recipient,
    deadline,
  ]);
}
