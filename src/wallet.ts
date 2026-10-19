import {
  Contract,
  ContractFactory,
  HDNodeWallet,
  JsonRpcProvider,
  Mnemonic,
  Wallet,
  formatEther,
  formatUnits,
  getAddress,
  isAddress,
  parseEther,
  parseUnits,
  type TransactionRequest,
  type TransactionResponse,
} from 'ethers';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import artifact from './wseth-artifact.json';
import coinArtifact from './coin-artifact.json';
import { settings } from './config';
import { listTokens, type Token } from './tokens';

const PHRASE_KEY = 'recoveryPhrase';
const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
];

let provider: JsonRpcProvider | null = null;
let signer: HDNodeWallet | null = null;

const pathFor = (i: number) => `m/44'/60'/0'/0/${i}`;

// ---------- Key storage (Android Keystore via SecureStorage) ----------

export async function hasWallet() {
  return (await SecureStorage.get(PHRASE_KEY)) !== null;
}

export function normalizePhrase(phrase: string) {
  return phrase.trim().toLowerCase().split(/\s+/).join(' ');
}

async function storedPhrase(): Promise<string> {
  const p = await SecureStorage.get(PHRASE_KEY);
  if (typeof p !== 'string') throw new Error('No wallet stored on this device.');
  return p;
}

/** Creates a new random wallet, stores its phrase, and returns the phrase for the user to back up. */
export async function createWallet(): Promise<string> {
  const phrase = Wallet.createRandom().mnemonic!.phrase;
  await SecureStorage.set(PHRASE_KEY, phrase);
  settings.activeAccount = 0;
  settings.accountCount = 1;
  return phrase;
}

export async function importWallet(phrase: string) {
  const p = normalizePhrase(phrase);
  if (!Mnemonic.isValidMnemonic(p)) throw new Error('That is not a valid 12/24-word recovery phrase.');
  await SecureStorage.set(PHRASE_KEY, p);
  settings.activeAccount = 0;
  settings.accountCount = 1;
}

/** Derives the active account (BIP-44 index) from the stored phrase. */
export async function loadWallet() {
  signer = HDNodeWallet.fromPhrase(await storedPhrase(), undefined, pathFor(settings.activeAccount));
  if (provider) signer = signer.connect(provider);
}

export async function accountAddresses(): Promise<string[]> {
  const p = await storedPhrase();
  return Array.from({ length: settings.accountCount }, (_, i) => HDNodeWallet.fromPhrase(p, undefined, pathFor(i)).address);
}

export const revealPhrase = storedPhrase;

export async function deleteWallet() {
  await SecureStorage.remove(PHRASE_KEY);
  signer = null;
}

export const address = () => signer?.address ?? '';

// ---------- Network ----------

/** Connects to the selected network's RPC and refuses it if the chain ID doesn't match. */
export async function connect() {
  const net = settings.network;
  // cacheTimeout -1: always fetch a fresh nonce, so back-to-back transactions never reuse one.
  const p = new JsonRpcProvider(settings.rpcUrl, undefined, { cacheTimeout: -1 });
  try {
    const { chainId } = await p.getNetwork();
    if (chainId !== net.chainId) throw new Error(`RPC is on chain ${chainId}, not ${net.name} (${net.chainId}).`);
    if (chainId === 1n && (await storedPhrase()) === 'test test test test test test test test test test test junk') {
      throw new Error('This recovery phrase is a public test phrase. It cannot be used on Ethereum.');
    }
  } catch (e) {
    p.destroy();
    throw e;
  }
  provider?.destroy();
  provider = p;
  if (signer) signer = signer.connect(p);
}

function requireSigner() {
  if (!signer || !provider) throw new Error('Wallet not connected.');
  return signer;
}

// ---------- Tokens & WSETH ----------

export const wsethToken = (): Token | null =>
  settings.wsethAddress ? { address: settings.wsethAddress, name: 'Wrapped Study Ether', symbol: 'WSETH', decimals: 18 } : null;

/** Reads a token's details from the chain, so names and symbols always come from the contract itself. */
export async function readToken(addr: string): Promise<Token> {
  const a = toAddress(addr, 'Token address');
  if ((await provider!.getCode(a)) === '0x') throw new Error(`No contract at that address on ${settings.network.name}.`);
  const c = new Contract(a, ERC20_ABI, provider);
  try {
    const [name, symbol, decimals] = await Promise.all([c.name(), c.symbol(), c.decimals()]);
    return { address: a, name, symbol, decimals: Number(decimals) };
  } catch {
    throw new Error('That contract is not a standard ERC-20 token.');
  }
}

