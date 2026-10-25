import { formatUnits as ethersFormatUnits, parseUnits as ethersParseUnits } from "ethers";

/** 100% expressed in basis points. */
export const BPS_DENOMINATOR = 10_000n;

/** Fixed-point precision used for all USD values (same as Chainlink: 8 decimals). */
export const USD_DECIMALS = 8;

/**
 * Takes `basisPoints` of `amount`, rounding down.
 * @param amount Base amount (wei-style integer).
 * @param basisPoints 1 bp = 0.01%.
 * @returns amount * bps / 10_000.
 */
export function bps(amount: bigint, basisPoints: bigint): bigint {
  return (amount * basisPoints) / BPS_DENOMINATOR;
}

/**
 * Minimum acceptable output after slippage. Rounds down, which makes the
 * resulting `amountOutMin` slightly more permissive by at most 1 wei.
 * @param amount Expected output.
 * @param slippageBps Allowed slippage in bps (must be 0..10_000).
 * @returns amount * (10_000 - slippageBps) / 10_000.
 */
export function applySlippage(amount: bigint, slippageBps: bigint): bigint {
  if (slippageBps < 0n || slippageBps > BPS_DENOMINATOR) {
    throw new RangeError(`slippageBps out of range: ${slippageBps}`);
  }
  return (amount * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR;
}

/**
 * Aave V3 flash loan premium. Mirrors `PercentageMath.percentMul`, which rounds
 * half up: (amount * bps + 5_000) / 10_000.
 * @param amount Borrowed amount.
 * @param premiumBps Pool's FLASHLOAN_PREMIUM_TOTAL.
 * @returns Premium owed on top of `amount`.
 */
export function flashLoanPremium(amount: bigint, premiumBps: bigint): bigint {
  return (amount * premiumBps + BPS_DENOMINATOR / 2n) / BPS_DENOMINATOR;
}

/**
 * Signed profit of a round trip, in borrowed-token units.
 * @param amountOut Tokens received after both swaps.
 * @param amountIn Tokens borrowed.
 * @param premium Flash loan premium.
 * @returns amountOut - amountIn - premium (may be negative).
 */
export function computeProfit(amountOut: bigint, amountIn: bigint, premium: bigint): bigint {
  return amountOut - amountIn - premium;
}

/**
 * Converts a token amount to USD (8-decimal fixed point).
 * @param amount Token amount in base units (may be negative).
 * @param decimals Token decimals.
 * @param priceUsdE8 USD price of one whole token, 8 decimals.
 * @returns USD value * 1e8, truncated toward zero.
 */
export function tokenToUsdE8(amount: bigint, decimals: number, priceUsdE8: bigint): bigint {
  return (amount * priceUsdE8) / 10n ** BigInt(decimals);
}

/**
 * Converts a USD value (8-decimal fixed point) to token base units, rounding UP
 * so profit floors derived from it are never understated.
 * @param usdE8 USD * 1e8 (must be >= 0).
 * @param decimals Token decimals.
 * @param priceUsdE8 USD price of one whole token, 8 decimals (> 0).
 * @returns Token amount in base units.
 */
export function usdE8ToToken(usdE8: bigint, decimals: number, priceUsdE8: bigint): bigint {
  if (priceUsdE8 <= 0n) throw new RangeError("priceUsdE8 must be > 0");
  if (usdE8 <= 0n) return 0n;
  const numerator = usdE8 * 10n ** BigInt(decimals);
  return (numerator + priceUsdE8 - 1n) / priceUsdE8;
}

/**
 * Native gas cost in USD (8 decimals).
 * @param gasUnits Gas limit / used.
 * @param gasPriceWei Price per gas unit in wei.
 * @param nativeUsdE8 USD price of 1 native token (18 decimals), 8 decimals.
 * @returns USD * 1e8.
 */
export function gasCostUsdE8(gasUnits: bigint, gasPriceWei: bigint, nativeUsdE8: bigint): bigint {
  return tokenToUsdE8(gasUnits * gasPriceWei, 18, nativeUsdE8);
}

/**
 * Parses a decimal string (e.g. "12.5") into base units.
 * @param value Decimal string.
 * @param decimals Number of decimals.
 * @returns Base-unit bigint.
 */
export function parseUnits(value: string, decimals: number): bigint {
  return ethersParseUnits(value, decimals);
}

/**
 * Formats base units as a decimal string. Handles negatives explicitly.
 * @param value Base-unit bigint.
 * @param decimals Number of decimals.
 * @returns Decimal string, e.g. "-1.5".
 */
export function formatUnits(value: bigint, decimals: number): string {
  const sign = value < 0n ? "-" : "";
  return sign + ethersFormatUnits(value < 0n ? -value : value, decimals);
}

/**
 * Parses a USD decimal string into 8-decimal fixed point.
 * @param value e.g. "25.10".
 * @returns USD * 1e8.
 */
export function parseUsd(value: string): bigint {
  return parseUnits(value, USD_DECIMALS);
}

/**
 * Formats an 8-decimal USD value for logs.
 * @param usdE8 USD * 1e8.
 * @returns e.g. "13.0".
 */
export function formatUsd(usdE8: bigint): string {
  return formatUnits(usdE8, USD_DECIMALS);
}

/**
 * Smaller of two bigints.
 * @param a First value.
 * @param b Second value.
 * @returns min(a, b).
 */
export function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
