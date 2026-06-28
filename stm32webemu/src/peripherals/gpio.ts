import type { MmioHandler } from "../memory/memory-bus.js";

/**
 * STM32F103 GPIO port (GPIOA..GPIOE).
 *
 * Register map (from RM0008 §9.2):
 *   0x00  CRL   — port configuration low (pins 0..7)
 *   0x04  CRH   — port configuration high (pins 8..15)
 *   0x08  IDR   — input data register (read-only)
 *   0x0C  ODR   — output data register
 *   0x10  BSRR  — bit set/reset register (write-only)
 *   0x14  BRR   — bit reset register (write-only)
 *   0x18  LCKR  — lock register
 */
export class Stm32GPIO implements MmioHandler {
  readonly base: number;
  readonly size = 0x400;
  /** Bit i = current level of pin i (output pins reflect ODR; input pins reflect external state). */
  pinState = 0;
  /** Configuration low register (CNFx/MODEx for pins 0-7). */
  crl = 0x4444_4444; // reset value: all pins = floating input
  /** Configuration high register (CNFx/MODEx for pins 8-15). */
  crh = 0x4444_4444;
  /** Output data register. */
  odr = 0;
  /** Input data register (driven externally). */
  idr = 0;

  /** Optional observer: called whenever ODR changes so the UI can update LEDs. */
  onOdrChange?: (odr: number, prev: number) => void;

  constructor(
    readonly name: string,
    base: number,
  ) {
    this.base = base;
  }

  read32(offset: number): number {
    switch (offset) {
      case 0x00: return this.crl >>> 0;
      case 0x04: return this.crh >>> 0;
      case 0x08: return this.idr >>> 0;
      case 0x0c: return this.odr >>> 0;
      default:   return 0;
    }
  }

  write32(offset: number, value: number): void {
    const v = value >>> 0;
    switch (offset) {
      case 0x00: this.crl = v; return;
      case 0x04: this.crh = v; return;
      case 0x0c: this.setOdr(v); return;
      case 0x10: { // BSRR: low 16 = set, high 16 = reset
        const setMask = v & 0xffff;
        const resetMask = (v >>> 16) & 0xffff;
        // Reset takes precedence only if both are set, per RM0008 §9.2.5.
        const next = ((this.odr | setMask) & ~resetMask) >>> 0;
        this.setOdr(next);
        return;
      }
      case 0x14: { // BRR
        const resetMask = v & 0xffff;
        this.setOdr((this.odr & ~resetMask) >>> 0);
        return;
      }
      case 0x18: this.crl = this.crl; return; // LCKR — ignored
    }
  }

  private setOdr(next: number): void {
    const prev = this.odr;
    this.odr = next >>> 0;
    if (prev !== this.odr && this.onOdrChange) this.onOdrChange(this.odr, prev);
  }
}