/** Checks that an address really is a Wrapped Study Ether contract before the app uses it. */
export async function verifyWseth(addr: string): Promise<string> {
  const t = await readToken(addr);
  if (t.name !== 'Wrapped Study Ether' || t.symbol !== 'WSETH') throw new Error('That contract is not Wrapped Study Ether.');
  return t.address;
}

export async function deployWseth(): Promise<{ tx: TransactionResponse; address: Promise<string> }> {
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, requireSigner());
  const contract = await factory.deploy();
  return { tx: contract.deploymentTransaction()!, address: contract.waitForDeployment().then(() => contract.getAddress()) };
}

/** Deploys the study coin and mints the whole supply to the active account. */
export async function deployCoin(name: string, symbol: string, wholeSupply: string) {
  const coinName = name.trim();
  const coinSymbol = symbol.trim();
  if (coinName.length < 1 || coinName.length > 32) throw new Error('Coin name must be 1 to 32 characters.');
  if (!/^[A-Za-z0-9]{1,8}$/.test(coinSymbol)) throw new Error('Symbol must be 1 to 8 letters or numbers.');
  if (!/^[1-9]\d{0,11}$/.test(wholeSupply.trim())) throw new Error('Supply must be a whole number from 1 to 999,999,999,999.');
  const factory = new ContractFactory(coinArtifact.abi, coinArtifact.bytecode, requireSigner());
  const contract = await factory.deploy(coinName, coinSymbol, BigInt(wholeSupply.trim()));
  const tx = contract.deploymentTransaction()!;
  const address = await contract.waitForDeployment().then(() => contract.getAddress());
  return { tx, address, name: coinName, symbol: coinSymbol };
}

// ---------- Balances ----------

export interface Holding {
  token: Token | null; // null = native coin
  balance: string | null;
}

export async function balances(): Promise<Holding[]> {
  const s = requireSigner();
  const tokens = [wsethToken(), ...listTokens()].filter((t): t is Token => !!t);
  const [native, ...rest] = await Promise.all([
    provider!.getBalance(s.address).then(formatEther),
    ...tokens.map((t) =>
      (new Contract(t.address, ERC20_ABI, provider).balanceOf(s.address) as Promise<bigint>)
        .then((b) => formatUnits(b, t.decimals))
        .catch(() => null),
    ),
  ]);
  return [{ token: null, balance: native }, ...tokens.map((t, i) => ({ token: t, balance: rest[i] }))];
}

// ---------- Building transactions ----------

function toAddress(v: string, what = 'Recipient') {
  if (!isAddress(v.trim())) throw new Error(`${what} is not a valid 0x address.`);
  return getAddress(v.trim());
}

function toUnits(amount: string, decimals: number) {
  let v: bigint;
  try {
    v = parseUnits(amount.trim(), decimals);
  } catch {
    throw new Error('Enter a valid amount.');
  }
  if (v <= 0n) throw new Error('Amount must be greater than 0.');
  return v;
}

const wsethContract = () => new Contract(settings.wsethAddress!, artifact.abi, provider);

/** Each builder returns an unsigned request; quote() and send() then work the same for all of them. */
export const build = {
  native: async (to: string, amount: string): Promise<TransactionRequest> => ({ to: toAddress(to), value: toUnits(amount, 18) }),
  token: async (t: Token, to: string, amount: string) =>
    new Contract(t.address, ERC20_ABI, provider).transfer.populateTransaction(toAddress(to), toUnits(amount, t.decimals)),
  wrap: async (amount: string) => wsethContract().deposit.populateTransaction({ value: toUnits(amount, 18) }),
  unwrap: async (amount: string) => wsethContract().withdraw.populateTransaction(toUnits(amount, 18)),
};

export interface Quote {
  request: TransactionRequest;
  gasLimit: bigint;
  fee: bigint; // worst-case network fee in wei
}

/** Estimates gas (this also simulates the call, so most failures show up here, before signing). */
export async function quote(request: TransactionRequest): Promise<Quote> {
  const s = requireSigner();
  const req = { ...request, from: s.address };
  const [gas, feeData] = await Promise.all([s.estimateGas(req), provider!.getFeeData()]);
  const gasLimit = (gas * 12n) / 10n; // 20% headroom
  const price = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  return { request: { ...req, gasLimit }, gasLimit, fee: gasLimit * price };
}

export const send = (q: Quote) => requireSigner().sendTransaction(q.request);

export const formatFee = (wei: bigint) => `${Number(formatEther(wei)).toPrecision(3)} ${settings.network.nativeSymbol}`;

export interface ChainActivity {
  hash: string;
  label: string;
  status: 'pending' | 'confirmed' | 'failed';
  time: number;
  incoming: boolean;
}

