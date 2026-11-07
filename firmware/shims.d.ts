// Auto-generated. Do not edit.
declare namespace padlink {

    /** Mailbox address (also sets the magic word). */
    //% shim=padlink::addr
    function addr(): int32;

    /** Write the mailbox address into the device log so the Mac can find it. */
    //% shim=padlink::announce
    function announce(): void;

    /** Heartbeat counter written by the Mac. */
    //% shim=padlink::heartbeat
    function heartbeat(): int32;

    /** Text sequence number written by the Mac. */
    //% shim=padlink::textSeq
    function textSeq(): int32;

    /** Mailbox text: slot 0 = status, slot 1 = legend, slot 2 = claude state. */
    //% shim=padlink::text
    function text(slot: int32): string;

    /** Mascot sequence number written by the Mac. */
    //% shim=padlink::mascotSeq
    function mascotSeq(): int32;

    /** Bit mask of moods that have a custom mascot frame. */
    //% shim=padlink::mascotMask
    function mascotMask(): int32;

    /** Raw 32x32 4bpp frame for a mood (512 bytes, low nibble = left pixel). */
    //% shim=padlink::mascotFrame
    function mascotFrame(mood: int32): Buffer;

    /** True once the Mac has configured the USB device. */
    //% shim=padlink::usbReady
    function usbReady(): boolean;
}

// Auto-generated. Do not edit. Really.
