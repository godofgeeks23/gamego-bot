/**
 * CLAUDE LINK — GameGo side (v2: Claude-aware).
 * - Sends raw button events ("D A", "U A", "R UP") to the Mac helper over USB.
 * - Shows what the Mac writes into the mailbox:
 *     slot 0  last action   "LABEL|hint|app|count"
 *     slot 1  legend        "A=Enter;...|B+A=Ctrl+C;..."
 *     slot 2  claude state  "kind|seq|headline|detail\nc|name|text\n..."
 *             kind: A = needs approval, D = done, I = your turn, "" = none
 *             c:    A approval, W working, D done, I idle
 * All key mapping lives on the Mac (config.json).
 */

padlink.addr()
padlink.announce()

// ---------- link state ----------
let lastHb = 0
let lastHbChangeAt = -100000
let lastSeq = -1
let sent = 0

function linked(): boolean {
    return lastHb != 0 && game.runtime() - lastHbChangeAt < 1500
}

game.onUpdateInterval(200, function () {
    const hb = padlink.heartbeat()
    if (hb != lastHb) {
        lastHb = hb
        lastHbChangeAt = game.runtime()
    }
})

// keep the mailbox address in the device log until the Mac finds it
game.onUpdateInterval(2000, function () {
    if (!linked()) padlink.announce()
})

// ---------- outgoing events ----------
let localFlash = ""
let localFlashUntil = 0

function send(msg: string) {
    // Never write unless the Mac is actively reading — the STM32 USB driver
    // blocks until the host reads, which would freeze the device.
    if (!linked()) {
        localFlash = "NO LINK"
        localFlashUntil = game.runtime() + 400
        return
    }
    console.log(msg)
    sent++
}

function wire(btn: controller.Button, name: string, repeat: boolean) {
    btn.onEvent(ControllerButtonEvent.Pressed, function () { send("D " + name) })
    btn.onEvent(ControllerButtonEvent.Released, function () { send("U " + name) })
    if (repeat) {
        btn.repeatDelay = 350
        btn.repeatInterval = 70
        btn.onEvent(ControllerButtonEvent.Repeated, function () { send("R " + name) })
    }
}

wire(controller.A, "A", false)
wire(controller.B, "B", false)
wire(controller.up, "UP", true)
wire(controller.down, "DOWN", true)
wire(controller.left, "LEFT", true)
wire(controller.right, "RIGHT", true)
wire(controller.menu, "MENU", false) // replaces the built-in pause menu

// ---------- incoming text ----------
class Session {
    constructor(public state: string, public name: string, public text: string) { }
}

let label = "WAITING"
let hint = "start the Mac helper"
let app = ""
let baseLegend: string[] = ["run on your Mac:", "  node claude-link.js", "", "then press any button"]
let comboLegend: string[] = []
let labelChangedAt = 0
let lastActionN = ""

let alertKind = ""
let alertSeq = ""
let alertHead = ""
let alertDetail = ""
let sessions: Session[] = []

function playAlert(kind: string) {
    control.runInParallel(function () {
        if (kind == "A") {
            music.playTone(880, 90); pause(40); music.playTone(1320, 140)
        } else if (kind == "D") {
            music.playTone(660, 70); music.playTone(880, 70); music.playTone(1175, 120)
        } else if (kind == "I") {
            music.playTone(740, 100)
        }
    })
}

function readMailbox() {
    const seq = padlink.textSeq()
    if (seq == lastSeq) return
    lastSeq = seq

    const st = padlink.text(0).split("|")
    const n = st.length > 3 ? st[3] : ""
    if (n != lastActionN) {
        lastActionN = n
        labelChangedAt = game.runtime()
    }
    label = st.length > 0 ? st[0] : ""
    hint = st.length > 1 ? st[1] : ""
    app = st.length > 2 ? st[2] : ""

    const lg = padlink.text(1).split("|")
    if (lg.length > 0 && lg[0].length > 0) baseLegend = lg[0].split(";")
    if (lg.length > 1) comboLegend = lg[1].split(";")

    const lines = padlink.text(2).split("\n")
    const head = lines[0].split("|")
    const kind = head.length > 0 ? head[0] : ""
    const aseq = head.length > 1 ? head[1] : ""
    if (aseq != alertSeq) {
        const first = alertSeq == ""
        alertSeq = aseq
        if (!first && kind != "") playAlert(kind)
    }
    alertKind = kind
    alertHead = head.length > 2 ? head[2] : ""
    alertDetail = head.length > 3 ? head[3] : ""
    sessions = []
    for (let i = 1; i < lines.length; i++) {
        const f = lines[i].split("|")
        if (f.length >= 3 && f[1].length > 0) sessions.push(new Session(f[0], f[1], f[2]))
    }
}

