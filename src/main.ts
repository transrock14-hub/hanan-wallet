import "./style.css";
import { Clipboard } from "@capacitor/clipboard";
import QRCode from "qrcode";
import {
  NETWORKS,
  explorerAddress,
  explorerTx,
  resetSettings,
  settings,
} from "./config";
import {
  discoverToken,
  isLookalike,
  listTokens,
  removeToken,
  saveToken,
  type Token,
} from "./tokens";
import {
  defaultCoinTemplate,
  parseCoinTemplate,
  setCoinHeader,
} from "./coin-template";
import {
  contactName,
  listContacts,
  listHistory,
  removeContact,
  saveContact,
  upsertHistory,
  type TxRecord,
} from "./store";
import * as w from "./wallet";
import * as arb from "./arb/engine";
import { formatUnits } from "./arb/math";
import type { Opportunity } from "./arb/scanner";

type Tab = "send" | "approve" | "transferFrom" | "wrap" | "unwrap";
type View = "dash" | "move" | "activity" | "arb";
type Msg = { kind: "ok" | "err" | "info"; html: string } | null;

const app = document.getElementById("app")!;
const state = {
  view: "dash" as View,
  tab: "send" as Tab,
  asset: "native", // 'native' | token address
  msg: null as Msg,
  busy: false,
  holdings: [] as w.Holding[],
  accounts: [] as string[],
  incoming: [] as w.ChainActivity[],
  draft: { to: "", amount: "", from: "", spender: "" },
  speed: "normal" as w.Speed,
};

// ---------- helpers ----------

const esc = (s: string) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (v: string | null) =>
  v === null
    ? "—"
    : Number(v).toLocaleString(undefined, { maximumFractionDigits: 6 });
const $ = <T extends HTMLElement>(sel: string) => app.querySelector(sel) as T;
const $opt = <T extends HTMLElement>(sel: string) =>
  app.querySelector(sel) as T | null;
const val = (sel: string) => ($opt<HTMLInputElement>(sel)?.value ?? "").trim();
const net = () => settings.network;
const badge = () =>
  net().mainnet
    ? '<span class="tag main">MAINNET</span>'
    : '<span class="tag">TESTNET</span>';
const sym = (t: Token | null) => (t ? t.symbol : net().nativeSymbol);
const lookalikeBadge = (t: Token) =>
  isLookalike(t) ? ` <span class="bad">⚠ lookalike</span>` : "";
const APP_LINK = "https://transrock14-hub.github.io/hanan-wallet/";
const STABLES = new Set(
  NETWORKS.flatMap((n) =>
    n.presets.filter((p) => p.stable).map((p) => p.address.toLowerCase()),
  ),
);
let ethUsd: number | null = null;
let tokenUsd = new Map<string, number>();

const money = (usd: number) =>
  `$${usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

const timeAgo = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60
    ? "just now"
    : s < 3600
      ? `${Math.round(s / 60)} min ago`
      : s < 86400
        ? `${Math.round(s / 3600)} h ago`
        : new Date(t).toLocaleDateString();
};

/** The big warning box was replaced by a compact TESTNET tag in every screen title. */
function banner() {
  return "";
}
function msgHtml() {
  return state.msg
    ? `<div class="msg ${state.msg.kind}">${state.msg.html}</div>`
    : "";
}
function setMsg(kind: "ok" | "err" | "info", text: string, rawHtml = false) {
  state.msg = { kind, html: rawHtml ? text : esc(text) };
}
async function copy(text: string, what = "Address") {
  await Clipboard.write({ string: text });
  setMsg("ok", `${what} copied.`);
}
const select = (id: string, opts: [string, string][], cur: string) =>
  `<select id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;

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
  $("#create").onclick = async () => renderBackup(await w.createWallet(), true);
  $("#import").onclick = async () => {
    try {
      await w.importWallet(val("#phrase"));
      state.msg = null;
      await start();
    } catch (e) {
      setMsg("err", w.explain(e));
      renderWelcome();
    }
  };
}

function renderBackup(phrase: string, firstTime: boolean) {
  const words = phrase
    .split(" ")
    .map((x, i) => `<span><i>${i + 1}</i>${esc(x)}</span>`)
    .join("");
  app.innerHTML = `
    ${banner()}
    <div class="top"><h1>Recovery phrase ${badge()}</h1></div>
    <div class="card">
      <p class="muted">Write these words down in order. Anyone with them controls every account in this wallet. The app cannot recover them for you.</p>
      <div class="phrase">${words}</div>
      ${firstTime ? `<label class="check"><input type="checkbox" id="ack">I wrote it down</label>` : ""}
      <button class="full" id="done" ${firstTime ? "disabled" : ""}>${firstTime ? "Continue" : "Back"}</button>
    </div>`;
  if (firstTime)
    $<HTMLInputElement>("#ack").onchange = (e) =>
      $("#done").toggleAttribute(
        "disabled",
        !(e.target as HTMLInputElement).checked,
      );
  $("#done").onclick = () => (firstTime ? start() : renderSettings());
}

// ---------- Home ----------

function sendable() {
  // While balances are (re)loading, holdings is empty; the native coin is always sendable.
  const holdings: w.Holding[] = state.holdings.length
    ? state.holdings
    : [{ token: null, balance: null }];
  return holdings.map((h) => ({
    id: h.token ? h.token.address : "native",
    token: h.token,
    balance: h.balance,
    label: h.token
      ? `${h.token.symbol}${h.token.symbol === "WSETH" ? "" : ` (${short(h.token.address)})`}`
      : net().nativeSymbol,
  }));
}

function actionForm() {
  const hasW = !!settings.wsethAddress;
  const amountRow = (unit: string, max = true) => `
    <label>Amount (${esc(unit)})</label>
    <div class="row"><input id="amt" inputmode="decimal" placeholder="0.01" value="${esc(state.draft.amount)}">${max ? `<button class="secondary grow0" id="max">Max</button>` : ""}</div>`;
  if ((state.tab === "wrap" || state.tab === "unwrap") && !hasW)
    return `<p class="muted">Set up WSETH for ${esc(net().name)} in Settings first (deploy it or paste its address).</p>`;
  const feeLine = `<label>Speed</label>${select(
    "speed",
    [
      ["slow", "Slow"],
      ["normal", "Normal"],
      ["fast", "Fast"],
    ],
    state.speed,
  )}<p class="muted fee" id="fee">Enter an amount to estimate the network fee.</p>`;
  if (state.tab === "wrap")
    return `<p class="muted">Locks ${esc(net().nativeSymbol)} in the contract and gives you the same amount of WSETH.</p>${amountRow(net().nativeSymbol, false)}${feeLine}<button class="full" id="go">Review wrap</button>`;
  if (state.tab === "unwrap")
    return `<p class="muted">Burns WSETH and returns the same amount of ${esc(net().nativeSymbol)}.</p>${amountRow("WSETH", false)}${feeLine}<button class="full" id="go">Review unwrap</button>`;

  if (state.tab === "approve" || state.tab === "transferFrom") {
    const tokens = sendable().filter((asset) => asset.token);
    if (!tokens.length)
      return '<p class="muted">Add or create an ERC-20 token first. Native ETH does not support token approvals.</p>';
    if (!tokens.some((asset) => asset.id === state.asset))
      state.asset = tokens[0].id;
    const cur = tokens.find((asset) => asset.id === state.asset)!;
    const tokenSelect = `<label>Token</label>${select(
      "asset",
      tokens.map((asset) => [asset.id, asset.label]),
      state.asset,
    )}`;
    if (state.tab === "approve")
      return `${tokenSelect}<p class="muted">Allow a spender address to move up to this amount of your ${esc(cur.token!.symbol)}.</p><label>Spender address</label><input id="spender" placeholder="0x…" autocapitalize="off" spellcheck="false" value="${esc(state.draft.spender)}">${amountRow(cur.token!.symbol, false)}${feeLine}<button class="full" id="go">Review approval</button>`;
    return `${tokenSelect}<p class="muted">Submit a transfer using an allowance already granted by the token owner. The active wallet pays gas.</p><label>Token owner</label><input id="from" placeholder="0x…" autocapitalize="off" spellcheck="false" value="${esc(state.draft.from)}"><label>Recipient address</label><input id="to" placeholder="0x…" autocapitalize="off" spellcheck="false" value="${esc(state.draft.to)}">${amountRow(cur.token!.symbol, false)}${feeLine}<button class="full" id="go">Review delegated transfer</button>`;
  }

  const list = sendable();
  if (!list.some((a) => a.id === state.asset)) state.asset = "native";
  const cur = list.find((a) => a.id === state.asset)!;
  const contacts = listContacts();
  return `
    <label>Coin</label>
    ${select(
      "asset",
      list.map((a) => [a.id, a.label]),
      state.asset,
    )}
    ${cur.token && isLookalike(cur.token) ? `<div class="msg err">This token uses the symbol "${esc(cur.token.symbol)}" but is not the known contract for it. It may be a lookalike.</div>` : ""}
    <label>Recipient address</label>
    <div class="row">
      <input id="to" placeholder="0x…" autocapitalize="off" spellcheck="false" value="${esc(state.draft.to)}">
      <button class="secondary grow0" id="scan">Scan</button>
    </div>
    ${contacts.length ? select("contact", [["", "Or pick a contact…"], ...contacts.map((c): [string, string] => [c.address, `${c.name} (${short(c.address)})`])], "") : ""}
    ${amountRow(sym(cur.token))}
    ${feeLine}
    <button class="full" id="go">Review send</button>`;
}

