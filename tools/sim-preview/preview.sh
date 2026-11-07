#!/bin/bash
# Renders the GameGo screen in MakeCode's simulator (headless Chromium) and saves
# screenshots of every state to images/screens/. Needs: firmware/build.sh run once
# (for the toolchain), python3, and Playwright (`npm i -D playwright && npx playwright install chromium`).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FW="$ROOT/firmware"
[ -d "$FW/node_modules/pxt-arcade" ] || { echo "Run firmware/build.sh once first."; exit 1; }

# 1. build the simulator version (no C++; the page fakes the mailbox)
SRV=""
B=$(mktemp -d); trap 'rm -rf "$B"; [ -n "$SRV" ] && kill $SRV 2>/dev/null || true' EXIT
cp "$FW/main.ts" "$FW/shims.d.ts" "$B/"
ln -s "$FW/node_modules" "$B/node_modules"
echo '{ "name": "sim-view", "dependencies": { "device": "*" }, "files": ["main.ts", "shims.d.ts"], "targetVersions": { "target": "arcade" } }' > "$B/pxt.json"
(cd "$B" && npx -y pxt@0.5.1 install >/dev/null && npx -y pxt@0.5.1 build >/dev/null)

# 2. stage runtime + compiled program; simulator defaults to 160x120, GameGo is 160x128
PXTSIM=$(find -L "$FW/node_modules" -maxdepth 5 -path "*pxt-core/built/pxtsim.js" | head -1)
cp "$PXTSIM" "$FW/node_modules/pxt-arcade/built/common-sim.js" "$FW/node_modules/pxt-arcade/built/sim.js" "$HERE/"
sed 's/getConfig(2103, 120)/getConfig(2103, 128)/' "$B/built/debug/binary.js" > "$HERE/binary.js"

# 3. optional: preview your own mascot PNGs
(cd "$ROOT" && node -e "
const m=require('./mascot'); const r=m.loadMascot('mascot');
require('fs').writeFileSync('$HERE/mascot.json', JSON.stringify({mask:r.mask, frames:r.frames.map(b=>[...b])}));")

# 4. serve + screenshot
(cd "$HERE" && python3 -m http.server 8765 >/dev/null 2>&1) & SRV=$!
sleep 1
(cd "$HERE" && node shot.js && node shot2.js)
mkdir -p "$ROOT/images/screens"
mv "$HERE"/*.png "$ROOT/images/screens/" 2>/dev/null || true
rm -f "$HERE/pxtsim.js" "$HERE/common-sim.js" "$HERE/sim.js" "$HERE/binary.js" "$HERE/mascot.json"
echo "Screenshots saved to images/screens/"
