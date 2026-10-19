import './style.css';
import { Clipboard } from '@capacitor/clipboard';
import QRCode from 'qrcode';
import { NETWORKS, explorerAddress, explorerTx, resetSettings, settings } from './config';
import { isLookalike, listTokens, removeToken, saveToken, type Token } from './tokens';
import { defaultCoinTemplate, parseCoinTemplate, setCoinHeader } from './coin-template';
import { contactName, listContacts, listHistory, removeContact, saveContact, upsertHistory, type TxRecord } from './store';
import * as w from './wallet';

type Tab = 'send' | 'wrap' | 'unwrap';
type View = 'dash' | 'move' | 'activity';
type Msg = { kind: 'ok' | 'err' | 'info'; html: string } | null;

const app = document.getElementById('app')!;
const state = {
  view: 'dash' as View,
  tab: 'send' as Tab,
  asset: 'native', // 'native' | token address
  msg: null as Msg,
  busy: false,
  holdings: [] as w.Holding[],
  accounts: [] as string[],
  incoming: [] as w.ChainActivity[],
  draft: { to: '', amount: '' },
};

// ---------- helpers ----------

const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (v: string | null) => (v === null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 6 }));
const $ = <T extends HTMLElement>(sel: string) => app.querySelector(sel) as T;
const $opt = <T extends HTMLElement>(sel: string) => app.querySelector(sel) as T | null;
const val = (sel: string) => ($opt<HTMLInputElement>(sel)?.value ?? '').trim();
const net = () => settings.network;
const badge = () => (net().chainId === 1n ? '<span class="tag main">MAINNET</span>' : '<span class="tag">TESTNET</span>');
const sym = (t: Token | null) => (t ? t.symbol : net().nativeSymbol);
const lookalikeBadge = (t: Token) => (isLookalike(t) ? ` <span class="bad">⚠ lookalike</span>` : '');
const timeAgo = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
};

