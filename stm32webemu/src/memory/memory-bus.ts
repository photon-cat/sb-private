import {
  FLASH_BASE,
  FLASH_ALIAS_BASE,
  FLASH_SIZE,
  SRAM_BASE,
  SRAM_SIZE,
} from "./regions.js";

/** Handler for a memory-mapped I/O region. */
export interface MmioHandler {
  base: number;
  size: number;
  read32: (offset: number) => number;
  write32: (offset: number, value: number) => void;
  read16?: (offset: number) => number;
  write16?: (offset: number, value: number) => void;
  read8?: (offset: number) => number;
  write8?: (offset: number, value: number) => void;
}

/**
 * Memory bus for STM32F103. Services flash (read-only), SRAM (read/write),
 * and an arbitrary set of MMIO regions registered via {@link addMmio}.
 *
 * All addresses are treated as unsigned 32-bit. Unmapped accesses return 0 on
 * read and are silently ignored on write — this is deliberately permissive so
 * partially-decoded firmware can make forward progress; a future revision
 * should add a BusFault hook once more peripherals are in place.
 */
export class MemoryBus {
  readonly flash: Uint8Array;
  readonly sram: Uint8Array;
  private readonly mmio: MmioHandler[] = [];

  constructor() {
    this.flash = new Uint8Array(FLASH_SIZE);
    this.sram = new Uint8Array(SRAM_SIZE);
  }

  /** Register an MMIO region. Overlapping regions are not validated. */
  addMmio(handler: MmioHandler): void {
    this.mmio.push(handler);
  }

  /** Load a firmware .bin image into flash (offset 0 = FLASH_BASE). */
  loadFlash(image: Uint8Array, offset = 0): void {
    if (offset + image.length > this.flash.length) {
      throw new Error(
        `firmware image too large: ${image.length} bytes at offset 0x${offset.toString(16)} exceeds ${FLASH_SIZE} byte flash`,
      );
    }
    this.flash.set(image, offset);
  }

  private resolveFlashOffset(addr: number): number | null {
    const a = addr >>> 0;
    if (a >= FLASH_BASE && a < FLASH_BASE + FLASH_SIZE) return a - FLASH_BASE;
    if (a >= FLASH_ALIAS_BASE && a < FLASH_ALIAS_BASE + FLASH_SIZE) return a - FLASH_ALIAS_BASE;
    return null;
  }

  private resolveSramOffset(addr: number): number | null {
    const a = addr >>> 0;
    if (a >= SRAM_BASE && a < SRAM_BASE + SRAM_SIZE) return a - SRAM_BASE;
    return null;
  }

  private findMmio(addr: number): { handler: MmioHandler; offset: number } | null {
    const a = addr >>> 0;
    for (const h of this.mmio) {
      if (a >= h.base && a < h.base + h.size) {
        return { handler: h, offset: a - h.base };
      }
    }
    return null;
  }

  read32(addr: number): number {
    const flashOff = this.resolveFlashOffset(addr);
    if (flashOff !== null) {
      return (
        (this.flash[flashOff] |
          (this.flash[flashOff + 1] << 8) |
          (this.flash[flashOff + 2] << 16) |
          (this.flash[flashOff + 3] << 24)) >>> 0
      );
    }
    const sramOff = this.resolveSramOffset(addr);
    if (sramOff !== null) {
      return (
        (this.sram[sramOff] |
          (this.sram[sramOff + 1] << 8) |
          (this.sram[sramOff + 2] << 16) |
          (this.sram[sramOff + 3] << 24)) >>> 0
      );
    }
    const m = this.findMmio(addr);
    if (m) return m.handler.read32(m.offset) >>> 0;
    return 0;
  }

  write32(addr: number, value: number): void {
    const v = value >>> 0;
    const sramOff = this.resolveSramOffset(addr);
    if (sramOff !== null) {
      this.sram[sramOff] = v & 0xff;
      this.sram[sramOff + 1] = (v >>> 8) & 0xff;
      this.sram[sramOff + 2] = (v >>> 16) & 0xff;
      this.sram[sramOff + 3] = (v >>> 24) & 0xff;
      return;
    }
    const m = this.findMmio(addr);
    if (m) m.handler.write32(m.offset, v);
    // Writes to flash are silently ignored (would need flash-controller unlock).
  }

  read16(addr: number): number {
    const flashOff = this.resolveFlashOffset(addr);
    if (flashOff !== null) {
      return (this.flash[flashOff] | (this.flash[flashOff + 1] << 8)) & 0xffff;
    }
    const sramOff = this.resolveSramOffset(addr);
    if (sramOff !== null) {
      return (this.sram[sramOff] | (this.sram[sramOff + 1] << 8)) & 0xffff;
    }
    const m = this.findMmio(addr);
    if (m) {
      if (m.handler.read16) return m.handler.read16(m.offset) & 0xffff;
      return m.handler.read32(m.offset & ~3) & 0xffff;
    }
    return 0;
  }

  write16(addr: number, value: number): void {
    const v = value & 0xffff;
    const sramOff = this.resolveSramOffset(addr);
    if (sramOff !== null) {
      this.sram[sramOff] = v & 0xff;
      this.sram[sramOff + 1] = (v >>> 8) & 0xff;
      return;
    }
    const m = this.findMmio(addr);
    if (m) {
      if (m.handler.write16) m.handler.write16(m.offset, v);
      else m.handler.write32(m.offset & ~3, v);
    }
  }

  read8(addr: number): number {
    const flashOff = this.resolveFlashOffset(addr);
    if (flashOff !== null) return this.flash[flashOff];
    const sramOff = this.resolveSramOffset(addr);
    if (sramOff !== null) return this.sram[sramOff];
    const m = this.findMmio(addr);
    if (m) {
      if (m.handler.read8) return m.handler.read8(m.offset) & 0xff;
      return m.handler.read32(m.offset & ~3) & 0xff;
    }
    return 0;
  }

  write8(addr: number, value: number): void {
    const v = value & 0xff;
    const sramOff = this.resolveSramOffset(addr);
    if (sramOff !== null) {
      this.sram[sramOff] = v;
      return;
    }
    const m = this.findMmio(addr);
    if (m) {
      if (m.handler.write8) m.handler.write8(m.offset, v);
      else m.handler.write32(m.offset & ~3, v);
    }
  }
}
