# Simulator preview

`./preview.sh` builds the firmware for MakeCode's simulator, runs it in headless Chromium
with a fake mailbox, and saves a screenshot of every screen state (plus your custom mascot
from `mascot/`) to `images/screens/`. Useful for checking layout changes before flashing.

- `index.html` — loads the simulator and fakes the C++ mailbox (`pxsim.padlink`)
- `shot.js` — the seven main states (no Mac, legend, working, approve, done, your turn, B layer)
- `shot2.js` — custom mascot frames + Pip fallback