/** The big warning box was replaced by a compact TESTNET tag in every screen title. */
function banner() {
  return '';
}
function msgHtml() {
  return state.msg ? `<div class="msg ${state.msg.kind}">${state.msg.html}</div>` : '';
}
function setMsg(kind: 'ok' | 'err' | 'info', text: string, rawHtml = false) {
  state.msg = { kind, html: rawHtml ? text : esc(text) };
}
async function copy(text: string, what = 'Address') {
  await Clipboard.write({ string: text });
  setMsg('ok', `${what} copied.`);
}
const select = (id: string, opts: [string, string][], cur: string) =>
  `<select id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

// ---------- Onboarding ----------

function renderWelcome() {
  app.innerHTML = `
    ${banner()}
    <div class="top"><h1>Hanan Wallet ${badge()}</h1></div>
    ${msgHtml()}
    <div class="card stack">
      <h2>Create a new wallet</h2>
      <p class="muted">Recommended. Generates a fresh recovery phrase on this phone, used only for testing.</p>
      <button class="full" id="create">Create wallet</button>
    </div>
    <div class="card">
      <h2>Import a recovery phrase</h2>
      <p class="muted">Only import a phrase you use for testing. Never import the phrase of a wallet that holds real funds.</p>
      <textarea id="phrase" placeholder="word1 word2 word3 …" autocapitalize="off" autocomplete="off" spellcheck="false"></textarea>
      <button class="full secondary" id="import">Import</button>
    </div>`;
  $('#create').onclick = async () => renderBackup(await w.createWallet(), true);
  $('#import').onclick = async () => {
    try {
      await w.importWallet(val('#phrase'));
      state.msg = null;
      await start();
    } catch (e) {
      setMsg('err', w.explain(e));
      renderWelcome();
    }
  };
}

function renderBackup(phrase: string, firstTime: boolean) {
  const words = phrase.split(' ').map((x, i) => `<span><i>${i + 1}</i>${esc(x)}</span>`).join('');
  app.innerHTML = `
    ${banner()}
    <div class="top"><h1>Recovery phrase ${badge()}</h1></div>
    <div class="card">
      <p class="muted">Write these words down in order. Anyone with them controls every account in this wallet. The app cannot recover them for you.</p>
      <div class="phrase">${words}</div>
      ${firstTime ? `<label class="check"><input type="checkbox" id="ack">I wrote it down</label>` : ''}
      <button class="full" id="done" ${firstTime ? 'disabled' : ''}>${firstTime ? 'Continue' : 'Back'}</button>
    </div>`;
  if (firstTime) $<HTMLInputElement>('#ack').onchange = (e) => $('#done').toggleAttribute('disabled', !(e.target as HTMLInputElement).checked);
  $('#done').onclick = () => (firstTime ? start() : renderSettings());
}

// ---------- Home ----------

function sendable() {
  // While balances are (re)loading, holdings is empty; the native coin is always sendable.
  const holdings: w.Holding[] = state.holdings.length ? state.holdings : [{ token: null, balance: null }];
  return holdings.map((h) => ({
    id: h.token ? h.token.address : 'native',
    token: h.token,
    balance: h.balance,
    label: h.token ? `${h.token.symbol}${h.token.symbol === 'WSETH' ? '' : ` (${short(h.token.address)})`}` : net().nativeSymbol,
  }));
}

function actionForm() {
  const hasW = !!settings.wsethAddress;
  const amountRow = (unit: string, max = true) => `
    <label>Amount (${esc(unit)})</label>
    <div class="row"><input id="amt" inputmode="decimal" placeholder="0.01" value="${esc(state.draft.amount)}">${max ? `<button class="secondary grow0" id="max">Max</button>` : ''}</div>`;
  if (state.tab !== 'send' && !hasW) return `<p class="muted">Set up WSETH for ${esc(net().name)} in Settings first (deploy it or paste its address).</p>`;
  const feeLine = `<p class="muted fee" id="fee">Enter an amount to estimate the network fee.</p>`;
  if (state.tab === 'wrap')
    return `<p class="muted">Locks ${esc(net().nativeSymbol)} in the contract and gives you the same amount of WSETH.</p>${amountRow(net().nativeSymbol, false)}${feeLine}<button class="full" id="go">Review wrap</button>`;
  if (state.tab === 'unwrap')
    return `<p class="muted">Burns WSETH and returns the same amount of ${esc(net().nativeSymbol)}.</p>${amountRow('WSETH', false)}${feeLine}<button class="full" id="go">Review unwrap</button>`;

  const list = sendable();
  if (!list.some((a) => a.id === state.asset)) state.asset = 'native';
  const cur = list.find((a) => a.id === state.asset)!;
  const contacts = listContacts();
  return `
    <label>Coin</label>
    ${select('asset', list.map((a) => [a.id, a.label]), state.asset)}
    ${cur.token && isLookalike(cur.token) ? `<div class="msg err">This token uses the symbol "${esc(cur.token.symbol)}" but is not the known contract for it. It may be a lookalike.</div>` : ''}
    <label>Recipient address</label>
    <div class="row">
      <input id="to" placeholder="0x…" autocapitalize="off" spellcheck="false" value="${esc(state.draft.to)}">
      <button class="secondary grow0" id="scan">Scan</button>
    </div>
    ${contacts.length ? select('contact', [['', 'Or pick a contact…'], ...contacts.map((c): [string, string] => [c.address, `${c.name} (${short(c.address)})`])], '') : ''}
    ${amountRow(sym(cur.token))}
    ${feeLine}
    <button class="full" id="go">Review send</button>`;
}

function accountOptions() {
  const opts: [string, string][] = state.accounts.map((a, i) => [String(i), `${settings.accountName(i)} (${short(a)})`]);
  opts.push(['new', '+ Add account']);
  return opts;
}

function hashLink(hash: string) {
  const url = explorerTx(hash);
  return url ? `<a href="${url}">${short(hash)}</a>` : short(hash);
}

function addrLink(addr: string) {
  const url = explorerAddress(addr);
  return url ? `<a class="addr" href="${url}">${short(addr)}</a>` : `<span class="addr">${short(addr)}</span>`;
}

function activityItems() {
  const local = listHistory(w.address()).map((t) => ({ ...t, incoming: false }));
  const seen = new Set(local.map((t) => t.hash));
  return [...local, ...state.incoming.filter((t) => !seen.has(t.hash))].sort((a, b) => b.time - a.time);
}

function nativeBalance() {
  const native = state.holdings.find((h) => !h.token);
  return native ? native.balance : state.holdings.length ? '0' : null;
}

function txRows(items: TxRecord[]) {
  return items
    .map(
      (t) => `<div class="tx"><span>${esc(t.label)}<br><span class="muted">${timeAgo(t.time)} · ${hashLink(t.hash)}</span></span>
      <span class="st-${t.status}">${t.status}</span></div>`,
    )
    .join('');
}

function assetRows() {
  const list = state.holdings.length ? state.holdings : [];
  if (!list.length) return '<p class="muted">Loading balances…</p>';
  return list
    .map((h) => {
      const name = sym(h.token);
      return `<div class="asset"><span class="badge">${esc(name.slice(0, 1))}</span><span class="asset-name">${esc(name)}${h.token ? lookalikeBadge(h.token) : ''}<br><span class="muted">${h.token ? short(h.token.address) : esc(net().name)}</span></span><b class="num">${fmt(h.balance)}</b></div>`;
    })
    .join('');
}

function chrome(title = 'Hanan Wallet') {
  return `
    ${banner()}
    <div class="top"><h1>${esc(title)} ${badge()}</h1><button class="secondary" id="settings">Settings</button></div>
    <div class="row picks">
      ${select('network', NETWORKS.map((n) => [String(n.chainId), n.name]), String(net().chainId))}
      ${select('account', accountOptions(), String(settings.activeAccount))}
    </div>
    ${msgHtml()}`;
}

function nav() {
  const items: [View, string][] = [
    ['dash', 'Dashboard'],
    ['move', 'Send'],
    ['activity', 'Activity'],
  ];
  return `<nav class="nav">${items.map(([id, label]) => `<button data-view="${id}" class="${state.view === id ? 'active' : ''}">${label}</button>`).join('')}</nav>`;
}

function bindShell() {
  const addr = w.address();
  $('#settings').onclick = () => {
    state.msg = null;
    renderSettings();
  };
  const copyBtn = $opt<HTMLButtonElement>('#copy');
  if (copyBtn)
    copyBtn.onclick = async () => {
      await copy(addr);
      renderHome();
    };
  const receive = $opt<HTMLButtonElement>('#receive');
  if (receive) receive.onclick = renderReceive;
  const refreshBtn = $opt<HTMLButtonElement>('#refresh');
  if (refreshBtn) refreshBtn.onclick = () => refresh();
  $<HTMLSelectElement>('#network').onchange = async (e) => {
    const next = NETWORKS.find((n) => String(n.chainId) === (e.target as HTMLSelectElement).value)!;
    if (next.chainId === 1n && !(await askConfirm('Ethereum is the real network. Sends from here spend real ETH.'))) {
      (e.target as HTMLSelectElement).value = String(settings.network.chainId);
      return;
    }
    settings.network = next;
    state.asset = 'native';
    state.msg = null;
    await reconnect();
  };
  $<HTMLSelectElement>('#account').onchange = async (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v === 'new') {
      settings.accountCount = settings.accountCount + 1;
      settings.activeAccount = settings.accountCount - 1;
      setMsg('ok', `Created Account ${settings.accountCount}. It comes from the same recovery phrase.`);
    } else settings.activeAccount = Number(v);
    await w.loadWallet();
    state.accounts = await w.accountAddresses();
    await refresh();
  };
  app.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(
    (b) =>
      (b.onclick = () => {
        saveDraft();
        state.view = b.dataset.view as View;
        state.msg = null;
        renderHome();
      }),
  );
  app.querySelectorAll<HTMLButtonElement>('[data-go]').forEach(
    (b) =>
      (b.onclick = () => {
        state.view = 'move';
        state.tab = b.dataset.go as Tab;
        state.msg = null;
        renderHome();
      }),
  );
  app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(
    (b) =>
      (b.onclick = () => {
        saveDraft();
        state.tab = b.dataset.tab as Tab;
        renderHome();
      }),
  );
}

function faucetHtml() {
  const n = net();
  if (n.faucetUrl) return `<a class="faucet" href="${esc(n.faucetUrl)}" target="_blank" rel="noopener">Get test ${esc(n.nativeSymbol)}</a>`;
  return `<p class="muted faucet-note">${esc(n.faucet)}</p>`;
}

function renderDash() {
  const addr = w.address();
  const recent = activityItems().slice(0, 3);
  const bal = nativeBalance();
  app.innerHTML = `
    ${chrome()}
    <section class="hero">
      <div class="muted">Balance · ${esc(net().name)}</div>
      <div class="amount">${fmt(bal)}<span class="unit">${esc(net().nativeSymbol)}</span></div>
      <button class="addr-chip" id="copy">${short(addr)} · Copy</button>
    </section>
    <div class="actions">
      <button data-go="send">Send</button>
      <button id="receive">Receive</button>
      <button data-go="wrap">Wrap</button>
      <button data-go="unwrap">Unwrap</button>
    </div>
    ${faucetHtml()}
    <button class="full secondary coin-btn" id="createCoin">Create a coin</button>
    <div class="card">
      <div class="section-head"><h2>Assets</h2><button class="secondary grow0" id="refresh">Refresh</button></div>
      ${assetRows()}
      <p class="muted" style="margin:8px 0 0">Add more coins in Settings → Tokens.</p>
    </div>
    <div class="card">
      <div class="section-head"><h2>Recent</h2><button class="secondary grow0" data-view="activity">All</button></div>
      ${txRows(recent) || '<p class="muted">No transactions yet on this network.</p>'}
    </div>
    ${nav()}`;
  bindShell();
  $('#createCoin').onclick = () => {
    state.msg = null;
    renderCoin();
  };
}

function renderCoin() {
  const src = localStorage.getItem('coinTemplate') || defaultCoinTemplate();
  const fields = parseCoinTemplate(src);
  app.innerHTML = `
    <div class="top"><h1>New coin ${badge()}</h1><button class="secondary" id="back">Back</button></div>
    ${msgHtml()}
    <div class="card">
      <p class="muted">Edit the template, then create the coin on <b>${esc(net().name)}</b>. The name, symbol, and supply at the top are written into the contract. The new coins go to your address.</p>
      <label>Contract</label>
      <textarea id="src" class="code" spellcheck="false">${esc(src)}</textarea>
      <label>Name</label>
      <input id="coinName" maxlength="32" value="${esc(fields.name)}">
      <label>Symbol</label>
      <input id="coinSymbol" maxlength="8" autocapitalize="characters" value="${esc(fields.symbol)}">
      <label>Supply (whole coins)</label>
      <input id="coinSupply" inputmode="numeric" value="${esc(fields.supply)}">
      <button class="full" id="deployCoin" ${state.busy ? 'disabled' : ''}>Create coin</button>
    </div>`;
  const area = $<HTMLTextAreaElement>('#src');
  const name = $<HTMLInputElement>('#coinName');
  const symbol = $<HTMLInputElement>('#coinSymbol');
  const supply = $<HTMLInputElement>('#coinSupply');
  const persist = () => localStorage.setItem('coinTemplate', area.value);
  const push = (field: 'Name' | 'Symbol' | 'Supply', value: string) => {
    area.value = setCoinHeader(area.value, field, value);
    persist();
  };
  name.oninput = () => push('Name', name.value);
  symbol.oninput = () => push('Symbol', symbol.value);
  supply.oninput = () => push('Supply', supply.value);
  area.oninput = () => {
    const next = parseCoinTemplate(area.value);
    if (document.activeElement !== name) name.value = next.name;
    if (document.activeElement !== symbol) symbol.value = next.symbol;
    if (document.activeElement !== supply) supply.value = next.supply;
    persist();
  };
  $('#back').onclick = () => {
    persist();
    state.msg = null;
    renderHome();
  };
  $('#deployCoin').onclick = async () => {
    persist();
    const coin = parseCoinTemplate(area.value);
    state.busy = true;
    setMsg('info', `Creating ${coin.symbol || 'coin'} on ${net().name}…`);
    renderCoin();
    try {
      const { tx, address, name: coinName, symbol: coinSymbol } = await w.deployCoin(coin.name, coin.symbol, coin.supply);
      saveToken({ address, name: coinName, symbol: coinSymbol, decimals: 18 });
      upsertHistory(w.address(), { hash: tx.hash, label: `Create ${coinSymbol}`, status: 'confirmed', time: Date.now() });
      state.busy = false;
      setMsg('ok', `Created ${coinName} (${coinSymbol}).`);
      state.view = 'dash';
      await refresh();
    } catch (e) {
      state.busy = false;
      setMsg('err', w.explain(e));
      renderCoin();
    }
  };
}

function renderMove() {
  const titles: Record<Tab, string> = { send: 'Send', wrap: 'Wrap', unwrap: 'Unwrap' };
  app.innerHTML = `
    ${chrome(titles[state.tab])}
    <div class="card">
      <div class="tabs">${(['send', 'wrap', 'unwrap'] as Tab[]).map((id) => `<button data-tab="${id}" class="${state.tab === id ? 'active' : ''}">${id[0].toUpperCase() + id.slice(1)}</button>`).join('')}</div>
      ${actionForm()}
    </div>
    ${nav()}`;
  bindShell();
}

function renderActivity() {
  const addr = w.address();
  const rows = activityItems().slice(0, 30);
  const explorer = explorerAddress(addr);
  app.innerHTML = `
    ${chrome('Activity')}
    <div class="card">
      <h2>On ${esc(net().name)}</h2>
      ${txRows(rows) || '<p class="muted">No transactions yet on this network.</p>'}
      ${explorer ? `<p class="muted" style="margin-bottom:0"><a href="${explorer}">Full history on the explorer</a></p>` : '<p class="muted" style="margin-bottom:0">Includes transfers sent to this address on Anvil.</p>'}
    </div>
    ${nav()}`;
  bindShell();
}

function renderHome() {
  if (state.view === 'move') renderMove();
  else if (state.view === 'activity') renderActivity();
  else renderDash();
  const assetSel = $opt<HTMLSelectElement>('#asset');
  if (assetSel)
    assetSel.onchange = () => {
      saveDraft();
      state.asset = assetSel.value;
      state.draft.amount = '';
      renderHome();
    };
  const contactSel = $opt<HTMLSelectElement>('#contact');
  if (contactSel) contactSel.onchange = () => contactSel.value && ($<HTMLInputElement>('#to').value = contactSel.value);
  const maxBtn = $opt<HTMLButtonElement>('#max');
  if (maxBtn)
    maxBtn.onclick = async () => {
      const cur = sendable().find((a) => a.id === state.asset)!;
      try {
        $<HTMLInputElement>('#amt').value = cur.token ? (cur.balance ?? '0') : await w.maxNative();
      } catch (e) {
        setMsg('err', w.explain(e));
        renderHome();
      }
    };
  const go = $opt<HTMLButtonElement>('#go');
  if (go) {
    go.disabled = state.busy;
    go.onclick = () => review();
  }
  const scan = $opt<HTMLButtonElement>('#scan');
  if (scan) scan.onclick = () => scanRecipient();
  bindFee();
}

let feeTimer = 0;
function bindFee() {
  const amt = $opt<HTMLInputElement>('#amt');
  const fee = $opt<HTMLElement>('#fee');
  if (!amt || !fee) return;
  const run = async () => {
    saveDraft();
    if (!state.draft.amount) {
      fee.textContent = 'Enter an amount to estimate the network fee.';
      return;
    }
    if (state.tab === 'send' && !state.draft.to) {
      fee.textContent = 'Add a recipient to estimate the network fee.';
      return;
    }
    fee.textContent = 'Estimating network fee…';
    try {
      let request;
      if (state.tab === 'wrap') request = await w.build.wrap(state.draft.amount);
      else if (state.tab === 'unwrap') request = await w.build.unwrap(state.draft.amount);
      else {
        const cur = sendable().find((a) => a.id === state.asset)!;
        request = cur.token ? await w.build.token(cur.token, state.draft.to, state.draft.amount) : await w.build.native(state.draft.to, state.draft.amount);
      }
      const q = await w.quote(request);
      if ($opt('#fee') === fee) fee.textContent = `Network fee ≈ ${w.formatFee(q.fee)}`;
    } catch (e) {
      if ($opt('#fee') === fee) fee.textContent = w.explain(e);
    }
  };
  const schedule = () => {
    window.clearTimeout(feeTimer);
    feeTimer = window.setTimeout(() => void run(), 450);
  };
  amt.addEventListener('input', schedule);
  $opt<HTMLInputElement>('#to')?.addEventListener('input', schedule);
  if (state.draft.amount) schedule();
}

async function scanRecipient() {
  const Detector = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
  if (!Detector || !navigator.mediaDevices?.getUserMedia) {
    setMsg('err', 'This phone cannot scan QR codes. Paste the address instead.');
    renderHome();
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'scan-overlay';
  overlay.innerHTML = `<h2>Scan a wallet QR</h2><video id="scanVideo" autoplay playsinline muted></video><button class="secondary" id="scanClose">Cancel</button>`;
  document.body.appendChild(overlay);
  let stream: MediaStream | null = null;
  let timer = 0;
  const close = () => {
    window.clearInterval(timer);
    stream?.getTracks().forEach((t) => t.stop());
    overlay.remove();
  };
  overlay.querySelector<HTMLButtonElement>('#scanClose')!.onclick = close;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = overlay.querySelector<HTMLVideoElement>('#scanVideo')!;
    video.srcObject = stream;
    await video.play();
    const det = new Detector({ formats: ['qr_code'] });
    timer = window.setInterval(async () => {
      try {
        const codes = await det.detect(video);
        const raw = codes[0]?.rawValue || '';
        const match = raw.match(/0x[a-fA-F0-9]{40}/);
        if (!match) return;
        state.draft.to = match[0];
        close();
        renderHome();
      } catch {
        /* keep scanning */
      }
    }, 350);
  } catch {
    close();
    setMsg('err', 'Camera permission is needed to scan a QR code.');
    renderHome();
  }
}

function saveDraft() {
  const toEl = $opt<HTMLInputElement>('#to');
  const amtEl = $opt<HTMLInputElement>('#amt');
  state.draft = {
    to: toEl ? toEl.value.trim() : state.draft.to,
    amount: amtEl ? amtEl.value.trim() : state.draft.amount,
  };
}

/** In-app confirm. The phone's WebView drops window.confirm after an awaited network call, so the send looks like it did nothing. */
function askConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'scan-overlay';
    overlay.innerHTML = `
      <div class="card">
        <h2>Confirm</h2>
        <p class="confirm-text"></p>
        <div class="row">
          <button class="secondary" id="confirmNo">Cancel</button>
          <button id="confirmYes">Confirm</button>
        </div>
      </div>`;
    overlay.querySelector('p')!.textContent = message;
    document.body.appendChild(overlay);
    const done = (yes: boolean) => {
      overlay.remove();
      resolve(yes);
    };
    overlay.querySelector<HTMLButtonElement>('#confirmYes')!.onclick = () => done(true);
    overlay.querySelector<HTMLButtonElement>('#confirmNo')!.onclick = () => done(false);
  });
}

/** Builds the transaction, estimates the fee (which also simulates it), asks for confirmation, then sends. */
async function review() {
  saveDraft();
  const amount = state.draft.amount;
  const to = state.draft.to;
  let label: string;
  let summary: string;
  state.busy = true;
  setMsg('info', 'Estimating network fee…');
  renderHome();
  try {
    let request;
    if (state.tab === 'wrap') {
      request = await w.build.wrap(amount);
      label = summary = `Wrap ${amount} ${net().nativeSymbol} → WSETH`;
    } else if (state.tab === 'unwrap') {
      request = await w.build.unwrap(amount);
      label = summary = `Unwrap ${amount} WSETH → ${net().nativeSymbol}`;
    } else {
      const cur = sendable().find((a) => a.id === state.asset)!;
      request = cur.token ? await w.build.token(cur.token, to, amount) : await w.build.native(to, amount);
      const who = contactName(to);
      label = `Send ${amount} ${sym(cur.token)} to ${who ?? short(to)}`;
      summary = `Send ${amount} ${sym(cur.token)}\nTo: ${who ? `${who}\n` : ''}${to}`;
    }
    const q = await w.quote(request);
    state.busy = false;
    state.msg = null;
    renderHome();
    if (!(await askConfirm(`${summary}\n\nNetwork: ${net().name}\nMax network fee: ≈ ${w.formatFee(q.fee)}\n\nConfirm?`))) return;
    await track(label, q);
    state.draft = { to: '', amount: '' };
    state.view = 'dash';
  } catch (e) {
    state.busy = false;
    setMsg('err', w.explain(e));
  }
  await refresh();
}

async function track(label: string, q: w.Quote) {
  const addr = w.address();
  state.busy = true;
  try {
    const tx = await w.send(q);
    const rec: TxRecord = { hash: tx.hash, label, status: 'pending', time: Date.now() };
    upsertHistory(addr, rec);
    setMsg('info', `Submitted. Waiting for ${net().name} to confirm…`);
    renderHome();
    const r = await tx.wait();
    rec.status = r?.status === 1 ? 'confirmed' : 'failed';
    upsertHistory(addr, rec);
    setMsg(rec.status === 'confirmed' ? 'ok' : 'err', rec.status === 'confirmed' ? 'Confirmed.' : 'Transaction failed on-chain.');
  } catch (e) {
    setMsg('err', w.explain(e));
  } finally {
    state.busy = false;
  }
}

/** Re-checks any transactions still marked pending (for example after the app was closed). */
async function settlePending() {
  const addr = w.address();
  for (const t of listHistory(addr).filter((t) => t.status === 'pending')) {
    try {
      const s = await w.receiptStatus(t.hash);
      if (s !== 'pending') upsertHistory(addr, { ...t, status: s });
    } catch {
      /* try again next refresh */
    }
  }
}

async function refresh() {
  try {
    state.holdings = await w.balances();
    await settlePending();
  } catch (e) {
    setMsg('err', w.explain(e));
  }
  try {
    state.incoming = await w.incomingActivity(w.address());
  } catch {
    state.incoming = [];
  }
  renderHome();
}

async function reconnect() {
  state.holdings = [];
  renderHome();
  try {
    await w.connect();
  } catch (e) {
    setMsg('err', w.explain(e));
    return renderHome();
  }
  await refresh();
}

// ---------- Receive ----------

async function renderReceive() {
  const addr = w.address();
  const qr = await QRCode.toDataURL(addr, { margin: 1, width: 600, color: { dark: '#0b0d12', light: '#ffffff' } });
  app.innerHTML = `
    ${banner()}
    <div class="top"><h1>Receive ${badge()}</h1><button class="secondary" id="back">Back</button></div>
    ${msgHtml()}
    <div class="card" style="text-align:center">
      <img src="${qr}" alt="QR code of your address" style="width:100%;max-width:300px;border-radius:12px">
      <div class="addr" style="margin:12px 0">${addr}</div>
      <button class="full" id="copy">Copy address</button>
    </div>
    <div class="card">
      <p class="muted" style="margin:0">Scan or share this address to receive ${esc(net().nativeSymbol)} or tokens on <b>${esc(net().name)}</b>.
      The same address works on all the test networks in this app; make sure the sender picks the same network.</p>
      <div style="margin-top:12px">${faucetHtml()}</div>
    </div>`;
  $('#back').onclick = () => {
    state.msg = null;
    renderHome();
  };
  $('#copy').onclick = async () => {
    await copy(addr);
    renderReceive();
  };
}

// ---------- Settings ----------

function renderSettings() {
  const ws = settings.wsethAddress;
  const mine = listTokens();
  const added = new Set(mine.map((t) => t.address.toLowerCase()));
  const tokenRows = mine
    .map(
      (t) => `<div class="tx"><span><b>${esc(t.symbol)}</b>${lookalikeBadge(t)} <span class="muted">${esc(t.name)}</span><br>
      ${addrLink(t.address)}</span>
      <button class="secondary grow0" data-remove="${t.address}">Remove</button></div>`,
    )
    .join('');
  const presetRows = net()
    .presets.filter((p) => !added.has(p.address.toLowerCase()))
    .map((p) => `<div class="tx"><span><b>${esc(p.symbol)}</b> <span class="muted">${esc(p.source)}</span></span><button class="grow0" data-preset="${p.address}">Add</button></div>`)
    .join('');
  const contactRows = listContacts()
    .map(
      (c) => `<div class="tx"><span><b>${esc(c.name)}</b><br><span class="addr">${short(c.address)}</span></span>
      <button class="secondary grow0" data-uncontact="${c.address}">Remove</button></div>`,
    )
    .join('');

  app.innerHTML = `
    ${banner()}
    <div class="top"><h1>Settings ${badge()}</h1><button class="secondary" id="back">Back</button></div>
    ${msgHtml()}
    <div class="card">
      <h2>Account names</h2>
      ${state.accounts
        .map(
          (a, i) => `<label>${esc(settings.accountName(i))} · ${short(a)}</label>
        <div class="row"><input id="an-${i}" value="${esc(settings.accountName(i))}" maxlength="24"><button class="secondary grow0" data-rename="${i}">Save</button></div>`,
        )
        .join('')}
    </div>
    <div class="card">
      <h2>App lock</h2>
      <p class="muted" id="pinHint">A PIN is asked every time the wallet opens.</p>
      <label>PIN (4–6 digits)</label>
      <input id="pinNew" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="••••">
      <button class="full secondary" id="savePin">Save PIN</button>
      <button class="full secondary" id="clearPin">Remove PIN</button>
    </div>
    <div class="card">
      <h2>Tokens on ${esc(net().name)}</h2>
      ${tokenRows || '<p class="muted">No extra tokens yet.</p>'}
      ${presetRows ? `<p class="muted" style="margin:10px 0 4px">Official test tokens</p>${presetRows}` : ''}
      <label style="margin-top:10px">Add any token by contract address</label>
      <input id="tokAddr" placeholder="0x…" autocapitalize="off" spellcheck="false">
      <button class="full secondary" id="addTok">Add token</button>
      <p class="muted">Name and symbol are read from the contract. A token is identified by its address, never its name.</p>
    </div>
    <div class="card">
      <h2>Address book</h2>
      ${contactRows || '<p class="muted">No saved contacts.</p>'}
      <label style="margin-top:10px">Name</label>
      <input id="cName" placeholder="e.g. My MetaMask">
      <label>Address</label>
      <input id="cAddr" placeholder="0x…" autocapitalize="off" spellcheck="false">
      <button class="full secondary" id="addContact">Save contact</button>
    </div>
    <div class="card">
      <h2>WSETH on ${esc(net().name)}</h2>
      ${ws ? `<div class="addr">${ws}</div>${explorerAddress(ws) ? `<p class="muted"><a href="${explorerAddress(ws)}">View on explorer</a></p>` : ''}` : '<p class="muted">Not set up on this network yet.</p>'}
      <label>Use an existing WSETH contract</label>
      <input id="wsAddr" placeholder="0x…" autocapitalize="off" spellcheck="false">
      <div class="row">
        <button class="secondary" id="useAddr">Use address</button>
        <button id="deploy" ${state.busy ? 'disabled' : ''}>Deploy new</button>
      </div>
      <p class="muted">Deploying costs a little ${esc(net().nativeSymbol)} for gas.</p>
    </div>
    <div class="card">
      <h2>${esc(net().name)} RPC</h2>
      <input id="rpc" value="${esc(settings.rpcUrl)}" autocapitalize="off" spellcheck="false">
      <div class="row">
        <button class="secondary" id="saveRpc">Save</button>
        <button class="secondary" id="resetRpc">Default</button>
      </div>
    </div>
    <div class="card stack">
      <h2>Wallet</h2>
      <button class="full secondary" id="reveal">Show recovery phrase</button>
      <button class="full danger" id="del">Delete wallet from this phone</button>
    </div>`;

  $('#back').onclick = () => {
    state.msg = null;
    refresh();
  };
  app.querySelectorAll<HTMLButtonElement>('[data-rename]').forEach(
    (b) =>
      (b.onclick = () => {
        const i = Number(b.dataset.rename);
        settings.setAccountName(i, val(`#an-${i}`));
        setMsg('ok', `Saved ${settings.accountName(i)}.`);
        renderSettings();
      }),
  );
  $('#savePin').onclick = async () => {
    try {
      await w.setPin(val('#pinNew'));
      setMsg('ok', 'PIN saved. It will be asked the next time you open the wallet.');
    } catch (e) {
      setMsg('err', e instanceof Error ? e.message : 'Could not save the PIN.');
    }
    renderSettings();
  };
  $('#clearPin').onclick = async () => {
    if (!(await w.pinIsSet())) {
      setMsg('info', 'No PIN is set.');
      renderSettings();
      return;
    }
    if (!(await askConfirm('Remove the PIN lock?'))) return;
    await w.clearPin();
    setMsg('ok', 'PIN removed.');
    renderSettings();
  };
  const addToken = async (addr: string) => {
    try {
      const t = await w.readToken(addr);
      saveToken(t);
      setMsg(
        isLookalike(t) ? 'err' : 'ok',
        isLookalike(t) ? `Added ${t.symbol}, but warning: it uses a famous symbol and is not the known contract for it.` : `Added ${t.symbol} (${t.name}).`,
      );
    } catch (e) {
      setMsg('err', w.explain(e));
    }
    renderSettings();
  };
  $('#addTok').onclick = () => addToken(val('#tokAddr'));
  app.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => (b.onclick = () => addToken(b.dataset.preset!)));
  app.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(
    (b) =>
      (b.onclick = () => {
        removeToken(b.dataset.remove!);
        state.msg = null;
        renderSettings();
      }),
  );
  $('#addContact').onclick = () => {
    try {
      saveContact(val('#cName'), val('#cAddr'));
      setMsg('ok', 'Contact saved.');
    } catch {
      setMsg('err', 'That is not a valid 0x address.');
    }
    renderSettings();
  };
  app.querySelectorAll<HTMLButtonElement>('[data-uncontact]').forEach(
    (b) =>
      (b.onclick = () => {
        removeContact(b.dataset.uncontact!);
        state.msg = null;
        renderSettings();
      }),
  );
  $('#useAddr').onclick = async () => {
    try {
      settings.wsethAddress = await w.verifyWseth(val('#wsAddr'));
      setMsg('ok', 'WSETH contract verified and saved.');
    } catch (e) {
      setMsg('err', w.explain(e));
    }
    renderSettings();
  };
  $('#deploy').onclick = async () => {
    if (!(await askConfirm(`Deploy a new Wrapped Study Ether contract on ${net().name}? This costs gas.`))) return;
    state.busy = true;
    try {
      const { tx, address } = await w.deployWseth();
      setMsg('info', `Deploying… ${hashLink(tx.hash)}`, true);
      renderSettings();
      settings.wsethAddress = await address;
      upsertHistory(w.address(), { hash: tx.hash, label: 'Deploy WSETH contract', status: 'confirmed', time: Date.now() });
      setMsg('ok', `Deployed at ${settings.wsethAddress}`);
    } catch (e) {
      setMsg('err', w.explain(e));
    } finally {
      state.busy = false;
    }
    renderSettings();
  };
  $('#saveRpc').onclick = () => changeRpc(val('#rpc'));
  $('#resetRpc').onclick = () => changeRpc(null);
  $('#reveal').onclick = async () => {
    if (!(await askConfirm('Show your recovery phrase? Make sure nobody can see your screen.'))) return;
    renderBackup(await w.revealPhrase(), false);
  };
  $('#del').onclick = async () => {
    if (!(await askConfirm('Delete this wallet from the phone? Without the recovery phrase, its funds are lost.'))) return;
    await w.deleteWallet();
    await w.clearPin();
    resetSettings();
    state.msg = null;
    renderWelcome();
  };
}

