// ARMv7-M (Cortex-M3/M4/M7) core host — the in-browser counterpart of the QEMU
// backend. Where CortexM0Host borrows rp2040js's ARMv6-M core (no Thumb-2), this
// drives the vendored unicorn.js engine (Unicorn v1.0 ARM, asm.js) which executes
// full Thumb-2 (mla/udiv/…) and runs in the browser — no native qemu process.
//
// It presents the SAME seam as CortexM0Host (loadFlash / reset / run / pc / sp)
// against the SAME STM32 memory map, and bridges the peripheral region to the
// SAME MMIOBus via Unicorn memory hooks:
//   • HOOK_MEM_WRITE  -> bus.write(addr, width, value)
//   • HOOK_MEM_READ   -> value = bus.read(addr, width); mem_write so the load sees it
//
// Limitation vs CortexM0Host: Unicorn v1.0 does not model the Cortex-M NVIC
// exception entry, so peripheral IRQs are not yet vectored here (polling-style
// firmware runs fine). See docs/unicorn-arm-core.md.

import type { MMIOBus } from "./mmio-bus";
import type { AccessWidth } from "./peripheral";
import {
  loadUnicornArm,
  ARM_REG,
  UC,
  type UnicornEngine,
  type UcModule,
} from "./unicorn/load-unicorn-arm";
import type { UnmappedAccess } from "./cortex-m0-host";

export const FLASH_BASE = 0x08000000;
export const FLASH_ALIAS_BASE = 0x00000000;
export const SRAM_BASE = 0x20000000;
// Cortex-M Private Peripheral Bus / System Control Space (SCB, SysTick, NVIC,
// DWT, …). Mapped as plain RW memory so core startup — SystemInit / the C
// runtime writing SCB->VTOR and SysTick — doesn't fault with WRITE_UNMAPPED.
// The NVIC isn't modelled here (see class note), so these registers act as
// memory; SysTick-IRQ-driven code won't tick, but polling firmware runs.
export const PPB_BASE = 0xe0000000;
export const PPB_SIZE = 0x00100000;
// Cortex-M bit-band: each word in an alias region atomically sets/clears one bit
// of a byte in the underlying region. Peripheral alias 0x42000000 ↔ 0x40000000,
// SRAM alias 0x22000000 ↔ 0x20000000. alias = aliasBase + byteOffset*32 + bit*4.
// Real STM32 HAL/CMSIS bit-bands RCC/peripheral flags, so the alias must be
// modeled or such firmware faults the instant it boots (WRITE_UNMAPPED).
export const PERIPH_BB_BASE = 0x42000000;
export const PERIPH_REGION_BASE = 0x40000000;
export const SRAM_BB_BASE = 0x22000000;

/** A contiguous peripheral window to map + bridge to the bus (4 KiB-aligned). */
export interface PeriphWindow {
  base: number;
  size: number;
}

/** Default peripheral window: APB1/APB2/AHB1 base region common to STM32 F/G/L. */
const DEFAULT_PERIPH: PeriphWindow[] = [{ base: 0x40000000, size: 0x00030000 }];

export interface UnicornArmHostOptions {
  /** Flash size in bytes (default 256 KiB). Rounded up to 4 KiB. */
  flashBytes?: number;
  /** SRAM size in bytes (default 64 KiB). Rounded up to 4 KiB. */
  sramBytes?: number;
  /** Peripheral windows to map + bridge to the bus (default one APB/AHB window). */
  periphWindows?: PeriphWindow[];
  /** Diagnostic: fired on a peripheral access no registered peripheral handles. */
  onUnmapped?: (ev: UnmappedAccess) => void;
  /** Pre-loaded unicorn.js module (required). Use UnicornArmHost.create() to load it. */
  uc: UcModule;
}

const PAGE = 0x1000;
const roundUp = (n: number, to: number) => Math.ceil(n / to) * to;

/**
 * Hosts an ARMv7-M core (unicorn.js) against the STM32 memory map, bridging the
 * peripheral region to an MMIOBus. Pure JS — runs in Node and the browser.
 */
export class UnicornArmHost {
  private readonly engine: UnicornEngine;
  private readonly flashBytes: number;
  private readonly sramBytes: number;
  private readonly periphWindows: PeriphWindow[];
  private readonly onUnmapped?: (ev: UnmappedAccess) => void;
  /** Flash image kept host-side so reset() can read the vector table. */
  private readonly flashImage: Uint8Array;
  /** Next instruction address (Thumb), tracked across run() chunks. */
  private nextPc = FLASH_BASE;
  private retired = 0;
  private spShadow = 0;

