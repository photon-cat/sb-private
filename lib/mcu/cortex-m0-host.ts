// Cortex-M0/M0+ core host for the SVD-driven peripheral framework.
//
// The ARM Cortex-M0+ core, its NVIC, SysTick, and SCB are *the same silicon* on
// an STM32 C0/G0/L0 as on the RP2040 — they are ARM IP, not ST IP. rp2040js
// already implements that core (CortexM0Core) plus the PPB block (RPPPB: NVIC +
// SysTick + SCB + VTOR), validated against real Pico firmware. So instead of
// hand-writing a Thumb decoder + NVIC (the trap the architecture plan warns
// about), we *borrow* rp2040js's core and only swap the memory bus.
//
// rp2040js gates deep imports behind its package `exports` map, so we cannot
// import CortexM0Core directly. We instead instantiate a full RP2040 purely to
// obtain a wired core + ppb + clock, then override its load/store methods to an
// STM32 memory map: flash, SRAM, the Cortex PPB (delegated to rp2040.ppb), and
// the peripheral region routed to our Phase-2 MMIOBus. The RP2040's own
// peripherals (UART/PIO/SIO/USB) are simply never addressed by STM32 firmware.

import { RP2040 } from "rp2040js";
import type { MMIOBus } from "./mmio-bus";
import type { AccessWidth } from "./peripheral";

/** STM32 memory map regions (Cortex-M common + ST layout). */
export const FLASH_BASE = 0x08000000;
export const FLASH_ALIAS_BASE = 0x00000000; // flash aliased here when BOOT0=0
export const SRAM_BASE = 0x20000000;
export const PERIPH_BASE = 0x40000000;
export const PERIPH_END = 0x60000000; // APB1/APB2/AHB peripheral space
/** Cortex-M System Control Space (NVIC/SysTick/SCB) lives at 0xE000Exxx. */
const PPB_PAGE = 0xe000e;

/** A load/store to a peripheral-region address not served by any bus peripheral. */
export interface UnmappedAccess {
  addr: number;
  width: AccessWidth;
  write: boolean;
  value?: number;
}

export interface CortexM0HostOptions {
  /** Flash size in bytes (default 256 KiB — typical STM32G0). */
  flashBytes?: number;
  /** SRAM size in bytes (default 36 KiB — STM32G071). */
  sramBytes?: number;
  /**
   * Diagnostic hook fired when firmware accesses a peripheral-region address no
   * registered peripheral handles — the signal for "what's unmodeled". Used by
   * the stress harness; has no effect on execution (unmapped reads still 0).
   */
  onUnmapped?: (ev: UnmappedAccess) => void;
}

/** Minimal view of the rp2040js core the host drives. */
interface CoreLike {
  PC: number;
  SP: number;
  cycles: number;
  waiting: boolean;
  reset(): void;
  executeInstruction(): number;
  setInterrupt(irq: number, value: boolean): void;
}

/** Minimal view of the rp2040js SimulationClock. */
interface ClockLike {
  readonly nanos: number;
  readonly nanosToNextAlarm: number;
  tick(deltaNanos: number): void;
}

/**
 * Hosts an ARM Cortex-M0+ core (borrowed from rp2040js) against an STM32 memory
 * map whose peripheral region is served by an MMIOBus. Drives interrupt lines
 * from the bus into the core's real NVIC.
 */
export class CortexM0Host {
  readonly flash: Uint8Array;
  readonly sram: Uint8Array;
  private readonly flashView: DataView;
  private readonly sramView: DataView;
  private readonly rp2040: RP2040;
  private readonly core: CoreLike;
  private readonly clock: ClockLike;
  /** Nanoseconds per CPU cycle, matching the SysTick timer's base frequency. */
  private readonly cycleNanos: number;
  /** IRQ numbers currently asserted into the NVIC (for edge/level sync). */
  private readonly asserted = new Set<number>();
  private readonly onUnmapped?: (ev: UnmappedAccess) => void;

