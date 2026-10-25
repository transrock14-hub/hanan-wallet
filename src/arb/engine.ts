import {
  AbiCoder,
  Contract,
  ContractFactory,
  Interface,
  dataSlice,
  getAddress,
  isAddress,
  isCallException,
  type TransactionRequest,
} from "ethers";
import arbArtifact from "../arb-artifact.json";
import mocks from "../arb-mocks.json";
import { settings } from "../config";
import * as w from "../wallet";
import { OnChainQuoteSource, encodeSwap, type DexVenue } from "./dex/quoter";
import { gasCostUsdE8, minBigInt, parseUnits, parseUsd } from "./math";
import { scanAll, type Opportunity, type TokenPair } from "./scanner";

/**
 * The flash-arb bot, run from the wallet. The bot's .env becomes per-network settings in localStorage,
 * and the wallet's active account signs instead of a PRIVATE_KEY.
 */

export interface ArbToken {
  symbol: string;
  address: string;
  decimals: number;
}

export interface ArbPair {
  base: ArbToken;
  quote: ArbToken;
  /** Whole base tokens to flash-borrow, e.g. "1000". */
  borrowAmount: string;
  /** USD price of one base token. Only drives the profit thresholds. */
  baseUsd: string;
}

export interface ArbConfig {
  pool: string;
  addressesProvider: string;
  contract: string;
  uniswapV2: string;
  sushiswap: string;
  uniswapV3Router: string;
  uniswapV3Quoter: string;
  feeTiers: string;
  minProfitUsd: string;
  maxLoanUsd: string;
  slippageBps: string;
  /** Used for gas math where the wallet has no live price (test networks). */
  nativeUsd: string;
  /** Refuse to send above this maxFeePerGas. Empty = no cap. */
  maxGwei: string;
  pairs: ArbPair[];
  /** Set by the practice-market setup; open-mint test contracts. */
  practice?: boolean;
}

const BLANK: ArbConfig = {
  pool: "",
  addressesProvider: "",
  contract: "",
  uniswapV2: "",
  sushiswap: "",
  uniswapV3Router: "",
  uniswapV3Quoter: "",
  feeTiers: "500,3000,10000",
  minProfitUsd: "5",
  maxLoanUsd: "10000",
  slippageBps: "50",
  nativeUsd: "2500",
  maxGwei: "50",
  pairs: [],
};