  /**
   * Async factory: loads the unicorn.js engine (code-split, ~2.3 MB) then builds
   * the host. Prefer this over `new` — it works in Node and the browser.
   */
  static async create(
    bus: MMIOBus,
    options: Omit<UnicornArmHostOptions, "uc"> = {},
  ): Promise<UnicornArmHost> {
    const uc = await loadUnicornArm();
    return new UnicornArmHost(bus, { ...options, uc });
  }

  constructor(
    private readonly bus: MMIOBus,
    options: UnicornArmHostOptions,
  ) {
    this.onUnmapped = options.onUnmapped;
    this.flashBytes = roundUp(options.flashBytes ?? 256 * 1024, PAGE);
    this.sramBytes = roundUp(options.sramBytes ?? 64 * 1024, PAGE);
    this.periphWindows = options.periphWindows ?? DEFAULT_PERIPH;
    this.flashImage = new Uint8Array(this.flashBytes).fill(0xff);

    const uc = options.uc;
    this.engine = new uc.Unicorn(UC.ARCH_ARM, UC.MODE_THUMB);

    // Map the STM32 regions into the guest address space.
    this.engine.mem_map(FLASH_BASE, this.flashBytes, UC.PROT_ALL);
    this.engine.mem_map(FLASH_ALIAS_BASE, this.flashBytes, UC.PROT_ALL); // boot alias at 0x0
    this.engine.mem_map(SRAM_BASE, this.sramBytes, UC.PROT_ALL);
    this.engine.mem_map(PPB_BASE, PPB_SIZE, UC.PROT_ALL); // SCB/SysTick/NVIC as memory
    for (const w of this.periphWindows) {
      this.engine.mem_map(w.base, roundUp(w.size, PAGE), UC.PROT_ALL);
      this.installBusBridge(w);
      // Peripheral bit-band alias covering this window (32 alias bytes per byte).
      const aliasBase = (PERIPH_BB_BASE + (w.base - PERIPH_REGION_BASE) * 32) >>> 0;
      const aliasSize = roundUp(w.size * 32, PAGE);
      this.engine.mem_map(aliasBase, aliasSize, UC.PROT_ALL);
      this.installBitBandBridge(aliasBase, aliasSize, PERIPH_BB_BASE, PERIPH_REGION_BASE, true);
    }
    // SRAM bit-band alias.
    const sramAliasSize = roundUp(this.sramBytes * 32, PAGE);
    this.engine.mem_map(SRAM_BB_BASE, sramAliasSize, UC.PROT_ALL);
    this.installBitBandBridge(SRAM_BB_BASE, sramAliasSize, SRAM_BB_BASE, SRAM_BASE, false);
  }

  /** Wire Unicorn memory hooks over a peripheral window to the MMIOBus. */
  private installBusBridge(w: PeriphWindow): void {
    const end = w.base + w.size;
    // Writes: forward to the bus.
    this.engine.hook_add(
      UC.HOOK_MEM_WRITE,
      (_h: unknown, _t: number, addrLo: number, _ah: number, size: number, valLo: number) => {
        const addr = addrLo >>> 0;
        const width = size as AccessWidth;
        const value = valLo >>> 0;
        if (this.onUnmapped && !this.bus.handles(addr)) {
          this.onUnmapped({ addr, width, write: true, value });
        }
        this.bus.write(addr, width, value);
      },
      {},
      w.base,
      end,
    );
    // Reads: compute the peripheral value and stash it in guest memory so the
    // load instruction returns it (Unicorn v1.0 read-hook substitution trick).
    this.engine.hook_add(
      UC.HOOK_MEM_READ,
      (_h: unknown, _t: number, addrLo: number, _ah: number, size: number) => {
        const addr = addrLo >>> 0;
        const width = size as AccessWidth;
        if (this.onUnmapped && !this.bus.handles(addr)) {
          this.onUnmapped({ addr, width, write: false });
        }
        const value = this.bus.read(addr, width) >>> 0;
        this.engine.mem_write(addr, leBytes(value, width));
      },
      {},
      w.base,
      end,
    );
  }