function accountOptions() {
  const opts: [string, string][] = state.accounts.map((a, i) => [
    String(i),
    `${settings.accountName(i)} (${short(a)})`,
  ]);
  opts.push(["new", "+ Add account"]);
  return opts;
}

function hashLink(hash: string) {
  const url = explorerTx(hash);
  return url ? `<a href="${url}">${short(hash)}</a>` : short(hash);
}

function addrLink(addr: string) {
  const url = explorerAddress(addr);
  return url
    ? `<a class="addr" href="${url}">${short(addr)}</a>`
    : `<span class="addr">${short(addr)}</span>`;
}

function activityItems() {
  const local = listHistory(w.address()).map((t) => ({
    ...t,
    incoming: false,
  }));
  const seen = new Set(local.map((t) => t.hash));
  return [...local, ...state.incoming.filter((t) => !seen.has(t.hash))].sort(
    (a, b) => b.time - a.time,
  );
}

function nativeBalance() {
  const native = state.holdings.find((h) => !h.token);
  return native ? native.balance : state.holdings.length ? "0" : null;
}

function txRows(items: TxRecord[]) {
  return items
    .map(
      (
        t,
      ) => `<div class="tx"><span>${esc(t.label)}<br><span class="muted">${timeAgo(t.time)} · ${hashLink(t.hash)}</span></span>
      <span class="st-${t.status}">${t.status}</span></div>`,
    )
    .join("");
}

function assetRows() {
  const list = state.holdings.length ? state.holdings : [];
  if (!list.length) return '<p class="muted">Loading balances…</p>';
  return list
    .map((h) => {
      const name = sym(h.token);
      const usd = holdingUsd(h);
      return `<div class="asset"><span class="badge">${esc(name.slice(0, 1))}</span><span class="asset-name">${esc(name)}${h.token ? lookalikeBadge(h.token) : ""}<br><span class="muted">${h.token ? short(h.token.address) : esc(net().name)}</span></span><b class="num">${fmt(h.balance)}${usd ? `<br><span class="muted">${usd}</span>` : ""}</b></div>`;
    })
    .join("");
}

function chrome(title = "Hanan Wallet") {
  return `
    ${banner()}
    <div class="top"><h1>${esc(title)} ${badge()}</h1><button class="secondary" id="settings">Settings</button></div>
    <div class="row picks">
      ${select(
        "network",
        NETWORKS.map((n) => [String(n.chainId), n.name]),
        String(net().chainId),
      )}
      ${select("account", accountOptions(), String(settings.activeAccount))}
    </div>
    ${msgHtml()}`;
}

function nav() {
  const items: [View, string][] = [
    ["dash", "Dashboard"],
    ["move", "Send"],
    ["activity", "Activity"],
    ["arb", "Arbitrage"],
  ];
  return `<nav class="nav">${items.map(([id, label]) => `<button data-view="${id}" class="${state.view === id ? "active" : ""}">${label}</button>`).join("")}</nav>`;
}

