import { Contract, Interface, solidityPacked, type Provider } from "ethers";

/** QuoterV2 ABI. Its functions revert internally, so only use `staticCall`. */
export const QUOTER_V2_ABI = [
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
] as const;

/** SwapRouter02 ABI subset. */
export const SWAP_ROUTER_02_ABI = [
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
] as const;

const routerInterface = new Interface(SWAP_ROUTER_02_ABI);

/**
 * Encodes a V3 path: token0 | fee0 | token1 | fee1 | token2 ...
 * (20-byte address, 3-byte fee, repeated).
 * @param tokens Token addresses, length n.
 * @param fees Fee tiers in hundredths of a bip, length n - 1.
 * @returns Packed path bytes (hex).
 */
export function encodeV3Path(tokens: string[], fees: number[]): string {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) {
    throw new Error(`invalid V3 path: ${tokens.length} tokens, ${fees.length} fees`);
  }
  const types: string[] = [];
  const values: (string | number)[] = [];
  tokens.forEach((token, i) => {
    types.push("address");
    values.push(token);
    const fee = fees[i];
    if (fee !== undefined) {
      types.push("uint24");
      values.push(fee);
    }
  });
  return solidityPacked(types, values);
}

/**
 * Quotes an exact-input V3 swap through QuoterV2.
 * @param provider RPC provider.
 * @param quoter QuoterV2 address.
 * @param tokens Token path.
 * @param fees Fee tier per hop.
 * @param amountIn Input amount.
 * @returns Output amount, or null if the pool is missing / the quote reverts.
 */
export async function quoteV3(
  provider: Provider,
  quoter: string,
  tokens: string[],
  fees: number[],
  amountIn: bigint,
): Promise<bigint | null> {
  const contract = new Contract(quoter, QUOTER_V2_ABI, provider);
  try {
    const result = await contract.getFunction("quoteExactInput").staticCall(encodeV3Path(tokens, fees), amountIn);
    const amountOut = result[0] as bigint;
    return amountOut > 0n ? amountOut : null;
  } catch {
    return null;
  }
}

/**
 * Encodes a SwapRouter02 `exactInput`, wrapped in `multicall(deadline, ...)`
 * because SwapRouter02's params have no deadline field.
 * @param tokens Token path.
 * @param fees Fee tier per hop.
 * @param amountIn Exact input.
 * @param amountOutMin Minimum output.
 * @param recipient Output receiver.
 * @param deadline Unix timestamp.
 * @returns ABI-encoded calldata for the router.
 */
export function encodeV3Swap(
  tokens: string[],
  fees: number[],
  amountIn: bigint,
  amountOutMin: bigint,
  recipient: string,
  deadline: bigint,
): string {
  const exactInput = routerInterface.encodeFunctionData("exactInput", [
    { path: encodeV3Path(tokens, fees), recipient, amountIn, amountOutMinimum: amountOutMin },
  ]);
  return routerInterface.encodeFunctionData("multicall(uint256,bytes[])", [deadline, [exactInput]]);
}
