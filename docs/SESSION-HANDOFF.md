# Session handoff: Claude Link (GameGo controller for Claude Code / Codex)

_Last updated: 2026-11-07_

Turn a TinkerGen GameGo handheld into a game-style controller for Claude Code / Codex
sessions on a MacBook Pro (Apple silicon): buttons drive the terminal, the screen shows
live session state (approvals, working, done) with an animated buddy.

---

## 1. Current status

| Area | State |
|---|---|
| Hardware | Working on USB power. **Original battery is dead** (removed). |
| Approach | **Method 2** (MakeCode firmware + Mac helper over HF2). Method 1 failed on this chip; method 3 not started. |
| Buttons → keystrokes | Built and tested against a simulated device. On real hardware: USB data link confirmed (usb-test green); end-to-end keystrokes not yet reported back by the user. |
| Claude-aware hooks | Built + tested (simulated device, real curl hooks). Needs `node install-hooks.js` on the Mac. |
| Codex monitoring | Local session discovery + native lifecycle hooks; six core tests pass. Running helper verified USB-linked with the current Codex thread in the live display feed. New hooks still require `/hooks` trust review. |
| Pip mascot + layout fix | Built, verified via simulator screenshots at 160×128. |
| Session rename (`/rename`) | Built + tested (reads transcript). |
| Custom mascot (PNG upload) | Built + tested (encoding, upload, live reload, simulator render). |
| Screen mirror (`/mirror`) | Built + tested end to end (helper + simulated device + headless Chromium, recording verified: H.264 MP4). |
| Not yet confirmed on the real GameGo | Latest `claude-link.uf2` (mascot upload, settings flash persistence). |

---

## 2. Hardware facts (from the files the GameGo exposed)

- **Bootloader:** UF2 Bootloader v2.7.5, Board-ID `STM32F4xx-Arcade-Generic`, model "TinkerGen GameGo".
- **MCU:** STM32F401, 512 KB flash, 96 KB RAM. UF2 family `0x57755a57`. App starts at `0x08010000`.
- **Display:** ST7735 160×**128** (Arcade games normally 160×120; on this device the screen image is 160×128).
- **Buttons:** A, B, Up, Down, Left, Right, Menu (7). Pin map decoded from `CONFIG.BIN`:
  A=0x20, B=0x21, LEFT=0x2a, RIGHT=0x28, UP=0x29, DOWN=0x2b, MENU=0x04, display SPI SCK 0x05 / MOSI 0x07,
  CS 0x1c, DC 0x14, RST 0x2c, BL 0x19, LED 0x10, LED1 0x11, jack TX 0x16 / PWREN 0x0a / SND 0x08.
- **Original firmware:** MakeCode Arcade game "Raptor Run". A full flash dump (`CURRENT.UF2`) exists as backup —
  dragging it back restores the original.
