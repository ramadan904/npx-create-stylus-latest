# Synthesizes the demo narration (every "Say" line of the demo script, verbatim) with Kokoro's am_michael voice.
# Each caption line is synthesized on its own, so its start and end are exact; words inside a line are timed by the
# length of what is spoken for them. Writes sec<N>.wav per section and timing.json.
import json, re
import numpy as np, soundfile as sf
from kokoro_onnx import Kokoro

SECTIONS = [
  ["Starting a Rust smart contract on Arbitrum usually means",
   "an afternoon of fixing version mismatches before anything deploys.",
   "create-stylus-latest fixes that with one command."],
  ["One command scaffolds a full Stylus project.",
   "It reads crates.io at that moment and pins the newest stylus-sdk",
   "with the exact alloy version it needs, so it compiles the first time.",
   "You get the contract, unit and property tests, deploy scripts and a typed client.",
   "There are nine templates: counter, ERC-20, ERC-721, vault, escrow,",
   "payment stream, Chainlink oracle, Rust–Solidity interop and faucet."],
  ["No Rust on your machine? One click opens a Codespace",
   "with Rust, cargo-stylus and a local Arbitrum chain.",
   "quickstart.sh deploys and calls a contract in about 105 seconds,",
   "with no wallet and no faucet."],
  ["These contracts were scaffolded by this tool and deployed with its own scripts.",
   "The page reads them from the chain right now.",
   "This is the stream template live. I lock 10 test BUIDL",
   "and it pays out second by second, on-chain.",
   "Escrow and vault work the same way,",
   "and every button is one real transaction."],
  ["Every template also ships a JSON tool interface and an MCP server,",
   "so an AI agent can use the contract.",
   "Here it opens a stream, pays out what's earned, then cancels and splits the rest.",
   "Under each call is the exact JSON the agent gets back.",
   "Spending limits are checked before anything is signed,",
   "and errors come back with the contract's own names.",
   "CI checks this with 147 on-chain checks."],
  ["Honest numbers: Stylus is about 31 times cheaper for real computation,",
   "and about 2 times more for simple storage writes. So use it where it wins.",
   "Compared with cargo stylus new and Scaffold-Stylus, this one focuses on",
   "contracts that move money correctly, and on getting them to a live deploy.",
   "17 CI jobs run on every change, and every template is deployed to a real Nitro node.",
   "It's also on Robinhood Chain testnet, with Paxos USDG presets."],
  ["It's not audited, and it says so. There are no admin keys,",
   "and mainnet deploys refuse to run unless you set MAINNET=1.",
   "Every npm release is published from CI with signed provenance.",
   "create-stylus-latest: from npm create to a live Stylus contract on the first try.",
   "The links are below. Thanks!"],
]

# How each written word is said. Captions keep the written form.
SAY = {
  "create-stylus-latest": "create stylus latest", "create-stylus-latest:": "create stylus latest,",
  "crates.io": "crates dot io", "stylus-sdk": "stylus S D K", "alloy": "alloy",
  "ERC-20,": "E R C twenty,", "ERC-721,": "E R C seven twenty one,", "Rust–Solidity": "Rust to Solidity",
  "cargo-stylus": "cargo stylus", "quickstart.sh": "quick start dot S H", "105": "a hundred and five",
  "BUIDL": "build", "MCP": "M C P", "AI": "A I", "CI": "C I", "147": "a hundred and forty seven",
  "on-chain": "on chain", "on-chain.": "on chain.", "31": "thirty one", "2": "two", "17": "Seventeen",
  "USDG": "U S D G", "MAINNET=1.": "mainnet equals one.", "npm": "N P M", "Scaffold-Stylus,": "Scaffold Stylus,",
  "10": "ten", "JSON": "Jason",
}
spoken = lambda w: SAY.get(w, w)

k = Kokoro("kokoro.onnx", "voices.bin")
SR = 24000
LINE_GAP, SECTION_TAIL = 0.28, 0.5
timing = []
for si, lines in enumerate(SECTIONS):
  pieces, t, out_lines = [], 0.0, []
  for line in lines:
    words = line.split()
    audio, sr = k.create(" ".join(spoken(w) for w in words), voice="am_michael", speed=1.0, lang="en-us")
    assert sr == SR
    # trim leading/trailing near-silence so word timing starts where speech starts
    idx = np.where(np.abs(audio) > 0.01)[0]
    a0, a1 = (idx[0], idx[-1] + 1) if len(idx) else (0, len(audio))
    audio = audio[max(0, a0 - 480):min(len(audio), a1 + 1200)]
    dur = len(audio) / SR
    weights = [len(re.sub(r"[^A-Za-z0-9]", "", spoken(w))) + 1.5 for w in words]
    total, acc, wt = sum(weights), 0.0, []
    lead = 0.02
    for w, wgt in zip(words, weights):
      start = t + lead + (dur - lead - 0.05) * acc / total
      acc += wgt
      end = t + lead + (dur - lead - 0.05) * acc / total
      wt.append({"w": w, "s": round(start, 3), "e": round(end, 3)})
    out_lines.append({"text": line, "s": round(t, 3), "e": round(t + dur, 3), "words": wt})
    pieces += [audio, np.zeros(int(LINE_GAP * SR), dtype=audio.dtype)]
    t += dur + LINE_GAP
  pieces.append(np.zeros(int(SECTION_TAIL * SR), dtype=np.float32))
  sec = np.concatenate(pieces)
  sf.write(f"sec{si+1}.wav", sec, SR)
  timing.append({"section": si + 1, "dur": round(len(sec) / SR, 3), "lines": out_lines})
  print(f"section {si+1}: {len(sec)/SR:.1f}s")
json.dump(timing, open("timing.json", "w"), indent=1)
print("total", round(sum(s["dur"] for s in timing), 1))
