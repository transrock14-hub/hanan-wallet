import type { Token } from './tokens';

/**
 * Networks the wallet can use. Every RPC connection is checked against the chain ID listed here.
 * Networks with `mainnet: true` hold real money. The other entries are test networks.
 */
export type Preset = Token & { source: string; stable?: boolean };

export interface Network {
  chainId: bigint;
  name: string;
  nativeSymbol: string;
  rpc: string;
  explorer: string;
  faucet: string;
  /** Opens in the browser. Empty when this network has no public faucet. */
  faucetUrl: string;
  /** Blockscout-style API base, without a trailing slash. Empty when incoming history is read from the node. */
  historyApi: string;
  presets: Preset[];
  /** Real funds. Mainnets get price lines, extra warnings, and their common coins added on first use. */
  mainnet?: boolean;
  /** CoinGecko coin ID of the native coin and asset-platform ID for token prices. */
  priceId?: string;
  pricePlatform?: string;
  /** Trust Wallet coin ID for its add-asset link. Left out where it is not confirmed. */
  trustId?: string;
}

const circleUsdc = (address: string): Preset => ({
  address,
  name: 'USDC',
  symbol: 'USDC',
  decimals: 6,
  source: 'Circle test USDC. Free at faucet.circle.com',
});

/** A real-asset preset. Each address, symbol and decimals value was read from the chain on 2026-10-20. */
const real = (address: string, name: string, symbol: string, decimals: number, issuer: string, stable = false): Preset => ({
  address,
  name,
  symbol,
  decimals,
  source: `${issuer}. Official contract.`,
  stable,
});