// ---------- HUD ----------
// Screen is 160x128. font5/font8 are 6 px per char, BIG is 12 px per char.
// Every string goes through printFit() with an explicit character budget.
const BIG = image.doubledFont(image.font8)
const SMALL = image.font5
const rowColors = [7, 2, 9, 4, 11, 13]
const W = 160

function printFit(t: Image, s: string, x: number, y: number, maxChars: number, col: number, f: image.Font) {
    if (maxChars <= 0) return
    if (s.length > maxChars) s = s.substr(0, maxChars - 1) + "."
    t.print(s, x, y, col, f)
}

function printRight(t: Image, s: string, rightX: number, y: number, col: number, f: image.Font) {
    t.print(s, rightX - s.length * f.charWidth, y, col, f)
}

function stateColor(s: string): number {
    if (s == "A") return 2   // red
    if (s == "W") return 9   // light blue
    if (s == "D") return 7   // green
    return 5                 // yellow: your turn / idle
}

// ---------- custom mascot frames ----------
// The Mac uploads PNGs from claude-link/mascot/ as 32x32 4-bit frames. They are also
// saved to flash (settings) so they survive a restart. Missing moods fall back to Pip.
const MOODS = ["sleep", "idle", "work", "alert", "happy", "curious"]
let customFrames: Image[] = [null, null, null, null, null, null]
let lastMascotSeq = -1

function frameFromBuffer(b: Buffer): Image {
    const im = image.create(32, 32)
    for (let p = 0; p < 512; p++) {
        const v = b[p]
        const x = (p % 16) * 2
        const y = Math.idiv(p, 16)
        im.setPixel(x, y, v & 15)
        im.setPixel(x + 1, y, (v >> 4) & 15)
    }
    return im
}

