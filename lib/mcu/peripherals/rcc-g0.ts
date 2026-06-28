// STM32G0 RCC (Reset & Clock Control).
//
// Same accuracy priority as the F1 RCC: the *ready flags* matter, because
// firmware spins on them. The G0 CR bit positions differ from F1 (HSION is bit
// 8 / HSIRDY bit 10 on G0), and clock enables live in IOPENR/APBENR1/APBENR2.
// We store the enable registers and mirror each oscillator enable into its ready
// flag so clock-init proceeds.

import { RegisterPeripheral, type AccessWidth } from "../peripheral";

const CR = 0x00; // HSION(8)/HSIRDY(10), HSEON(16)/HSERDY(17), PLLON(24)/PLLRDY(25)
const CFGR = 0x08; // SW(2:0) selects sysclk; SWS(5:3) reports the active source

export class STM32RccG0 extends RegisterPeripheral {
  write(offset: number, width: AccessWidth, value: number): void {
    if (offset === CR) {
      let v = value >>> 0;
      // Each oscillator's ready flag tracks its enable bit (set when on, cleared
      // when off) so firmware that disables HSI/HSE/PLL and polls READY proceeds.
      v = v & (1 << 8) ? v | (1 << 10) : v & ~(1 << 10); // HSION ↔ HSIRDY
      v = v & (1 << 16) ? v | (1 << 17) : v & ~(1 << 17); // HSEON ↔ HSERDY
      v = v & (1 << 24) ? v | (1 << 25) : v & ~(1 << 25); // PLLON ↔ PLLRDY
      this.writeReg(CR, 4, v);
      return;
    }
    if (offset === CFGR) {
      // SWS (active clock, bits 5:3) immediately follows SW (request, bits 2:0).
      // HAL spins on SWS==requested after a clock switch; not mirroring hangs it.
      const v = value >>> 0;
      this.writeReg(CFGR, 4, (v & ~(0b111 << 3)) | ((v & 0b111) << 3));
      return;
    }
    this.writeReg(offset, width, value);
  }

  reset(): void {
    super.reset();
    // Power-on: HSI16 on and ready.
    this.writeReg(CR, 4, (1 << 8) | (1 << 10));
  }

  isReady(bit: number): boolean {
    return ((this.readReg(CR, 4) >> bit) & 1) === 1;
  }
}
