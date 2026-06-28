// STM32 EXTI — F1/F4 flavor (single PR pending register, distinct from the G0
// split RPR/FPR layout). Lines have per-line rising/falling trigger enables
// (RTSR/FTSR), an interrupt mask (IMR), a software trigger (SWIER), and one
// write-1-to-clear pending register (PR). The 16 GPIO lines map onto seven NVIC
// vectors: EXTI0..4 are individual, EXTI9_5 and EXTI15_10 are shared.

import { RegisterPeripheral, type AccessWidth } from "../peripheral";

const IMR = 0x00; // interrupt mask (per line)
const RTSR = 0x08; // rising trigger selection (per line)
const FTSR = 0x0c; // falling trigger selection (per line)
const SWIER = 0x10; // software interrupt event (write 1 → pending)
const PR = 0x14; // pending (write-1-to-clear)

// F1 NVIC line→vector mapping.
const IRQ_EXTI0 = 6;
const IRQ_EXTI1 = 7;
const IRQ_EXTI2 = 8;
const IRQ_EXTI3 = 9;
const IRQ_EXTI4 = 10;
const IRQ_EXTI9_5 = 23;
const IRQ_EXTI15_10 = 40;

export class STM32ExtiF1 extends RegisterPeripheral {
  /**
   * Drive an edge on an EXTI line. Sets the pending bit only if that edge's
   * trigger (RTSR/FTSR) is enabled for the line.
   */
  triggerLine(line: number, rising: boolean): void {
    if (line < 0 || line > 31) return;
    const bit = 1 << line;
    const sel = rising ? this.readReg(RTSR, 4) : this.readReg(FTSR, 4);
    if (sel & bit) {
      this.writeReg(PR, 4, (this.readReg(PR, 4) | bit) >>> 0);
    }
  }

  /** Map an EXTI line (0..15) to its F1 NVIC IRQ number. */
  irqForLine(line: number): number | null {
    switch (true) {
      case line < 0 || line > 15:
        return null;
      case line === 0:
        return IRQ_EXTI0;
      case line === 1:
        return IRQ_EXTI1;
      case line === 2:
        return IRQ_EXTI2;
      case line === 3:
        return IRQ_EXTI3;
      case line === 4:
        return IRQ_EXTI4;
      case line <= 9:
        return IRQ_EXTI9_5;
      default:
        return IRQ_EXTI15_10;
    }
  }

  write(offset: number, width: AccessWidth, value: number): void {
    if (offset === PR) {
      // Write-1-to-clear pending bits (also clears the matching SWIER bits).
      const clear = value >>> 0;
      this.writeReg(PR, 4, this.readReg(PR, 4) & ~clear);
      this.writeReg(SWIER, 4, this.readReg(SWIER, 4) & ~clear);
      return;
    }
    if (offset === SWIER) {
      // Software trigger: newly-set SWIER bits latch into PR.
      const prev = this.readReg(SWIER, 4);
      const next = value >>> 0;
      this.writeReg(SWIER, 4, next);
      this.writeReg(PR, 4, (this.readReg(PR, 4) | (next & ~prev)) >>> 0);
      return;
    }
    this.writeReg(offset, width, value);
  }

  pendingIRQ(): number | null {
    const masked = (this.readReg(PR, 4) & this.readReg(IMR, 4)) >>> 0;
    if (masked === 0) return null;
    for (let line = 0; line <= 15; line++) {
      if ((masked >>> line) & 1) return this.irqForLine(line);
    }
    return null;
  }
}
