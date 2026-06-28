// simavr golden-trace oracle adapter.
//
// Parses a trace produced by lib/verify/simavr/tracer.c (one line per
// instruction: "PC R0..R31 SREG SP", all hex) into CpuState[]. The simavr
// binary is a dev-time generator; tests diff avr8js against a committed golden
// trace, so CI needs no simavr build.

import type { CpuState } from "./trace";

/** Parse a simavr golden trace (text) into CpuState[]. */
export function parseSimavrTrace(text: string): CpuState[] {
  const out: CpuState[] = [];
  const lines = text.trim().split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const f = line.split(/\s+/).map((x) => parseInt(x, 16));
    if (f.length < 35) continue; // pc + 32 regs + sreg + sp
    out.push({
      step: i,
      pc: f[0],
      regs: f.slice(1, 33),
      sreg: f[33],
      sp: f[34],
      cycles: 0, // simavr cycle model differs from avr8js; not compared
    });
  }
  return out;
}
