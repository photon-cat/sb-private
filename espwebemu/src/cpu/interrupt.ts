// ESP32 Interrupt Controller
// The ESP32 has a programmable interrupt matrix that maps 71 peripheral
// interrupt sources to 32 CPU interrupts (per core).

import { ESP32CPU, SR_PS, SR_INTENABLE, SR_INTERRUPT, SR_EPC1, SR_EPS2, PS_INTLEVEL_MASK, PS_EXCM } from "./cpu.js";

// Interrupt levels (Xtensa supports 1-7, ESP32 uses 1-6 + NMI at 7)
export const MAX_INTERRUPT_LEVEL = 7;

// CPU interrupt types
export const INTTYPE_LEVEL = 0;
export const INTTYPE_EDGE = 1;

// ESP32 interrupt allocation (simplified):
// Level 1 (lowest): interrupts 0-5, 8-13, 17-21
// Level 2: interrupt 19
// Level 3: interrupts 22-27
// Level 4: interrupts 28-30
// Level 5: interrupt 16 (timer)
// NMI (7): interrupt 14

interface PendingInterrupt {
  source: number;  // Peripheral source number (0-71)
  cpuInt: number;  // CPU interrupt number (0-31)
  level: number;   // Interrupt level (1-7)
}

export class InterruptController {
  // Interrupt matrix: source → CPU interrupt mapping
  // In real hardware, this is in DPORT registers
  private readonly sourceToInt = new Uint8Array(72); // source → cpu_int
  private readonly intLevel = new Uint8Array(32);     // cpu_int → level

  // Pending edge-triggered interrupts
  private pendingEdge = 0;

  constructor() {
    // Default interrupt levels (simplified from ESP32 TRM)
    // Level 1 interrupts
    for (let i = 0; i <= 5; i++) this.intLevel[i] = 1;
    for (let i = 8; i <= 13; i++) this.intLevel[i] = 1;
    for (let i = 17; i <= 21; i++) this.intLevel[i] = 1;
    // Level 2
    this.intLevel[19] = 2;
    // Level 3
    for (let i = 22; i <= 27; i++) this.intLevel[i] = 3;
    // Level 4
    for (let i = 28; i <= 30; i++) this.intLevel[i] = 4;
    // Level 5 (timer)
    this.intLevel[16] = 5;
    // NMI
    this.intLevel[14] = 7;
    this.intLevel[31] = 3; // Software interrupt
  }

  // Map a peripheral source to a CPU interrupt
  mapInterrupt(source: number, cpuInt: number): void {
    if (source < 72 && cpuInt < 32) {
      this.sourceToInt[source] = cpuInt;
    }
  }

  // Trigger a peripheral interrupt
  triggerInterrupt(cpu: ESP32CPU, source: number): void {
    const cpuInt = this.sourceToInt[source];
    if (cpuInt === 0 && source !== 0) return; // Not mapped

    // Set bit in INTERRUPT register
    cpu.specialRegisters[SR_INTERRUPT] |= (1 << cpuInt);
  }

  // Clear a CPU interrupt
  clearInterrupt(cpu: ESP32CPU, cpuInt: number): void {
    cpu.specialRegisters[SR_INTERRUPT] &= ~(1 << cpuInt);
  }

  // Check and service pending interrupts
  // Returns true if an interrupt was taken
  checkInterrupts(cpu: ESP32CPU): boolean {
    const ps = cpu.specialRegisters[SR_PS];

    // Don't take interrupts if EXCM is set (in exception handler)
    if (ps & PS_EXCM) return false;

    const currentLevel = ps & PS_INTLEVEL_MASK;
    const enabled = cpu.specialRegisters[SR_INTENABLE];
    const pending = cpu.specialRegisters[SR_INTERRUPT] & enabled;

    if (pending === 0) return false;

    // Find highest-priority pending interrupt
    let bestInt = -1;
    let bestLevel = 0;

    for (let i = 31; i >= 0; i--) {
      if ((pending >>> i) & 1) {
        const level = this.intLevel[i];
        if (level > currentLevel && level > bestLevel) {
          bestInt = i;
          bestLevel = level;
        }
      }
    }

    if (bestInt < 0) return false;

    // Take the interrupt
    this.serviceInterrupt(cpu, bestInt, bestLevel);
    return true;
  }

  private serviceInterrupt(cpu: ESP32CPU, intNum: number, level: number): void {
    const ps = cpu.specialRegisters[SR_PS];

    // Save PC to EPC[level]
    cpu.specialRegisters[SR_EPC1 + level - 1] = cpu.pc;

    // Save PS to EPS[level] (EPS2-EPS7 at indices 194-199)
    if (level >= 2) {
      cpu.specialRegisters[SR_EPS2 + level - 2] = ps;
    }

    // Update PS: set INTLEVEL to this level, set EXCM
    cpu.specialRegisters[SR_PS] = (ps & ~PS_INTLEVEL_MASK) | level | PS_EXCM;

    // Jump to interrupt vector
    // Level 1: VECBASE + 0x00 (or kernel vector at VECBASE + 0x300 if not configured)
    // Level 2-6: VECBASE + 0x180 + (level-2) * 0x10
    // Level 7 (NMI): VECBASE + 0x1c0 (? architecture dependent)
    const vecbase = cpu.specialRegisters[231] >>> 0; // VECBASE
    let vector: number;
    if (level === 1) {
      vector = vecbase + 0x300; // Kernel exception vector handles level 1
    } else {
      vector = vecbase + 0x180 + (level - 2) * 0x10;
    }

    cpu.pc = vector >>> 0;
    cpu.halted = false; // Wake from WAITI
  }
}
