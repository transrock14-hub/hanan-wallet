import type { DexVenue, Quote, QuoteSource } from "./dex/quoter";
import {
  applySlippage,
  computeProfit,
  flashLoanPremium,
  formatUsd,
  tokenToUsdE8,
  usdE8ToToken,
} from "./math";

/** A token in a scanned pair. `usdPrice` (USD * 1e8) only drives thresholds, never trade sizing. */
export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
  usdPrice: bigint;
}

/** `base` is flash-borrowed from Aave; `quote` is the intermediate token. */
export interface TokenPair {
  base: TokenInfo;
  quote: TokenInfo;
  borrowAmountWei: bigint;
}

/** Inputs the scanner needs; everything is injected so tests need no RPC. */
export interface ScanContext {
  quoteSource: QuoteSource;
  venues: DexVenue[];
  /** Aave flash loan premium in bps. */
  premiumBps: bigint;
  slippageBps: bigint;
  minProfitUsdE8: bigint;
  maxFlashLoanUsdE8: bigint;
  /** Estimated gas cost of one arbitrage tx, USD * 1e8. */
  gasCostUsdE8: bigint;
  /** Called for each pair skipped before quoting (the bot logged these). */
  onSkip?: (reason: string) => void;
}

/** A priced round trip: borrow base -> buy quote on leg1 -> sell on leg2. */
export interface Opportunity {
  pair: TokenPair;
  amountIn: bigint;
  leg1: Quote;
  leg2: Quote;
  /** amountOutMin for leg 1, and the exact amountIn encoded for leg 2. */
  leg1MinOut: bigint;
  leg2MinOut: bigint;
  premium: bigint;
  expectedOut: bigint;
  /** Profit in base-token units before gas (expectedOut - amountIn - premium). */
  grossProfitToken: bigint;
  grossProfitUsdE8: bigint;
  gasCostUsdE8: bigint;
  netProfitUsdE8: bigint;
  /** On-chain floor passed to the contract: (min profit + gas) in base units. */
  minProfitToken: bigint;
}

/**
 * Prices every leg1/leg2 venue combination for one pair.
 * @param pair Token pair and borrow size.
 * @param ctx Scan context.
 * @returns All priced round trips (unfiltered).
 */
export async function scanPair(pair: TokenPair, ctx: ScanContext): Promise<Opportunity[]> {
  const { base, quote } = pair;
  const amountIn = pair.borrowAmountWei;

  const leg1Quotes = await Promise.all(
    ctx.venues.map((v) => ctx.quoteSource.quote(v, base.address, quote.address, amountIn)),
  );

  const tasks: Promise<Opportunity | null>[] = [];
  leg1Quotes.forEach((leg1) => {
    if (!leg1) return;
    for (const venue of ctx.venues) {
      // Same-DEX round trips can't capture a cross-venue spread and only pay
      // fees twice, so they are skipped.
      if (venue.name === leg1.dex) continue;
      tasks.push(priceRoundTrip(pair, amountIn, leg1, venue, ctx));
    }
  });

  const results = await Promise.all(tasks);
  return results.filter((o): o is Opportunity => o !== null);
}

/**
 * Quotes leg 2 and computes profit for one leg1/venue combination.
 * @param pair Token pair.
 * @param amountIn Borrowed amount.
 * @param leg1 Leg 1 quote (base -> quote).
 * @param venue Venue for leg 2 (quote -> base).
 * @param ctx Scan context.
 * @returns Priced opportunity or null if leg 2 has no route.
 */
