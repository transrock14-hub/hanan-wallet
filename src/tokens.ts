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
const FAMOUS = ['ETH', 'WETH', 'USDT', 'USDC', 'DAI', 'LINK', 'WBTC', 'BTC', 'BNB', 'POL', 'MATIC', 'SEPOLIAETH'];
const KNOWN = new Set(NETWORKS.flatMap((n) => n.presets.map((p) => p.address.toLowerCase())));

export function isLookalike(t: Token) {
  return FAMOUS.includes(t.symbol.trim().toUpperCase()) && !KNOWN.has(t.address.toLowerCase());
}

const key = () => `tokens:${settings.network.chainId}`;

export function listTokens(): Token[] {
  try {
    return JSON.parse(localStorage.getItem(key()) || '[]');
  } catch {
    return [];
  }
}

export function saveToken(t: Token) {
  const all = listTokens().filter((x) => x.address.toLowerCase() !== t.address.toLowerCase());
  all.push({ ...t, address: getAddress(t.address) });
  localStorage.setItem(key(), JSON.stringify(all));
}

export function removeToken(address: string) {
  localStorage.setItem(key(), JSON.stringify(listTokens().filter((x) => x.address.toLowerCase() !== address.toLowerCase())));
}