- **Drive mode:** the GAMEGO USB drive. Flashing = drag a `.uf2` onto it. Bootloader is self-protecting (can't brick).
  "Disk Not Ejected Properly" notifications after flashing are normal (device reboots).

### Battery diagnosis (resolved)
Symptoms: would not boot unplugged; plugged in, showed the bootloader screen for 1–2 s then reset.
Cause: deeply discharged/failed LiPo dragging the supply down. **Fix: battery unplugged; runs fine from USB.**
Replacement (optional): 3.7 V LiPo, same connector — **check red/black polarity** before plugging in.

---

## 3. What was tried and why we're on method 2

1. **Method 1 — USB HID keyboard (MakeCode `keyboard` extension)** → `legacy/claude-pad/`
   - v1 froze on first button press. Root cause: codal-stm32 `writeEP()` busy-waits forever until the host reads the endpoint.
   - v2 added a USB-configured guard (`usbstat.isReady()`) → showed **USB: NOT ACCEPTED**; System Report showed no device.
   - Diagnostic `legacy/usb-test/` (same firmware **without** keyboard) → **USB OK**.
   - **Conclusion:** adding the HID keyboard interface breaks USB enumeration on this STM32F401 build. Not hub- or macOS-permission-related.
2. **Method 2 — HF2 link + Mac helper** (current). Uses MakeCode's own vendor-class USB interface, which enumerates fine.
3. **Method 3 — custom C/Rust firmware** (future). Would allow a real HID keyboard + CDC serial, no helper needed, richer screen.

---

## 4. Architecture (method 2)

```
 GameGo (MakeCode firmware)                         Mac
 ┌──────────────────────────┐   USB HF2 (vendor   ┌─────────────────────────────┐
 │ main.ts                  │   class 0xFF/42)    │ claude-link.js (Node)       │
 │  buttons → "D A"/"U A"/  │ ── serial lines ──▶ │  button logic (B layer)     │──▶ keys.jxa.js (osascript)
 │  "R UP" (console.log)    │                     │  → System Events keystrokes │     → frontmost terminal
 │  HUD + Pip               │ ◀── WRITE_WORDS ─── │  heartbeat, status, legend, │
 │ padlink.cpp mailbox (RAM)│     into mailbox    │  claude state, mascot frames│
 └──────────────────────────┘                     │  HTTP 127.0.0.1:47821       │◀── Claude Code hooks (curl)
                                                  └─────────────────────────────┘◀── Codex hooks + local rollouts
```

### Key design rule: never let the GameGo block
On STM32 the HF2 send path is synchronous: a write blocks until the host reads. So:
- The Mac writes a **heartbeat** into the mailbox every 300 ms.
- The GameGo only sends events if the heartbeat changed in the last 1.5 s (`linked()`).
- The Mac keeps a continuous read poll on the IN endpoint while connected.

### Mailbox finding
The firmware logs `PLNK <address>` via `DMESG` (and re-announces every 2 s while unlinked).
The helper sends HF2 `INFO` (0x0002), then `DMESG` (0x0010), parses the last `PLNK` address.

### Mailbox layout (`plBox`, 32-bit words)
| Words | Bytes offset | Content |
|---|---|---|
| 0 | 0 | magic `PLNK` |
| 1 | 4 | heartbeat |
| 2 | 8 | text seq (bump after writing text) |
| 3–34 | 12 | status `LABEL\|hint\|app\|actionCount` (128 B) |
| 35–114 | 140 | legend `A=Enter;...\|B+A=Ctrl+C;...` (320 B) |
| 115–178 | 460 | claude state `kind\|seq\|headline\|detail` + `\n` rows `c\|name\|text` (256 B) |
| 179 | 716 | mascot seq |
| 180 | 720 | mascot mask (bit i = mood i present) |
| 181–948 | 724 | 6 × 512 B frames, 32×32 4bpp, low nibble = left pixel |

Moods (index order): `sleep, idle, work, alert, happy, curious`.
Claude state codes: kind `A` approve / `D` done / `I` your turn / `""` none; row `c` = A/W/D/I.

### HF2 framing (reference)
64-byte packets, byte 0 = flags|size: `0x40` last command packet, `0x00` body, `0x80` serial out, `0xC0` serial err.
Command = `u32 cmd, u16 tag, u8, u8, data`. Response = `u16 tag, u8 status, u8 info, data`.
`WRITE_WORDS` (0x0009) data = `u32 addr, u32 nWords, words…` (helper chunks ≤240 B).

---

## 5. Claude Code hooks

`install-hooks.js` adds to `~/.claude/settings.json` (backup `settings.json.claude-link-backup-<ts>`):
PreToolUse, PostToolUse, PermissionRequest (matcher `*`), SessionStart, SessionEnd, UserPromptSubmit, Notification, Stop.
Each runs: `curl -s -m 1 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:47821/hook || true`
— no output, always exit 0, ~10 ms; silent if the helper is down. Idempotent; `--uninstall` removes only ours.

Codex: installs native lifecycle hooks in `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`):
SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop, Interrupt.
These POST to `/codex`. Existing hooks and other `notify` commands are preserved; only the old
claude-link-owned notify entry is removed. `--codex-only` leaves Claude settings untouched.
New hooks require review/trust in Codex's `/hooks` UI, then a session restart/resume.
See [official hook documentation](https://learn.chatgpt.com/docs/hooks).

`codex-sessions.js` also discovers recent local rollout files on startup and every ten seconds,
then incrementally reads them every two seconds. This works without a notify slot or trusted hooks,
including sessions that predate helper startup. Thread IDs are the keys, not working directories;
names come from `session_index.jsonl`, prefixed `C:`. Internal subagents are excluded.
Reads are asynchronous and bounded to the latest 1 MiB per file; incomplete JSONL lines are retried.
Initial history does not replay completion chimes. Hooks take precedence over older transcript events.
The existing three-hour visibility limit and five-row screen limit also apply to Codex.
Set `CLAUDE_LINK_CODEX_HOME` to override the monitored home, useful for isolated tests.

State mapping (helper): SessionStart→I ready; UserPromptSubmit→W thinking; PreToolUse→W `<tool> <detail>`;
PostToolUse→W thinking (clears approval); PermissionRequest / Notification `permission_prompt`→A;
Notification `idle_prompt`→I your turn (+ banner 6 s); Stop→D done (+ chime, banner 5 s); SessionEnd→remove.
Stale approvals (answered "No", no follow-up hook) revert after 10 min.

Session names: `/rename` fires no hook; Claude Code appends `{"type":"custom-title","customTitle":…}` (and `agent-name`)
to the transcript. Helper tails `transcript_path` (incremental, every hook + every 2 s). Name = customTitle → agentName → cwd folder.

---

## 6. Default controls (`config.json`, live-reloaded)

| Button | Action | Hold B + | Action |
|---|---|---|---|
| A | Enter | A | Ctrl+C |
| B tap (<450 ms) | Esc | Up | types `continue` + Enter |
| D-pad | arrows (auto-repeat) | Down | Esc Esc (rewind) |
| Menu | Shift+Tab (mode) | Left/Right | prev/next terminal tab (Cmd+Shift+[ / ]) |
| | | Menu | `/` |

Keystrokes go to the **frontmost app** via a persistent `osascript -l JavaScript` worker
(needs Accessibility permission for the terminal + Automation for System Events).

---

## 7. Screen (160×128, 6 px/char small fonts, 12 px/char big font)

Title bar (pill: LINKED / NO MAC / NO USB / B LAYER) · Pip (x 2–38) + message box (9 big chars, 18 small) ·
lower panel: SESSIONS (5 rows: name 9 chars, text 14 chars) or legend, combo legend while B held · footer: front app + event count.
All text goes through `printFit()` with explicit char budgets (fixes earlier overflow).

**Clawd** is supplied in all six `mascot/*.png` files, converted from the official SVG in
`mascot/clawd.svg`. The firmware adds mood-specific motion/effects and saves uploads to flash
(`settings` keys `pip_<mood>`). No reflash is needed. The original blue Pip remains the fallback
before first upload or for deleted mood PNGs. Older screenshots show Pip; `images/clawd-preview.png`
shows the current artwork. See `mascot/README.md` for provenance.

---

## 7b. Screen mirror (demo / recording)

`http://127.0.0.1:47821/mirror` (served by the helper's existing HTTP server):
- Runs the **same program** (`mirror/binary.js`, a simulator build of `firmware/main.ts`, patched to 160×128)
  in MakeCode's simulator runtime (`pxtsim.js`, `common-sim.js`, `sim.js` — from pxt-core / pxt-arcade, MIT).
- `pxsim.padlink` is faked in the page; data arrives over **Server-Sent Events** at `/mirror/events`:
  `state` = `{t0 status, t1 legend, t2 claude state, device, mascot{seq,mask,frames(base64)}}`,
  `btn` = `{ev: D|U|R, btn}` forwarded from the real GameGo → `board.setButton(pxsim.Key.X, down)`.
- The page heartbeats the fake mailbox while SSE is up → shows LINKED; helper down → NO MAC / sleeping Pip.
- Stage is one canvas (547×782 transparent portrait GameGo, or 640×512 screen-only) → `canvas.captureStream(30)` +
  `MediaRecorder` (mp4/h264 when supported, else webm). Simulator keyboard input is disabled so shortcuts are safe.
- `firmware/build.sh` regenerates `mirror/` along with `claude-link.uf2`, keeping them in sync.
- Mirror's `ev` counter counts presses seen since the page opened (may differ from the device).
- `mirror/gamego-front.png` is an image-tool-edited transparent cutout of the user-provided front photo
  `61ZSRKAMBdL._AC_SL1000_.jpg`, with the left wrist strap, white background and ground shadow removed.
  The 1132×1390 asset is drawn at 637×782 with a −90px horizontal offset to trim empty space.
  Canvas clearing preserves alpha for PNG snapshots; video codecs may composite transparency onto black.
  The live LCD and seven press highlights overlay the photo at measured coordinates in `DEVICE`.
  Menu is the left grey button; the right Reset button, power switch, LEDs and speaker remain photographic.

## 8. Files

| Path | What |
|---|---|
| `claude-link.uf2` | firmware to flash |
| `claude-link.js` | Mac helper (USB link, keys, hooks server, sessions, mascot upload) |
| `mascot.js` | PNG → 32×32 4bpp Arcade-palette encoder |
| `keys.jxa.js` | keystroke worker (osascript JXA) |
| `install-hooks.js` | add/remove Claude Code and Codex lifecycle hooks |
| `codex-sessions.js` | automatic discovery, names, and activity from local Codex rollouts |
| `config.json` | button mapping + legend |
| `firmware/` | `main.ts`, `padlink.cpp`, `shims.d.ts`, `pxt.json`, `build.sh` |
| `mascot/` | custom PNGs (`examples/` has a sample + blank template) |
| `images/` | simulator screenshots of every state |
| `tests/` | simulated-device tests; `run-all.sh` |
| `tools/sim-preview/` | headless MakeCode simulator screenshots (`preview.sh`) |
| `mirror/` | live browser mirror of the GameGo screen (`index.html` + simulator runtime + `binary.js`) |
| `legacy/` | method 1 attempts (`claude-pad` v1/v2) and `usb-test` diagnostic |

---

## 9. How to run

```bash
cd ~/Downloads/claude-link
npm install                       # usb + pngjs
node install-hooks.js             # once; restart Claude sessions afterwards
node claude-link.js               # --dry-run --verbose to debug without keystrokes
```
Flash `claude-link.uf2` via drive mode. Rebuild firmware: `firmware/build.sh` (Node + internet; MakeCode cloud compiles the C++).
Tests: `tests/run-all.sh` (isolated port and Codex home; the helper can stay running). Screen preview: `tools/sim-preview/preview.sh`.

---

## 10. Known limitations / gotchas

- Helper must be running for the GameGo to do anything; if it dies mid-write, the device may pause until the helper reconnects.
- Approvals answered with "No"/Esc stay red until the next hook or 10 min.
- Session rows are not linked to terminal tabs — use the name and B+Left/Right.
- Codex approval alerts require trusted lifecycle hooks for reliability; transcript fallback uses an internal format and discovers only locally stored sessions.
- MakeCode web editor may not compile `padlink.cpp`; use `firmware/build.sh`.
- Custom mascot frames persist in flash; deleting a PNG removes it from the device on the next upload.
- Simulator defaults to 160×120; preview tooling patches it to 128.

---

## 11. Next steps (ideas)

0. For the showcase: open `/mirror`, press H for a clean view, project or record it.
1. Confirm the latest firmware on hardware (LINKED, keystrokes, hooks, mascot upload, persistence after replug).
2. Launch the helper automatically at login (`launchd` plist).
3. Jump to the terminal tab of the session needing approval (iTerm2/Terminal AppleScript by tty/cwd).
4. Optional new battery for untethered use.
5. Method 3: custom firmware with HID keyboard + CDC serial (no helper), richer status (diffs, token use).