const clip = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Transfers sent to this address. Public testnets use a block explorer. Anvil is read from the local node. */
export async function incomingActivity(addr: string): Promise<ChainActivity[]> {
  const net = settings.network;
  if (!provider) return [];
  if (net.chainId === 31337n) return scanLocalIncoming(addr);
  if (!net.historyApi) return [];
  const res = await fetch(`${net.historyApi}/addresses/${addr}/transactions?filter=to`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('Could not load incoming transfers.');
  const data = (await res.json()) as { items?: Record<string, unknown>[] };
  const items = Array.isArray(data.items) ? data.items : [];
  const out: ChainActivity[] = [];
  for (const it of items.slice(0, 30)) {
    const hash = String(it.hash || '');
    if (!hash) continue;
    const from = (it.from as { hash?: string } | undefined)?.hash;
    const who = from ? clip(from) : 'someone';
    let wei = 0n;
    try {
      wei = BigInt(String(it.value || '0'));
    } catch {
      wei = 0n;
    }
    const amt = wei > 0n ? `${Number(formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${net.nativeSymbol}` : '';
    const status = it.status === 'ok' ? 'confirmed' : it.status === 'error' ? 'failed' : 'pending';
    out.push({
      hash,
      label: amt ? `Received ${amt} from ${who}` : `Incoming call from ${who}`,
      status,
      time: Date.parse(String(it.timestamp || '')) || Date.now(),
      incoming: true,
    });
  }
  return out;
}

async function scanLocalIncoming(addr: string): Promise<ChainActivity[]> {
  const latest = await provider!.getBlockNumber();
  const start = Math.max(0, latest - 250);
  const mine = addr.toLowerCase();
  const found: ChainActivity[] = [];
  for (let n = latest; n >= start && found.length < 25; n--) {
    const block = await provider!.getBlock(n, true);
    if (!block) continue;
    for (const tx of block.prefetchedTransactions) {
      if (!tx.to || tx.to.toLowerCase() !== mine || tx.value <= 0n) continue;
      found.push({
        hash: tx.hash,
        label: `Received ${Number(formatEther(tx.value)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${settings.network.nativeSymbol} from ${clip(tx.from)}`,
        status: 'confirmed',
        time: Number(block.timestamp || 0) * 1000,
        incoming: true,
      });
    }
  }
  return found;
}

const PIN_KEY = 'appPinHash';

async function hashPin(pin: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`hanan-wallet:${pin}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function pinIsSet() {
  return (await SecureStorage.get(PIN_KEY)) !== null;
}

export async function setPin(pin: string) {
  if (!/^\d{4,6}$/.test(pin)) throw new Error('Use a PIN of 4 to 6 digits.');
  await SecureStorage.set(PIN_KEY, await hashPin(pin));
}

export async function checkPin(pin: string) {
  const saved = await SecureStorage.get(PIN_KEY);
  return typeof saved === 'string' && saved === (await hashPin(pin));
}

export async function clearPin() {
  await SecureStorage.remove(PIN_KEY);
}

/** Largest native amount that can be sent while leaving room for the fee (and L2 data fees). */
export async function maxNative(): Promise<string> {
  const s = requireSigner();
  const [bal, feeData] = await Promise.all([provider!.getBalance(s.address), provider!.getFeeData()]);
  const fee = 21000n * (feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n);
  const reserve = fee * 2n > parseEther('0.00005') ? fee * 2n : parseEther('0.00005');
  return bal > reserve ? formatEther(bal - reserve) : '0';
}

export async function receiptStatus(hash: string): Promise<'pending' | 'confirmed' | 'failed'> {
  const r = await provider!.getTransactionReceipt(hash);
  return !r ? 'pending' : r.status === 1 ? 'confirmed' : 'failed';
}

/** Turns ethers errors into a short message a person can act on. */
export function explain(e: unknown): string {
  const err = e as { code?: string; shortMessage?: string; message?: string; reason?: string };
  const sym = settings.network.nativeSymbol;
  if (err?.code === 'INSUFFICIENT_FUNDS') return `Not enough ${sym} to pay for this and its network fee.`;
  if (err?.code === 'NETWORK_ERROR' || err?.code === 'TIMEOUT' || err?.code === 'SERVER_ERROR') {
    if (settings.network.chainId === 31337n) return 'Could not reach Anvil. On your computer, run ./start-anvil.sh in the ETH Practice folder, then try again.';
    return `Could not reach ${settings.network.name}. Check your internet connection.`;
  }
  if (err?.code === 'CALL_EXCEPTION') return `The contract rejected this${err.reason ? ` (${err.reason})` : ''}. Check you have enough of the token.`;
  return err?.shortMessage || err?.message || String(e);
}
