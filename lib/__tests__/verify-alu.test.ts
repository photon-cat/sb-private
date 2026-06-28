import { describe, it, expect } from "vitest";
import { probeAvr8jsAlu, type AluOp } from "../verify/avr8js-alu-probe";
import {
  refADD, refSUB, refAND, refOR, refEOR, SREG_H, SREG_Z,
  type AluResult,
} from "../verify/alu-reference";

type RefFn = (a: number, b: number) => AluResult;
const REF: Record<AluOp, RefFn> = { ADD: refADD, SUB: refSUB, AND: refAND, OR: refOR, EOR: refEOR };

describe("avr8js ALU vs independent datasheet reference", () => {
  // Sanity gate — if the instruction encoding were wrong these obvious cases
  // fail loudly, so a real flag-bug can never be confused with an encoding bug.
  it("sanity: trivial operations produce the obvious result", () => {
    expect(probeAvr8jsAlu("ADD", 1, 1).result).toBe(2);
    expect(probeAvr8jsAlu("SUB", 5, 3).result).toBe(2);
    expect(probeAvr8jsAlu("SUB", 3, 3)).toEqual({ result: 0, sreg: SREG_Z });
    expect(probeAvr8jsAlu("AND", 0xf0, 0x0f)).toEqual({ result: 0, sreg: SREG_Z });
    expect(probeAvr8jsAlu("OR", 0xf0, 0x0f).result).toBe(0xff);
    expect(probeAvr8jsAlu("EOR", 0xaa, 0xff).result).toBe(0x55);
  });

  // Exhaustive 256×256: avr8js must match the datasheet on the RESULT and every
  // flag EXCEPT half-carry (H), which has a known avr8js bug characterized below.
  for (const op of ["ADD", "SUB", "AND", "OR", "EOR"] as AluOp[]) {
    it(`${op}: result + all flags except H match the reference (exhaustive)`, () => {
      const ref = REF[op];
      const mismatches: string[] = [];
      for (let a = 0; a < 256; a++) {
        for (let b = 0; b < 256; b++) {
          const got = probeAvr8jsAlu(op, a, b);
          const exp = ref(a, b);
          const gotNoH = got.sreg & ~SREG_H;
          const expNoH = exp.sreg & ~SREG_H;
          if (got.result !== exp.result || gotNoH !== expNoH) {
            if (mismatches.length < 5) {
              mismatches.push(`${op} a=0x${a.toString(16)} b=0x${b.toString(16)}`);
            }
          }
        }
      }
      expect(mismatches, mismatches.join("; ")).toHaveLength(0);
    });
  }
});

// ── Documented bug: avr8js half-carry uses bit 0 instead of bit 3 ──
//
// avr8js computes H as `1 & ((d&r)|(r&~R)|(~R&d))` — the half-carry EXPRESSION
// is correct, but it's masked at bit 0 instead of bit 3. So avr8js's H equals
// the carry out of bit 0, not the carry out of bit 3 (the true half-carry).
// Pervasive across ADD/ADC/SUB/SUBI/SBC/SBCI/CP/CPC/CPI/NEG. Latent because AVR
// has no BCD instruction, so C compilers essentially never read H.
//
// This characterization test pins the exact bug: it stays green while the bug
// exists and will FAIL (alerting us) if avr8js ever fixes it.
describe("KNOWN avr8js bug — half-carry computed from bit 0, not bit 3", () => {
  const addHCexpr = (a: number, b: number) => {
    const R = (a + b) & 0xff;
    return (a & b) | (b & ~R) | (~R & a);
  };
  const subHCexpr = (a: number, b: number) => {
    const R = (a - b) & 0xff;
    return (~a & b) | (b & R) | (R & ~a);
  };

  it("ADD: avr8js H == bit0 of the HC expression (buggy), not bit3 (correct)", () => {
    let differingCases = 0;
    for (let a = 0; a < 256; a++) {
      for (let b = 0; b < 256; b++) {
        const avr8jsH = (probeAvr8jsAlu("ADD", a, b).sreg & SREG_H) ? 1 : 0;
        const expr = addHCexpr(a, b);
        const buggyH = expr & 1; // bit 0 — what avr8js actually does
        const correctH = (expr >> 3) & 1; // bit 3 — the true half-carry
        expect(avr8jsH).toBe(buggyH);
        if (buggyH !== correctH) differingCases++;
      }
    }
    // The bug is real: there exist many operands where bit0 ≠ bit3.
    expect(differingCases).toBeGreaterThan(0);
  });

  it("SUB: avr8js H == bit0 of the HC expression (buggy), not bit3 (correct)", () => {
    let differingCases = 0;
    for (let a = 0; a < 256; a++) {
      for (let b = 0; b < 256; b++) {
        const avr8jsH = (probeAvr8jsAlu("SUB", a, b).sreg & SREG_H) ? 1 : 0;
        const expr = subHCexpr(a, b);
        const buggyH = expr & 1;
        const correctH = (expr >> 3) & 1;
        expect(avr8jsH).toBe(buggyH);
        if (buggyH !== correctH) differingCases++;
      }
    }
    expect(differingCases).toBeGreaterThan(0);
  });
});
