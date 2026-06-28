// STM32G0 embedded FLASH interface (the register block at 0x40022000, NOT the
// flash array itself). The accuracy-critical register for boot is ACR: HAL's
// HAL_RCC_ClockConfig writes the wait-state LATENCY field then **reads it back**
// in a spin loop before switching the clock. An unmodeled FLASH reads 0, so the
// readback never matches and boot hangs — the #1 wall the stress harness found.
//
// Plain read/write storage satisfies the ACR readback. SR.BSY (program/erase
// busy) reads 0 = "not busy", which is correct for firmware that never writes
// flash; modeling the program/erase state machine is left for later.

import { RegisterPeripheral } from "../peripheral";

export class STM32FlashG0 extends RegisterPeripheral {
  // Default behavior (register-array storage) is exactly what ACR readback needs.
  // Kept as a named model so the SVD group "FLASH" maps to documented intent and
  // a future BSY/program model has a home.
}
