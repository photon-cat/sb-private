import { MemoryBus } from "../memory/memory-bus.js";

/** ARM condition codes (ARMv7-M A7.3). */
export const Cond = {
  EQ: 0,  NE: 1,  CS: 2,  CC: 3,
  MI: 4,  PL: 5,  VS: 6,  VC: 7,
  HI: 8,  LS: 9,  GE: 10, LT: 11,
  GT: 12, LE: 13, AL: 14, NV: 15,
} as const;

/** Register indices. */
export const R_SP = 13;
export const R_LR = 14;
export const R_PC = 15;

/** APSR / xPSR flag bit positions. */
export const APSR_N = 1 << 31;
export const APSR_Z = 1 << 30;
export const APSR_C = 1 << 29;
export const APSR_V = 1 << 28;

/**
 * ARMv7-M (Cortex-M3) CPU state.
 *
 * Only the architectural state needed by current instruction handlers is
 * modeled. MPU, FPU, and privilege separation are out of scope.
 */
export class CortexM3 {
  readonly regs = new Uint32Array(16);
  /** Application Program Status Register (flags). */
  apsr = 0;
  /** IT-block state (itState is the base ITSTATE field, 0 when outside IT). */
  itState = 0;
  /** Cycle counter. */
  cycles = 0;
  /** Set to true by BKPT, fault, or WFI; runner should stop stepping. */
  halted = false;

  constructor(readonly memory: MemoryBus) {}

  /**
   * Reset the CPU per ARMv7-M B1.5.5 "Reset behavior":
   *   - SP = word at address 0x00000000 (vector table[0])
   *   - PC = word at address 0x00000004 (vector table[1]) with thumb bit cleared
   *   - LR = 0xFFFFFFFF
   *
   * The vector table lives at the start of flash, which the bus aliases to
   * 0x00000000 after reset.
   */
  reset(): void {
    this.regs.fill(0);
    this.regs[R_SP] = this.memory.read32(0x0000_0000);
    this.regs[R_LR] = 0xffff_ffff >>> 0;
    // Reset vector has the thumb bit set; clear it before writing PC.
    this.regs[R_PC] = this.memory.read32(0x0000_0004) & ~1;
    this.apsr = 0;
    this.itState = 0;
    this.cycles = 0;
    this.halted = false;
  }

  get pc(): number { return this.regs[R_PC] >>> 0; }
  set pc(v: number) { this.regs[R_PC] = v >>> 0; }
  get sp(): number { return this.regs[R_SP] >>> 0; }
  set sp(v: number) { this.regs[R_SP] = v >>> 0; }
  get lr(): number { return this.regs[R_LR] >>> 0; }
  set lr(v: number) { this.regs[R_LR] = v >>> 0; }

  setFlagsNZ(result: number): void {
    const r = result >>> 0;
    this.apsr = (this.apsr & ~(APSR_N | APSR_Z)) >>> 0;
    if (r === 0) this.apsr = (this.apsr | APSR_Z) >>> 0;
    if (r & 0x8000_0000) this.apsr = (this.apsr | APSR_N) >>> 0;
  }

  setFlagsNZCV(result: number, carry: boolean, overflow: boolean): void {
    this.setFlagsNZ(result);
    this.apsr = (this.apsr & ~(APSR_C | APSR_V)) >>> 0;
    if (carry)    this.apsr = (this.apsr | APSR_C) >>> 0;
    if (overflow) this.apsr = (this.apsr | APSR_V) >>> 0;
  }

  /** Evaluate an ARM condition code against current APSR. */
  condPasses(cond: number): boolean {
    const n = (this.apsr & APSR_N) !== 0;
    const z = (this.apsr & APSR_Z) !== 0;
    const c = (this.apsr & APSR_C) !== 0;
    const v = (this.apsr & APSR_V) !== 0;
    switch (cond & 0xe) {
      case 0x0: return cond & 1 ? !z : z;                    // EQ / NE
      case 0x2: return cond & 1 ? !c : c;                    // CS / CC
      case 0x4: return cond & 1 ? !n : n;                    // MI / PL
      case 0x6: return cond & 1 ? !v : v;                    // VS / VC
      case 0x8: return cond & 1 ? !(c && !z) : (c && !z);    // HI / LS
      case 0xa: return cond & 1 ? n !== v : n === v;         // GE / LT
      case 0xc: return cond & 1 ? !(!z && n === v) : (!z && n === v); // GT / LE
      case 0xe: return true;                                  // AL (NV is unpredictable)
      default:  return true;
    }
  }
}
