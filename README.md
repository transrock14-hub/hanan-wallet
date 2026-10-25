# Hanan Wallet

An Android wallet for learning, locked to the **Sepolia testnet**. It holds its own key and can
send SepoliaETH and wrap, unwrap and send Wrapped Study Ether (WSETH), the contract in
`../anvil-lab/src/WrappedStudyEther.sol`.

- Refuses to connect to any chain other than Sepolia (chain ID 11155111).
- The recovery phrase is stored with `@aparajita/capacitor-secure-storage`, which encrypts it with
  a key held in the Android Keystore. Android cloud backup is disabled for the app.
- Before using a WSETH address, the app checks that it is a contract named
  "Wrapped Study Ether" / "WSETH".
- Holds and sends any ERC-20 token on the selected network (Settings → Tokens). Ethereum
  mainnet is available for sending real ETH and tokens; the app warns before irreversible
  mainnet sends and token-contract deployment. Learning-token contracts can be deployed on
  mainnet, which spends real ETH on gas; they are not real-world assets and have no guaranteed
  value. Circle's test USDC
  and Chainlink's test LINK are built-in presets; other tokens are added by contract address,
  with name, symbol and decimals read from the contract. A token that uses a famous symbol
  (USDT, USDC, ETH, …) from an address that isn't the known one is marked "⚠ lookalike".

Real networks (mainnets), each with its common coins added on first use (every contract address,
symbol and decimals value checked on-chain):

| Network | Native coin | Common coins |
|---|---|---|
| Ethereum | ETH | USDT, USDC, DAI, WBTC, cbBTC, WETH, LINK |
| BNB Smart Chain | BNB | USDT, USDC, ETH, BTCB, WBNB (BEP20) |
| Polygon | POL | USDT0, USDC, WETH, WBTC |
| Base | ETH | USDC, DAI, cbBTC, WETH |
| Arbitrum One | ETH | USD₮0, USDC, WBTC, WETH, ARB |
| OP Mainnet | ETH | USDT, USDC, WETH, OP |
| Avalanche C-Chain | AVAX | USDt, USDC, BTC.b, WETH.e |

These are the official contracts, so MetaMask, Trust Wallet, Coinbase Wallet and Binance Wallet
show them to recipients without importing (when the recipient's wallet has that network enabled).
One address works on every network, but each network keeps its own balance, and a send must use the
network the recipient expects (for example BEP20 for many Binance deposits).

Since v1.3:

- **Five test networks:** Sepolia, Base Sepolia, Arbitrum Sepolia, OP Sepolia, Polygon Amoy. Each
  RPC is checked against the expected chain ID; tokens, WSETH and history are kept per network.
- **Receive** screen with a QR code of the address.
- **Review before sending:** gas is estimated first (which also simulates the call, so most
  failures show before signing), and the confirmation shows the maximum network fee. **Max** button.
- **Address book** for saved recipients, usable from the Send form.
- **Multiple accounts** from the same recovery phrase (BIP-44 index 0, 1, 2, …).
- **Saved activity history** per network and account; pending transactions are re-checked on refresh.
- **ERC-20 approvals and delegated transfers** for tokens that support `approve` and `transferFrom`.
  Newly deployed learning tokens also expose allowances and owner-only minting; the initial supply
  is scaled to 18 decimals.
- **Incoming token discovery** on networks with a configured Blockscout-compatible token index.
  Hanan Wallet verifies metadata from the contract and adds received assets automatically; unknown
  contracts may still be malicious. Other wallet apps control their own discovery and may require
  the token contract address to be imported manually.
- **Show in other wallets:** after a coin is created (or from Settings → Tokens → Share), the app shows
  the contract address as text and QR, a Trust Wallet add-token link on Ethereum, and import steps for
  MetaMask and Binance Wallet. Those wallets show the coin once its contract address is imported on
  the same network.

Use it with test funds only unless you intentionally select Ethereum mainnet. Mainnet transactions
spend real funds and cannot be reversed. Never import a recovery phrase for a wallet holding funds
unless you understand that this app controls those keys.

Learning tokens can use custom names and symbols, but names and tickers matching major real assets
are reserved to reduce impersonation. A token's contract address, not its name or symbol, identifies it.

## Arbitrage (from flash-arb)

The **Arbitrage** tab runs the flash-loan arbitrage bot from `Flash tool/flash-arb` inside the wallet,
signed by the active account instead of a `PRIVATE_KEY` in `.env`:

- **Scan** quotes every token pair on Uniswap V2, SushiSwap and Uniswap V3 (best fee tier), prices each
  round trip net of the Aave flash-loan fee and gas, and lists them best first. "Scan every 15 seconds"
  keeps watching while the screen is open; "Execute automatically" sends the best profitable one.
- **Execute** runs the bot's pipeline: Aave liquidity check, `eth_call` simulation (decoded revert
  reasons), gas estimate, worst-case-gas profit check, then a confirmation (and PIN on mainnet).
- **Deploy** puts `FlashLoanArbitrage` on the current network, owned by the active account, and approves
  the configured routers. Profit stays in the contract until **Withdraw**.
- **Practice market** (test networks and the hosted Anvil chain only) deploys practice tokens pUSD and
  pETH, a stand-in Aave pool and two DEXes priced 2% apart, so the whole flow can be seen working.
- **Setup** holds the bot's `.env` values per network. Sepolia and Ethereum come pre-filled with Aave V3,
  Uniswap and SushiSwap addresses checked on-chain on 2026-10-25.

The contract is unaudited. On mainnet, professional bots take most spreads first, and a reverted
attempt still costs gas.

## Install on your phone

1. Copy `Hanan-Wallet.apk` to the phone (USB, Google Drive, or email it to yourself).
2. Open it on the phone. Android will ask you to allow installs from that source (Files, Drive, …).
3. Open **Hanan Wallet** → **Create wallet** → write down the 12 words.

Or with USB debugging enabled: `adb install Hanan-Wallet.apk`.

## First use

1. Copy the app's address and send it some SepoliaETH from MetaMask (or a faucet).
2. **Settings → Deploy new** to deploy your own WSETH contract, or paste an existing WSETH address.
3. Back on the home screen: **Wrap**, **Unwrap**, **Send WSETH**, **Send ETH**.
   Each transaction shows in Activity with a link to sepolia.etherscan.io.
4. To see WSETH in MetaMask, import the contract address as a token on Sepolia.

## Build

```sh
npm install
npm run sync-contract        # copy ABI + bytecode from ../anvil-lab/out (run `forge build` there first)
export ANDROID_HOME=$HOME/homebrew/share/android-commandlinetools
npm run android:apk          # → android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run dev` serves the same UI in a desktop browser for quick checks (it uses browser
storage there instead of the Keystore, so only use it with throwaway wallets).