function bindShell() {
  const addr = w.address();
  $("#settings").onclick = () => {
    state.msg = null;
    renderSettings();
  };
  const copyBtn = $opt<HTMLButtonElement>("#copy");
  if (copyBtn)
    copyBtn.onclick = async () => {
      await copy(addr);
      renderHome();
    };
  const receive = $opt<HTMLButtonElement>("#receive");
  if (receive) receive.onclick = renderReceive;
  const refreshBtn = $opt<HTMLButtonElement>("#refresh");
  if (refreshBtn) refreshBtn.onclick = () => refresh();
  $<HTMLSelectElement>("#network").onchange = async (e) => {
    const next = NETWORKS.find(
      (n) => String(n.chainId) === (e.target as HTMLSelectElement).value,
    )!;
    if (
      next.mainnet &&
      !(await askConfirm(
        `${next.name} is a real network. Sends from here spend real ${next.nativeSymbol} and tokens.`,
      ))
    ) {
      (e.target as HTMLSelectElement).value = String(settings.network.chainId);
      return;
    }
    settings.network = next;
    state.asset = "native";
    state.msg = null;
    await reconnect();
  };
  $<HTMLSelectElement>("#account").onchange = async (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v === "new") {
      settings.accountCount = settings.accountCount + 1;
      settings.activeAccount = settings.accountCount - 1;
      setMsg(
        "ok",
        `Created Account ${settings.accountCount}. It comes from the same recovery phrase.`,
      );
    } else settings.activeAccount = Number(v);
    await w.loadWallet();
    state.accounts = await w.accountAddresses();
    await refresh();
  };
  app.querySelectorAll<HTMLButtonElement>("[data-view]").forEach(
    (b) =>
      (b.onclick = () => {
        saveDraft();
        state.view = b.dataset.view as View;
        state.msg = null;
        renderHome();
      }),
  );
  app.querySelectorAll<HTMLButtonElement>("[data-go]").forEach(
    (b) =>
      (b.onclick = () => {
        state.view = "move";
        state.tab = b.dataset.go as Tab;
        state.msg = null;
        renderHome();
      }),
  );
  app.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(
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
  if (n.faucetUrl)
    return `<a class="faucet" href="${esc(n.faucetUrl)}" target="_blank" rel="noopener">Get test ${esc(n.nativeSymbol)}</a>`;
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
      ${usdLine(bal)}
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
      <p class="muted" style="margin:8px 0 0">Incoming tokens are detected automatically where supported. Add contract addresses in Settings → Tokens.</p>
    </div>
    <div class="card">
      <div class="section-head"><h2>Recent</h2><button class="secondary grow0" data-view="activity">All</button></div>
      ${txRows(recent) || '<p class="muted">No transactions yet on this network.</p>'}
    </div>
    ${nav()}`;
  bindShell();
  $("#createCoin").onclick = () => {
    state.msg = null;
    renderCoin();
  };
}

function renderCoin() {
  const src = localStorage.getItem("coinTemplate") || defaultCoinTemplate();
  const fields = parseCoinTemplate(src);
  const presets = [
    {
      id: "dollar",
      label: "Dollar-style demo (HUSD)",
      name: "Hanan Study Dollar",
      symbol: "HUSD",
    },
    {
      id: "satoshi",
      label: "Bitcoin-style demo (HSAT)",
      name: "Hanan Study Satoshi",
      symbol: "HSAT",
    },
    {
      id: "token",
      label: "Ether-style demo (HETH)",
      name: "Hanan Study Token",
      symbol: "HETH",
    },
  ];
  const mainnet = !!net().mainnet;
  app.innerHTML = `
    <div class="top"><h1>New coin ${badge()}</h1><button class="secondary" id="back">Back</button></div>
    ${msgHtml()}
    <div class="card">
      ${mainnet ? `<div class="msg err">${esc(net().name)} deployment spends real ${esc(net().nativeSymbol)} on gas. The deployed contract is permanent, and its tokens have no connection to established assets.</div>` : ""}
      <p class="muted">These are independent learning tokens with no connection to real assets and no monetary value. Transfers are permanent; a recipient must send tokens back themselves.</p>
      <label>Start with an example</label>
      <div class="row"><select id="coinPreset">${presets.map((preset) => `<option value="${preset.id}">${preset.label}</option>`).join("")}</select><button class="secondary grow0" id="loadPreset">Load</button></div>
      <p class="muted">Deploy on <b>${esc(net().name)}</b>. The initial supply goes to your address and will appear in Assets, ready to send from the Send screen.</p>
      <label>Contract</label>
      <textarea id="src" class="code" spellcheck="false">${esc(src)}</textarea>
      <label>Name</label>
      <input id="coinName" maxlength="32" value="${esc(fields.name)}">
      <label>Symbol</label>
      <input id="coinSymbol" maxlength="8" autocapitalize="characters" value="${esc(fields.symbol)}">
      <label>Supply (whole coins)</label>
      <input id="coinSupply" inputmode="numeric" value="${esc(fields.supply)}">
      <button class="full" id="deployCoin" ${state.busy ? "disabled" : ""}>${mainnet ? "Deploy learning token" : "Create learning token"}</button>
    </div>`;
  const area = $<HTMLTextAreaElement>("#src");
  const name = $<HTMLInputElement>("#coinName");
  const symbol = $<HTMLInputElement>("#coinSymbol");
  const supply = $<HTMLInputElement>("#coinSupply");
  const persist = () => localStorage.setItem("coinTemplate", area.value);
  const push = (field: "Name" | "Symbol" | "Supply", value: string) => {
    area.value = setCoinHeader(area.value, field, value);
    persist();
  };
  $("#loadPreset").onclick = () => {
    const preset = presets.find(
      (item) => item.id === $<HTMLSelectElement>("#coinPreset").value,
    )!;
    name.value = preset.name;
    symbol.value = preset.symbol;
    push("Name", name.value);
    push("Symbol", symbol.value);
  };
  name.oninput = () => push("Name", name.value);
  symbol.oninput = () => push("Symbol", symbol.value);
  supply.oninput = () => push("Supply", supply.value);
  area.oninput = () => {
    const next = parseCoinTemplate(area.value);
    if (document.activeElement !== name) name.value = next.name;
    if (document.activeElement !== symbol) symbol.value = next.symbol;
    if (document.activeElement !== supply) supply.value = next.supply;
    persist();
  };
  $("#back").onclick = () => {
    persist();
    state.msg = null;
    renderHome();
  };
  $("#deployCoin").onclick = async () => {
    persist();
    const coin = parseCoinTemplate(area.value);
    if (
      mainnet &&
      !(await askConfirm(
        `Deploy ${coin.name} (${coin.symbol}) with a supply of ${coin.supply} on ${net().name}?\n\nThis deploys a permanent token contract and spends real ${net().nativeSymbol} on gas. Anyone can receive and transfer these tokens, but they are not real USDT, ETH, or BTC and have no guaranteed value.\n\nContinue?`,
      ))
    )
      return;
    state.busy = true;
    setMsg("info", `Creating ${coin.symbol || "coin"} on ${net().name}…`);
    renderCoin();
    try {
      const {
        tx,
        address,
        name: coinName,
        symbol: coinSymbol,
      } = await w.deployCoin(coin.name, coin.symbol, coin.supply);
      const created = {
        address,
        name: coinName,
        symbol: coinSymbol,
        decimals: 18,
      };
      saveToken(created);
      upsertHistory(w.address(), {
        hash: tx.hash,
        label: `Create ${coinSymbol}`,
        status: "confirmed",
        time: Date.now(),
      });
      state.busy = false;
      state.view = "dash";
      setMsg(
        "ok",
        `Created ${coinName} (${coinSymbol}). Add it to other wallets with the contract address below.`,
      );
      renderShareToken(created, () => refresh());
    } catch (e) {
      state.busy = false;
      setMsg("err", w.explain(e));
      renderCoin();
    }
  };
}

function renderMove() {
  const titles: Record<Tab, string> = {
    send: "Send",
    approve: "Approve token",
    transferFrom: "Transfer from",
    wrap: "Wrap",
    unwrap: "Unwrap",
  };
  const mainnetWarning =
    net().mainnet && state.tab === "send"
      ? `<div class="msg err">${esc(net().name)} uses real ${esc(net().nativeSymbol)} and tokens. Transactions cannot be reversed. Check the recipient address, make sure the recipient uses ${esc(net().name)}, and keep ${esc(net().nativeSymbol)} for gas.</div>`
      : "";
  app.innerHTML = `
    ${chrome(titles[state.tab])}
    ${mainnetWarning}
    <div class="card">
      <div class="tabs">${(["send", "approve", "transferFrom", "wrap", "unwrap"] as Tab[]).map((id) => `<button data-tab="${id}" class="${state.tab === id ? "active" : ""}">${id === "transferFrom" ? "Transfer from" : id[0].toUpperCase() + id.slice(1)}</button>`).join("")}</div>
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
    ${chrome("Activity")}
    <div class="card">
      <h2>On ${esc(net().name)}</h2>
      ${txRows(rows) || '<p class="muted">No transactions yet on this network.</p>'}
      ${explorer ? `<p class="muted" style="margin-bottom:0"><a href="${explorer}">Full history on the explorer</a></p>` : '<p class="muted" style="margin-bottom:0">Includes transfers sent to this address on Anvil.</p>'}
    </div>
    ${nav()}`;
  bindShell();
}

function renderHome() {
  if (state.view === "move") renderMove();
  else if (state.view === "activity") renderActivity();
  else if (state.view === "arb") renderArb();
  else renderDash();
  const assetSel = $opt<HTMLSelectElement>("#asset");
  if (assetSel)
    assetSel.onchange = () => {
      saveDraft();
      state.asset = assetSel.value;
      state.draft.amount = "";
      renderHome();
    };
  const contactSel = $opt<HTMLSelectElement>("#contact");
  if (contactSel)
    contactSel.onchange = () =>
      contactSel.value && ($<HTMLInputElement>("#to").value = contactSel.value);
  const speedSel = $opt<HTMLSelectElement>("#speed");
  if (speedSel)
    speedSel.onchange = () => {
      saveDraft();
      state.speed = speedSel.value as w.Speed;
      renderHome();
    };
  const maxBtn = $opt<HTMLButtonElement>("#max");
  if (maxBtn)
    maxBtn.onclick = async () => {
      const cur = sendable().find((a) => a.id === state.asset)!;
      try {
        $<HTMLInputElement>("#amt").value = cur.token
          ? (cur.balance ?? "0")
          : await w.maxNative(state.speed);
      } catch (e) {
        setMsg("err", w.explain(e));
        renderHome();
      }
    };
  const go = $opt<HTMLButtonElement>("#go");
  if (go) {
    go.disabled = state.busy;
    go.onclick = () => review();
  }
  const scan = $opt<HTMLButtonElement>("#scan");
  if (scan) scan.onclick = () => scanRecipient();
  bindFee();
}

let feeTimer = 0;
function bindFee() {
  const amt = $opt<HTMLInputElement>("#amt");
  const fee = $opt<HTMLElement>("#fee");
  if (!amt || !fee) return;
  const run = async () => {
    saveDraft();
    if (!state.draft.amount) {
      fee.textContent = "Enter an amount to estimate the network fee.";
      return;
    }
    if (state.tab === "send" && !state.draft.to) {
      fee.textContent = "Add a recipient to estimate the network fee.";
      return;
    }
    if (state.tab === "approve" && !state.draft.spender) {
      fee.textContent = "Add a spender to estimate the network fee.";
      return;
    }
    if (
      state.tab === "transferFrom" &&
      (!state.draft.from || !state.draft.to)
    ) {
      fee.textContent =
        "Add the token owner and recipient to estimate the network fee.";
      return;
    }
    fee.textContent = "Estimating network fee…";
    try {
      let request;
      if (state.tab === "wrap")
        request = await w.build.wrap(state.draft.amount);
      else if (state.tab === "unwrap")
        request = await w.build.unwrap(state.draft.amount);
      else if (state.tab === "approve" || state.tab === "transferFrom") {
        const token = sendable().find(
          (asset) => asset.id === state.asset,
        )?.token;
        if (!token) throw new Error("Select an ERC-20 token first.");
        request =
          state.tab === "approve"
            ? await w.build.approveToken(
                token,
                state.draft.spender,
                state.draft.amount,
              )
            : await w.build.transferTokenFrom(
                token,
                state.draft.from,
                state.draft.to,
                state.draft.amount,
              );
      } else {
        const cur = sendable().find((a) => a.id === state.asset)!;
        request = cur.token
          ? await w.build.token(cur.token, state.draft.to, state.draft.amount)
          : await w.build.native(state.draft.to, state.draft.amount);
      }
      const q = await w.quote(request, state.speed);
      const usd = feeUsd(q.fee);
      if ($opt("#fee") === fee)
        fee.textContent = `Network fee ≈ ${w.formatFee(q.fee)}${usd ? ` · ${usd}` : ""}`;
    } catch (e) {
      if ($opt("#fee") === fee) fee.textContent = w.explain(e);
    }
  };
  const schedule = () => {
    window.clearTimeout(feeTimer);
    feeTimer = window.setTimeout(() => void run(), 450);
  };
  amt.addEventListener("input", schedule);
  $opt<HTMLInputElement>("#to")?.addEventListener("input", schedule);
  $opt<HTMLInputElement>("#from")?.addEventListener("input", schedule);
  $opt<HTMLInputElement>("#spender")?.addEventListener("input", schedule);
  if (state.draft.amount) schedule();
}

async function scanRecipient() {
  const Detector = (
    window as unknown as {
      BarcodeDetector?: new (o: { formats: string[] }) => {
        detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]>;
      };
    }
  ).BarcodeDetector;
  if (!Detector || !navigator.mediaDevices?.getUserMedia) {
    setMsg(
      "err",
      "This phone cannot scan QR codes. Paste the address instead.",
    );
    renderHome();
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "scan-overlay";
  overlay.innerHTML = `<h2>Scan a wallet QR</h2><video id="scanVideo" autoplay playsinline muted></video><button class="secondary" id="scanClose">Cancel</button>`;
  document.body.appendChild(overlay);
  let stream: MediaStream | null = null;
  let timer = 0;
  const close = () => {
    window.clearInterval(timer);
    stream?.getTracks().forEach((t) => t.stop());
    overlay.remove();
  };
  overlay.querySelector<HTMLButtonElement>("#scanClose")!.onclick = close;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
    const video = overlay.querySelector<HTMLVideoElement>("#scanVideo")!;
    video.srcObject = stream;
    await video.play();
    const det = new Detector({ formats: ["qr_code"] });
    timer = window.setInterval(async () => {
      try {
        const codes = await det.detect(video);
        const raw = codes[0]?.rawValue || "";
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
    setMsg("err", "Camera permission is needed to scan a QR code.");
    renderHome();
  }
}

function saveDraft() {
  const toEl = $opt<HTMLInputElement>("#to");
  const amtEl = $opt<HTMLInputElement>("#amt");
  state.draft = {
    to: toEl ? toEl.value.trim() : state.draft.to,
    amount: amtEl ? amtEl.value.trim() : state.draft.amount,
    from: $opt<HTMLInputElement>("#from")?.value.trim() ?? state.draft.from,
    spender:
      $opt<HTMLInputElement>("#spender")?.value.trim() ?? state.draft.spender,
  };
}

/** In-app confirm. The phone's WebView drops window.confirm after an awaited network call, so the send looks like it did nothing. */
function askConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "scan-overlay";
    overlay.innerHTML = `
      <div class="card">
        <h2>Confirm</h2>
        <p class="confirm-text"></p>
        <div class="row">
          <button class="secondary" id="confirmNo">Cancel</button>
          <button id="confirmYes">Confirm</button>
        </div>
      </div>`;
    overlay.querySelector("p")!.textContent = message;
    document.body.appendChild(overlay);
    const done = (yes: boolean) => {
      overlay.remove();
      resolve(yes);
    };
    overlay.querySelector<HTMLButtonElement>("#confirmYes")!.onclick = () =>
      done(true);
    overlay.querySelector<HTMLButtonElement>("#confirmNo")!.onclick = () =>
      done(false);
  });
}

/** PIN prompt drawn over the app. Without Cancel it stays until the right PIN is entered (used for auto-lock). */
function pinOverlay(
  title: string,
  reason: string,
  cancellable: boolean,
): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = `scan-overlay${cancellable ? "" : " lock-overlay"}`;
    overlay.innerHTML = `
      <div class="card">
        <h2></h2>
        <p class="confirm-text"></p>
        <input id="pinAsk" type="password" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="4–6 digits">
        <p class="bad" id="pinErr"></p>
        <div class="row">
          ${cancellable ? '<button class="secondary" id="pinNo">Cancel</button>' : ""}
          <button id="pinYes">${cancellable ? "Continue" : "Unlock"}</button>
        </div>
      </div>`;
    overlay.querySelector("h2")!.textContent = title;
    overlay.querySelector("p")!.textContent = reason;
    document.body.appendChild(overlay);
    const input = overlay.querySelector<HTMLInputElement>("#pinAsk")!;
    const err = overlay.querySelector<HTMLElement>("#pinErr")!;
    const done = (ok: boolean) => {
      overlay.remove();
      resolve(ok);
    };
    const noBtn = overlay.querySelector<HTMLButtonElement>("#pinNo");
    if (noBtn) noBtn.onclick = () => done(false);
    overlay.querySelector<HTMLButtonElement>("#pinYes")!.onclick = async () => {
      try {
        if (await w.checkPin(input.value.trim())) return done(true);
        err.textContent = "Wrong PIN.";
      } catch (e) {
        err.textContent = w.explain(e);
      }
      input.value = "";
    };
    input.focus();
  });
}

/** Asks for the app PIN before a sensitive action. True straight away when no PIN is set. */
async function askPin(reason: string) {
  return !(await w.pinIsSet()) || pinOverlay("Enter PIN", reason, true);
}

/** Locks the wallet again after it has been in the background this long. */
const AUTO_LOCK_MS = 60_000;
let hiddenAt = 0;
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    return;
  }
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  if (
    away < AUTO_LOCK_MS ||
    !w.address() ||
    document.querySelector(".lock-overlay") ||
    !(await w.pinIsSet())
  )
    return;
  await pinOverlay("Hanan Wallet is locked", "Enter your PIN to continue.", false);
});

/** Token contracts don't hand back tokens sent to them, so this is a common way to lose funds. */
function recipientWarning(dest: string) {
  const d = dest.toLowerCase();
  const contract = [w.wsethToken(), ...listTokens()].find(
    (t) => t && t.address.toLowerCase() === d,
  );
  if (contract)
    return `WARNING: This is the ${contract.symbol} token contract, not a wallet. Anything sent to it is almost certainly lost for good.\n\n`;
  if (d === w.address().toLowerCase())
    return "Note: this is your own address.\n\n";
  return "";
}

/** Builds the transaction, estimates the fee (which also simulates it), asks for confirmation, then sends. */
async function review() {
  saveDraft();
  const amount = state.draft.amount;
  const to = state.draft.to;
  let label: string;
  let summary: string;
  state.busy = true;
  setMsg("info", "Estimating network fee…");
  renderHome();
  try {
    let request;
    if (state.tab === "wrap") {
      request = await w.build.wrap(amount);
      label = summary = `Wrap ${amount} ${net().nativeSymbol} → WSETH`;
    } else if (state.tab === "unwrap") {
      request = await w.build.unwrap(amount);
      label = summary = `Unwrap ${amount} WSETH → ${net().nativeSymbol}`;
    } else if (state.tab === "approve") {
      const token = sendable().find((asset) => asset.id === state.asset)?.token;
      if (!token) throw new Error("Select an ERC-20 token first.");
      const spender = await w.resolveRecipient(state.draft.spender);
      request = await w.build.approveToken(token, spender, amount);
      label = `Approve ${amount} ${sym(token)} for ${short(spender)}`;
      summary = `Approve ${amount} ${sym(token)}\nSpender: ${spender}`;
    } else if (state.tab === "transferFrom") {
      const token = sendable().find((asset) => asset.id === state.asset)?.token;
      if (!token) throw new Error("Select an ERC-20 token first.");
      const from = await w.resolveRecipient(state.draft.from);
      const dest = await w.resolveRecipient(to);
      request = await w.build.transferTokenFrom(token, from, dest, amount);
      label = `Transfer ${amount} ${sym(token)} from ${short(from)} to ${short(dest)}`;
      summary = `${recipientWarning(dest)}Transfer ${amount} ${sym(token)}\nFrom: ${from}\nTo: ${dest}`;
    } else {
      const cur = sendable().find((a) => a.id === state.asset)!;
      const dest = await w.resolveRecipient(to);
      request = cur.token
        ? await w.build.token(cur.token, dest, amount)
        : await w.build.native(dest, amount);
      const who =
        contactName(dest) ||
        (dest.toLowerCase() !== to.toLowerCase() ? to : null);
      label = `Send ${amount} ${sym(cur.token)} to ${who ?? short(dest)}`;
      summary = `${recipientWarning(dest)}Send ${amount} ${sym(cur.token)}\nTo: ${who ? `${who}\n` : ""}${dest}`;
    }
    const q = await w.quote(request, state.speed);
    state.busy = false;
    state.msg = null;
    renderHome();
    const usd = feeUsd(q.fee);
    const realFundsWarning =
      net().mainnet
        ? `REAL FUNDS: This ${net().name} transaction is irreversible.\n\n`
        : "";
    if (
      !(await askConfirm(
        `${realFundsWarning}${summary}\n\nNetwork: ${net().name}\nSpeed: ${state.speed}\nMax network fee: ≈ ${w.formatFee(q.fee)}${usd ? ` (${usd})` : ""}\n\nConfirm?`,
      ))
    )
      return;
    await track(label, q);
    state.draft = { to: "", amount: "", from: "", spender: "" };
    state.view = "dash";
  } catch (e) {
    state.busy = false;
    setMsg("err", w.explain(e));
  }
  await refresh();
}

async function track(label: string, q: w.Quote) {
  const addr = w.address();
  state.busy = true;
  try {
    const tx = await w.send(q);
    const rec: TxRecord = {
      hash: tx.hash,
      label,
      status: "pending",
      time: Date.now(),
    };
    upsertHistory(addr, rec);
    setMsg("info", `Submitted. Waiting for ${net().name} to confirm…`);
    renderHome();
    const r = await tx.wait();
    rec.status = r?.status === 1 ? "confirmed" : "failed";
    upsertHistory(addr, rec);
    const url = explorerTx(tx.hash);
    if (rec.status === "confirmed" && url)
      setMsg(
        "ok",
        `Confirmed. <a href="${esc(url)}">View transaction</a>`,
        true,
      );
    else
      setMsg(
        rec.status === "confirmed" ? "ok" : "err",
        rec.status === "confirmed"
          ? "Confirmed."
          : "Transaction failed on-chain.",
      );
  } catch (e) {
    setMsg("err", w.explain(e));
  } finally {
    state.busy = false;
  }
}

/** Re-checks any transactions still marked pending (for example after the app was closed). */
async function settlePending() {
  const addr = w.address();
  for (const t of listHistory(addr).filter((t) => t.status === "pending")) {
    try {
      const s = await w.receiptStatus(t.hash);
      if (s !== "pending") upsertHistory(addr, { ...t, status: s });
    } catch {
      /* try again next refresh */
    }
  }
}

function feeUsd(wei: bigint) {
  if (!net().mainnet || ethUsd == null) return "";
  return money((Number(wei) / 1e18) * ethUsd);
}

function holdingUsd(h: w.Holding) {
  if (!net().mainnet || h.balance == null) return "";
  const n = Number(h.balance);
  if (!Number.isFinite(n)) return "";
  if (!h.token) return ethUsd == null ? "" : money(n * ethUsd);
  const px = STABLES.has(h.token.address.toLowerCase())
    ? 1
    : tokenUsd.get(h.token.address.toLowerCase());
  return px == null ? "" : money(n * px);
}

function usdLine(bal: string | null) {
  if (!net().mainnet || ethUsd == null || bal == null) return "";
  const n = Number(bal);
  if (!Number.isFinite(n)) return "";
  return `<div class="muted">≈ ${money(n * ethUsd)}</div>`;
}

async function refreshPrice() {
  const n = net();
  if (!n.mainnet || !n.priceId || !n.pricePlatform) {
    ethUsd = null;
    tokenUsd = new Map();
    return;
  }
  ethUsd = null;
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${n.priceId}&vs_currencies=usd`,
    );
    if (res.ok) {
      const data = (await res.json()) as Record<string, { usd?: number }>;
      ethUsd = data[n.priceId]?.usd ?? null;
    }
  } catch {
    /* The balance still shows without a dollar price. */
  }
  const addrs = listTokens()
    .map((t) => t.address.toLowerCase())
    .filter((a) => !STABLES.has(a));
  if (!addrs.length) return;
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/token_price/${n.pricePlatform}?contract_addresses=${addrs.join(",")}&vs_currencies=usd`,
    );
    if (!res.ok) return;
    const data = (await res.json()) as Record<string, { usd?: number }>;
    const next = new Map<string, number>();
    for (const [addr, row] of Object.entries(data))
      if (row?.usd != null) next.set(addr.toLowerCase(), row.usd);
    tokenUsd = next;
  } catch {
    /* Token balances still show without a dollar price. */
  }
}

let refreshJob: Promise<void> | null = null;
async function refresh(render = true) {
  if (!refreshJob) {
    refreshJob = (async () => {
      const price = refreshPrice();
      try {
        const tokens = await w.incomingTokens(w.address());
        tokens.forEach(discoverToken);
      } catch {
        // Keep existing assets visible if the explorer's token index is unavailable.
      }
      try {
        state.holdings = await w.balances();
        await settlePending();
      } catch (e) {
        setMsg("err", w.explain(e));
      }
      await price;
      try {
        state.incoming = await w.incomingActivity(w.address());
      } catch {
        state.incoming = [];
      }
    })();
  }
  const job = refreshJob;
  try {
    await job;
  } finally {
    if (refreshJob === job) refreshJob = null;
  }
  if (render || $opt("#refresh")) renderHome();
}

const refreshDashboard = () => {
  if (document.visibilityState === "visible" && $opt("#refresh"))
    void refresh(false);
};
document.addEventListener("visibilitychange", refreshDashboard);
window.setInterval(refreshDashboard, 60_000);

async function reconnect() {
  state.holdings = [];
  renderHome();
  try {
    await w.connect();
  } catch (e) {
    setMsg("err", w.explain(e));
    return renderHome();
  }
  await refresh();
}

// ---------- Arbitrage (the flash-arb bot) ----------

const arbState = {
  /** Network + account the state below belongs to. */
  owner: "",
  scan: null as arb.ScanResult | null,
  scannedAt: 0,
  status: null as arb.ContractStatus | null,
  statusErr: "",
  statusLoading: false,
  watching: false,
  autoExec: false,
  timer: 0,
  /** A deploy, scan or trade is in progress. */
  running: false,
  setupOpen: false,
};

function arbFresh() {
  const owner = `${net().chainId}:${w.address()}`;
  if (arbState.owner === owner) return;
  stopWatch();
  Object.assign(arbState, {
    owner,
    scan: null,
    scannedAt: 0,
    status: null,
    statusErr: "",
    autoExec: false,
  });
}

const usdE8 = (v: bigint) => {
  const n = Number(v) / 1e8;
  return `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

