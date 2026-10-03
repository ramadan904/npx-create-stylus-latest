#!/usr/bin/env bash
# Smoke-test the package exactly as a user receives it: pack the tarball, run it with npx in an empty directory, and
# scaffold every template. Catches anything that works from a git checkout but not from npm (a file missing from
# "files", a dotfile npm drops, a lost executable bit, a wrong version string). Used by CI and by the publish workflow.
set -euo pipefail
cd "$(dirname "$0")/.."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

version="$(node -p "require('./package.json').version")"
tarball="$(npm pack --pack-destination "$work" --silent)"
echo "packed $tarball"

run() { (cd "$work" && npx --yes --package="$work/$tarball" create-stylus-latest "$@"); }

got="$(run --version)"
[ "$got" = "$version" ] || { echo "FAIL: --version printed '$got', package.json says '$version'" >&2; exit 1; }

templates="$(node -e 'import("./src/templates.js").then(m => console.log(Object.keys(m.TEMPLATES).join(" ")))')"
for t in $templates; do
  run "app-$t" -t "$t" -y --no-git --offline >/dev/null
  dir="$work/app-$t"
  for f in .env.example .gitignore Cargo.toml Stylus.toml README.md src/lib.rs scripts/deploy.sh scripts/devnode.sh \
           scripts/devnode/setup.mjs scripts/devnode/bytecode.json scripts/devnode/package.json; do
    [ -e "$dir/$f" ] || { echo "FAIL: $t is missing $f" >&2; exit 1; }
  done
  for f in scripts/deploy.sh scripts/devnode.sh scripts/export-abi.sh scripts/verify.sh; do
    [ -x "$dir/$f" ] || { echo "FAIL: $t/$f lost its executable bit" >&2; exit 1; }
  done
  if [ "$t" = interop ]; then
    [ -e "$dir/solidity/Consumer.sol" ] || { echo "FAIL: interop is missing solidity/Consumer.sol" >&2; exit 1; }
    [ -x "$dir/scripts/interop.sh" ] || { echo "FAIL: interop/scripts/interop.sh lost its executable bit" >&2; exit 1; }
  fi
  if grep -rq '{{' "$dir" --include='*.toml' --include='*.rs' --include='*.md' --include='*.sh'; then
    echo "FAIL: $t has an unrendered {{placeholder}}" >&2; exit 1
  fi
  echo "ok  $t"
done
run "app-ui" -t counter -y --no-git --offline --with-ui --with-client >/dev/null
for f in ui/index.html ui/serve.mjs client/package.json; do
  [ -e "$work/app-ui/$f" ] || { echo "FAIL: --with-ui/--with-client is missing $f" >&2; exit 1; }
done
[ -x "$work/app-ui/scripts/ui.sh" ] || { echo "FAIL: scripts/ui.sh lost its executable bit" >&2; exit 1; }
echo "ok  --with-ui --with-client"
echo "smoke test passed for: $templates (version $version)"