export const NETWORKS: Network[] = [
  {
    chainId: 11155111n,
    name: 'Sepolia',
    nativeSymbol: 'SepoliaETH',
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.etherscan.io',
    faucet: 'Google Cloud Web3 faucet',
    faucetUrl: 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia',
    historyApi: 'https://eth-sepolia.blockscout.com/api/v2',
    presets: [
      circleUsdc('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'),
      {
        address: '0x779877A7B0D9E8603169DdbD7836e478b4624789',
        name: 'ChainLink Token',
        symbol: 'LINK',
        decimals: 18,
        source: 'Chainlink test LINK. Free at faucets.chain.link',
      },
    ],
  },
  {
    chainId: 84532n,
    name: 'Base Sepolia',
    nativeSymbol: 'ETH (Base Sepolia)',
    rpc: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    faucet: 'Coinbase / Alchemy Base Sepolia faucet',
    faucetUrl: 'https://portal.cdp.coinbase.com/products/faucet',
    historyApi: 'https://base-sepolia.blockscout.com/api/v2',
    presets: [circleUsdc('0x036CbD53842c5426634e7929541eC2318f3dCF7e')],
  },
  {
    chainId: 421614n,
    name: 'Arbitrum Sepolia',
    nativeSymbol: 'ETH (Arb Sepolia)',
    rpc: 'https://sepolia-rollup.arbitrum.io/rpc',
    explorer: 'https://sepolia.arbiscan.io',
    faucet: 'Arbitrum bridge from Sepolia, or an Arbitrum Sepolia faucet',
    faucetUrl: 'https://www.alchemy.com/faucets/arbitrum-sepolia',
    historyApi: '',
    presets: [circleUsdc('0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d')],
  },
  {
    chainId: 11155420n,
    name: 'OP Sepolia',
    nativeSymbol: 'ETH (OP Sepolia)',
    rpc: 'https://sepolia.optimism.io',
    explorer: 'https://sepolia-optimism.etherscan.io',
    faucet: 'Superchain faucet (console.optimism.io)',
    faucetUrl: 'https://console.optimism.io/faucet',
    historyApi: 'https://testnet-explorer.optimism.io/api/v2',
    presets: [circleUsdc('0x5fd84259d66Cd46123540766Be93DFE6D43130D7')],
  },
  {
    chainId: 80002n,
    name: 'Polygon Amoy',
    nativeSymbol: 'POL (Amoy)',
    rpc: 'https://polygon-amoy-bor-rpc.publicnode.com',
    explorer: 'https://amoy.polygonscan.com',
    faucet: 'faucet.polygon.technology',
    faucetUrl: 'https://faucet.polygon.technology/',
    historyApi: '',
    presets: [circleUsdc('0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582')],
  },
  {
    chainId: 31337n,
    name: 'Anvil',
    nativeSymbol: 'ETH',
    rpc: 'https://hanan-anvil.onrender.com',
    explorer: '',
    faucet: 'This is the shared Anvil chain. The first connection after it sleeps can take about a minute.',
    faucetUrl: '',
    historyApi: '',
    presets: [],
  },
  {
    chainId: 1n,
    name: 'Ethereum',
    nativeSymbol: 'ETH',
    rpc: 'https://ethereum-rpc.publicnode.com',
    explorer: 'https://etherscan.io',
    faucet: 'This is Ethereum mainnet. The ETH here is real.',
    faucetUrl: '',
    historyApi: 'https://eth.blockscout.com/api/v2',
    mainnet: true,
    priceId: 'ethereum',
    pricePlatform: 'ethereum',
    trustId: 'c60',
    presets: [
      real('0xdAC17F958D2ee523a2206206994597C13D831ec7', 'Tether USD', 'USDT', 6, 'Tether', true),
      real('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USD Coin', 'USDC', 6, 'Circle', true),
      real('0x6B175474E89094C44Da98b954EedeAC495271d0F', 'Dai Stablecoin', 'DAI', 18, 'MakerDAO', true),
      real('0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 'Wrapped BTC', 'WBTC', 8, 'BitGo'),
      real('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 'Coinbase Wrapped BTC', 'cbBTC', 8, 'Coinbase'),
      real('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'Wrapped Ether', 'WETH', 18, 'WETH9'),
      real('0x514910771AF9Ca656af840dff83E8264EcF986CA', 'ChainLink Token', 'LINK', 18, 'Chainlink'),
    ],
  },
  {
    chainId: 56n,
    name: 'BNB Smart Chain',
    nativeSymbol: 'BNB',
    rpc: 'https://bsc-rpc.publicnode.com',
    explorer: 'https://bscscan.com',
    faucet: 'This is BNB Smart Chain. The BNB here is real. Binance deposits often use this network (BEP20).',
    faucetUrl: '',
    historyApi: '',
    mainnet: true,
    priceId: 'binancecoin',
    pricePlatform: 'binance-smart-chain',
    trustId: 'c20000714',
    presets: [
      real('0x55d398326f99059fF775485246999027B3197955', 'Tether USD', 'USDT', 18, 'Binance-Peg Tether (BEP20)', true),
      real('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 'USD Coin', 'USDC', 18, 'Binance-Peg USDC (BEP20)', true),
      real('0x2170Ed0880ac9A755fd29B2688956BD959F933F8', 'Ethereum Token', 'ETH', 18, 'Binance-Peg Ether (BEP20)'),
      real('0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', 'BTCB Token', 'BTCB', 18, 'Binance-Peg Bitcoin (BEP20)'),
      real('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 'Wrapped BNB', 'WBNB', 18, 'Wrapped BNB'),
    ],
  },
  {
    chainId: 137n,
    name: 'Polygon',
    nativeSymbol: 'POL',
    rpc: 'https://polygon-bor-rpc.publicnode.com',
    explorer: 'https://polygonscan.com',
    faucet: 'This is Polygon PoS. The POL here is real.',
    faucetUrl: '',
    historyApi: '',
    mainnet: true,
    priceId: 'polygon-ecosystem-token',
    pricePlatform: 'polygon-pos',
    trustId: 'c966',
    presets: [
      real('0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 'USDT0', 'USDT0', 6, 'Tether USDT on Polygon (now branded USDT0)', true),
      real('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 'USD Coin', 'USDC', 6, 'Circle native USDC', true),
      real('0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 'Wrapped Ether', 'WETH', 18, 'Bridged Ether'),
      real('0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', '(PoS) Wrapped BTC', 'WBTC', 8, 'Bridged WBTC'),
    ],
  },
  {
    chainId: 8453n,
    name: 'Base',
    nativeSymbol: 'ETH',
    rpc: 'https://base-rpc.publicnode.com',
    explorer: 'https://basescan.org',
    faucet: 'This is Base, Coinbase’s network. The ETH here is real.',
    faucetUrl: '',
    historyApi: '',
    mainnet: true,
    priceId: 'ethereum',
    pricePlatform: 'base',
    presets: [
      real('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USD Coin', 'USDC', 6, 'Circle native USDC', true),
      real('0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', 'Dai Stablecoin', 'DAI', 18, 'Bridged DAI', true),
      real('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 'Coinbase Wrapped BTC', 'cbBTC', 8, 'Coinbase'),
      real('0x4200000000000000000000000000000000000006', 'Wrapped Ether', 'WETH', 18, 'Base WETH'),
    ],
  },
  {
    chainId: 42161n,
    name: 'Arbitrum One',
    nativeSymbol: 'ETH',
    rpc: 'https://arbitrum-one-rpc.publicnode.com',
    explorer: 'https://arbiscan.io',
    faucet: 'This is Arbitrum One. The ETH here is real.',
    faucetUrl: '',
    historyApi: '',
    mainnet: true,
    priceId: 'ethereum',
    pricePlatform: 'arbitrum-one',
    presets: [
      real('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 'USD₮0', 'USD₮0', 6, 'Tether USDT on Arbitrum (now branded USDT0)', true),
      real('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'USD Coin', 'USDC', 6, 'Circle native USDC', true),
      real('0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', 'Wrapped BTC', 'WBTC', 8, 'Bridged WBTC'),
      real('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 'Wrapped Ether', 'WETH', 18, 'Arbitrum WETH'),
      real('0x912CE59144191C1204E64559FE8253a0e49E6548', 'Arbitrum', 'ARB', 18, 'Arbitrum governance token'),
    ],
  },
  {
    chainId: 10n,
    name: 'OP Mainnet',
    nativeSymbol: 'ETH',
    rpc: 'https://optimism-rpc.publicnode.com',
    explorer: 'https://optimistic.etherscan.io',
    faucet: 'This is OP Mainnet (Optimism). The ETH here is real.',
    faucetUrl: '',
    historyApi: 'https://optimism.blockscout.com/api/v2',
    mainnet: true,
    priceId: 'ethereum',
    pricePlatform: 'optimistic-ethereum',
    presets: [
      real('0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 'Tether USD', 'USDT', 6, 'Tether', true),
      real('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 'USD Coin', 'USDC', 6, 'Circle native USDC', true),
      real('0x4200000000000000000000000000000000000006', 'Wrapped Ether', 'WETH', 18, 'OP WETH'),
      real('0x4200000000000000000000000000000000000042', 'Optimism', 'OP', 18, 'Optimism governance token'),
    ],
  },
  {
    chainId: 43114n,
    name: 'Avalanche',
    nativeSymbol: 'AVAX',
    rpc: 'https://avalanche-c-chain-rpc.publicnode.com',
    explorer: 'https://snowtrace.io',
    faucet: 'This is Avalanche C-Chain. The AVAX here is real.',
    faucetUrl: '',
    historyApi: '',
    mainnet: true,
    priceId: 'avalanche-2',
    pricePlatform: 'avalanche',
    presets: [
      real('0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 'TetherToken', 'USDt', 6, 'Tether native USDt', true),
      real('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 'USD Coin', 'USDC', 6, 'Circle native USDC', true),
      real('0x152b9d0FdC40C096757F570A51E494bd4b943E50', 'Bitcoin', 'BTC.b', 8, 'Bridged Bitcoin'),
      real('0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', 'Wrapped Ether', 'WETH.e', 18, 'Bridged Ether'),
    ],
  },
];

const store = {
  get: (k: string) => localStorage.getItem(k),
  set: (k: string, v: string | null) => (v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v)),
};

// One-time move of v1.x settings (Sepolia only) into the per-network keys.
if (store.get('wsethAddress')) {
  store.set('wseth:11155111', store.get('wsethAddress'));
  store.set('wsethAddress', null);
}
if (store.get('tokens')) {
  store.set('tokens:11155111', store.get('tokens'));
  store.set('tokens', null);
}
if (store.get('rpcUrl')) {
  store.set('rpc:11155111', store.get('rpcUrl'));
  store.set('rpcUrl', null);
}

/** Non-secret settings live in localStorage; the recovery phrase never does. */
export const settings = {
  get network(): Network {
    const id = store.get('network');
    return NETWORKS.find((n) => String(n.chainId) === id) ?? NETWORKS[0];
  },
  set network(n: Network) {
    store.set('network', String(n.chainId));
  },
  get rpcUrl(): string {
    const n = this.network;
    return store.get(`rpc:${n.chainId}`) || n.rpc;
  },
  set rpcUrl(v: string | null) {
    store.set(`rpc:${this.network.chainId}`, v);
  },
  get wsethAddress(): string | null {
    return store.get(`wseth:${this.network.chainId}`);
  },
  set wsethAddress(v: string | null) {
    store.set(`wseth:${this.network.chainId}`, v);
  },
  get activeAccount(): number {
    return Number(store.get('activeAccount') || 0);
  },
  set activeAccount(i: number) {
    store.set('activeAccount', String(i));
  },
  get accountCount(): number {
    return Math.max(1, Number(store.get('accountCount') || 1));
  },
  set accountCount(n: number) {
    store.set('accountCount', String(n));
  },
  accountName(i: number): string {
    return store.get(`acctName:${i}`)?.trim() || `Account ${i + 1}`;
  },
  setAccountName(i: number, name: string) {
    store.set(`acctName:${i}`, name.trim() || null);
  },
};

export const explorerTx = (hash: string) => (settings.network.explorer ? `${settings.network.explorer}/tx/${hash}` : '');
export const explorerAddress = (addr: string) => (settings.network.explorer ? `${settings.network.explorer}/address/${addr}` : '');

/** Clears every non-secret setting (used when the wallet is deleted). */
export function resetSettings() {
  localStorage.clear();
}
