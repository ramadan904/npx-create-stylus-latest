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

## Narrated cut

`demo-narrated.mp4` (2 min 46 s, 1280×720, H.264 + AAC): the full demo script read aloud, with captions that light up
word by word as they are spoken. Same rules as above: the terminal output and every transaction are real (a local Nitro
dev node, flagged in the video).

```bash
e2e/video/chain.sh /tmp/video                       # the six contracts on a local Nitro dev node
cd e2e/video/narrated
pip install kokoro-onnx soundfile                   # offline neural TTS; then download kokoro-v1.0.onnx -> kokoro.onnx
                                                    # and voices-v1.0.bin -> voices.bin from thewh1teagle/kokoro-onnx releases
python3 narrate.py                                  # the narration (voice am_michael) and its word timings
node narrated.mjs "$PWD/../../.." /tmp/video <term-dir>   # records each scene timed to its narration
python3 build.py ../../../media/demo-narrated.mp4   # mixes the voice in and burns in the karaoke captions
```

`<term-dir>` holds the real terminal output the video replays: `created.txt` (`npm create stylus-latest my-app -- -t
stream --with-client`), `tested.txt` (`cargo test --lib` in that project) and `list.txt` (`create-stylus-latest --list`).
