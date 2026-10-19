import { getAddress } from 'ethers';
import { settings } from './config';

// ---------- Address book (shared across networks: an address is the same on every EVM chain) ----------

export interface Contact {
  name: string;
  address: string;
}

export function listContacts(): Contact[] {
  try {
    return JSON.parse(localStorage.getItem('contacts') || '[]');
  } catch {
    return [];
  }
}

export function saveContact(name: string, address: string) {
  const a = getAddress(address);
  const all = listContacts().filter((c) => c.address !== a);
  all.push({ name: name.trim() || 'Unnamed', address: a });
  all.sort((x, y) => x.name.localeCompare(y.name));
  localStorage.setItem('contacts', JSON.stringify(all));
}

export function removeContact(address: string) {
  localStorage.setItem('contacts', JSON.stringify(listContacts().filter((c) => c.address !== address)));
}

export const contactName = (address: string) =>
  listContacts().find((c) => c.address.toLowerCase() === address.toLowerCase())?.name;

// ---------- Transaction history (per network and account) ----------

export interface TxRecord {
  hash: string;
  label: string;
  status: 'pending' | 'confirmed' | 'failed';
  time: number;
}

const MAX_HISTORY = 100;
const historyKey = (account: string) => `history:${settings.network.chainId}:${account.toLowerCase()}`;

export function listHistory(account: string): TxRecord[] {
  try {
    return JSON.parse(localStorage.getItem(historyKey(account)) || '[]');
  } catch {
    return [];
  }
}

export function upsertHistory(account: string, rec: TxRecord) {
  const all = listHistory(account).filter((r) => r.hash !== rec.hash);
  all.unshift(rec);
  localStorage.setItem(historyKey(account), JSON.stringify(all.slice(0, MAX_HISTORY)));
}
