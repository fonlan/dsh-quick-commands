#!/bin/bash
# Build @fonlan/dsh-quick-commands: the host half with the dsh checkout's tsc
# (junction-linked deps) and the browser half with tsdown (npm run build:client).
# Requires DSH_CHECKOUT pointing at a dsh source checkout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "build: cannot locate the dsh checkout (set DSH_CHECKOUT)" >&2
  exit 1
fi

TSC="$CHECKOUT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  echo "build: tsc not found at $TSC" >&2
  exit 1
fi

link_pkg() {
  local target="$CHECKOUT/$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$1" "$target"
}

echo "=== Linking build dependencies (checkout: $CHECKOUT) ==="
mkdir -p node_modules/@deepseek-ai
link_pkg cordis vendor/cordis
link_pkg cosmokit vendor/cosmokit
link_pkg schemastery vendor/schemastery
link_pkg @deepseek-ai/dsh-settings packages/core/settings
link_pkg @deepseek-ai/dsh-subprocess packages/core/subprocess
link_pkg @deepseek-ai/dsh-workspace packages/core/workspace
link_pkg @deepseek-ai/dsh-host-webserver packages/core/host-webserver

echo "=== Compiling host src → lib ($("$TSC" --version)) ==="
"$TSC" -p tsconfig.build.json

if [ -x "$ROOT/node_modules/.bin/tsdown" ]; then
  echo "=== Compiling browser client (tsdown) ==="
  npm run build:client
else
  echo "build: tsdown not available; client bundle skipped (host-only build)"
fi

echo "=== Build complete ==="
ls -la lib/ lib/types/ 2>/dev/null
