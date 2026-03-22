// ESP32 CPU — Xtensa LX6 core
import { MemoryBus } from "../memory/memory-bus.js";

// Special Register indices
export const SR_LBEG = 0;
export const SR_LEND = 1;
export const SR_LCOUNT = 2;
export const SR_SAR = 3; // Shift Amount Register
export const SR_BR = 4; // Boolean Register (16-bit)
export const SR_LITBASE = 5;
export const SR_SCOMPARE1 = 12;
export const SR_ACCLO = 16;
export const SR_ACCHI = 17;
export const SR_WINDOWBASE = 72;
export const SR_WINDOWSTART = 73;
export const SR_IBREAKENABLE = 96;
export const SR_IBREAKA0 = 128;
export const SR_IBREAKA1 = 129;
export const SR_DBREAKA0 = 144;
export const SR_DBREAKA1 = 145;
export const SR_DBREAKC0 = 160;
export const SR_DBREAKC1 = 161;
export const SR_EPC1 = 177;
export const SR_EPC2 = 178;
export const SR_EPC3 = 179;
export const SR_EPC4 = 180;
export const SR_EPC5 = 181;
export const SR_EPC6 = 182;
export const SR_EPC7 = 183;
export const SR_DEPC = 192;
export const SR_EPS2 = 194;
export const SR_EPS3 = 195;
export const SR_EPS4 = 196;
export const SR_EPS5 = 197;
export const SR_EPS6 = 198;
export const SR_EPS7 = 199;
export const SR_EXCSAVE1 = 209;
export const SR_EXCSAVE2 = 210;
export const SR_EXCSAVE3 = 211;
export const SR_EXCSAVE4 = 212;
export const SR_EXCSAVE5 = 213;
export const SR_EXCSAVE6 = 214;
export const SR_EXCSAVE7 = 215;
export const SR_CPENABLE = 224;
export const SR_INTERRUPT = 226;
export const SR_INTSET = 226;
export const SR_INTCLEAR = 227;
export const SR_INTENABLE = 228;
export const SR_PS = 230; // Processor State
export const SR_VECBASE = 231;
export const SR_EXCCAUSE = 232;
export const SR_DEBUGCAUSE = 233;
export const SR_CCOUNT = 234; // Cycle count
export const SR_PRID = 235; // Processor ID
export const SR_ICOUNT = 236;
export const SR_ICOUNTLEVEL = 237;
export const SR_EXCVADDR = 238;
export const SR_CCOMPARE0 = 240;
export const SR_CCOMPARE1 = 241;
export const SR_CCOMPARE2 = 242;

// PS register fields
export const PS_INTLEVEL_MASK = 0xf;
export const PS_EXCM = 1 << 4;
export const PS_UM = 1 << 5;
export const PS_RING_SHIFT = 6;
export const PS_RING_MASK = 0x3 << PS_RING_SHIFT;
export const PS_OWB_SHIFT = 8;
export const PS_OWB_MASK = 0xf << PS_OWB_SHIFT;
export const PS_CALLINC_SHIFT = 16;
export const PS_CALLINC_MASK = 0x3 << PS_CALLINC_SHIFT;
export const PS_WOE = 1 << 18;

// Exception causes
export const EXCCAUSE_ILLEGAL = 0;
export const EXCCAUSE_SYSCALL = 1;
export const EXCCAUSE_INSTR_ERROR = 2;
export const EXCCAUSE_LOAD_STORE_ERROR = 3;
export const EXCCAUSE_LEVEL1_INTERRUPT = 4;
export const EXCCAUSE_ALLOCA = 5;
export const EXCCAUSE_DIVIDE_BY_ZERO = 6;
export const EXCCAUSE_WINDOW_OVERFLOW4 = 9;
export const EXCCAUSE_WINDOW_OVERFLOW8 = 10;
export const EXCCAUSE_WINDOW_OVERFLOW12 = 11;
export const EXCCAUSE_WINDOW_UNDERFLOW4 = 13;
export const EXCCAUSE_WINDOW_UNDERFLOW8 = 14;
export const EXCCAUSE_WINDOW_UNDERFLOW12 = 15;

export class ESP32CPU {
  // Xtensa LX6 has 64 physical address registers (AR0-AR63)
  // Windowed via WindowBase — a logical a0–a15 maps to physical[WindowBase*4 .. WindowBase*4+15]
  readonly physicalRegisters = new Int32Array(64);

  // Special registers (indexed by SR number, sparse — 256 slots)
  readonly specialRegisters = new Int32Array(256);

  // User registers (indexed by UR number, sparse — 256 slots)
  readonly userRegisters = new Int32Array(256);

  // Program counter
  pc: number = 0;

  // Cycle counter
  cycles: number = 0;

  // Memory bus
  readonly memory: MemoryBus;

  // Halted flag (e.g., on WAITI or unhandled exception)
  halted = false;

  // Callback for unhandled exceptions
  onException?: (cause: number, vaddr: number) => void;

  // Callback for BREAK instruction (debugger)
  onBreak?: (s: number, t: number) => void;

  // Callback for SYSCALL
  onSyscall?: () => void;

