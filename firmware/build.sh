#!/bin/bash
# Rebuild claude-link.uf2 (and the browser mirror) from the sources in this folder.
# Needs Node 18+ and internet (MakeCode's cloud compiles the C++ part, padlink.cpp).
# First run downloads the MakeCode Arcade toolchain (~200 MB) into firmware/node_modules.
set -euo pipefail
cd "$(dirname "$0")"
FW="$PWD"
ROOT="$(cd .. && pwd)"

if [ ! -d node_modules/pxt-arcade ]; then
  echo "Installing MakeCode Arcade toolchain (first run only)…"
  [ -f package.json ] || echo '{ "name": "claude-link-firmware", "private": true }' > package.json
  npm install --no-audit --no-fund pxt-arcade pxt-core
fi
echo '{"targetdir":"pxt-arcade"}' > node_modules/pxtcli.json

# 1. device firmware
npx -y pxt@0.5.1 install --hwvariant stm32f401
npx -y pxt@0.5.1 build --hwvariant stm32f401 --cloud
cp built/binary.uf2 "$ROOT/claude-link.uf2"

# 2. same program for the simulator (used by the /mirror page); the C++ mailbox is faked in JS
B=$(mktemp -d); trap 'rm -rf "$B"' EXIT
cp main.ts shims.d.ts "$B/"
ln -s "$FW/node_modules" "$B/node_modules"
echo '{ "name": "claude-link-sim", "dependencies": { "device": "*" }, "files": ["main.ts", "shims.d.ts"], "targetVersions": { "target": "arcade" } }' > "$B/pxt.json"
(cd "$B" && npx -y pxt@0.5.1 install >/dev/null && npx -y pxt@0.5.1 build >/dev/null)
mkdir -p "$ROOT/mirror"
# the simulator defaults to 160x120; the GameGo screen is 160x128
sed 's/getConfig(2103, 120)/getConfig(2103, 128)/' "$B/built/debug/binary.js" > "$ROOT/mirror/binary.js"
PXTSIM=$(find -L node_modules -maxdepth 5 -path "*pxt-core/built/pxtsim.js" | head -1)
cp "$PXTSIM" node_modules/pxt-arcade/built/common-sim.js node_modules/pxt-arcade/built/sim.js "$ROOT/mirror/"

echo
echo "Built ../claude-link.uf2 (flash it) and refreshed ../mirror/ (restart claude-link.js)."
