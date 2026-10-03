# Security

create-stylus-latest generates **starting points**. The contracts are tested hard: unit tests, reference-model property
tests, and deploys to a real Arbitrum Nitro node on every change. **None of them has been audited.** Read this before a
generated contract holds funds you care about.

## Known limitations, by template

| Template | What it does not do (yet) |
| --- | --- |
| `counter` | Anyone can call `set_number`; it is a learning example, not access-controlled. |
| `erc20` | Minimal ERC-20: no pause, no permit, no owner. The standard `approve` race applies; set an allowance to 0 before changing it. |
| `erc721` | One minter, fixed at deploy, with no way to change it. No royalties, no enumeration. |
| `vault` | No pause, no deposit caps, no fee-on-transfer handling. |
| `escrow` | Fee-on-transfer and rebasing tokens are not handled. There is no partial release. The arbiter, if set, can settle either way, and both sides must trust it. |
| `stream` | Fee-on-transfer and rebasing tokens are not handled. Streams cannot be topped up or transferred, and either side can cancel at any time. A recipient blocked by the token (USDC can block addresses) gets their share held for `claim()` instead of stranding the sender. |
| `oracle` | Reads one Chainlink feed and refuses stale, zero, negative or incomplete prices. It does **not** check Arbitrum's sequencer-uptime feed; add that check before using it for liquidations or lending. |
| `interop` | Pure math. It reverts by name on division by zero or overflow, and never rounds silently. |
| `faucet` | One drip per address per cooldown does not stop someone with many addresses. It is for test tokens, not an anti-sybil system. |

All templates:
- **No admin keys and no upgrades.** `vault`, `escrow` and `stream` have no owner, no pause and no proxy. A bug cannot be
  patched in place; you redeploy.
- **Checks-effects-interactions.** State changes before any token call, and a failed or false-returning transfer reverts
  the whole call. Behaviour against a malicious or reentrant token has not been reviewed.
- **Block time.** Deadlines and stream schedules use the block timestamp, which is fine for minutes-to-days schedules and
  not for second-exact settlement.

## The generated client and AI-agent tools

- **The agent's spending limits are client-side.** `AGENT_MAX_AMOUNT` and `AGENT_ALLOWED_COUNTERPARTIES` stop a model
  from overspending, but not someone who already has the key. Give an agent a dedicated key that holds only what it may
  spend.
- **The key lives in `.env`.** It is git-ignored by the generated `.gitignore`. Use a throwaway key on testnets.

## Before mainnet

1. Get an audit, or at least an independent review, of the exact contract you will deploy.
2. Decide the template-specific items in the table above for your use case.
3. Deploy reproducibly with `VERIFY=1 ./scripts/deploy.sh`, and publish the `./scripts/verify.sh` result.
4. `deploy.sh` refuses Arbitrum One, Nova and Robinhood Chain unless you set `MAINNET=1`. Treat that as the last
   checkpoint, not a formality.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's
[private vulnerability reporting](https://github.com/ramadan904/npx-create-stylus-latest/security/advisories/new) for this
repository, with the template, a description and, if you can, a failing test.
