#!/bin/bash
# Runs every test against a simulated GameGo (no hardware, no keystrokes sent).
# Uses a temporary copy of the helper so your real mascot/ folder is never touched.
# Uses an isolated hook port and Codex home; the running helper is left alone.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d node_modules/pngjs ] || { echo "Run 'npm install' in the claude-link folder first."; exit 1; }

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
cp claude-link.js claude-sessions.js codex-sessions.js install-hooks.js mascot.js keys.jxa.js config.json package.json "$T"/
ln -s "$PWD/node_modules" "$T/node_modules"
mkdir "$T/mascot"
mkdir "$T/tests" "$T/codex" "$T/claude"
cp tests/*.js "$T/tests/"
export CLAUDE_LINK_CODEX_HOME="$T/codex"
export CLAUDE_LINK_CLAUDE_HOME="$T/claude"
export CLAUDE_LINK_PORT=$(node -e 'const server = require("net").createServer(); server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); }); server.on("error", () => process.exit(1));')
[ -n "$CLAUDE_LINK_PORT" ] || exit 1
cp mascot/examples/test-bot.png "$T/mascot/idle.png"
cp mascot/examples/test-bot.png "$T/mascot/work.png"

fail=0
for t in startup-test mock-test mock-long hook-test rename-test mascot-test codex-test claude-test; do
  if out=$(node "$T/tests/$t.js" "$T/claude-link.js" 2>&1); then
    echo "PASS  $t"
  else
    echo "FAIL  $t"; echo "$out" | tail -20; fail=1
  fi
done
# optional browser test of the /mirror page (needs: npm i -D playwright && npx playwright install chromium)
if node -e "require('playwright')" 2>/dev/null; then
  cp -r mirror "$T/"; mkdir -p "$T/shots"
  if OUT="$T/shots" node "$T/tests/mirror-test.js" "$T/claude-link.js" >/dev/null 2>&1; then echo "PASS  mirror-test"; else echo "FAIL  mirror-test"; fail=1; fi
else
  echo "skip  mirror-test (playwright not installed)"
fi
exit $fail
