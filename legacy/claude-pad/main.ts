/**
 * CLAUDE PAD — turns a TinkerGen GameGo into a USB keyboard
 * for driving Claude Code / Codex sessions in a terminal.
 *
 * Base layer                 Hold B (combo layer)
 *   A      -> Enter            B+A     -> Ctrl+C
 *   B tap  -> Esc              B+UP    -> types "continue" + Enter
 *   D-pad  -> Arrow keys       B+DOWN  -> Tab
 *   MENU   -> Shift+Tab        B+LEFT  -> Esc Esc (rewind / edit prev)
 *                              B+RIGHT -> "/" (slash commands)
 *                              B+MENU  -> GameGo system menu (volume etc.)
 */

// ---------- state ----------
let lastLabel = "READY"
let lastHint = "v2 - press a button"
let flashUntil = 0
let keysSent = 0
let approvals = 0
let comboUsed = false
let bDownAt = 0
const B_TAP_MS = 450 // hold B longer than this with no combo = cancel, no Esc

// ---------- USB guard ----------
// The STM32 USB driver spins forever if we write a key while the Mac
// hasn't accepted the device, freezing everything. So never send unless ready.
let blocked = 0
function usbOk(): boolean {
    if (usbstat.isReady()) return true
    blocked++
    lastLabel = "NO USB"
    lastHint = "Mac hasn't accepted device"
    flashUntil = game.runtime() + 350
    music.playTone(220, 40)
    return false
}

// ---------- key helpers ----------
function fnKey(k: KeyboardFunctionKey) {
    keyboard.functionKey(k, KeyboardKeyEvent.Press)
}

function withMod(mod: KeyboardModifierKey, send: () => void) {
    keyboard.modifierKey(mod, KeyboardKeyEvent.Down)
    send()
    keyboard.modifierKey(mod, KeyboardKeyEvent.Up)
    keyboard.clearAllKeys()
}

function fired(label: string, hint: string) {
    lastLabel = label
    lastHint = hint
    flashUntil = game.runtime() + 350
    keysSent++
    music.playTone(1400, 12)
}

function bHeld(): boolean {
    return controller.B.isPressed()
}

// ---------- A ----------
controller.A.onEvent(ControllerButtonEvent.Pressed, function () {
    if (!usbOk()) return
    if (bHeld()) {
        comboUsed = true
        withMod(KeyboardModifierKey.Control, function () {
            keyboard.key("c", KeyboardKeyEvent.Press)
        })
        fired("CTRL+C", "cancel / exit")
    } else {
        fnKey(KeyboardFunctionKey.Enter)
        approvals++
        fired("ENTER", "send / approve")
    }
})

// ---------- B (tap = Esc, hold = combo layer) ----------
controller.B.onEvent(ControllerButtonEvent.Pressed, function () {
    comboUsed = false
    bDownAt = game.runtime()
})

controller.B.onEvent(ControllerButtonEvent.Released, function () {
    if (!comboUsed && game.runtime() - bDownAt < B_TAP_MS && usbOk()) {
        fnKey(KeyboardFunctionKey.Esc)
        fired("ESC", "interrupt")
    }
    comboUsed = false
})

// ---------- D-pad ----------
function arrow(k: KeyboardFunctionKey, label: string) {
    fnKey(k)
    fired(label, "navigate")
}

controller.up.onEvent(ControllerButtonEvent.Pressed, function () {
    if (!usbOk()) return
    if (bHeld()) {
        comboUsed = true
        keyboard.type("continue")
        fnKey(KeyboardFunctionKey.Enter)
        fired("CONTINUE", "macro sent")
    } else arrow(KeyboardFunctionKey.UpArrow, "UP")
})
controller.up.onEvent(ControllerButtonEvent.Repeated, function () {
    if (!usbOk()) return
    if (!bHeld()) arrow(KeyboardFunctionKey.UpArrow, "UP")
})

controller.down.onEvent(ControllerButtonEvent.Pressed, function () {
    if (!usbOk()) return
    if (bHeld()) {
        comboUsed = true
        fnKey(KeyboardFunctionKey.Tab)
        fired("TAB", "complete / toggle")
    } else arrow(KeyboardFunctionKey.DownArrow, "DOWN")
})
controller.down.onEvent(ControllerButtonEvent.Repeated, function () {
    if (!usbOk()) return
    if (!bHeld()) arrow(KeyboardFunctionKey.DownArrow, "DOWN")
})

