# Project site

A static site with no build step and no dependencies: `index.html` introduces the tool and reads the deployed Arbitrum
Sepolia contracts live in the visitor's browser, and `playground.js` lets a visitor use them with their own wallet: take
test tokens from the faucet, open a payment stream and watch it pay out, fund and settle an escrow, and use the vault.

- `abi.js` is generated (function selectors, event topics, every template's custom errors). After changing a contract or
  the page's calls, run `node e2e/gen-web-abi.mjs` (from the repository root, after `npm install` in `e2e/`). CI fails if it is
  out of date.
- `e2e/web-check.mjs` loads the page in a real browser and checks it: no script errors, phone layout, calldata identical to
  viem's, contract errors turned into sentences. CI runs it on every change.
- `agent-live.js` is the "Run the AI agent demo" section: the stream agent's `open_stream`, `withdraw_from_stream` and
  `cancel_stream`, ported from `templates/_client/stream/agent.ts` and run from the visitor's wallet. `e2e/agent-live.mjs`
  runs it against a dev node in CI and checks its JSON against the agent CLI's (same fields; identical bytes for the same
  calls). Its error hints come from `agent-kit.ts` through `abi.js`.
- `agent-demo.js` replays `agent-demo.json`, a longer agent run that CI recorded (see `e2e/gen-agent-demo.mjs`).
- `pg-polish.js` adds feedback to the playground and the agent demo: a card glows while its transaction waits, flashes
  on success and shakes on an error, the pressed button spins, the stream bar shimmers while it pays out, the activity
  list is a timeline with each transaction's state, balances flash when they change, and the connected account gets an
  identicon. It only reads what the page already renders, so the page works the same without it; `web-check` drives it.
- The faucet address goes in `PG.faucet` at the top of `playground.js`; until it is set the faucet button is disabled.

## Deploy on Vercel

Live: https://npx-create-stylus-latest-web-mocha.vercel.app/

1. Sign in at https://vercel.com with GitHub, then **Add New → Project** and import this repository.
2. Set **Root Directory** to `web`. Framework preset: **Other**. Leave the build and output settings empty.
3. Deploy. Vercel redeploys on every push to the production branch (`main` by default).

If a contract is redeployed, update the addresses in the `CONTRACTS` list in `index.html`.

## Preview locally

```bash
npx http-server web
```