function dexLabel(q: Opportunity["leg1"], practice: boolean) {
  if (practice) return q.dex === "uniswapV2" ? "DEX A" : "DEX B";
  const name = { uniswapV2: "Uniswap V2", sushiswap: "SushiSwap", uniswapV3: "Uniswap V3" }[q.dex];
  return q.feeTiers ? `${name} ${q.feeTiers.map((f) => `${f / 10000}%`).join("/")}` : name;
}

const routeText = (o: Opportunity, practice: boolean) =>
  `buy ${o.pair.quote.symbol} on ${dexLabel(o.leg1, practice)}, sell on ${dexLabel(o.leg2, practice)}`;

async function loadArbStatus() {
  const cfg = arb.loadConfig();
  arbState.status = null;
  arbState.statusErr = "";
  if (!cfg.contract) return;
  try {
    arbState.status = await arb.contractStatus(cfg);
  } catch (e) {
    arbState.statusErr = w.explain(e);
  }
}

function renderArb() {
  arbFresh();
  const cfg = arb.loadConfig();
  const n = net();
  const s = arbState.status;
  const res = arbState.scan;
  const practice = !!cfg.practice;
  if (cfg.contract && !s && !arbState.statusErr && !arbState.statusLoading) {
    arbState.statusLoading = true;
    void loadArbStatus().finally(() => {
      arbState.statusLoading = false;
      if (state.view === "arb") renderHome();
    });
  }

  const contractHtml = cfg.contract
    ? `<div class="addr">${addrLink(cfg.contract)}</div>
      ${
        arbState.statusErr
          ? `<p class="bad">${esc(arbState.statusErr)}</p>`
          : !s
            ? '<p class="muted">Checking the contract…</p>'
            : `${s.isOwner ? "" : `<div class="msg err">Owned by ${short(s.owner)}, not the active account. Switch to that account to trade or withdraw.</div>`}
        ${s.unapproved.length ? `<p class="muted">${s.unapproved.length} DEX router(s) not approved in the contract yet.</p><button class="full secondary" id="arbApprove" ${s.isOwner ? "" : "disabled"}>Approve routers</button>` : ""}
        <p class="muted" style="margin:10px 0 4px">Held by the contract. Profit stays here until you withdraw it.</p>
        ${s.balances
          .map(
            (b) =>
              `<div class="tx"><span><b>${esc(b.token.symbol)}</b> ${fmt(formatUnits(b.amount, b.token.decimals))}</span><button class="secondary grow0" data-withdraw="${b.token.address}" ${b.amount > 0n && s.isOwner ? "" : "disabled"}>Withdraw</button></div>`,
          )
          .join("")}`
      }`
    : `<p class="muted">No arbitrage contract on ${esc(n.name)} yet. It is deployed from this account, which becomes its only owner.</p>
      <button class="full" id="arbDeploy" ${cfg.addressesProvider && arb.venues(cfg).length ? "" : "disabled"}>Deploy arbitrage contract</button>
      ${cfg.addressesProvider ? "" : '<p class="muted">Fill in the Aave addresses provider and DEX routers under Setup first.</p>'}`;

  const practiceHtml = n.mainnet
    ? ""
    : `<div class="card">
      <h2>Practice market</h2>
      <p class="muted">Public test networks rarely have two DEXes with a usable price gap. This deploys practice tokens pUSD and pETH, a practice lending pool and two DEXes that price pETH 2% apart on ${esc(n.name)}, plus your arbitrage contract, so a full flash-loan arbitrage can be watched end to end. Costs only test ${esc(n.nativeSymbol)}.</p>
      <button class="full secondary" id="arbPractice">${practice ? "Rebuild practice market" : "Set up practice market"}</button>
    </div>`;

  const rows = !res
    ? '<p class="muted">Not scanned yet.</p>'
    : res.opportunities
        .map((o, i) => {
          const ok = o.netProfitUsdE8 >= res.minProfitUsdE8;
          return `<div class="tx"><span><b>${esc(o.pair.base.symbol)} → ${esc(o.pair.quote.symbol)} → ${esc(o.pair.base.symbol)}</b><br><span class="muted">${esc(routeText(o, practice))} · borrow ${fmt(formatUnits(o.amountIn, o.pair.base.decimals))}</span></span>
          <span style="text-align:right"><b class="${ok ? "st-confirmed" : "muted"}">${usdE8(o.netProfitUsdE8)}</b>${ok && cfg.contract ? `<br><button class="grow0" data-exec="${i}" ${arbState.running || state.busy ? "disabled" : ""}>Execute</button>` : ""}</span></div>`;
        })
        .join("") || '<p class="muted">No route had a price on two DEXes. The pools may not exist on this network.</p>';

  const field = (id: keyof arb.ArbConfig, label: string, hint = "0x…") =>
    `<label>${label}</label><input id="arb-${id}" value="${esc(String(cfg[id] ?? ""))}" placeholder="${hint}" autocapitalize="off" spellcheck="false">`;
  const pairRows = cfg.pairs
    .map(
      (p, i) =>
        `<div class="tx"><span><b>${esc(p.base.symbol)}/${esc(p.quote.symbol)}</b><br><span class="muted">borrow ${esc(p.borrowAmount)} ${esc(p.base.symbol)} · ${esc(p.base.symbol)} = $${esc(p.baseUsd)}</span></span><button class="secondary grow0" data-unpair="${i}">Remove</button></div>`,
    )
    .join("");

  app.innerHTML = `
    ${chrome("Arbitrage")}
    <div class="card">
      <p class="muted" style="margin-top:0">Flash-loan arbitrage borrows from Aave, buys on one DEX, sells on another and repays the loan, all in one transaction. The contract reverts unless the trade clears your minimum profit, so a failed attempt only costs gas.</p>
      ${n.mainnet ? `<div class="msg err">${esc(n.name)} uses real ${esc(n.nativeSymbol)}. Professional bots compete for these spreads, so most of them are gone before a phone can act, and a reverted attempt still costs gas. The contract is not audited.</div>` : ""}
    </div>
    ${practiceHtml}
    <div class="card">
      <h2>Contract</h2>
      ${contractHtml}
    </div>
    <div class="card">
      <div class="section-head"><h2>Opportunities</h2><button class="secondary grow0" id="arbScan" ${arbState.running ? "disabled" : ""}>Scan</button></div>
      ${res ? `<p class="muted">${timeAgo(arbState.scannedAt)} · Aave fee ${Number(res.premiumBps) / 100}% · gas ≈ ${usdE8(res.gasCostUsdE8)} · minimum ${usdE8(res.minProfitUsdE8)}. Profit shown after both.</p>` : ""}
      ${rows}
      <label class="check"><input type="checkbox" id="arbWatch" ${arbState.watching ? "checked" : ""}>Scan every 15 seconds while this screen is open</label>
      <label class="check"><input type="checkbox" id="arbAuto" ${arbState.autoExec ? "checked" : ""} ${cfg.contract ? "" : "disabled"}>Execute the best opportunity automatically</label>
    </div>
    <div class="card">
      <details id="arbSetup" ${arbState.setupOpen ? "open" : ""}>
        <summary><b>Setup for ${esc(n.name)}</b></summary>
        ${field("pool", "Aave pool")}
        ${field("addressesProvider", "Aave addresses provider")}
        ${field("contract", "Arbitrage contract (filled in after deploying)")}
        ${field("uniswapV2", practice ? "DEX A router" : "Uniswap V2 router")}
        ${field("sushiswap", practice ? "DEX B router" : "SushiSwap router")}
        ${field("uniswapV3Router", "Uniswap V3 SwapRouter02")}
        ${field("uniswapV3Quoter", "Uniswap V3 QuoterV2")}
        ${field("feeTiers", "V3 fee tiers", "500,3000,10000")}
        ${field("minProfitUsd", "Minimum profit after gas (USD)", "5")}
        ${field("maxLoanUsd", "Max flash loan (USD)", "10000")}
        ${field("slippageBps", "Max slippage per swap (basis points, 50 = 0.5%)", "50")}
        ${n.mainnet ? "" : field("nativeUsd", `${esc(n.nativeSymbol)} price for gas maths (USD)`, "2500")}
        ${field("maxGwei", "Gas cap (gwei, empty = none)", "50")}
        <div class="row"><button class="secondary" id="arbReset">Defaults</button><button id="arbSave">Save</button></div>
        <h3 style="margin-top:16px">Token pairs</h3>
        ${pairRows || '<p class="muted">No pairs yet.</p>'}
        <label>Borrowed token (address)</label><input id="pairBase" placeholder="0x…" autocapitalize="off" spellcheck="false">
        <label>Intermediate token (address)</label><input id="pairQuote" placeholder="0x…" autocapitalize="off" spellcheck="false">
        <label>Amount to borrow (whole tokens)</label><input id="pairAmt" inputmode="decimal" placeholder="1000">
        <label>Borrowed token price (USD)</label><input id="pairUsd" inputmode="decimal" placeholder="1">
        <button class="full secondary" id="arbAddPair">Add pair</button>
      </details>
    </div>
    ${nav()}`;
  bindShell();
  bindArb(cfg);
}

