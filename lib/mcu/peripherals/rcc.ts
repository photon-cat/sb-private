// STM32 RCC (Reset & Clock Control), F1-style.
//
// The accuracy-critical part isn't the clock math — it's the *ready flags*.
// Firmware spins on HSIRDY/HSERDY/PLLRDY after enabling each oscillator; if the
// model never sets the ready bit, the firmware hangs (exactly the class of bug
// that stalled the mbed RP2040 core). We mirror each "enable" bit into its
// "ready" bit immediately so clock-init code proceeds.

import { RegisterPeripheral, type AccessWidth } from "../peripheral";

const CR = 0x00; // clock control: HSION(0)/HSIRDY(1), HSEON(16)/HSERDY(17), PLLON(24)/PLLRDY(25)
const CFGR = 0x04;

export class STM32RccF1 extends RegisterPeripheral {
  write(offset: number, width: AccessWidth, value: number): void {
    if (offset === CR) {
      let v = value >>> 0;
      // Reflect each oscillator enable into its ready flag.
      if (v & (1 << 0)) v |= 1 << 1; // HSION → HSIRDY
      if (v & (1 << 16)) v |= 1 << 17; // HSEON → HSERDY
      if (v & (1 << 24)) v |= 1 << 25; // PLLON → PLLRDY
      this.writeReg(CR, 4, v);
      return;
    }
    if (offset === CFGR) {
      // SWS (system clock switch status, bits 3:2) follows SW (bits 1:0).
      let v = value >>> 0;
      v = (v & ~(0b11 << 2)) | ((v & 0b11) << 2);
      this.writeReg(CFGR, 4, v);
      return;
    }
    this.writeReg(offset, width, value);
  }

  reset(): void {
    super.reset();
    // Power-on: HSI on and ready.
    this.writeReg(CR, 4, (1 << 0) | (1 << 1));
  }

  /** True once the named clock-enable bit's ready flag is set. */
  isReady(bit: number): boolean {
    return ((this.readReg(CR, 4) >> bit) & 1) === 1;
  }
}
