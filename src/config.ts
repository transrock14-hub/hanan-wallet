import type { Token } from './tokens';

/**
 * Networks the wallet can use. Every RPC connection is checked against the chain ID listed here.
 * Ethereum (chain 1) is real money. The other entries are test networks.
 */
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
  presets: (Token & { source: string })[];
}

const circleUsdc = (address: string): Token & { source: string } => ({
  address,
  name: 'USDC',
  symbol: 'USDC',
  decimals: 6,
  source: 'Circle test USDC. Free at faucet.circle.com',
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
    name: 'Anvil (this computer)',
    nativeSymbol: 'ETH',
    rpc: 'http://10.0.2.2:8545',
    explorer: '',
    faucet: 'Anvil already holds test ETH on its built-in accounts. Send some to your address from one of those accounts.',
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
    presets: [
      {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        source: 'Circle USDC on Ethereum.',
      },
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