controller.left.onEvent(ControllerButtonEvent.Pressed, function () {
    if (!usbOk()) return
    if (bHeld()) {
        comboUsed = true
        fnKey(KeyboardFunctionKey.Esc)
        pause(60)
        fnKey(KeyboardFunctionKey.Esc)
        fired("ESC ESC", "rewind / edit prev")
    } else arrow(KeyboardFunctionKey.LeftArrow, "LEFT")
})
controller.left.onEvent(ControllerButtonEvent.Repeated, function () {
    if (!usbOk()) return
    if (!bHeld()) arrow(KeyboardFunctionKey.LeftArrow, "LEFT")
})

controller.right.onEvent(ControllerButtonEvent.Pressed, function () {
    if (!usbOk()) return
    if (bHeld()) {
        comboUsed = true
        keyboard.type("/")
        fired("/", "slash commands")
    } else arrow(KeyboardFunctionKey.RightArrow, "RIGHT")
})
controller.right.onEvent(ControllerButtonEvent.Repeated, function () {
    if (!usbOk()) return
    if (!bHeld()) arrow(KeyboardFunctionKey.RightArrow, "RIGHT")
})

for (const btn of [controller.up, controller.down, controller.left, controller.right]) {
    btn.repeatDelay = 350
    btn.repeatInterval = 70
}

// ---------- MENU (overrides the built-in pause menu) ----------
controller.menu.onEvent(ControllerButtonEvent.Pressed, function () {
    if (bHeld()) {
        comboUsed = true
        scene.systemMenu.showSystemMenu()
    } else if (usbOk()) {
        withMod(KeyboardModifierKey.Shift, function () {
            fnKey(KeyboardFunctionKey.Tab)
        })
        fired("SHIFT+TAB", "cycle mode")
    }
})

// ---------- HUD ----------
const BIG = image.doubledFont(image.font8)
const SMALL = image.font5

class LegendRow {
    constructor(public btn: string, public action: string, public color: number) { }
}
const baseLegend = [
    new LegendRow("A", "Enter", 7),
    new LegendRow("B", "Esc", 2),
    new LegendRow("PAD", "Arrows", 9),
    new LegendRow("MENU", "Shift+Tab", 4),
    new LegendRow("hold B", "more...", 13)
]
const comboLegend = [
    new LegendRow("B+A", "Ctrl+C", 2),
    new LegendRow("B+UP", "continue", 7),
    new LegendRow("B+DN", "Tab", 9),
    new LegendRow("B+LT", "Esc Esc", 4),
    new LegendRow("B+RT", "/ cmds", 11),
    new LegendRow("B+MENU", "device menu", 13)
]

scene.setBackgroundColor(15)

scene.createRenderable(0, function (target: Image, camera: scene.Camera) {
    const now = game.runtime()
    const layer = bHeld()

    // title bar
    target.fillRect(0, 0, 160, 12, layer ? 4 : 12)
    target.print("CLAUDE PAD", 4, 2, layer ? 15 : 4, image.font8)
    target.print(layer ? "B LAYER" : "READY", layer ? 112 : 124, 3, layer ? 15 : 7, SMALL)

    // action box (terminal style)
    const hot = now < flashUntil
    target.drawRect(4, 16, 152, 38, hot ? 4 : 11)
    if (hot) target.fillRect(5, 17, 150, 36, 12)
    target.print(">", 9, 22, 4, BIG)
    target.print(lastLabel, 25, 22, hot ? 1 : 4, BIG)
    if (Math.idiv(now, 500) % 2 == 0 && !hot) {
        const cx = 25 + lastLabel.length * BIG.charWidth + 2
        if (cx < 148) target.fillRect(cx, 22, 8, 16, 4)
    }
    target.print(lastHint, 9, 43, 13, SMALL)

    // legend
    const rows = layer ? comboLegend : baseLegend
    let y = 59
    for (const r of rows) {
        target.fillRect(6, y, 3, 7, r.color)
        target.print(r.btn, 12, y + 1, 1, SMALL)
        target.print(r.action, 60, y + 1, r.color, SMALL)
        y += 9
    }

    // footer stats
    const ok = usbstat.isReady()
    target.fillRect(0, 118, 160, 10, ok ? 12 : 2)
    target.print(ok ? "USB OK" : "USB: NOT ACCEPTED", 4, 120, ok ? 7 : 1, SMALL)
    target.print("keys " + keysSent, ok ? 60 : 110, 120, ok ? 11 : 1, SMALL)
    if (ok) target.print("ok " + approvals, 120, 120, 7, SMALL)
})