function bindArb(cfg: arb.ArbConfig) {
  const realFunds = () =>
    net().mainnet ? `REAL FUNDS on ${net().name}. This spends real ${net().nativeSymbol} on gas.\n\n` : "";
  $("#arbSetup").ontoggle = () => (arbState.setupOpen = $<HTMLDetailsElement>("#arbSetup").open);
  $opt<HTMLButtonElement>("#arbDeploy")?.addEventListener("click", async () => {
    if (
      !(await askConfirm(
        `${realFunds()}Deploy the flash-loan arbitrage contract on ${net().name} and approve ${arb.venues(cfg).length} DEX router(s)? The active account becomes its owner.`,
      )) ||
      (net().mainnet && !(await askPin("Enter your PIN to deploy on mainnet.")))
    )
      return;
    await arbRun((p) => arb.deployContract(arb.validate(cfg), p), "Arbitrage contract deployed.");
  });
  $opt<HTMLButtonElement>("#arbApprove")?.addEventListener("click", () =>
    arbRun((p) => arb.approveRouters(cfg, p), "Routers approved."),
  );
  $opt<HTMLButtonElement>("#arbPractice")?.addEventListener("click", async () => {
    if (
      !(await askConfirm(
        `Deploy a practice market on ${net().name}? This sends about 15 transactions, paid with test ${net().nativeSymbol}, and replaces this network's arbitrage setup.`,
      ))
    )
      return;
    await arbRun(async (p) => {
      const next = await arb.setupPractice(p);
      // So withdrawn profit shows up in Assets.
      for (const t of [next.pairs[0].base, next.pairs[0].quote]) saveToken({ ...t, name: t.symbol });
      arbState.scan = null;
    }, "Practice market ready. Tap Scan.");
  });
  app.querySelectorAll<HTMLButtonElement>("[data-withdraw]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          const q = await w.quote(await arb.withdrawRequest(cfg, b.dataset.withdraw!), state.speed);
          if (
            !(await askConfirm(
              `${realFunds()}Withdraw the contract's whole balance of this token to ${short(w.address())}?\n\nMax network fee: ≈ ${w.formatFee(q.fee)}`,
            ))
          )
            return;
          await track("Withdraw arbitrage profit", q);
        } catch (e) {
          setMsg("err", w.explain(e));
        }
        arbState.status = null;
        renderHome();
      }),
  );
  $("#arbScan").onclick = async () => {
    if (arbState.running) return;
    arbState.running = true;
    setMsg("info", "Scanning DEX prices…");
    renderHome();
    await arbScan();
    arbState.running = false;
    renderHome();
  };
  $<HTMLInputElement>("#arbWatch").onchange = (e) => {
    if ((e.target as HTMLInputElement).checked) startWatch();
    else stopWatch();
  };
  $<HTMLInputElement>("#arbAuto").onchange = async (e) => {
    const box = e.target as HTMLInputElement;
    if (
      box.checked &&
      net().mainnet &&
      (!(await askConfirm(
        `${realFunds()}Execute opportunities on ${net().name} without asking each time? Every trade is simulated first and the contract refuses unprofitable ones, but a trade that reverts on-chain still costs gas.`,
      )) ||
        !(await askPin("Enter your PIN to allow automatic trades.")))
    ) {
      box.checked = false;
      return;
    }
    arbState.autoExec = box.checked;
    if (box.checked && !arbState.watching) startWatch();
    renderHome();
  };
  app.querySelectorAll<HTMLButtonElement>("[data-exec]").forEach(
    (b) =>
      (b.onclick = async () => {
        const o = arbState.scan?.opportunities[Number(b.dataset.exec)];
        if (!o || arbState.running) return;
        arbState.running = true;
        try {
          await arbExecute(o, true);
        } finally {
          arbState.running = false;
        }
        renderHome();
      }),
  );
  const readForm = (): arb.ArbConfig => {
    const next = { ...cfg };
    for (const k of [
      "pool",
      "addressesProvider",
      "contract",
      "uniswapV2",
      "sushiswap",
      "uniswapV3Router",
      "uniswapV3Quoter",
      "feeTiers",
      "minProfitUsd",
      "maxLoanUsd",
      "slippageBps",
      "nativeUsd",
      "maxGwei",
    ] as const) {
      const el = $opt<HTMLInputElement>(`#arb-${k}`);
      if (el) next[k] = el.value.trim();
    }
    return next;
  };
  $("#arbSave").onclick = () => {
    try {
      arb.saveConfig(arb.validate(readForm()));
      arbState.status = null;
      arbState.scan = null;
      setMsg("ok", "Saved.");
    } catch (e) {
      setMsg("err", w.explain(e));
    }
    renderHome();
  };
  $("#arbReset").onclick = async () => {
    if (!(await askConfirm(`Reset the arbitrage setup for ${net().name} to its defaults? Your contract address will be forgotten here (the contract itself stays on-chain).`)))
      return;
    arb.resetConfig();
    arbState.status = null;
    arbState.scan = null;
    renderHome();
  };
  app.querySelectorAll<HTMLButtonElement>("[data-unpair]").forEach(
    (b) =>
      (b.onclick = () => {
        arb.saveConfig({ ...cfg, pairs: cfg.pairs.filter((_, i) => i !== Number(b.dataset.unpair)) });
        arbState.scan = null;
        renderHome();
      }),
  );
  $("#arbAddPair").onclick = async () => {
    try {
      const amount = val("#pairAmt");
      const usdPx = val("#pairUsd");
      if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) throw new Error("Enter an amount to borrow.");
      if (!/^\d+(\.\d{1,8})?$/.test(usdPx)) throw new Error("Enter the borrowed token's USD price.");
      const [base, quote] = await Promise.all([w.readToken(val("#pairBase")), w.readToken(val("#pairQuote"))]);
      if (base.address === quote.address) throw new Error("The two tokens must be different.");
      const pick = ({ symbol, address, decimals }: Token) => ({ symbol, address, decimals });
      arb.saveConfig({
        ...cfg,
        pairs: [...cfg.pairs, { base: pick(base), quote: pick(quote), borrowAmount: amount, baseUsd: usdPx }],
      });
      arbState.scan = null;
      setMsg("ok", `Added ${base.symbol}/${quote.symbol}.`);
    } catch (e) {
      setMsg("err", w.explain(e));
    }
    renderHome();
  };
}