async function priceRoundTrip(
  pair: TokenPair,
  amountIn: bigint,
  leg1: Quote,
  venue: DexVenue,
  ctx: ScanContext,
): Promise<Opportunity | null> {
  // Leg 2's input is fixed in pre-encoded calldata, so it must be the worst
  // case leg 1 output (after slippage). Quoting with that amount keeps the
  // estimate honest; any extra leg-1 output stays in the contract as dust.
  const leg1MinOut = applySlippage(leg1.amountOut, ctx.slippageBps);
  if (leg1MinOut === 0n) return null;

  const leg2 = await ctx.quoteSource.quote(venue, pair.quote.address, pair.base.address, leg1MinOut);
  if (!leg2) return null;

  const { decimals, usdPrice } = pair.base;
  const premium = flashLoanPremium(amountIn, ctx.premiumBps);
  const grossProfitToken = computeProfit(leg2.amountOut, amountIn, premium);
  const grossProfitUsdE8 = tokenToUsdE8(grossProfitToken, decimals, usdPrice);

  return {
    pair,
    amountIn,
    leg1,
    leg2,
    leg1MinOut,
    leg2MinOut: applySlippage(leg2.amountOut, ctx.slippageBps),
    premium,
    expectedOut: leg2.amountOut,
    grossProfitToken,
    grossProfitUsdE8,
    gasCostUsdE8: ctx.gasCostUsdE8,
    netProfitUsdE8: grossProfitUsdE8 - ctx.gasCostUsdE8,
    // Requiring (min profit + gas) on-chain means a filled tx is net-positive
    // even after paying gas in the native token.
    minProfitToken: usdE8ToToken(ctx.minProfitUsdE8 + ctx.gasCostUsdE8, decimals, usdPrice),
  };
}

/**
 * Scans all pairs and returns profitable opportunities, best first.
 * Pairs whose borrow size exceeds MAX_FLASH_LOAN_USD are skipped, not resized.
 * @param pairs Configured token pairs.
 * @param ctx Scan context.
 * @returns Opportunities with netProfitUsd >= MIN_PROFIT_USD, sorted desc.
 */
export async function scan(pairs: readonly TokenPair[], ctx: ScanContext): Promise<Opportunity[]> {
  return (await scanAll(pairs, ctx)).filter((o) => o.netProfitUsdE8 >= ctx.minProfitUsdE8);
}

/**
 * Like `scan`, but keeps round trips below MIN_PROFIT_USD so the app can show how close they are.
 * @param pairs Configured token pairs.
 * @param ctx Scan context.
 * @returns Every priced round trip, best first.
 */
export async function scanAll(pairs: readonly TokenPair[], ctx: ScanContext): Promise<Opportunity[]> {
  const eligible = pairs.filter((pair) => {
    const borrowUsd = tokenToUsdE8(pair.borrowAmountWei, pair.base.decimals, pair.base.usdPrice);
    if (borrowUsd > ctx.maxFlashLoanUsdE8) {
      ctx.onSkip?.(`${pair.base.symbol}/${pair.quote.symbol}: borrow of $${formatUsd(borrowUsd)} is over the max flash loan`);
      return false;
    }
    return true;
  });

  const perPair = await Promise.all(eligible.map((pair) => scanPair(pair, ctx)));
  return perPair
    .flat()
    .sort((a, b) => (b.netProfitUsdE8 > a.netProfitUsdE8 ? 1 : b.netProfitUsdE8 < a.netProfitUsdE8 ? -1 : 0));
}

/**
 * Compact, log-safe summary of an opportunity (bigints as strings).
 * @param o Opportunity.
 * @returns Plain object for pino.
 */
export function describeOpportunity(o: Opportunity): Record<string, string> {
  return {
    pair: `${o.pair.base.symbol}/${o.pair.quote.symbol}`,
    route: `${o.leg1.dex}${o.leg1.feeTiers ? `(${o.leg1.feeTiers.join("/")})` : ""} -> ${o.leg2.dex}${o.leg2.feeTiers ? `(${o.leg2.feeTiers.join("/")})` : ""}`,
    amountIn: o.amountIn.toString(),
    expectedOut: o.expectedOut.toString(),
    premium: o.premium.toString(),
    grossProfitUsd: formatUsd(o.grossProfitUsdE8),
    gasCostUsd: formatUsd(o.gasCostUsdE8),
    netProfitUsd: formatUsd(o.netProfitUsdE8),
  };
}
