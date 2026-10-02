# Demo video

`demo.mp4` (69 s, 1280×720, H.264) and its poster `demo-poster.jpg`: `npx create-stylus-latest`, `cargo test`, the
faucet, a payment stream, then an AI agent opening, paying out and cancelling a stream through JSON tool calls.
It is submitted separately and is not on the site.

It is generated from a real run, not edited:

```bash
e2e/video/chain.sh /tmp/video          # deploy the site's six contracts to a local Nitro dev node, with the projects' own scripts
node e2e/video/record.mjs /tmp/video   # real npx and cargo output, then the real site driven against those contracts
```

The recording needs Docker, Rust with the wasm target, cargo-stylus, Node, Chromium (`CHROME_PATH`) and ffmpeg with
libx264. `e2e/web-check.mjs` checks the file's length (60–90 s) and size.