  constructor(
    private readonly bus: MMIOBus,
    options: CortexM0HostOptions = {},
  ) {
    this.onUnmapped = options.onUnmapped;
    const flashBytes = options.flashBytes ?? 256 * 1024;
    const sramBytes = options.sramBytes ?? 36 * 1024;
    this.flash = new Uint8Array(flashBytes);
    this.flashView = new DataView(this.flash.buffer);
    this.sram = new Uint8Array(sramBytes);
    this.sramView = new DataView(this.sram.buffer);

    // Borrow a fully-wired Cortex-M0+ core + PPB (NVIC/SysTick/SCB) + clock.
    this.rp2040 = new RP2040();
    this.core = this.rp2040.core as unknown as CoreLike;
    const rp = this.rp2040 as unknown as { clock: ClockLike; clkSys: number };
    this.clock = rp.clock;
    // SysTick's Timer32 was built with rp2040.clkSys as its base frequency, so
    // advancing the clock by this per cycle makes SysTick fire after `reload`
    // cycles regardless of the nominal STM32 clock — the HAL timebase ticks.
    this.cycleNanos = 1e9 / rp.clkSys;

    this.installBus();
  }

  /** Replace the RP2040's load/store path with the STM32 memory map. */
  private installBus(): void {
    const rp = this.rp2040 as unknown as {
      readUint32(a: number): number;
      readUint16(a: number): number;
      readUint8(a: number): number;
      writeUint32(a: number, v: number): void;
      writeUint16(a: number, v: number): void;
      writeUint8(a: number, v: number): void;
      ppb: { readUint32(o: number): number; writeUint32(o: number, v: number): void };
    };
    const ppb = rp.ppb;

    rp.readUint32 = (addr) => this.read(addr >>> 0, 4, ppb);
    rp.readUint16 = (addr) => this.read(addr >>> 0, 2, ppb);
    rp.readUint8 = (addr) => this.read(addr >>> 0, 1, ppb);
    rp.writeUint32 = (addr, v) => this.write(addr >>> 0, 4, v >>> 0, ppb);
    rp.writeUint16 = (addr, v) => this.write(addr >>> 0, 2, v >>> 0, ppb);
    rp.writeUint8 = (addr, v) => this.write(addr >>> 0, 1, v >>> 0, ppb);
  }

  private read(
    addr: number,
    width: AccessWidth,
    ppb: { readUint32(o: number): number },
  ): number {
    // Flash (and its boot alias at 0x0).
    const flashOff = this.flashOffset(addr);
    if (flashOff >= 0 && flashOff + width <= this.flash.length) {
      return readView(this.flashView, flashOff, width);
    }
    // SRAM.
    if (addr >= SRAM_BASE && addr + width <= SRAM_BASE + this.sram.length) {
      return readView(this.sramView, addr - SRAM_BASE, width);
    }
    // Cortex PPB: NVIC / SysTick / SCB / VTOR (word registers).
    if (addr >>> 12 === PPB_PAGE) {
      // Page check already constrains addr to 0xE000Exxx; word-align the offset.
      const word = ppb.readUint32(addr & 0xffc) >>> 0;
      return extractByteLane(word, addr, width);
    }
    // Peripheral region → MMIO bus.
    if (addr >= PERIPH_BASE && addr < PERIPH_END) {
      if (this.onUnmapped && !this.bus.handles(addr)) {
        this.onUnmapped({ addr, width, write: false });
      }
      return this.bus.read(addr, width);
    }
    return 0;
  }

  private write(
    addr: number,
    width: AccessWidth,
    value: number,
    ppb: { readUint32(o: number): number; writeUint32(o: number, v: number): void },
  ): void {
    const flashOff = this.flashOffset(addr);
    if (flashOff >= 0 && flashOff + width <= this.flash.length) {
      // Flash is read-only at runtime; ignore stores (matches hardware).
      return;
    }
    if (addr >= SRAM_BASE && addr + width <= SRAM_BASE + this.sram.length) {
      writeView(this.sramView, addr - SRAM_BASE, width, value);
      return;
    }
    if (addr >>> 12 === PPB_PAGE) {
      const off = addr & 0xffc; // word-aligned offset within the PPB page
      if (width === 4) {
        ppb.writeUint32(off, value >>> 0);
      } else {
        // Read-modify-write for sub-word PPB stores (uncommon).
        const cur = ppb.readUint32(off) >>> 0;
        ppb.writeUint32(off, insertByteLane(cur, addr, width, value));
      }
      return;
    }
    if (addr >= PERIPH_BASE && addr < PERIPH_END) {
      if (this.onUnmapped && !this.bus.handles(addr)) {
        this.onUnmapped({ addr, width, write: true, value });
      }
      this.bus.write(addr, width, value);
    }
  }