  /**
   * Bridge a bit-band alias region to its underlying region. A word access at
   * `aliasBase + byteOffset*32 + bit*4` reads/writes bit `((byteOffset&3)*8+bit)`
   * of the underlying word. Writes are word-granular read-modify-write *through
   * the bus* (when a peripheral handles that word) so register side effects —
   * e.g. RCC mirroring PLLON→PLLRDY — still run; otherwise they hit guest memory.
   */
  private installBitBandBridge(
    aliasBase: number,
    aliasLen: number,
    bbBase: number,
    targetBase: number,
    isPeriph: boolean,
  ): void {
    const aliasEnd = (aliasBase + aliasLen) >>> 0;
    const decode = (addr: number) => {
      const off = (addr - bbBase) >>> 0;
      const byteOffset = off >>> 5; // 32 alias bytes per target byte
      const targetWord = (targetBase + (byteOffset & ~3)) >>> 0;
      const bitInWord = (((byteOffset & 3) * 8 + ((off >>> 2) & 7)) & 31) >>> 0;
      return { targetWord, bitInWord };
    };
    const readWord = (target: number) =>
      isPeriph && this.bus.handles(target)
        ? this.bus.read(target, 4) >>> 0
        : this.readGuestWord(target);
    const writeWord = (target: number, value: number) => {
      if (isPeriph && this.bus.handles(target)) this.bus.write(target, 4, value >>> 0);
      else this.engine.mem_write(target, leBytes(value >>> 0, 4));
    };

    this.engine.hook_add(
      UC.HOOK_MEM_WRITE,
      (_h: unknown, _t: number, addrLo: number, _ah: number, _size: number, valLo: number) => {
        const { targetWord, bitInWord } = decode(addrLo >>> 0);
        const word = readWord(targetWord);
        const next = valLo & 1 ? word | (1 << bitInWord) : word & ~(1 << bitInWord);
        writeWord(targetWord, next >>> 0);
      },
      {},
      aliasBase,
      aliasEnd,
    );
    this.engine.hook_add(
      UC.HOOK_MEM_READ,
      (_h: unknown, _t: number, addrLo: number, _ah: number, size: number) => {
        const addr = addrLo >>> 0;
        const { targetWord, bitInWord } = decode(addr);
        const bit = (readWord(targetWord) >>> bitInWord) & 1;
        this.engine.mem_write(addr, leBytes(bit, size as AccessWidth));
      },
      {},
      aliasBase,
      aliasEnd,
    );
  }

  /** Read a little-endian 32-bit word from guest memory. */
  private readGuestWord(addr: number): number {
    const b = this.engine.mem_read(addr >>> 0, 4);
    return ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0) as number;
  }

  /** Load a raw flash image (offset 0 = 0x08000000). Mirrored into the boot alias. */
  loadFlash(image: Uint8Array): void {
    this.flashImage.fill(0xff);
    this.flashImage.set(image.subarray(0, this.flashBytes));
    const bytes = [...this.flashImage];
    this.engine.mem_write(FLASH_BASE, bytes);
    this.engine.mem_write(FLASH_ALIAS_BASE, bytes);
  }

  /** Reset: load SP/PC from the Cortex-M vector table (SP @ 0, reset @ 4). */
  reset(): void {
    this.bus.reset();
    const sp = readLE32(this.flashImage, 0) >>> 0;
    const pc = readLE32(this.flashImage, 4) >>> 0;
    this.spShadow = sp;
    this.nextPc = pc & ~1; // strip the Thumb bit for PC; mode is already THUMB
    this.engine.reg_write_i32(ARM_REG.SP, sp | 0);
    this.engine.reg_write_i32(ARM_REG.PC, this.nextPc | 0);
    this.retired = 0;
  }

  get cycles(): number {
    return this.retired; // 1 instruction ≈ 1 "cycle" for this backend
  }
  get pc(): number {
    return this.nextPc >>> 0;
  }
  get sp(): number {
    return this.engine.reg_read_i32(ARM_REG.SP) >>> 0 || this.spShadow >>> 0;
  }

  /** Read a core register by ARM_REG id (e.g. ARM_REG.R3). */
  readReg(regid: number): number {
    return this.engine.reg_read_i32(regid) >>> 0;
  }

  /** Read `len` bytes of guest memory (e.g. SRAM) for assertions. */
  readMem(addr: number, len: number): Uint8Array {
    return this.engine.mem_read(addr >>> 0, len);
  }

  /** Execute exactly one instruction. */
  step(): void {
    this.run(1);
  }

  /** Batched execution (McuCoreHost): unicorn runs the whole chunk in one go. */
  runBatch(n: number): void {
    this.run(n);
  }

  /** Execute up to `count` instructions, then return (resumable). */
  run(count: number): void {
    if (count <= 0) return;
    // emu_start runs `count` instructions from the current Thumb PC, then halts.
    this.engine.emu_start((this.nextPc >>> 0) | 1, 0, 0, count);
    this.nextPc = this.engine.reg_read_i32(ARM_REG.PC) >>> 0;
    this.retired += count;
    // Advance peripheral time (approx 1 cycle/instruction).
    this.bus.tick(count);
  }

  /** Stop a running emulation (e.g. from a hook). */
  stop(): void {
    this.engine.emu_stop();
  }

  /** Release the underlying engine. */
  close(): void {
    this.engine.close();
  }
}

/** Little-endian bytes of `value` at the given access width. */
function leBytes(value: number, width: AccessWidth): number[] {
  const out: number[] = [];
  for (let i = 0; i < width; i++) out.push((value >>> (i * 8)) & 0xff);
  return out;
}

function readLE32(buf: Uint8Array, off: number): number {
  return (
    (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0
  );
}
