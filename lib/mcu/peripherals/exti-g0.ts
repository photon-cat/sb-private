// STM32 EXTI — G0 flavor (distinct from the F1/F4 single-PR/IMR layout). The G0
// EXTI splits pending into rising (RPR1) and falling (FPR1) registers, both
// write-1-to-clear, with per-line rising/falling trigger enables (RTSR1/FTSR1)
// and an interrupt mask (IMR1). Lines are condensed onto three NVIC vectors:
// EXTI0_1, EXTI2_3, EXTI4_15.

import { RegisterPeripheral, type AccessWidth } from "../peripheral";

const RTSR1 = 0x00; // rising trigger selection (per line)
const FTSR1 = 0x04; // falling trigger selection (per line)
const RPR1 = 0x0c; // rising pending (write-1-to-clear)
const FPR1 = 0x10; // falling pending (write-1-to-clear)
const IMR1 = 0x80; // interrupt mask (per line)

// G0 NVIC line→vector mapping.
const IRQ_EXTI0_1 = 5;
const IRQ_EXTI2_3 = 6;
const IRQ_EXTI4_15 = 7;

export class STM32ExtiG0 extends RegisterPeripheral {
  /**
   * Drive an edge on an EXTI line. Sets the matching pending bit only if that
   * edge's trigger (RTSR/FTSR) is enabled for the line.
   */
  triggerLine(line: number, rising: boolean): void {
    if (line < 0 || line > 31) return;
    const bit = 1 << line;
    if (rising) {
      if (this.readReg(RTSR1, 4) & bit) {
        this.writeReg(RPR1, 4, this.readReg(RPR1, 4) | bit);
      }
    } else {
      if (this.readReg(FTSR1, 4) & bit) {
        this.writeReg(FPR1, 4, this.readReg(FPR1, 4) | bit);
      }
    }
  }

  /** Map an EXTI line to its G0 NVIC IRQ number. */
  irqForLine(line: number): number | null {
    if (line < 0 || line > 15) return null;
    if (line <= 1) return IRQ_EXTI0_1;
    if (line <= 3) return IRQ_EXTI2_3;
    return IRQ_EXTI4_15;
  }

  write(offset: number, width: AccessWidth, value: number): void {
    if (offset === RPR1 || offset === FPR1) {
      // Write-1-to-clear pending bits.
      this.writeReg(offset, 4, this.readReg(offset, 4) & ~(value >>> 0));
      return;
    }
    this.writeReg(offset, width, value);
  }

  pendingIRQ(): number | null {
    const pending = (this.readReg(RPR1, 4) | this.readReg(FPR1, 4)) >>> 0;
    const masked = pending & this.readReg(IMR1, 4);
    if (masked === 0) return null;
    for (let line = 0; line <= 15; line++) {
      if ((masked >>> line) & 1) return this.irqForLine(line);
    }
    return null;
  }
}
