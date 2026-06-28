import type { MmioHandler } from "../memory/memory-bus.js";

/**
 * Cortex-M3 SysTick timer (ARMv7-M B3.3).
 *
 * Register map (at 0xE000_E010):
 *   0x00 CTRL  — ENABLE (bit 0), TICKINT (bit 1), CLKSOURCE (bit 2), COUNTFLAG (bit 16)
 *   0x04 LOAD  — reload value (24-bit)
 *   0x08 VAL   — current value (write clears to 0)
 *   0x0C CALIB — calibration (read-only hint)
 *
 * The runner should call {@link tick} once per executed CPU cycle so the
 * counter decrements in lockstep with emulated time.
 */
export class Stm32SysTick implements MmioHandler {
  readonly base = 0xe000_e010;
  readonly size = 0x10;

  ctrl = 0;
  load = 0;
  val = 0;
  calib = 0x000a_4000; // placeholder TENMS value
  /** Set to true when countflag latches; cleared on CTRL read. */
  private countFlag = false;
  /** Set by write side-effects so the runner can signal the NVIC. */
  pendingIrq = false;

  read32(offset: number): number {
    switch (offset) {
      case 0x00: {
        const cf = this.countFlag ? 1 << 16 : 0;
        const v = (this.ctrl | cf) >>> 0;
        this.countFlag = false;
        return v;
      }
      case 0x04: return this.load >>> 0;
      case 0x08: return this.val >>> 0;
      case 0x0c: return this.calib >>> 0;
      default:   return 0;
    }
  }

  write32(offset: number, value: number): void {
    switch (offset) {
      case 0x00: this.ctrl = value & 0x7; return;
      case 0x04: this.load = value & 0x00ff_ffff; return;
      case 0x08: this.val = 0; this.countFlag = false; return;
    }
  }

  /** Advance SysTick by `cycles` ticks; reloads and raises flag on wrap. */
  tick(cycles: number): void {
    if ((this.ctrl & 1) === 0) return;
    let remaining = cycles;
    while (remaining > 0) {
      if (this.val === 0) {
        this.val = this.load;
        this.countFlag = true;
        if ((this.ctrl & 2) !== 0) this.pendingIrq = true;
      } else if (this.val <= remaining) {
        remaining -= this.val;
        this.val = 0;
        continue;
      } else {
        this.val = (this.val - remaining) >>> 0;
        remaining = 0;
      }
      if (remaining > 0) remaining -= 1;
    }
  }
}
