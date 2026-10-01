// Resolves the newest stable stylus-sdk (and the alloy version it needs) from the
// crates.io sparse index, so scaffolded projects never start on stale dependencies.

// Known-good fallback, used when offline. Verified against these exact versions.
export const FALLBACK = { stylusSdk: "0.10.9", alloy: "1.5.7" };

const INDEX = "https://index.crates.io";

export function indexPath(crate) {
  const n = crate.length;
  if (n === 1) return `1/${crate}`;
  if (n === 2) return `2/${crate}`;
  if (n === 3) return `3/${crate[0]}/${crate}`;
  return `${crate.slice(0, 2)}/${crate.slice(2, 4)}/${crate}`;
}

function parseVersion(v) {
  return v.split(".").map((p) => Number.parseInt(p, 10));
}

export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

// Picks the highest non-yanked, non-prerelease release from sparse-index lines.
export function pickLatest(indexText) {
  const releases = indexText
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e) => !e.yanked && !e.vers.includes("-"));
  if (releases.length === 0) throw new Error("no stable releases found");
  return releases.reduce((best, e) => (compareVersions(e.vers, best.vers) > 0 ? e : best));
}

// "^1.5.7" / ">=1.5.7, <2" / "1.5.7" -> "1.5.7"
export function minVersionOf(req) {
  const m = /\d+\.\d+\.\d+/.exec(req);
  if (!m) throw new Error(`cannot parse version requirement: ${req}`);
  return m[0];
}

export async function resolveVersions({ offline = false, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (offline) return { ...FALLBACK, source: "offline" };
  try {
    const res = await fetchImpl(`${INDEX}/${indexPath("stylus-sdk")}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const latest = pickLatest(await res.text());
    const dep = latest.deps.find((d) => d.name === "alloy-primitives" && d.kind === "normal");
    if (!dep) throw new Error("stylus-sdk does not declare alloy-primitives");
    return { stylusSdk: latest.vers, alloy: minVersionOf(dep.req), source: "crates.io" };
  } catch (err) {
    return { ...FALLBACK, source: "fallback", reason: err.message };
  }
}
