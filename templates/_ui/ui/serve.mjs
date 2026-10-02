// Serves the contract page on 127.0.0.1 with no dependencies. /config.json is built from ../.env on every request.
// The dev node's throwaway PRIVATE_KEY is handed to the page only when CHAIN_ID is the local dev node (412346), so the
// page can sign for you there like a burner wallet; on any other chain the page uses your browser wallet and never
// sees a key.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const DEV_NODE_CHAIN_ID = 412346;
const here = fileURLToPath(new URL(".", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".sol": "text/plain; charset=utf-8", ".json": "application/json" };

/** KEY=value lines (quotes stripped, comments and blanks skipped). */
export function parseEnv(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && !line.startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

/** What the page may know. The key is included only for the local dev node. */
export function pageConfig(env) {
  const chainId = Number(env.CHAIN_ID || 0);
  const config = { rpc: env.RPC_URL || "", chainId, address: env.CONTRACT_ADDRESS || "" };
  if (chainId === DEV_NODE_CHAIN_ID && /^0x[0-9a-fA-F]{64}$/.test(env.PRIVATE_KEY || "")) config.devKey = env.PRIVATE_KEY;
  return config;
}

function serve(port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/config.json") {
      const envFile = join(here, "..", ".env");
      const env = { ...parseEnv(existsSync(envFile) ? readFileSync(envFile, "utf8") : ""), ...pick(process.env) };
      res.setHeader("content-type", TYPES[".json"]);
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify(pageConfig(env)));
    }
    const file = normalize(join(here, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(here) || !existsSync(file)) {
      res.statusCode = 404;
      return res.end("not found");
    }
    res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
    res.setHeader("cache-control", "no-store");
    res.end(readFileSync(file));
  });
  server.listen(port, "127.0.0.1", () => console.log(`Contract UI: http://127.0.0.1:${port}  (Ctrl+C to stop)`));
}

// Variables set in the shell override .env, like for deploy.sh.
const pick = (e) => Object.fromEntries(["RPC_URL", "CHAIN_ID", "CONTRACT_ADDRESS", "PRIVATE_KEY"].filter((k) => e[k]).map((k) => [k, e[k]]));

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) serve(Number(process.argv[2] || 5173));
