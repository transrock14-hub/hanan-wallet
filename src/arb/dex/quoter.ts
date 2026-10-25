import type { Provider } from "ethers";
import { encodeSushiSwap, quoteSushi } from "./sushiswap";
import { encodeV2Swap, quoteV2 } from "./uniswapV2";
import { encodeV3Swap, quoteV3 } from "./uniswapV3";

export type DexName = "uniswapV2" | "sushiswap" | "uniswapV3";

/** A configured DEX the bot can quote and trade on. */
export interface DexVenue {
  name: DexName;
  kind: "v2" | "v3";
  router: string;
  /** QuoterV2 address (V3 only). */
  quoter?: string;
  /** Candidate fee tiers to try for single-hop V3 quotes. */
  feeTiers?: number[];
}

/** Unified quote shape across all DEXes. */
export interface Quote {
  dex: DexName;
  amountIn: bigint;
  amountOut: bigint;
  path: string[];
  /** V3 fee per hop; undefined for V2-style DEXes. */
  feeTiers?: number[];
  router: string;
}

/** Anything that can produce quotes. Lets the scanner be tested without RPC. */
export interface QuoteSource {
  quote(venue: DexVenue, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote | null>;
}

/**
 * Quotes a V2-style router (Uniswap V2 or SushiSwap).
 * @param provider RPC provider.
 * @param router Router address.
 * @param path Token path.
 * @param amountIn Input amount.
 * @param dex Which V2-style DEX this is.
 * @returns Quote, or null if no liquidity.
 */
export async function getBestQuoteV2(
  provider: Provider,
  router: string,
  path: string[],
  amountIn: bigint,
  dex: "uniswapV2" | "sushiswap" = "uniswapV2",
): Promise<Quote | null> {
  const out = dex === "sushiswap"
    ? await quoteSushi(provider, router, path, amountIn)
    : await quoteV2(provider, router, path, amountIn);
  return out === null ? null : { dex, amountIn, amountOut: out, path, router };
}

/**
 * Quotes Uniswap V3. For a single hop every fee tier in `fees` is tried and the
 * best output wins; for multi-hop paths `fees` is the per-hop fee list.
 * @param provider RPC provider.
 * @param quoter QuoterV2 address.
 * @param router SwapRouter02 address (carried into the quote for execution).
 * @param path Token path.
 * @param fees Candidate tiers (single hop) or per-hop tiers (multi-hop).
 * @param amountIn Input amount.
 * @returns Best quote, or null if no pool returned a quote.
 */
export async function getBestQuoteV3(
  provider: Provider,
  quoter: string,
  router: string,
  path: string[],
  fees: number[],
  amountIn: bigint,
): Promise<Quote | null> {
  const feeSets = path.length === 2 ? fees.map((f) => [f]) : [fees];
  const outs = await Promise.all(feeSets.map((set) => quoteV3(provider, quoter, path, set, amountIn)));

  let best: Quote | null = null;
  outs.forEach((out, i) => {
    const feeTiers = feeSets[i];
    if (out !== null && feeTiers && (best === null || out > best.amountOut)) {
      best = { dex: "uniswapV3", amountIn, amountOut: out, path, feeTiers, router };
    }
  });
  return best;
}

/** Live on-chain quote source backed by an ethers provider. */
export class OnChainQuoteSource implements QuoteSource {
  constructor(private readonly provider: Provider) {}

  /**
   * Quotes a single-hop swap on `venue`.
   * @param venue DEX to quote.
   * @param tokenIn Input token.
   * @param tokenOut Output token.
   * @param amountIn Input amount.
   * @returns Quote or null.
   */
  quote(venue: DexVenue, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<Quote | null> {
    const path = [tokenIn, tokenOut];
    if (venue.kind === "v3") {
      if (!venue.quoter) return Promise.resolve(null);
      return getBestQuoteV3(this.provider, venue.quoter, venue.router, path, venue.feeTiers ?? [3000], amountIn);
    }
    const dex = venue.name === "sushiswap" ? "sushiswap" : "uniswapV2";
    return getBestQuoteV2(this.provider, venue.router, path, amountIn, dex);
  }
}

/**
 * Builds router calldata for executing `quote` with explicit amounts.
 * @param quote Quote describing DEX, path and fee tiers.
 * @param amountIn Exact input to encode.
 * @param amountOutMin Slippage-protected minimum output.
 * @param recipient Output receiver (the arbitrage contract).
 * @param deadline Unix timestamp.
 * @returns ABI-encoded calldata.
 */
export function encodeSwap(
  quote: Quote,
  amountIn: bigint,
  amountOutMin: bigint,
  recipient: string,
  deadline: bigint,
): string {
  switch (quote.dex) {
    case "uniswapV3":
      if (!quote.feeTiers) throw new Error("V3 quote is missing fee tiers");
      return encodeV3Swap(quote.path, quote.feeTiers, amountIn, amountOutMin, recipient, deadline);
    case "sushiswap":
      return encodeSushiSwap(amountIn, amountOutMin, quote.path, recipient, deadline);
    case "uniswapV2":
      return encodeV2Swap(amountIn, amountOutMin, quote.path, recipient, deadline);
  }
}
