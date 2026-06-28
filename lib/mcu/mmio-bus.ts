// Memory-mapped I/O bus — routes CPU loads/stores to the peripheral whose
// register window contains the address, and aggregates pending interrupts.
//
// CPU-core-agnostic: any Cortex-M engine (rp2040js core, Unicorn-WASM) calls
// read/write here for addresses in the peripheral region; RAM/flash are handled
// by the core's own memory.

import type { AccessWidth, Peripheral } from "./peripheral";

export class MMIOBus {
  private readonly peripherals: Peripheral[] = [];

  /** Register a peripheral instance. Throws on overlapping windows. */
  add(p: Peripheral): void {
    for (const q of this.peripherals) {
      if (p.base < q.base + q.size && q.base < p.base + p.size) {
        throw new Error(
          `Peripheral ${p.name} [0x${p.base.toString(16)}] overlaps ${q.name} [0x${q.base.toString(16)}]`,
        );
      }
    }
    this.peripherals.push(p);
  }

  get(name: string): Peripheral | undefined {
    return this.peripherals.find((p) => p.name === name);
  }

  private find(addr: number): Peripheral | undefined {
    return this.peripherals.find((p) => addr >= p.base && addr < p.base + p.size);
  }

  /** True if the address falls in any registered peripheral window. */
  handles(addr: number): boolean {
    return this.find(addr) !== undefined;
  }

  read(addr: number, width: AccessWidth): number {
    const p = this.find(addr);
    if (!p) return 0; // unmapped reads as 0 (matches typical bus behavior)
    return p.read(addr - p.base, width) >>> 0;
  }

  write(addr: number, width: AccessWidth, value: number): void {
    const p = this.find(addr);
    if (p) p.write(addr - p.base, width, value >>> 0);
  }

  /** Advance all peripherals by `cycles` system clocks. */
  tick(cycles: number): void {
    for (const p of this.peripherals) p.tick?.(cycles);
  }

  reset(): void {
    for (const p of this.peripherals) p.reset?.();
  }

  /** Collect IRQ numbers currently asserted by any peripheral. */
  pendingIRQs(): number[] {
    const out: number[] = [];
    for (const p of this.peripherals) {
      const irq = p.pendingIRQ?.();
      if (irq != null) out.push(irq);
    }
    return out;
  }
}
