import type { MmioHandler } from "../memory/memory-bus.js";

/**
 * STM32F103 RCC (Reset and Clock Control) — just enough to let Arduino-style
 * init code "enable" clocks for GPIO ports and USART1 without faulting.
 *
 * Register map (from RM0008 §7.3):
 *   0x00  CR      — clock control
 *   0x04  CFGR    — clock configuration
 *   0x08  CIR     — clock interrupt
 *   0x0C  APB2RSTR
 *   0x10  APB1RSTR
 *   0x14  AHBENR
 *   0x18  APB2ENR
 *   0x1C  APB1ENR
 *   0x20  BDCR
 *   0x24  CSR
 *
 * All registers are backed by a 256-byte scratch window and reads return the
 * last written value, plus some hardcoded "ready" bits (HSIRDY=1, HSERDY=1,
 * PLLRDY=1) in CR so busy-wait loops on clock ready bits terminate.
 */
export class Stm32RCC implements MmioHandler {
  readonly base = 0x4002_1000;
  readonly size = 0x100;
  private readonly regs = new Uint32Array(this.size / 4);

  constructor() {
    // CR: HSION=1, HSIRDY=1, HSERDY=1, PLLRDY=1
    this.regs[0] = (1 << 0) | (1 << 1) | (1 << 17) | (1 << 25);
    // CFGR: SWS=SYSCLK source reported as PLL (matches typical Arduino core)
    this.regs[1] = (0x2 << 2);
  }

  read32(offset: number): number {
    const idx = offset >>> 2;
    if (idx < this.regs.length) return this.regs[idx] >>> 0;
    return 0;
  }

  write32(offset: number, value: number): void {
    const idx = offset >>> 2;
    if (idx >= this.regs.length) return;
    // CR: ignore writes to ready bits (they stay set); let everything else stick.
    if (idx === 0) {
      const readyMask = (1 << 1) | (1 << 17) | (1 << 25);
      this.regs[idx] = ((value & ~readyMask) | readyMask) >>> 0;
      return;
    }
    this.regs[idx] = value >>> 0;
  }
}