function sameBuffer(a: Buffer, b: Buffer): boolean {
    if (!a || !b || a.length != b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false
    return true
}

function loadSavedMascot() {
    for (let i = 0; i < MOODS.length; i++) {
        const b = settings.readBuffer("pip_" + MOODS[i])
        customFrames[i] = b && b.length == 512 ? frameFromBuffer(b) : null
    }
}

function readMascot() {
    const seq = padlink.mascotSeq()
    if (seq == 0 || seq == lastMascotSeq) return
    lastMascotSeq = seq
    const mask = padlink.mascotMask()
    for (let i = 0; i < MOODS.length; i++) {
        const key = "pip_" + MOODS[i]
        if (mask & (1 << i)) {
            const b = padlink.mascotFrame(i)
            customFrames[i] = frameFromBuffer(b)
            // only touch flash when the frame actually changed
            if (!sameBuffer(settings.readBuffer(key), b)) settings.writeBuffer(key, b)
        } else {
            customFrames[i] = null
            if (settings.exists(key)) settings.remove(key)
        }
    }
}

function customFrameFor(mood: string): Image {
    const i = MOODS.indexOf(mood)
    return i >= 0 ? customFrames[i] : null
}

loadSavedMascot()

// ---------- Pip, the link buddy (original character) ----------
// mood: "sleep" | "idle" | "work" | "alert" | "happy" | "curious"
const JUMP = [0, -2, -4, -5, -4, -2, 0, 0]
const HOP = [0, -1, -2, -1, 0, 0, 0, 0, 0, 0]

function drawPipEffects(t: Image, cx: number, cy: number, r: number, mood: string, now: number) {
    // bubbles & effects
    const bx = cx + 9
    const by = Math.max(13, cy - r - 8) // keep bubbles below the title bar
    if (mood == "alert") {
        t.fillRect(bx, by, 7, 9, 2)
        t.print("!", bx + 1, by + 1, 1, image.font8)
    } else if (mood == "curious") {
        t.fillRect(bx, by, 7, 9, 5)
        t.print("?", bx + 1, by + 1, 15, image.font8)
    } else if (mood == "work") {
        const n = Math.idiv(now, 300) % 4
        for (let i = 0; i < n; i++) t.fillRect(bx + i * 3, by + 6, 2, 2, 1)
    } else if (mood == "happy") {
        const k = Math.idiv(now, 150) % 4
        const sx = [cx - 15, cx + 13, cx - 13, cx + 15]
        const sy = [cy - 10, cy - 12, cy + 2, cy]
        for (let i = 0; i < 4; i++) {
            if ((i + k) % 2 == 0) {
                t.setPixel(sx[i], sy[i], 5); t.setPixel(sx[i] - 1, sy[i], 5); t.setPixel(sx[i] + 1, sy[i], 5)
                t.setPixel(sx[i], sy[i] - 1, 5); t.setPixel(sx[i], sy[i] + 1, 5)
            }
        }
    } else if (mood == "sleep") {
        const z = Math.idiv(now, 500) % 3
        t.print("z", bx + z, by + 4 - z * 2, 11, SMALL)
    }
}

function drawPip(t: Image, cx: number, baseY: number, mood: string, now: number, nod: boolean) {
    const f8 = Math.idiv(now, 90)
    let dy = 0
    if (mood == "alert") dy = JUMP[f8 % JUMP.length]
    else if (mood == "happy") dy = HOP[f8 % HOP.length]
    else if (mood == "work") dy = Math.idiv(now, 160) % 2
    else if (mood == "sleep") dy = Math.idiv(now, 900) % 2
    else dy = Math.idiv(now, 600) % 2
    if (nod) dy += 1

    const custom = customFrameFor(mood)
    let r = 11
    let cy = baseY - r - 3 + dy
    if (custom) {
        // user-supplied 32x32 frame, same motion as Pip; bubbles still drawn on top
        r = 16
        cy = baseY - 16 + dy
        t.fillRect(cx - 9, baseY, 18, 1, 12)
        t.drawTransparentImage(custom, cx - 16, baseY - 32 + dy)
        drawPipEffects(t, cx, cy, r, mood, now)
        return
    }

    // shadow + feet
    t.fillRect(cx - 7, baseY, 14, 1, 12)
    t.fillRect(cx - 7, cy + r - 1, 4, 3, 8)
    t.fillRect(cx + 3, cy + r - 1, 4, 3, 8)

    // antenna
    let tip = 7
    if (mood == "alert") tip = Math.idiv(now, 200) % 2 == 0 ? 2 : 1
    else if (mood == "work") tip = Math.idiv(now, 150) % 2 == 0 ? 5 : 4
    else if (mood == "curious") tip = 5
    else if (mood == "sleep") tip = 12
    const sway = mood == "work" ? (Math.idiv(now, 150) % 3) - 1 : 0
    t.drawLine(cx, cy - r, cx + sway, cy - r - 5, 8)
    t.fillCircle(cx + sway, cy - r - 6, 2, tip)

    // body
    t.fillCircle(cx, cy, r, 9)
    t.drawCircle(cx, cy, r, 8)
    t.fillRect(cx - 6, cy + 3, 2, 1, 3) // cheeks
    t.fillRect(cx + 5, cy + 3, 2, 1, 3)

    // eyes
    const blinkNow = Math.idiv(now, 100) % 32 == 0
    const ex1 = cx - 6
    const ex2 = cx + 2
    const ey = cy - 4
    if (mood == "sleep" || (blinkNow && mood != "alert")) {
        t.fillRect(ex1, ey + 3, 4, 1, 15)
        t.fillRect(ex2, ey + 3, 4, 1, 15)
    } else if (mood == "happy") {
        // ^ ^
        t.drawLine(ex1, ey + 3, ex1 + 2, ey + 1, 15); t.drawLine(ex1 + 2, ey + 1, ex1 + 4, ey + 3, 15)
        t.drawLine(ex2, ey + 3, ex2 + 2, ey + 1, 15); t.drawLine(ex2 + 2, ey + 1, ex2 + 4, ey + 3, 15)
    } else {
        const tall = mood == "alert" ? 6 : 5
        t.fillRect(ex1, ey, 4, tall, 1)
        t.fillRect(ex2, ey, 4, tall, 1)
        let lx = 1
        let ly = 2
        if (mood == "work") lx = [0, 1, 2, 1][Math.idiv(now, 400) % 4]
        if (mood == "curious") ly = 1
        if (mood == "alert") { lx = 1; ly = 2 }
        t.fillRect(ex1 + lx, ey + ly, 2, 2, 15)
        t.fillRect(ex2 + lx, ey + ly, 2, 2, 15)
    }

    // mouth
    const my = cy + 4
    if (mood == "alert") t.fillRect(cx - 1, my, 3, 3, 15)
    else if (mood == "happy") { t.fillRect(cx - 2, my + 1, 5, 1, 15); t.setPixel(cx - 3, my, 15); t.setPixel(cx + 3, my, 15) }
    else if (mood == "sleep") t.fillRect(cx - 1, my + 1, 2, 1, 15)
    else if (mood == "curious") t.fillRect(cx, my, 2, 2, 15)
    else t.fillRect(cx - 1, my + 1, 3, 1, 15)

    drawPipEffects(t, cx, cy, r, mood, now)
}

scene.setBackgroundColor(15)

scene.createRenderable(0, function (target: Image, camera: scene.Camera) {
    if (linked()) { readMailbox(); readMascot() }
    const now = game.runtime()
    const isLinked = linked()
    const usb = padlink.usbReady()
    const layer = controller.B.isPressed() && comboLegend.length > 0
    const blink = Math.idiv(now, 400) % 2 == 0
    const urgent = isLinked && alertKind == "A"

    // ---- title bar: y 0-10 ----
    target.fillRect(0, 0, W, 11, layer ? 4 : urgent ? (blink ? 2 : 12) : 12)
    target.print("CLAUDE LINK", 4, 3, layer ? 15 : urgent ? 1 : 4, SMALL)
    const pill = !usb ? "NO USB" : isLinked ? (layer ? "B LAYER" : "LINKED") : "NO MAC"
    printRight(target, pill, 156, 3, !usb ? 2 : isLinked ? (layer || urgent ? 15 : 7) : 5, SMALL)

    // ---- hero: Pip (x 2-38) + message box (x 40-157), y 13-51 ----
    let anyWorking = false
    for (const s of sessions) if (s.state == "W") anyWorking = true
    let mood = "idle"
    if (!isLinked) mood = "sleep"
    else if (alertKind == "A") mood = "alert"
    else if (alertKind == "D") mood = "happy"
    else if (alertKind == "I") mood = "curious"
    else if (anyWorking) mood = "work"
    drawPip(target, 20, 49, mood, now, now - labelChangedAt < 200)

    const showLocal = now < localFlashUntil
    const hasAlert = isLinked && alertKind != "" && !showLocal
    let big = ""
    let sub = ""
    let border = 11
    let fill = -1
    let textCol = 4
    if (hasAlert) {
        big = alertHead
        sub = alertDetail
        const c = stateColor(alertKind)
        border = c
        if (alertKind == "A") { fill = blink ? 2 : 12; textCol = 1 }
        else { fill = 12; textCol = c }
    } else {
        const hot = showLocal || now - labelChangedAt < 350
        big = showLocal ? localFlash : (isLinked ? label : (usb ? "NO MAC" : "NO USB"))
        sub = isLinked ? hint : (usb ? "run claude-link.js" : "check the cable")
        border = hot ? 4 : 11
        if (hot) { fill = 12; textCol = 1 }
    }
    target.drawRect(40, 13, 118, 39, border)
    if (fill >= 0) target.fillRect(41, 14, 116, 37, fill)
    printFit(target, big, 45, 18, 9, textCol, BIG)            // 9 x 12px = 108 -> ends at 153
    printFit(target, sub, 45, 40, 18, hasAlert ? 1 : 13, SMALL) // 18 x 6px = 108 -> ends at 153

    // ---- lower panel: y 55-114 ----
    let y = 56
    if (layer || sessions.length == 0) {
        const rows = layer ? comboLegend : baseLegend
        for (let i = 0; i < rows.length && i < 6; i++) {
            const r = rows[i]
            const eq = r.indexOf("=")
            const col = rowColors[i % rowColors.length]
            if (eq > 0) {
                target.fillRect(4, y, 3, 7, col)
                printFit(target, r.substr(0, eq), 10, y + 1, 7, 1, SMALL)       // ends at 52
                printFit(target, r.substr(eq + 1), 58, y + 1, 16, col, SMALL)   // ends at 154
            } else {
                printFit(target, r, 6, y + 1, 25, 1, SMALL)                     // ends at 156
            }
            y += 9
        }
    } else {
        target.print("SESSIONS", 4, y, 11, SMALL)
        printRight(target, "A:Enter B:Esc", 156, y, 13, SMALL)
        y += 9
        for (let i = 0; i < sessions.length && i < 5; i++) {
            const s = sessions[i]
            const col = stateColor(s.state)
            const on = s.state == "A" ? blink : s.state == "W" ? Math.idiv(now, 250) % 4 != 0 : true
            if (on) target.fillRect(4, y + 1, 5, 5, col)
            else target.drawRect(4, y + 1, 5, 5, col)
            printFit(target, s.name, 12, y + 1, 9, 1, SMALL)    // ends at 66
            printFit(target, s.text, 70, y + 1, 14, col, SMALL) // ends at 154
            y += 10
        }
    }

    // ---- footer: y 117-127 ----
    target.fillRect(0, 117, W, 11, 12)
    const ev = "ev " + sent
    printRight(target, ev, 156, 120, 7, SMALL)
    const appRoom = Math.idiv(156 - ev.length * 6 - 6 - 4, 6)
    printFit(target, isLinked && app.length > 0 ? app : "--", 4, 120, appRoom, 11, SMALL)
})
