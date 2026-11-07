#include "pxt.h"

namespace usbstat {
/**
 * True once the host computer has configured the USB device
 * (i.e. the Mac has accepted it and will poll the keyboard endpoint).
 */
//%
bool isReady() {
#if CONFIG_ENABLED(DEVICE_USB)
    return pxt::usb.isInitialised() > 0;
#else
    return false;
#endif
}
}
