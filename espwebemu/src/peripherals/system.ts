// ESP32 System Peripheral Stubs
// Covers DPORT, RTC_CNTL, IO_MUX, and other system registers
import type { PeripheralHandler } from "../memory/memory-bus.js";

// DPORT registers (0x3FF00000)
// These control clocks, resets, memory mapping, and inter-CPU communication
export class ESP32DPORT implements PeripheralHandler {
  // Key registers
  private proBootRemap = 0;
  private appBootRemap = 0;
  private cpuPerConf = 0x00000002; // Default: 240MHz
  private proIramSplit = 0;
  private appIramSplit = 0;
  private periphClkEn = 0xffffffff; // All peripherals enabled
  private periphRst = 0;

  read32(offset: number): number {
    switch (offset) {
      case 0x00: return this.proBootRemap;
      case 0x04: return this.appBootRemap;
      case 0x3c: return this.cpuPerConf;
      case 0xc0: return this.periphClkEn;
      case 0xc4: return this.periphRst;
      // DPORT_PRO_CACHE_CTRL_REG
      case 0x40: return 0x00000010; // Cache enabled
      // DPORT_PRO_CACHE_CTRL1_REG
      case 0x44: return 0;
      // DPORT_APP_CACHE_CTRL_REG
      case 0x58: return 0x00000010;
      // DPORT_PRO_DCACHE_DBUG0 — cache debug status (CACHE_STATE at bits 7-18)
      case 0x3f0: return 1 << 7; // CACHE_STATE=1 (idle)
      // DPORT_APP_DCACHE_DBUG0
      case 0x418: return 1 << 7; // CACHE_STATE=1 (idle)
      // Various clock/reset status — return "everything enabled, nothing in reset"
      default: return 0;
    }
  }

  write32(offset: number, value: number): void {
    switch (offset) {
      case 0x00: this.proBootRemap = value; break;
      case 0x04: this.appBootRemap = value; break;
      case 0x3c: this.cpuPerConf = value; break;
      case 0xc0: this.periphClkEn = value; break;
      case 0xc4: this.periphRst = value; break;
      // Cache control writes — accept but ignore
      default: break;
    }
  }
}

// RTC_CNTL registers (0x3FF48000)
export class ESP32RTC implements PeripheralHandler {
  private optionsReg = 0;
  private slpTimerVal = 0;
  private timeUpdate = 0;
  private timeLow = 0;
  private timeHigh = 0;
  private storeRegs = new Uint32Array(8); // RTC_CNTL_STORE0 through STORE7
  private resetState = 0x00000001; // Power-on reset
  private wdtConfig0 = 0;
  private wdtFeed = 0;
  private wdtProtect = 0x50d83aa1;
  private swdConf = 0;
  // RTC_CNTL_SWD_WPROTECT_REG (0xB0) also used by ESP-IDF as RTC_XTAL_FREQ_REG
  // Bootloader stores XTAL frequency here: both 16-bit halves = same value
  // For 40MHz: 0x28 in both halves → freq = (0x28 >> 1) * 2 = 40
  private swdProtect = 0x00280028;

  read32(offset: number): number {
    switch (offset) {
      case 0x00: return this.optionsReg;
      case 0x04: return this.slpTimerVal;
      case 0x08: return this.timeUpdate;
      case 0x0c: return this.timeLow | (1 << 30); // Bit 30 = time valid
      case 0x10: return this.timeHigh;
      case 0x38: return this.resetState;
      // RTC_CNTL_STORE0-7 at offsets 0x4c-0x68
      case 0x4c: case 0x50: case 0x54: case 0x58:
      case 0x5c: case 0x60: case 0x64: case 0x68:
        return this.storeRegs[(offset - 0x4c) >> 2];
      case 0x8c: return this.wdtConfig0;
      case 0xa4: return this.wdtProtect;
      case 0xac: return this.swdConf;
      case 0xb0: return this.swdProtect;
      default: return 0;
    }
  }

  write32(offset: number, value: number): void {
    switch (offset) {
      case 0x00: this.optionsReg = value; break;
      case 0x04: this.slpTimerVal = value; break;
      case 0x08:
        this.timeUpdate = value;
        // Trigger time latch — increment RTC time to simulate passage of time
        this.timeLow += 1000; // Advance by ~1000 RTC slow clock ticks
        if (this.timeLow > 0x3fffffff) { // Wrap at 30 bits (bit 30 is "valid" flag)
          this.timeLow = 0;
          this.timeHigh++;
        }
        break;
      case 0x4c: case 0x50: case 0x54: case 0x58:
      case 0x5c: case 0x60: case 0x64: case 0x68:
        this.storeRegs[(offset - 0x4c) >> 2] = value;
        break;
      case 0x8c:
        if (this.wdtProtect === 0) this.wdtConfig0 = value;
        break;
      case 0x98: // WDT feed
        break;
      case 0xa4: this.wdtProtect = value; break;
      case 0xac:
        if (this.swdProtect === 0) this.swdConf = value;
        break;
      case 0xb0: this.swdProtect = value; break;
      default: break;
    }
  }
}

// IO_MUX registers (0x3FF49000)
// Controls pin function selection (GPIO matrix input)
export class ESP32IOMUX implements PeripheralHandler {
  // 40 pins × 4 bytes, plus some config regs
  private readonly pinRegs = new Uint32Array(64);

  constructor() {
    // Set default pin functions (GPIO mode = function 2 typically)
    for (let i = 0; i < 40; i++) {
      this.pinRegs[i] = 0x00001800; // Default: input enabled, no pull-up/pull-down
    }
  }

  read32(offset: number): number {
    const idx = offset >> 2;
    if (idx < this.pinRegs.length) return this.pinRegs[idx];
    return 0;
  }

  write32(offset: number, value: number): void {
    const idx = offset >> 2;
    if (idx < this.pinRegs.length) this.pinRegs[idx] = value;
  }
}