/** Runs a multi-transaction job (deploys, approvals) with progress shown in the message bar. */
async function arbRun(work: (progress: (s: string) => void) => Promise<unknown>, done: string) {
  if (arbState.running) return;
  arbState.running = true;
  state.busy = true;
  const progress = (s: string) => {
    setMsg("info", s);
    if (state.view === "arb") renderHome();
  };
  try {
    await work(progress);
    setMsg("ok", done);
  } catch (e) {
    setMsg("err", w.explain(e));
  } finally {
    arbState.running = false;
    state.busy = false;
    arbState.status = null;
  }
  renderHome();
}

async function arbScan() {
  try {
    arbState.scan = await arb.scan(arb.loadConfig(), net().mainnet ? ethUsd : null);
    arbState.scannedAt = Date.now();
    const found = arbState.scan.opportunities.filter((o) => o.netProfitUsdE8 >= arbState.scan!.minProfitUsdE8).length;
    setMsg(
      found ? "ok" : "info",
      [found ? `${found} profitable route(s).` : "Nothing clears your minimum profit right now.", ...arbState.scan.skipped].join(" "),
    );
  } catch (e) {
    setMsg("err", w.explain(e));
  }
}

/** Simulates, asks (unless automatic), then sends through the same tracking as every other transaction. */
async function arbExecute(o: Opportunity, ask: boolean) {
  const cfg = arb.loadConfig();
  const res = arbState.scan!;
  let q: w.Quote;
  setMsg("info", "Simulating the trade…");
  renderHome();
  try {
    q = await arb.prepare(cfg, o, res);
  } catch (e) {
    setMsg("err", w.explain(e));
    return;
  }
  const amount = `${fmt(formatUnits(o.amountIn, o.pair.base.decimals))} ${o.pair.base.symbol}`;
  if (ask) {
    const real = net().mainnet
      ? `REAL FUNDS on ${net().name}. The contract is unaudited, and a reverted attempt still costs gas.\n\n`
      : "";
    if (
      !(await askConfirm(
        `${real}Flash-borrow ${amount}, ${routeText(o, !!cfg.practice)}, repay the loan.\n\nExpected profit after gas: ${usdE8(o.netProfitUsdE8)}\nMax network fee: ≈ ${w.formatFee(q.fee)}\n\nThe simulation passed. The contract reverts unless the trade still makes at least the minimum profit when mined.\n\nExecute?`,
      )) ||
      (net().mainnet && !(await askPin("Enter your PIN to trade on mainnet.")))
    )
      return;
  }
  await track(`Arbitrage ${o.pair.base.symbol}/${o.pair.quote.symbol}: ${amount}`, q);
  // Prices moved with the trade, so the old quotes are stale.
  arbState.scan = null;
  arbState.status = null;
}

