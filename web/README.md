# Project site

A static site with no build step and no dependencies: `index.html` introduces the tool and reads the deployed Arbitrum
Sepolia contracts live in the visitor's browser, and `playground.js` lets a visitor use them with their own wallet: take
test tokens from the faucet, open a payment stream and watch it pay out, fund and settle an escrow, and use the vault.

- `abi.js` is generated (function selectors, event topics, every template's custom errors). After changing a contract or
  the page's calls, run `node e2e/gen-web-abi.mjs` (from the repository root, after `npm install` in `e2e/`). CI fails if it is
  out of date.
- `e2e/web-check.mjs` loads the page in a real browser and checks it: no script errors, phone layout, calldata identical to
  viem's, contract errors turned into sentences. CI runs it on every change.
- The faucet address goes in `PG.faucet` at the top of `playground.js`; until it is set the faucet button is disabled.

## Deploy on Vercel

1. Sign in at https://vercel.com with GitHub, then **Add New → Project** and import this repository.
2. Set **Root Directory** to `web`. Framework preset: **Other**. Leave the build and output settings empty.
3. Deploy. Vercel redeploys on every push to the production branch (`main` by default).

If a contract is redeployed, update the addresses in the `CONTRACTS` list in `index.html`.

## Preview locally

```bash
npx http-server web
```
