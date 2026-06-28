// Architectural-state trace types for differential testing of AVR models.
//
// A "golden trace" is the sequence of CPU states produced by executing a program
// one instruction at a time. Two models (e.g. avr8js under test vs. a reference
// oracle) are run over identical firmware and their traces compared; the first
// divergence pinpoints a bug.

/** Architectural CPU state captured AFTER executing one instruction. */
export interface CpuState {
  /** Step index (0-based instruction count). */
  step: number;
  /** Program counter, normalized to a BYTE address (avr8js uses word addresses). */
  pc: number;
  /** General-purpose registers R0–R31. */
  regs: number[];
  /** Status register (SREG). */
  sreg: number;
  /** Stack pointer. */
  sp: number;
  /** Cumulative cycle count. */
  cycles: number;
}

/** The fields compared between models. `cycles` is compared separately/optionally. */
export const STATE_FIELDS = ["pc", "sreg", "sp", "regs"] as const;

/** SREG bit names, MSB→LSB, for human-readable diffs. */
export const SREG_BITS = ["I", "T", "H", "S", "V", "N", "Z", "C"] as const;

export function formatSreg(sreg: number): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    const bit = (sreg >> (7 - i)) & 1;
    out += bit ? SREG_BITS[i] : "-";
  }
  return out;
}