// Each address was checked on-chain on 2026-10-25: Aave pools report these providers, and the
// Uniswap/Sushi routers and quoters report the official factories.
const DEFAULTS: Record<string, Partial<ArbConfig>> = {
  "11155111": {
    pool: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
    addressesProvider: "0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A",
    uniswapV2: "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3",
    uniswapV3Router: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
    uniswapV3Quoter: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
    pairs: [
      {
        base: { symbol: "USDC", address: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8", decimals: 6 },
        quote: { symbol: "WETH", address: "0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c", decimals: 18 },
        borrowAmount: "1000",
        baseUsd: "1",
      },
    ],
  },
  "1": {
    pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    addressesProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
    uniswapV2: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    sushiswap: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
    uniswapV3Router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    uniswapV3Quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    maxLoanUsd: "1000",
    pairs: [
      {
        base: { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
        quote: { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
        borrowAmount: "1000",
        baseUsd: "1",
      },
    ],
  },
};

const key = () => `arb:${settings.network.chainId}`;

export function loadConfig(): ArbConfig {
  try {
    const saved = localStorage.getItem(key());
    if (saved) return { ...BLANK, ...JSON.parse(saved) };
  } catch {
    /* fall back to defaults */
  }
  return { ...BLANK, ...DEFAULTS[String(settings.network.chainId)] };
}

export function saveConfig(cfg: ArbConfig) {
  localStorage.setItem(key(), JSON.stringify(cfg));
}

export function resetConfig() {
  localStorage.removeItem(key());
}

const optAddr = (v: string, what: string) => {
  const s = v.trim();
  if (!s) return "";
  if (!isAddress(s)) throw new Error(`${what} is not a valid 0x address.`);
  return getAddress(s);
};

/** Checks the settings the way the bot's zod schema did, and normalizes addresses. */
export function validate(cfg: ArbConfig): ArbConfig {
  const out: ArbConfig = {
    ...cfg,
    pool: optAddr(cfg.pool, "Aave pool"),
    addressesProvider: optAddr(cfg.addressesProvider, "Aave addresses provider"),
    contract: optAddr(cfg.contract, "Arbitrage contract"),
    uniswapV2: optAddr(cfg.uniswapV2, "Uniswap V2 router"),
    sushiswap: optAddr(cfg.sushiswap, "SushiSwap router"),
    uniswapV3Router: optAddr(cfg.uniswapV3Router, "Uniswap V3 router"),
    uniswapV3Quoter: optAddr(cfg.uniswapV3Quoter, "Uniswap V3 quoter"),
  };
  if (!!out.uniswapV3Router !== !!out.uniswapV3Quoter)
    throw new Error("Uniswap V3 router and quoter must be set together.");
  const tiers = out.feeTiers.split(",").map((s) => Number(s.trim()));
  if (!tiers.length || tiers.some((t) => !Number.isInteger(t) || t <= 0 || t > 1_000_000))
    throw new Error("Fee tiers must be whole numbers, e.g. 500,3000,10000.");
  for (const [v, what] of [
    [out.minProfitUsd, "Minimum profit"],
    [out.maxLoanUsd, "Max flash loan"],
    [out.nativeUsd, `${settings.network.nativeSymbol} price`],
  ])
    if (!/^\d+(\.\d{1,8})?$/.test(v.trim())) throw new Error(`${what} must be a dollar amount.`);
  const slip = Number(out.slippageBps);
  // Capped at 10% like the bot: anything wider is almost certainly a mistake and invites sandwiching.
  if (!Number.isInteger(slip) || slip < 0 || slip > 1000)
    throw new Error("Slippage must be 0 to 1000 basis points (10%).");
  if (out.maxGwei.trim() && !/^\d+(\.\d+)?$/.test(out.maxGwei.trim()))
    throw new Error("Gas cap must be a number of gwei, or empty.");
  return out;
}

export function venues(cfg: ArbConfig): DexVenue[] {
  const v: DexVenue[] = [];
  if (cfg.uniswapV2) v.push({ name: "uniswapV2", kind: "v2", router: cfg.uniswapV2 });
  if (cfg.sushiswap) v.push({ name: "sushiswap", kind: "v2", router: cfg.sushiswap });
  if (cfg.uniswapV3Router && cfg.uniswapV3Quoter)
    v.push({
      name: "uniswapV3",
      kind: "v3",
      router: cfg.uniswapV3Router,
      quoter: cfg.uniswapV3Quoter,
      feeTiers: cfg.feeTiers.split(",").map((s) => Number(s.trim())),
    });
  return v;
}

const routers = (cfg: ArbConfig) =>
  [...new Set([cfg.uniswapV2, cfg.sushiswap, cfg.uniswapV3Router].filter(Boolean))];

// ---------- Contract ----------

const arbInterface = new Interface(arbArtifact.abi);
const ERROR_STRING_SELECTOR = "0x08c379a0";
const POOL_ABI = [
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
  "function getReserveData(address asset) view returns (tuple(tuple(uint256 data) configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
];
const BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];

/** Decodes the contract's custom errors, including the router reason nested in SwapFailed. */
export function decodeRevert(data: string | null | undefined): string {
  if (!data || data === "0x") return "reverted without data";
  if (data.startsWith(ERROR_STRING_SELECTOR)) {
    const [msg] = AbiCoder.defaultAbiCoder().decode(["string"], dataSlice(data, 4));
    return String(msg);
  }
  const parsed = arbInterface.parseError(data);
  if (!parsed) return `unknown error ${data.slice(0, 10)}`;
  if (parsed.name === "SwapFailed")
    return `Swap ${Number(parsed.args[0]) + 1} failed: ${decodeRevert(parsed.args[1] as string)}`;
  if (parsed.name === "InsufficientProfit")
    return "Not profitable any more (the contract refused it; the spread closed or prices are off).";
  if (parsed.name === "RouterNotApproved") return `Router ${parsed.args[0]} is not approved in the contract.`;
  return `${parsed.name}(${parsed.args.map((a: unknown) => String(a)).join(", ")})`;
}

async function needCode(addr: string, what: string) {
  const { provider } = w.connection();
  if (!addr || (await provider.getCode(addr)) === "0x")
    throw new Error(`No ${what} contract at that address on ${settings.network.name}.`);
}

/** Deploys FlashLoanArbitrage owned by the active account, then approves every configured router. */
export async function deployContract(cfg: ArbConfig, progress: (s: string) => void): Promise<ArbConfig> {
  const { signer } = w.connection();
  await needCode(cfg.addressesProvider, "Aave addresses provider");
  if (!routers(cfg).length) throw new Error("Set at least one DEX router first.");
  progress("Deploying the arbitrage contract…");
  const c = await new ContractFactory(arbArtifact.abi, arbArtifact.bytecode, signer).deploy(cfg.addressesProvider);
  await c.waitForDeployment();
  const contract = await c.getAddress();
  const next = { ...cfg, contract };
  saveConfig(next);
  await approveRouters(next, progress);
  return next;
}

/** Approves any configured router the contract doesn't allow yet (owner only). */
export async function approveRouters(cfg: ArbConfig, progress: (s: string) => void) {
  const { signer } = w.connection();
  const arb = new Contract(cfg.contract, arbArtifact.abi, signer);
  for (const r of routers(cfg)) {
    if (await arb.approvedRouters(r)) continue;
    progress(`Approving router ${r.slice(0, 8)}…`);
    await (await arb.setRouterApproval(r, true)).wait();
  }
}

export interface ContractStatus {
  owner: string;
  isOwner: boolean;
  unapproved: string[];
  balances: { token: ArbToken; amount: bigint }[];
}

export async function contractStatus(cfg: ArbConfig): Promise<ContractStatus> {
  const { provider, signer } = w.connection();
  await needCode(cfg.contract, "arbitrage");
  const arb = new Contract(cfg.contract, arbArtifact.abi, provider);
  const owner = getAddress(await arb.owner());
  const approved = await Promise.all(routers(cfg).map((r) => arb.approvedRouters(r) as Promise<boolean>));
  const tokens = new Map<string, ArbToken>();
  for (const p of cfg.pairs) for (const t of [p.base, p.quote]) tokens.set(t.address.toLowerCase(), t);
  const balances = await Promise.all(
    [...tokens.values()].map(async (token) => ({
      token,
      amount: (await new Contract(token.address, BALANCE_ABI, provider)
        .balanceOf(cfg.contract)
        .catch(() => 0n)) as bigint,
    })),
  );
  return {
    owner,
    isOwner: owner === signer.address,
    unapproved: routers(cfg).filter((_, i) => !approved[i]),
    balances,
  };
}

/** Sends the contract's whole balance of a token (profit and leftover dust) to the owner. */
export function withdrawRequest(cfg: ArbConfig, token: string): Promise<TransactionRequest> {
  return new Contract(cfg.contract, arbArtifact.abi).withdraw.populateTransaction(token);
}

// ---------- Scan ----------

export interface ScanResult {
  opportunities: Opportunity[];
  skipped: string[];
  premiumBps: bigint;
  gasCostUsdE8: bigint;
  minProfitUsdE8: bigint;
  nativeUsdE8: bigint;
}

/** Gas assumed per arbitrage while scanning; execution re-estimates it. */
const GAS_LIMIT_ESTIMATE = 500_000n;

const toPair = (p: ArbPair): TokenPair => ({
  base: { ...p.base, usdPrice: parseUsd(p.baseUsd) },
  // The quote token's price never enters the scanner's maths.
  quote: { ...p.quote, usdPrice: 0n },
  borrowAmountWei: parseUnits(p.borrowAmount, p.base.decimals),
});

/** One scan cycle of the bot: quote every pair on every DEX pair, net of premium and gas. */
export async function scan(cfg: ArbConfig, liveNativeUsd: number | null): Promise<ScanResult> {
  const { provider } = w.connection();
  const vs = venues(cfg);
  if (vs.length < 2) throw new Error("Configure at least two DEX venues to compare prices.");
  if (!cfg.pairs.length) throw new Error("Add a token pair to scan.");
  let premiumBps = 9n;
  if (cfg.pool)
    premiumBps = await new Contract(cfg.pool, POOL_ABI, provider)
      .FLASHLOAN_PREMIUM_TOTAL()
      .catch(() => 9n);
  const fee = await provider.getFeeData();
  const nativeUsdE8 = parseUsd(liveNativeUsd != null ? liveNativeUsd.toFixed(2) : cfg.nativeUsd);
  const gasCost = gasCostUsdE8(GAS_LIMIT_ESTIMATE, fee.maxFeePerGas ?? fee.gasPrice ?? 0n, nativeUsdE8);
  const minProfitUsdE8 = parseUsd(cfg.minProfitUsd);
  const skipped: string[] = [];
  const opportunities = await scanAll(cfg.pairs.map(toPair), {
    quoteSource: new OnChainQuoteSource(provider),
    venues: vs,
    premiumBps: BigInt(premiumBps),
    slippageBps: BigInt(cfg.slippageBps),
    minProfitUsdE8,
    maxFlashLoanUsdE8: parseUsd(cfg.maxLoanUsd),
    gasCostUsdE8: gasCost,
    onSkip: (r) => skipped.push(r),
  });
  return { opportunities, skipped, premiumBps: BigInt(premiumBps), gasCostUsdE8: gasCost, minProfitUsdE8, nativeUsdE8 };
}

// ---------- Execute ----------

/**
 * The bot's execution pipeline up to signing: liquidity check, calldata, eth_call simulation,
 * gas estimate and worst-case-gas profit check. Throws a readable reason when it should not be sent.
 */
export async function prepare(cfg: ArbConfig, opp: Opportunity, scanned: ScanResult): Promise<w.Quote> {
  const { provider, signer } = w.connection();
  if (!cfg.contract) throw new Error("Deploy the arbitrage contract first.");
  const arb = new Contract(cfg.contract, arbArtifact.abi, provider);
  if (getAddress(await arb.owner()) !== signer.address)
    throw new Error("The active account doesn't own this arbitrage contract. Switch to the account that deployed it.");

  if (cfg.pool) {
    const liquidity = await availableLiquidity(cfg.pool, opp.pair.base.address);
    if (liquidity !== null && liquidity < opp.amountIn) throw new Error("Aave doesn't have enough of that token to lend.");
  }

  // Chain time, not the phone clock, so a skewed clock can't produce expired deadlines.
  const latest = await provider.getBlock("latest");
  const deadline = BigInt(latest?.timestamp ?? Math.floor(Date.now() / 1000)) + 60n;
  const swapDataA = encodeSwap(opp.leg1, opp.amountIn, opp.leg1MinOut, cfg.contract, deadline);
  const swapDataB = encodeSwap(opp.leg2, opp.leg1MinOut, opp.leg2MinOut, cfg.contract, deadline);
  const data = arbInterface.encodeFunctionData("requestFlashLoan", [
    opp.pair.base.address,
    opp.amountIn,
    opp.leg1.router,
    opp.leg2.router,
    swapDataA,
    swapDataB,
    opp.minProfitToken,
    opp.pair.quote.address,
  ]);
  const request = { from: signer.address, to: cfg.contract, data };

  try {
    await provider.call({ ...request, blockTag: "latest" });
  } catch (e) {
    throw new Error(isCallException(e) ? decodeRevert(e.data) : `Simulation failed: ${(e as Error).message}`);
  }

  const gasLimit = ((await provider.estimateGas(request)) * 120n) / 100n;
  const feeData = await provider.getFeeData();
  const cap = cfg.maxGwei.trim() ? parseUnits(cfg.maxGwei.trim(), 9) : null;
  const price = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  if (cap !== null && price > cap) throw new Error("Gas is above your cap right now. Try again later.");
  // The full gas limit at the max fee must still leave the minimum profit, or it's a likely loss.
  const worstGasUsd = gasCostUsdE8(gasLimit, price, scanned.nativeUsdE8);
  if (opp.grossProfitUsdE8 - worstGasUsd < scanned.minProfitUsdE8)
    throw new Error("Gas would eat the profit on this one.");

  const priced: TransactionRequest = { ...request, gasLimit };
  if (feeData.maxFeePerGas != null && feeData.maxPriorityFeePerGas != null) {
    priced.maxFeePerGas = feeData.maxFeePerGas;
    priced.maxPriorityFeePerGas = minBigInt(feeData.maxPriorityFeePerGas, feeData.maxFeePerGas);
  } else priced.gasPrice = price;
  return { request: priced, gasLimit, fee: gasLimit * price };
}

async function availableLiquidity(pool: string, asset: string): Promise<bigint | null> {
  const { provider } = w.connection();
  try {
    const reserve = await new Contract(pool, POOL_ABI, provider).getReserveData(asset);
    return (await new Contract(asset, BALANCE_ABI, provider).balanceOf(reserve.aTokenAddress)) as bigint;
  } catch {
    return null;
  }
}

// ---------- Practice market (test networks only) ----------

/**
 * Deploys the bot's local demo on the current test network: practice tokens pUSD and pETH, a stand-in
 * Aave pool holding 1,000,000 pUSD, and two DEXes pricing pETH at 2500 and 2550 pUSD (a 2% gap).
 */
export async function setupPractice(progress: (s: string) => void): Promise<ArbConfig> {
  if (settings.network.mainnet)
    throw new Error("Practice markets use open-mint test contracts and are only for test networks.");
  const { signer } = w.connection();
  const deploy = async (name: keyof typeof mocks, label: string, ...args: unknown[]) => {
    progress(`Deploying ${label}…`);
    const c = await new ContractFactory(mocks[name].abi, mocks[name].bytecode, signer).deploy(...args);
    await c.waitForDeployment();
    return { c: c as Contract, address: await c.getAddress() };
  };
  const usd = await deploy("MockERC20", "practice dollar (pUSD)", "Practice USD", "pUSD", 6);
  const eth = await deploy("MockERC20", "practice ether (pETH)", "Practice ETH", "pETH", 18);
  const pool = await deploy("MockAavePool", "practice lending pool", 9);
  const provider = await deploy("MockPoolAddressesProvider", "pool registry", pool.address);
  progress("Funding the lending pool…");
  await (await usd.c.mint(pool.address, parseUnits("1000000", 6))).wait();
  const dexA = await deploy("MockRouter", "DEX A");
  const dexB = await deploy("MockRouter", "DEX B");
  progress("Setting DEX prices…");
  // Base units: 1 pUSD is 1e6, 1 pETH is 1e18. DEX A: 2500 pUSD per pETH, DEX B: 2550.
  for (const [dex, px] of [[dexA, 2500n], [dexB, 2550n]] as const) {
    await (await dex.c.setRate(usd.address, eth.address, 10n ** 12n, px)).wait();
    await (await dex.c.setRate(eth.address, usd.address, px, 10n ** 12n)).wait();
  }
  const cfg: ArbConfig = {
    ...BLANK,
    pool: pool.address,
    addressesProvider: provider.address,
    uniswapV2: dexA.address,
    sushiswap: dexB.address,
    pairs: [
      {
        base: { symbol: "pUSD", address: usd.address, decimals: 6 },
        quote: { symbol: "pETH", address: eth.address, decimals: 18 },
        borrowAmount: "1000",
        baseUsd: "1",
      },
    ],
    practice: true,
  };
  saveConfig(cfg);
  return deployContract(cfg, progress);
}
