import { getAddress } from 'ethers';
import { NETWORKS, settings } from './config';

export interface Token {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
}

/**
 * Symbols scammers copy. A token using one of these from an address that is not a known
 * preset is flagged, because anyone can deploy a contract that calls itself "USDT".
 */
const FAMOUS = [
  'ETH', 'WETH', 'USDT', 'USDT0', 'USD₮0', 'USDC', 'DAI', 'LINK', 'WBTC', 'CBBTC', 'BTC', 'BTCB', 'BTC.B',
  'BNB', 'WBNB', 'POL', 'MATIC', 'AVAX', 'ARB', 'OP', 'WETH.E', 'SEPOLIAETH',
];
const KNOWN = new Set(NETWORKS.flatMap((n) => n.presets.map((p) => p.address.toLowerCase())));

export function isLookalike(t: Token) {
  return FAMOUS.includes(t.symbol.trim().toUpperCase()) && !KNOWN.has(t.address.toLowerCase());
}

const key = () => `tokens:${settings.network.chainId}`;

export function listTokens(): Token[] {
  const stored = localStorage.getItem(key());
  // First visit to a mainnet: start with its common coins so balances show without importing.
  if (stored === null && settings.network.mainnet) {
    const seeded = settings.network.presets.map(({ address, name, symbol, decimals }) => ({ address, name, symbol, decimals }));
    localStorage.setItem(key(), JSON.stringify(seeded));
    return seeded;
  }
  try {
    return JSON.parse(stored || '[]');
  } catch {
    return [];
  }
}

// Tokens the user removed, so incoming-token discovery doesn't add them back.
const hiddenKey = () => `hiddenTokens:${settings.network.chainId}`;

function listHidden(): string[] {
  try {
    return JSON.parse(localStorage.getItem(hiddenKey()) || '[]');
  } catch {
    return [];
  }
}

function setHidden(address: string, hidden: boolean) {
  const a = address.toLowerCase();
  const rest = listHidden().filter((x) => x !== a);
  localStorage.setItem(hiddenKey(), JSON.stringify(hidden ? [...rest, a] : rest));
}

export function saveToken(t: Token) {
  const all = listTokens().filter((x) => x.address.toLowerCase() !== t.address.toLowerCase());
  all.push({ ...t, address: getAddress(t.address) });
  localStorage.setItem(key(), JSON.stringify(all));
  setHidden(t.address, false);
}

/**
 * Adds a token found by incoming-transfer discovery, unless the user removed it or it is a lookalike
 * (scam airdrops of fake "USDT" are common). Returns true when it was newly added.
 */
export function discoverToken(t: Token) {
  const a = t.address.toLowerCase();
  if (listHidden().includes(a) || isLookalike(t)) return false;
  if (listTokens().some((x) => x.address.toLowerCase() === a)) return false;
  saveToken(t);
  return true;
}

export function removeToken(address: string) {
  localStorage.setItem(key(), JSON.stringify(listTokens().filter((x) => x.address.toLowerCase() !== address.toLowerCase())));
  setHidden(address, true);
}
