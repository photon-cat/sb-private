import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { traceAvr8js, diffTraces, formatDivergence, formatSreg, type CpuState } from "../verify";

const BLINK = path.join(__dirname, "fixtures", "blink.hex");
const hex = existsSync(BLINK) ? readFileSync(BLINK, "utf-8") : "";

describe("differential-test harness", () => {
  it("avr8js tracer produces a sane per-instruction trace", () => {
    const trace = traceAvr8js(hex, { maxSteps: 200 });
    expect(trace).toHaveLength(200);
    // cycles are monotonic non-decreasing; regs are bytes; pc is a byte address
    let prevCycles = -1;
    for (const s of trace) {
      expect(s.cycles).toBeGreaterThanOrEqual(prevCycles);
      prevCycles = s.cycles;
      expect(s.regs).toHaveLength(32);
      expect(s.regs.every((r) => r >= 0 && r <= 255)).toBe(true);
      expect(s.pc % 2).toBe(0); // byte-addressed, instructions are 2 or 4 bytes
    }
  });

  it("is deterministic — two runs produce identical traces (no divergence)", () => {
    const a = traceAvr8js(hex, { maxSteps: 300 });
    const b = traceAvr8js(hex, { maxSteps: 300 });
    const result = diffTraces(a, b, { labelA: "run1", labelB: "run2" });
    expect(result.divergence).toBeNull();
    expect(result.compared).toBe(300);
    expect(formatDivergence(result)).toContain("agree across 300 steps");
  });

  it("detects a register divergence at the exact step", () => {
    const a = traceAvr8js(hex, { maxSteps: 100 });
    const b: CpuState[] = a.map((s) => ({ ...s, regs: [...s.regs] }));
    // Perturb R16 at step 42
    b[42].regs[16] = (b[42].regs[16] + 1) & 0xff;
    const result = diffTraces(a, b);
    expect(result.divergence?.step).toBe(42);
    expect(result.divergence?.diffs.some((d) => d.field === "r16")).toBe(true);
  });

  it("detects a PC/SREG divergence and reports it readably", () => {
    const a = traceAvr8js(hex, { maxSteps: 80 });
    const b: CpuState[] = a.map((s) => ({ ...s }));
    b[10] = { ...b[10], pc: b[10].pc + 2, sreg: b[10].sreg ^ 0b0000_0010 };
    const result = diffTraces(a, b, { labelA: "avr8js", labelB: "oracle" });
    expect(result.divergence?.step).toBe(10);
    const report = formatDivergence(result);
    expect(report).toContain("Divergence at step 10");
    expect(report).toMatch(/pc\b/);
    expect(report).toContain("avr8js");
    expect(report).toContain("oracle");
  });

  it("formatSreg renders flag bits", () => {
    expect(formatSreg(0b1000_0010)).toBe("I-----Z-");
    expect(formatSreg(0)).toBe("--------");
    expect(formatSreg(0xff)).toBe("ITHSVNZC");
  });

  it("comparing different-length traces only compares the common prefix", () => {
    const a = traceAvr8js(hex, { maxSteps: 100 });
    const b = traceAvr8js(hex, { maxSteps: 50 });
    const result = diffTraces(a, b);
    expect(result.compared).toBe(50);
    expect(result.divergence).toBeNull();
  });
});
