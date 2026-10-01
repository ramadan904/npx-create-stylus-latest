// Asks an RPC endpoint what it is and whether it can run Stylus, without building or sending anything.
// ArbSys (0x64) and ArbWasm (0x71) are Arbitrum's built-in system contracts; stylusVersion() is non-zero
// only on chains with Stylus enabled.
const ARB_SYS = "0x0000000000000000000000000000000000000064";
const ARB_WASM = "0x0000000000000000000000000000000000000071";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const SEL = { arbOSVersion: "0x051038f2", stylusVersion: "0xa996e0c2" };

// RPC URLs often embed an API key, so only the host is ever shown.
export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid URL)";
  }
}

async function rpcCall(fetchImpl, url, method, params, timeoutMs) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message ?? "RPC error");
  return json.result;
}

export async function probeRpc(url, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const out = {
    host: hostOf(url),
    reachable: false,
    chainId: null,
    arbitrum: false,
    stylusVersion: null,
    stylus: false,
    stateOverrides: null,
    notes: [],
  };
  const call = (method, params) => rpcCall(fetchImpl, url, method, params, timeoutMs);
  const clean = (message) => String(message).split(url).join(out.host);

  try {
    out.chainId = Number(BigInt(await call("eth_chainId", [])));
    out.reachable = true;
  } catch (err) {
    out.notes.push(`could not read eth_chainId: ${clean(err.message)}`);
    return out;
  }
  try {
    await call("eth_call", [{ to: ARB_SYS, data: SEL.arbOSVersion }, "latest"]);
    out.arbitrum = true;
  } catch {
    // not an Arbitrum chain
  }
  try {
    const version = BigInt(await call("eth_call", [{ to: ARB_WASM, data: SEL.stylusVersion }, "latest"]));
    out.stylusVersion = Number(version);
    out.stylus = version > 0n;
  } catch {
    // ArbWasm missing or reverting: Stylus is not available here
  }
  try {
    await call("eth_call", [{ to: DEAD, data: "0x" }, "latest", { [DEAD]: { balance: "0x1" } }]);
    out.stateOverrides = true;
  } catch {
    out.stateOverrides = false;
  }
  return out;
}
