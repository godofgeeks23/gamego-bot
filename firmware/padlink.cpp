#include "pxt.h"

// Shared mailbox the Mac writes into over USB (HF2 WRITE_WORDS).
//   word 0      magic 'PLNK'
//   word 1      heartbeat counter (Mac bumps it a few times a second)
//   word 2      text sequence number (Mac bumps it after writing text)
//   words 3-34  status text, 128 bytes  "LABEL|hint|app"
//   words 35-114 legend text, 320 bytes "A=Enter;B=Esc;...|B+A=Ctrl+C;..."
//   words 115-178 claude state, 256 bytes "kind|seq|headline|detail\nc|name|text\n..."
//   word 179    mascot sequence number (Mac bumps it after uploading frames)
//   word 180    mascot mask: bit i set = custom frame present for mood i
//   words 181-948 six 32x32 mascot frames, 4 bits/pixel (Arcade palette), 512 bytes each
//               mood order: sleep, idle, work, alert, happy, curious
#define PL_STATUS_OFF 3
#define PL_STATUS_LEN 128
#define PL_LEGEND_OFF 35
#define PL_LEGEND_LEN 320
#define PL_CLAUDE_OFF 115
#define PL_CLAUDE_LEN 256
#define PL_MASCOT_SEQ 179
#define PL_MASCOT_MASK 180
#define PL_MASCOT_OFF 181
#define PL_MASCOT_FRAME_BYTES 512
#define PL_MASCOT_FRAMES 6
#define PL_WORDS (PL_MASCOT_OFF + PL_MASCOT_FRAMES * PL_MASCOT_FRAME_BYTES / 4)

static volatile uint32_t plBox[PL_WORDS];

namespace padlink {

/** Mailbox address (also sets the magic word). */
//%
int addr() {
    plBox[0] = 0x4B4E4C50;
    return (int)(uintptr_t)plBox;
}

/** Write the mailbox address into the device log so the Mac can find it. */
//%
void announce() {
    DMESG("PLNK %d", (int)(uintptr_t)plBox);
}

/** Heartbeat counter written by the Mac. */
//%
int heartbeat() {
    return (int)plBox[1];
}

/** Text sequence number written by the Mac. */
//%
int textSeq() {
    return (int)plBox[2];
}

/** Mailbox text: slot 0 = status, slot 1 = legend, slot 2 = claude state. */
//%
String text(int slot) {
    char tmp[PL_LEGEND_LEN + 1];
    int off = slot == 1 ? PL_LEGEND_OFF : slot == 2 ? PL_CLAUDE_OFF : PL_STATUS_OFF;
    int len = slot == 1 ? PL_LEGEND_LEN : slot == 2 ? PL_CLAUDE_LEN : PL_STATUS_LEN;
    memcpy(tmp, (const void *)&plBox[off], len);
    tmp[len] = 0;
    return mkString(tmp, -1);
}

/** Mascot sequence number written by the Mac. */
//%
int mascotSeq() {
    return (int)plBox[PL_MASCOT_SEQ];
}

/** Bit mask of moods that have a custom mascot frame. */
//%
int mascotMask() {
    return (int)plBox[PL_MASCOT_MASK];
}

/** Raw 32x32 4bpp frame for a mood (512 bytes, low nibble = left pixel). */
//%
Buffer mascotFrame(int mood) {
    if (mood < 0 || mood >= PL_MASCOT_FRAMES)
        mood = 0;
    return mkBuffer((const uint8_t *)&plBox[PL_MASCOT_OFF + mood * PL_MASCOT_FRAME_BYTES / 4],
                    PL_MASCOT_FRAME_BYTES);
}

/** True once the Mac has configured the USB device. */
//%
bool usbReady() {
#if CONFIG_ENABLED(DEVICE_USB)
    return pxt::usb.isInitialised() > 0;
#else
    return false;
#endif
}
} // namespace padlink
