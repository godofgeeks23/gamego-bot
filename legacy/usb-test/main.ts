// USB diagnostic: no keyboard, just reports whether the host configured the device.
scene.setBackgroundColor(15)
let presses = 0
let firstOkAt = -1
controller.anyButton.onEvent(ControllerButtonEvent.Pressed, function () { presses++ })
scene.createRenderable(0, function (t: Image, c: scene.Camera) {
    const ok = usbstat.isReady()
    if (ok && firstOkAt < 0) firstOkAt = game.runtime()
    t.fillRect(0, 0, 160, 14, 12)
    t.print("USB TEST (no keyboard)", 4, 3, 4, image.font8)
    t.fillRect(10, 30, 140, 40, ok ? 7 : 2)
    t.printCenter(ok ? "USB OK" : "NO USB", 42, 1, image.doubledFont(image.font8))
    t.print("uptime " + Math.idiv(game.runtime(), 1000) + "s", 10, 80, 1, image.font8)
    t.print("buttons pressed " + presses, 10, 92, 1, image.font8)
    if (firstOkAt >= 0) t.print("accepted at " + firstOkAt + "ms", 10, 104, 7, image.font8)
})