async function changeRpc(url: string | null) {
  const prev = settings.rpcUrl;
  settings.rpcUrl = url;
  try {
    await w.connect();
    setMsg('ok', `Connected to ${net().name}.`);
  } catch (e) {
    settings.rpcUrl = prev === net().rpc ? null : prev;
    await w.connect().catch(() => {});
    setMsg('err', w.explain(e));
  }
  renderSettings();
}

// ---------- Start ----------

async function start() {
  app.innerHTML = `${banner()}<p class="muted">Connecting to ${esc(net().name)}…</p>`;
  try {
    await w.loadWallet();
    state.accounts = await w.accountAddresses();
    await w.connect();
  } catch (e) {
    setMsg('err', w.explain(e));
  }
  await refresh();
}

function renderLock() {
  app.innerHTML = `
    <div class="top"><h1>Hanan Wallet ${badge()}</h1></div>
    ${msgHtml()}
    <div class="card">
      <h2>Enter PIN</h2>
      <input id="pin" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="4–6 digits">
      <button class="full" id="unlock">Unlock</button>
    </div>`;
  $('#unlock').onclick = async () => {
    if (await w.checkPin(val('#pin'))) {
      state.msg = null;
      await start();
    } else {
      setMsg('err', 'Wrong PIN.');
      renderLock();
    }
  };
}

(async () => {
  if (!(await w.hasWallet())) return renderWelcome();
  if (await w.pinIsSet()) return renderLock();
  await start();
})();
