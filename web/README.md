# Project site

A single static page (`index.html`, no build step, no dependencies) that introduces the tool and reads the three
deployed Arbitrum Sepolia contracts live from the public RPC in the visitor's browser.

## Deploy on Vercel

1. Sign in at https://vercel.com with GitHub, then **Add New → Project** and import this repository.
2. Set **Root Directory** to `web`. Framework preset: **Other**. Leave the build and output settings empty.
3. Deploy. Vercel redeploys on every push to the production branch (`main` by default).

If a contract is redeployed, update the addresses in the `CONTRACTS` list in `index.html`.

## Preview locally

```bash
npx http-server web
```
