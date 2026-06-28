// Cortex-M NVIC (Nested Vectored Interrupt Controller), minimal model.
//
// Registers live in the System Control Space at 0xE000E100. We model the
// enable/pending bitsets and expose the highest-priority pending+enabled IRQ so
// a CPU core can vector to it. Priorities are simplified to lowest-IRQ-first
// (sufficient until per-IRQ priority handling is needed).

import { type AccessWidth, type Peripheral } from "../peripheral";

const NVIC_BASE = 0xe000e100;
const NVIC_SIZE = 0x400;

const ISER = 0x000; // set-enable    (0x000–0x01F: 8 words → 256 IRQs)
const ICER = 0x080; // clear-enable
const ISPR = 0x100; // set-pending
const ICPR = 0x180; // clear-pending

const WORDS = 8; // 256 IRQ lines

export class CortexMNvic implements Peripheral {
  readonly name = "NVIC";
  readonly base = NVIC_BASE;
  readonly size = NVIC_SIZE;

  private enable = new Uint32Array(WORDS);
  private pending = new Uint32Array(WORDS);

  read(offset: number, _width: AccessWidth): number {
    if (offset >= ISER && offset < ISER + WORDS * 4) return this.enable[(offset - ISER) >> 2];
    if (offset >= ICER && offset < ICER + WORDS * 4) return this.enable[(offset - ICER) >> 2];
    if (offset >= ISPR && offset < ISPR + WORDS * 4) return this.pending[(offset - ISPR) >> 2];
    if (offset >= ICPR && offset < ICPR + WORDS * 4) return this.pending[(offset - ICPR) >> 2];
    return 0;
  }

  write(offset: number, _width: AccessWidth, value: number): void {
    const v = value >>> 0;
    if (offset >= ISER && offset < ISER + WORDS * 4) this.enable[(offset - ISER) >> 2] |= v;
    else if (offset >= ICER && offset < ICER + WORDS * 4) this.enable[(offset - ICER) >> 2] &= ~v;
    else if (offset >= ISPR && offset < ISPR + WORDS * 4) this.pending[(offset - ISPR) >> 2] |= v;
    else if (offset >= ICPR && offset < ICPR + WORDS * 4) this.pending[(offset - ICPR) >> 2] &= ~v;
  }

  /** Latch an IRQ as pending (called from peripherals via the bus). */
  setPending(irq: number): void {
    if (irq < 0 || irq >= WORDS * 32) return;
    this.pending[irq >> 5] |= 1 << (irq & 31);
  }

  isEnabled(irq: number): boolean {
    return ((this.enable[irq >> 5] >> (irq & 31)) & 1) === 1;
  }

  isPending(irq: number): boolean {
    return ((this.pending[irq >> 5] >> (irq & 31)) & 1) === 1;
  }

  /** Lowest-numbered enabled+pending IRQ a core should take, or null. */
  nextPending(): number | null {
    for (let w = 0; w < WORDS; w++) {
      const live = this.enable[w] & this.pending[w];
      if (live) return w * 32 + (31 - Math.clz32(live & -live));
    }
    return null;
  }

  /** Acknowledge entry to an IRQ handler (clear its pending bit). */
  acknowledge(irq: number): void {
    this.pending[irq >> 5] &= ~(1 << (irq & 31));
  }

  reset(): void {
    this.enable.fill(0);
    this.pending.fill(0);
  }
}
