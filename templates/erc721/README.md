# {{name}}

A Stylus (Rust) ERC-721 NFT contract scaffolded with `create-stylus-latest` against `stylus-sdk` {{stylus_sdk_version}}.

## Contract

`Nft` implements ERC-721 with metadata: `balanceOf`, `ownerOf`, `approve`, `getApproved`, `setApprovalForAll`,
`isApprovedForAll`, `transferFrom`, both `safeTransferFrom` forms, `tokenURI`, `name`, `symbol` and `supportsInterface`
(ERC-165, ERC-721, ERC-721 Metadata), plus `mint`, `burn`, `minter` and `totalSupply`.

- **Constructor** `(name, symbol, baseURI, minter)`: runs atomically at deploy time. Pass `minter` explicitly:
  `msg_sender` inside a Stylus constructor is the deployer helper contract, not you.
- **Mint**: only the minter; ids count up from 1. `tokenURI(id)` is `baseURI` + `id` (empty `baseURI`: no metadata).
- **Safe transfers** ask a receiving contract (`onERC721Received`) and revert if it does not accept, so tokens cannot get
  stuck in contracts that do not know they hold one.
- **Errors** are the standard ERC-6093 ones (`ERC721NonexistentToken`, `ERC721InsufficientApproval`, ...), so wallets and
  agents can decode them by name. A refused call changes nothing.

Size: about 24.4 KB compressed, just under Stylus's 24 KB (24,576-byte) limit; `./scripts/deploy.sh --check-only` reports
it. Adding much more to this contract may need trimming elsewhere, or splitting into two contracts.

## Develop

```bash
cargo test     # unit tests, and a property test that checks random mints, approvals, transfers and burns against a model
./scripts/export-abi.sh
cargo build --release --target wasm32-unknown-unknown --lib
```

## Deploy

Everything after `--` goes to the constructor:

```bash
cp .env.example .env                 # add a funded testnet PRIVATE_KEY
./scripts/deploy.sh --check-only
./scripts/deploy.sh -- "My Badges" BADGE ipfs://YourMetadataCID/ 0xYourAddress
```

### Deploy locally first

```bash
cp .env.example .env     # a throwaway PRIVATE_KEY is fine; the dev node funds it
./scripts/devnode.sh     # needs Docker and Node: starts a dev node, funds your key, installs the Stylus deployer
RPC_URL=http://127.0.0.1:8547 ./scripts/deploy.sh -- "My Badges" BADGE ipfs://YourMetadataCID/ 0xYourAddress
docker rm -f stylus-devnode
```

With `--with-client`: `cd client && npm install && MINT_TO=0xSomeone npm start` reads the collection and mints the next
token (your `PRIVATE_KEY` must be the minter's).