  constructor(memory: MemoryBus) {
    this.memory = memory;

    // Initial state
    this.specialRegisters[SR_PS] = PS_WOE | (1 & PS_INTLEVEL_MASK); // WOE enabled, intlevel=1
    this.specialRegisters[SR_WINDOWBASE] = 0;
    this.specialRegisters[SR_WINDOWSTART] = 1; // Frame 0 valid
    this.specialRegisters[SR_VECBASE] = 0x40000000; // Default vectors in ROM
    this.specialRegisters[SR_PRID] = 0xcdcd; // ESP32 PRO CPU
    this.specialRegisters[SR_CCOUNT] = 0;
  }

  // Get logical register a[n] (n = 0..15)
  getAR(n: number): number {
    const wb = this.specialRegisters[SR_WINDOWBASE] & 0xf;
    return this.physicalRegisters[((wb << 2) + n) & 63];
  }

  // Set logical register a[n]
  setAR(n: number, value: number): void {
    const wb = this.specialRegisters[SR_WINDOWBASE] & 0xf;
    this.physicalRegisters[((wb << 2) + n) & 63] = value;
  }

  // Register save buffer — used to preserve physical registers across window rotations.
  // Acts as a LIFO stack: rotateWindowUp pushes, rotateWindowDown pops.
  private readonly regSaveStack: number[] = [];

  // Rotate window for CALL (callinc = 1 for CALL4, 2 for CALL8, 3 for CALL12)
  rotateWindowUp(callinc: number): void {
    const oldWB = this.specialRegisters[SR_WINDOWBASE] & 0xf;
    const newWB = (oldWB + callinc) & 0xf;

    // Save physical registers that the new window's exclusive area will overwrite.
    // New window: physical regs [newWB*4..newWB*4+15] mod 64.
    // Shared with caller: first callinc*4 regs (caller's a8+ = callee's a0+).
    // Exclusive new: last (4-callinc)*4 regs — these might hold data from earlier frames.
    const numToSave = (4 - callinc) * 4;
    for (let i = 0; i < numToSave; i++) {
      const phys = ((newWB + callinc) * 4 + i) & 63;
      this.regSaveStack.push(this.physicalRegisters[phys]);
    }

    this.specialRegisters[SR_WINDOWBASE] = newWB;
    this.specialRegisters[SR_WINDOWSTART] |= (1 << newWB);
  }

  // Rotate window for RETW — returns false if underflow can't be resolved
  rotateWindowDown(n: number): boolean {
    const oldWB = this.specialRegisters[SR_WINDOWBASE] & 0xf;
    const targetWB = (oldWB - n + 16) & 0xf;

    // Restore physical registers that were saved by the matching rotateWindowUp.
    // The number of saved regs matches: (4 - callinc) * 4, and callinc = n.
    const numToRestore = (4 - n) * 4;
    if (this.regSaveStack.length >= numToRestore) {
      const startIdx = this.regSaveStack.length - numToRestore;
      for (let i = 0; i < numToRestore; i++) {
        // Restore to the same physical regs that were saved:
        // Save was at (newWB + callinc)*4 = (oldWB_entry + 2*callinc)*4
        // From RETW side: oldWB = newWB_entry, n = callinc
        // So restore at (oldWB + n)*4
        const phys = ((oldWB + n) * 4 + i) & 63;
        this.physicalRegisters[phys] = this.regSaveStack[startIdx + i];
      }
      this.regSaveStack.length -= numToRestore;
    }

    // Clear current frame in WindowStart
    this.specialRegisters[SR_WINDOWSTART] &= ~(1 << oldWB);
    this.specialRegisters[SR_WINDOWBASE] = targetWB;
    return true;
  }


  // Check if window frame is valid
  isWindowValid(frame: number): boolean {
    return (this.specialRegisters[SR_WINDOWSTART] & (1 << (frame & 0xf))) !== 0;
  }

  // Raise an exception
  raiseException(cause: number, vaddr: number = 0): void {
    this.specialRegisters[SR_EXCCAUSE] = cause;
    this.specialRegisters[SR_EXCVADDR] = vaddr;

    // General exceptions always save to EPC1 (level 1)
    this.specialRegisters[SR_EPC1] = this.pc;

    // Set EXCM bit
    this.specialRegisters[SR_PS] |= PS_EXCM;

    // Jump to exception vector
    const vecbase = this.specialRegisters[SR_VECBASE] >>> 0;
    // Kernel exception vector offset = 0x300
    this.pc = (vecbase + 0x300) >>> 0;

    if (this.onException) {
      this.onException(cause, vaddr);
    }
  }

  reset(): void {
    this.physicalRegisters.fill(0);
    this.specialRegisters.fill(0);
    this.specialRegisters[SR_PS] = PS_WOE | 1;
    this.specialRegisters[SR_WINDOWBASE] = 0;
    this.specialRegisters[SR_WINDOWSTART] = 1;
    this.specialRegisters[SR_VECBASE] = 0x40000000;
    this.specialRegisters[SR_PRID] = 0xabab;
    this.pc = 0;
    this.cycles = 0;
    this.halted = false;
  }
}