function startWatch() {
  stopWatch();
  arbState.watching = true;
  arbState.timer = window.setInterval(() => void watchTick(), 15_000);
  void watchTick();
}

function stopWatch() {
  window.clearInterval(arbState.timer);
  arbState.watching = false;
}

async function watchTick() {
  if (state.view !== "arb" || arbState.owner !== `${net().chainId}:${w.address()}`) {
    stopWatch();
    return;
  }
  if (arbState.running || state.busy) return;
  arbState.running = true;
  try {
    await arbScan();
    const res = arbState.scan;
    const best = res?.opportunities[0];
    if (arbState.autoExec && res && best && best.netProfitUsdE8 >= res.minProfitUsdE8)
      await arbExecute(best, false);
  } finally {
    arbState.running = false;
  }
  // Don't wipe what the person is typing in Setup.
  if (state.view === "arb" && !(document.activeElement instanceof HTMLInputElement)) renderHome();
}

// ---------- Receive ----------

async function renderReceive() {
  const addr = w.address();
  const qr = await QRCode.toDataURL(addr, {
    margin: 1,
    width: 600,
    color: { dark: "#0b0d12", light: "#ffffff" },
  });
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
      <p class="muted" style="margin:0">${
        net().mainnet
          ? `Send real ${esc(net().nativeSymbol)} or tokens on <b>${esc(net().name)}</b> to this address. The same address works on every EVM network in this app, but each network's balance is separate. Sending from this wallet also needs a little ${esc(net().nativeSymbol)} here for the network fee.`
          : `Scan or share this address to receive ${esc(net().nativeSymbol)} or tokens on <b>${esc(net().name)}</b>. The sender has to use the same network.`
      }</p>
      <div style="margin-top:12px">${faucetHtml()}</div>
    </div>`;
  $("#back").onclick = () => {
    state.msg = null;
    renderHome();
  };
  $("#copy").onclick = async () => {
    await copy(addr);
    renderReceive();
  };
}

// ---------- Show a token in other wallets ----------

/** Other wallets find a token by its contract address; name and symbol are not enough. */
async function renderShareToken(t: Token, back: () => void) {
  const n = net();
  const mainnet = !!n.mainnet;
  const qr = await QRCode.toDataURL(t.address, {
    margin: 1,
    width: 600,
    color: { dark: "#0b0d12", light: "#ffffff" },
  });
  const explorer = explorerAddress(t.address);
  // Trust Wallet's add-asset link: <coin ID>_t<token address>.
  const trustLink = n.trustId
    ? `https://link.trustwallet.com/add_asset?asset=${n.trustId}_t${t.address}`
    : "";
  const details = `Network: ${n.name} (chain ID ${n.chainId})\nContract: ${t.address}\nSymbol: ${t.symbol}\nDecimals: ${t.decimals}`;
  app.innerHTML = `
    <div class="top"><h1>Show ${esc(t.symbol)} in other wallets ${badge()}</h1><button class="secondary" id="back">Back</button></div>
    ${msgHtml()}
    <div class="card" style="text-align:center">
      <img src="${qr}" alt="QR code of the token contract address" style="width:100%;max-width:240px;border-radius:12px">
      <div class="addr" style="margin:12px 0">${esc(t.address)}</div>
      <p class="muted">Network <b>${esc(n.name)}</b> · Symbol <b>${esc(t.symbol)}</b> · Decimals <b>${t.decimals}</b></p>
      <button class="full" id="copyTok">Copy contract address</button>
      <button class="full secondary" id="copyAll">Copy all token details</button>
      ${explorer ? `<a class="faucet" href="${esc(explorer)}" target="_blank" rel="noopener">View on ${mainnet ? "Etherscan" : "the explorer"}</a>` : ""}
    </div>
    ${
      mainnet
        ? ""
        : `<div class="card"><div class="msg err">This token is on ${esc(n.name)}, a test network. Trust Wallet and Binance Wallet only show it if they support ${esc(n.name)}. Switch to a mainnet such as Ethereum or BNB Smart Chain and create the coin there to show it in those wallets.</div></div>`
    }
    <div class="card">
      <h3>MetaMask</h3>
      <p class="muted">Switch MetaMask to <b>${esc(n.name)}</b>, then open <b>Tokens → ⋮ → Import tokens → Custom token</b> and paste the contract address. Symbol and decimals fill in automatically.</p>
      <h3>Trust Wallet</h3>
 ${trustLink ? `<a class="faucet" href="${trustLink}" target="_blank" rel="noopener">Add ${esc(t.symbol)} to Trust Wallet</a>` : ""}
      <p class="muted">Or tap the settings icon on the home screen, then <b>Add Custom Token</b>. Choose network <b>${esc(n.name)}</b> and paste the contract address.</p>
      <h3>Binance Wallet</h3>
      <p class="muted">In the Binance app open <b>Wallet → Web3 / Binance Wallet → Manage crypto → Add custom token</b>. Choose <b>${esc(n.name)}</b> and paste the contract address. The Binance exchange account does not list new tokens; only the wallet does.</p>
      <p class="muted">New tokens have no price and no logo in these wallets. Getting a logo or automatic detection means submitting the token to each wallet's token list. Etherscan contract verification usually comes first.</p>
    </div>`;
  $("#back").onclick = () => {
    state.msg = null;
    back();
  };
  $("#copyTok").onclick = async () => {
    await copy(t.address, "Contract address");
    renderShareToken(t, back);
  };
  $("#copyAll").onclick = async () => {
    await copy(details, "Token details");
    renderShareToken(t, back);
  };
}

