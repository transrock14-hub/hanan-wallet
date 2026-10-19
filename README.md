# Hanan Wallet

An Android wallet for learning, locked to the **Sepolia testnet**. It holds its own key and can
send SepoliaETH and wrap, unwrap and send Wrapped Study Ether (WSETH), the contract in
`../anvil-lab/src/WrappedStudyEther.sol`.

- Refuses to connect to any chain other than Sepolia (chain ID 11155111).
- The recovery phrase is stored with `@aparajita/capacitor-secure-storage`, which encrypts it with
  a key held in the Android Keystore. Android cloud backup is disabled for the app.
- Before using a WSETH address, the app checks that it is a contract named
  "Wrapped Study Ether" / "WSETH".
- Holds and sends any ERC-20 token on Sepolia (Settings → Tokens). Circle's test USDC and
  Chainlink's test LINK are built-in presets; other tokens are added by contract address, with
  name, symbol and decimals read from the contract. A token that uses a famous symbol (USDT,
  USDC, ETH, …) from an address that isn't the known one is marked "⚠ lookalike".

Since v1.3:

- **Five test networks:** Sepolia, Base Sepolia, Arbitrum Sepolia, OP Sepolia, Polygon Amoy. Each
  RPC is checked against the expected chain ID; tokens, WSETH and history are kept per network.
- **Receive** screen with a QR code of the address.
- **Review before sending:** gas is estimated first (which also simulates the call, so most
  failures show before signing), and the confirmation shows the maximum network fee. **Max** button.
- **Address book** for saved recipients, usable from the Send form.
- **Multiple accounts** from the same recovery phrase (BIP-44 index 0, 1, 2, …).
- **Saved activity history** per network and account; pending transactions are re-checked on refresh.

Use it with test funds only, and don't import the recovery phrase of a wallet that holds real funds.

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
