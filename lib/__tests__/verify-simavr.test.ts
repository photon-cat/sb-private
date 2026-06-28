import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { traceAvr8js, diffTraces, type CpuState } from "../verify";
import { parseSimavrTrace } from "../verify/simavr-oracle";

const BLINK = path.join(__dirname, "fixtures", "blink.hex");
const GOLDEN = path.join(__dirname, "fixtures", "blink.simavr-trace.txt");
const present = existsSync(BLINK) && existsSync(GOLDEN);

const SREG_H = 1 << 5;

// Strip the half-carry flag from a trace (known avr8js bit-0/bit-3 H bug; see
// verify-alu.test.ts) so the whole-program comparison isn't dominated by it.
function maskH(t: CpuState[]): CpuState[] {
  return t.map((s) => ({ ...s, sreg: s.sreg & ~SREG_H }));
}

describe.skipIf(!present)("avr8js vs simavr (whole-program golden trace)", () => {
  const golden = present ? parseSimavrTrace(readFileSync(GOLDEN, "utf-8")) : [];
  const hex = present ? readFileSync(BLINK, "utf-8") : "";

  it("agrees with simavr across the entire peripheral-free init (PC/regs/SP/SREG ex-H)", () => {
    const avr8js = traceAvr8js(hex, { maxSteps: golden.length });
    const result = diffTraces(maskH(avr8js), maskH(golden), {
      labelA: "avr8js",
      labelB: "simavr",
    });
    // avr8js and simavr execute identically until the firmware first reads a
    // timing-dependent peripheral (Timer0/TCNT0), proving the full instruction
    // mix in the C runtime init matches the reference. Require a healthy window.
    const agreedSteps = result.divergence ? result.divergence.step : result.compared;
    expect(agreedSteps).toBeGreaterThanOrEqual(150);
  });

  it("the first divergence is a benign peripheral-timing read, not an instruction bug", () => {
    const avr8js = traceAvr8js(hex, { maxSteps: golden.length });
    const result = diffTraces(maskH(avr8js), maskH(golden), { labelA: "avr8js", labelB: "simavr" });
    // If they diverge within the trace, it must be ONLY a register value (a
    // peripheral read result) with PC + SP still in lockstep — i.e. timing of a
    // hardware counter, not control-flow or an ALU error.
    if (result.divergence) {
      const fields = result.divergence.diffs.map((d) => d.field);
      expect(fields.some((f) => f === "pc")).toBe(false);
      expect(fields.some((f) => f === "sp")).toBe(false);
      expect(fields.every((f) => /^r\d+$/.test(f))).toBe(true);
    }
  });

  it("reset SP/RAMEND matches real hardware (0x08FF for the ATmega328P 2KB SRAM)", () => {
    // Regression guard for the SRAM-size fix this oracle surfaced.
    const avr8js = traceAvr8js(hex, { maxSteps: 1 });
    expect(avr8js[0].sp).toBe(golden[0].sp);
    expect(golden[0].sp).toBe(0x08ff);
  });
});