// ---------- Settings ----------

function renderSettings() {
  const ws = settings.wsethAddress;
  const mine = listTokens();
  const added = new Set(mine.map((t) => t.address.toLowerCase()));
  const tokenRows = mine
    .map(
      (
        t,
      ) => `<div class="tx"><span><b>${esc(t.symbol)}</b>${lookalikeBadge(t)} <span class="muted">${esc(t.name)}</span><br>
      ${addrLink(t.address)}</span>
      <button class="secondary grow0" data-share="${t.address}">Share</button>
      <button class="secondary grow0" data-remove="${t.address}">Remove</button></div>`,
    )
    .join("");
  const presetRows = net()
    .presets.filter((p) => !added.has(p.address.toLowerCase()))
    .map(
      (p) =>
        `<div class="tx"><span><b>${esc(p.symbol)}</b> <span class="muted">${esc(p.source)}</span></span><button class="grow0" data-preset="${p.address}">Add</button></div>`,
    )
    .join("");
  const contactRows = listContacts()
    .map(
      (
        c,
      ) => `<div class="tx"><span><b>${esc(c.name)}</b><br><span class="addr">${short(c.address)}</span></span>
      <button class="secondary grow0" data-uncontact="${c.address}">Remove</button></div>`,
    )
    .join("");

  app.innerHTML = `
    ${banner()}
    <div class="top"><h1>Settings ${badge()}</h1><button class="secondary" id="back">Back</button></div>
    ${msgHtml()}
    <div class="card">
      <h2>Account names</h2>
      ${state.accounts
        .map(
          (
            a,
            i,
          ) => `<label>${esc(settings.accountName(i))} · ${short(a)}</label>
        <div class="row"><input id="an-${i}" value="${esc(settings.accountName(i))}" maxlength="24"><button class="secondary grow0" data-rename="${i}">Save</button></div>`,
        )
        .join("")}
    </div>
    <div class="card">
      <h2>App lock</h2>
      <p class="muted" id="pinHint">A PIN is asked every time the wallet opens.</p>
      <label>PIN (4–6 digits)</label>
      <input id="pinNew" type="password" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="••••">
      <button class="full secondary" id="savePin">Save PIN</button>
      <button class="full secondary" id="clearPin">Remove PIN</button>
    </div>
    <div class="card">
      <h2>Tokens on ${esc(net().name)}</h2>
      ${tokenRows || '<p class="muted">No extra tokens yet.</p>'}
      ${presetRows ? `<p class="muted" style="margin:10px 0 4px">Known contracts</p>${presetRows}` : ""}
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
      ${ws ? `<div class="addr">${ws}</div>${explorerAddress(ws) ? `<p class="muted"><a href="${explorerAddress(ws)}">View on explorer</a></p>` : ""}` : '<p class="muted">Not set up on this network yet.</p>'}
      <label>Use an existing WSETH contract</label>
      <input id="wsAddr" placeholder="0x…" autocapitalize="off" spellcheck="false">
      <div class="row">
        <button class="secondary" id="useAddr">Use address</button>
        <button id="deploy" ${state.busy ? "disabled" : ""}>Deploy new</button>
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
      <button class="full secondary" id="shareApp">Copy app link for a friend</button>
      <button class="full secondary" id="reveal">Show recovery phrase</button>
      <button class="full danger" id="del">Delete wallet from this phone</button>
    </div>`;

  $("#back").onclick = () => {
    state.msg = null;
    refresh();
  };
  app.querySelectorAll<HTMLButtonElement>("[data-rename]").forEach(
    (b) =>
      (b.onclick = () => {
        const i = Number(b.dataset.rename);
        settings.setAccountName(i, val(`#an-${i}`));
        setMsg("ok", `Saved ${settings.accountName(i)}.`);
        renderSettings();
      }),
  );
  $("#savePin").onclick = async () => {
    if (!(await askPin("Enter your current PIN to change it."))) return;
    try {
      await w.setPin(val("#pinNew"));
      setMsg(
        "ok",
        "PIN saved. It will be asked the next time you open the wallet.",
      );
    } catch (e) {
      setMsg("err", e instanceof Error ? e.message : "Could not save the PIN.");
    }
    renderSettings();
  };
  $("#clearPin").onclick = async () => {
    if (!(await w.pinIsSet())) {
      setMsg("info", "No PIN is set.");
      renderSettings();
      return;
    }
    if (!(await askPin("Enter your current PIN to remove the lock."))) return;
    await w.clearPin();
    setMsg("ok", "PIN removed.");
    renderSettings();
  };
  const addToken = async (addr: string) => {
    try {
      const t = await w.readToken(addr);
      saveToken(t);
      setMsg(
        isLookalike(t) ? "err" : "ok",
        isLookalike(t)
          ? `Added ${t.symbol}, but warning: it uses a famous symbol and is not the known contract for it.`
          : `Added ${t.symbol} (${t.name}).`,
      );
    } catch (e) {
      setMsg("err", w.explain(e));
    }
    renderSettings();
  };
  $("#addTok").onclick = () => addToken(val("#tokAddr"));
  app
    .querySelectorAll<HTMLButtonElement>("[data-preset]")
    .forEach((b) => (b.onclick = () => addToken(b.dataset.preset!)));
  app.querySelectorAll<HTMLButtonElement>("[data-share]").forEach(
    (b) =>
      (b.onclick = () => {
        const t = listTokens().find(
          (x) => x.address.toLowerCase() === b.dataset.share!.toLowerCase(),
        );
        state.msg = null;
        if (t) renderShareToken(t, renderSettings);
      }),
  );
  app.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach(
    (b) =>
      (b.onclick = () => {
        removeToken(b.dataset.remove!);
        state.msg = null;
        renderSettings();
      }),
  );
  $("#addContact").onclick = () => {
    try {
      saveContact(val("#cName"), val("#cAddr"));
      setMsg("ok", "Contact saved.");
    } catch {
      setMsg("err", "That is not a valid 0x address.");
    }
    renderSettings();
  };
  app.querySelectorAll<HTMLButtonElement>("[data-uncontact]").forEach(
    (b) =>
      (b.onclick = () => {
        removeContact(b.dataset.uncontact!);
        state.msg = null;
        renderSettings();
      }),
  );
  $("#useAddr").onclick = async () => {
    try {
      settings.wsethAddress = await w.verifyWseth(val("#wsAddr"));
      setMsg("ok", "WSETH contract verified and saved.");
    } catch (e) {
      setMsg("err", w.explain(e));
    }
    renderSettings();
  };
  $("#deploy").onclick = async () => {
    if (
      !(await askConfirm(
        `Deploy a new Wrapped Study Ether contract on ${net().name}? This costs gas.`,
      ))
    )
      return;
    state.busy = true;
    try {
      const { tx, address } = await w.deployWseth();
      setMsg("info", `Deploying… ${hashLink(tx.hash)}`, true);
      renderSettings();
      settings.wsethAddress = await address;
      upsertHistory(w.address(), {
        hash: tx.hash,
        label: "Deploy WSETH contract",
        status: "confirmed",
        time: Date.now(),
      });
      setMsg("ok", `Deployed at ${settings.wsethAddress}`);
    } catch (e) {
      setMsg("err", w.explain(e));
    } finally {
      state.busy = false;
    }
    renderSettings();
  };
  $("#saveRpc").onclick = () => changeRpc(val("#rpc"));
  $("#resetRpc").onclick = () => changeRpc(null);
  $("#shareApp").onclick = async () => {
    await copy(APP_LINK, "App link");
    renderSettings();
  };
  $("#reveal").onclick = async () => {
    if (
      !(await askConfirm(
        "Show your recovery phrase? Make sure nobody can see your screen.",
      )) ||
      !(await askPin("Enter your PIN to show the recovery phrase."))
    )
      return;
    renderBackup(await w.revealPhrase(), false);
  };
  $("#del").onclick = async () => {
    if (
      !(await askConfirm(
        "Delete this wallet from the phone? Without the recovery phrase, its funds are lost.",
      )) ||
      !(await askPin("Enter your PIN to delete the wallet."))
    )
      return;
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
    setMsg("ok", `Connected to ${net().name}.`);
  } catch (e) {
    settings.rpcUrl = prev === net().rpc ? null : prev;
    await w.connect().catch(() => {});
    setMsg("err", w.explain(e));
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
    setMsg("err", w.explain(e));
  }
  await refresh();
}

function renderLock() {
  app.innerHTML = `
    <div class="top"><h1>Hanan Wallet ${badge()}</h1></div>
    ${msgHtml()}
    <div class="card">
      <h2>Enter PIN</h2>
      <input id="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="4–6 digits">
      <button class="full" id="unlock">Unlock</button>
    </div>`;
  $("#unlock").onclick = async () => {
    try {
      if (await w.checkPin(val("#pin"))) {
        state.msg = null;
        await start();
        return;
      }
      setMsg("err", "Wrong PIN.");
    } catch (e) {
      setMsg("err", w.explain(e));
    }
    renderLock();
  };
}

(async () => {
  if (!(await w.hasWallet())) return renderWelcome();
  if (await w.pinIsSet()) return renderLock();
  await start();
})();
