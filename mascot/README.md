# Custom mascot

The six bundled mood PNGs use Claude Code's official Clawd silhouette. `clawd.svg` is
the source artwork from Anthropic's Claude Code VS Code extension, version 2.1.296
(`resources/clawd.svg`). Its terracotta colour is mapped to the device's existing orange
palette entry. Each PNG is 32×32 with a transparent background; the firmware adds the
different mood animations and effects to the same character.

Start the helper with the current firmware to upload Clawd; no firmware reflash is
needed. Once uploaded, the frames are saved on the device for disconnected use too.

Drop PNG files in this folder, named after the mood they replace:

| File | Shown when |
|---|---|
| `sleep.png` | the Mac helper isn't running (no link) |
| `idle.png` | linked, nothing happening |
| `work.png` | a session is working |
| `alert.png` | a session needs your approval |
| `happy.png` | a session just finished |
| `curious.png` | a session is waiting for you |

Removing a mood PNG restores the firmware's original Pip fallback for that mood on
the next upload. Clawd is supplied for all six moods by default.

**How it works:** while `node claude-link.js` is running, it watches this folder and uploads
changes to the GameGo within a second, no reflash needed. The GameGo saves the frames to
its flash, so they survive a restart even before the helper connects.

**Format tips**
- 32×32 pixels is native. Bigger images are scaled down (nearest-neighbour) to fit, centred,
  sitting on the bottom edge. Pixel art drawn at 32×32 looks best.
- Transparent background (alpha < 50% = transparent).
- Colours snap to the GameGo's 16-colour palette: white, red, pink, orange, yellow, teal,
  green, dark blue, light blue, purple, mauve, dark purple, beige, brown, black.
- The bob/jump motion and the `!` / `?` / `…` / sparkle effects are added on top automatically.

`examples/test-bot.png` is a sample — copy it to `idle.png` to see it work.
`examples/template-32x32.png` is a blank transparent canvas to draw on.