  /** Flash offset for an address, or -1 if not in flash (incl. boot alias). */
  private flashOffset(addr: number): number {
    if (addr >= FLASH_BASE && addr < FLASH_BASE + this.flash.length) return addr - FLASH_BASE;
    // Boot alias: flash mirrored at 0x0 (BOOT0=0). Only below FLASH_BASE, so it
    // can never shadow SRAM/peripherals even with an oversized flash.
    if (addr >= FLASH_ALIAS_BASE && addr < FLASH_ALIAS_BASE + this.flash.length && addr < FLASH_BASE) {
      return addr - FLASH_ALIAS_BASE;
    }
    return -1;
  }

  /** Load a raw flash image (offset 0 = 0x08000000). */
  loadFlash(image: Uint8Array): void {
    this.flash.fill(0xff);
    this.flash.set(image.subarray(0, this.flash.length));
  }

  /** Reset the core: reload SP/PC from the vector table at VTOR (0). */
  reset(): void {
    this.bus.reset();
    this.asserted.clear();
    this.core.reset(); // reads SP = [VTOR], PC = [VTOR+4]
  }

  get cycles(): number {
    return this.core.cycles;
  }
  get pc(): number {
    return this.core.PC;
  }
  get sp(): number {
    return this.core.SP;
  }

  /** Execute one instruction, advance the clock (SysTick/timers), sync IRQs. */
  step(): void {
    if (this.core.waiting) {
      // WFI/WFE: jump the clock to the next scheduled alarm so timers progress.
      const skip = this.clock.nanosToNextAlarm;
      this.clock.tick(skip > 0 ? skip : this.cycleNanos);
    } else {
      const cycles = this.core.executeInstruction();
      this.clock.tick(cycles * this.cycleNanos);
    }
    this.syncInterrupts();
  }

  /** Execute up to `n` instructions (McuCoreHost). Stepped so SysTick advances. */
  runBatch(n: number): void {
    for (let i = 0; i < n; i++) this.step();
  }

  /** Level-sync peripheral IRQ assertions to the NVIC (set rising, clear falling). */
  private syncInterrupts(): void {
    const pending = this.bus.pendingIRQs();
    const now = new Set(pending);
    for (const irq of pending) {
      if (!this.asserted.has(irq)) {
        this.core.setInterrupt(irq, true);
        this.asserted.add(irq);
      }
    }
    for (const irq of [...this.asserted]) {
      if (!now.has(irq)) {
        this.core.setInterrupt(irq, false);
        this.asserted.delete(irq);
      }
    }
  }
}

function readView(view: DataView, offset: number, width: AccessWidth): number {
  switch (width) {
    case 1:
      return view.getUint8(offset);
    case 2:
      return view.getUint16(offset, true);
    default:
      return view.getUint32(offset, true) >>> 0;
  }
}

function writeView(view: DataView, offset: number, width: AccessWidth, value: number): void {
  switch (width) {
    case 1:
      view.setUint8(offset, value & 0xff);
      break;
    case 2:
      view.setUint16(offset, value & 0xffff, true);
      break;
    default:
      view.setUint32(offset, value >>> 0, true);
  }
}

/** Extract the byte lane for a sub-word access from an aligned 32-bit word. */
function extractByteLane(word: number, addr: number, width: AccessWidth): number {
  if (width === 4) return word >>> 0;
  const shift = (addr & 3) * 8;
  const mask = width === 1 ? 0xff : 0xffff;
  return (word >>> shift) & mask;
}

/** Insert a sub-word value into the correct byte lane of an aligned word. */
function insertByteLane(word: number, addr: number, width: AccessWidth, value: number): number {
  const shift = (addr & 3) * 8;
  const mask = (width === 1 ? 0xff : 0xffff) << shift;
  return ((word & ~mask) | ((value << shift) & mask)) >>> 0;
}
