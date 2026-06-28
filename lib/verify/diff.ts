// Golden-trace comparator — finds the first architectural-state divergence
// between two models and reports it with context.

import type { CpuState } from "./trace";
import { formatSreg } from "./trace";

export interface FieldDiff {
  field: string;
  a: number | string;
  b: number | string;
}

export interface TraceDivergence {
  /** Step index of the first divergence. */
  step: number;
  /** PC (byte addr) at that step, from model A. */
  pc: number;
  diffs: FieldDiff[];
}

export interface DiffOptions {
  /** Compare cumulative cycle counts too (default false — many models differ on cycles). */
  compareCycles?: boolean;
  /** Label for model A (default "A"). */
  labelA?: string;
  /** Label for model B (default "B"). */
  labelB?: string;
}

export interface DiffResult {
  labelA: string;
  labelB: string;
  /** Number of steps compared (min of the two trace lengths). */
  compared: number;
  /** First divergence, or null if the compared prefix matches. */
  divergence: TraceDivergence | null;
}

function compareStates(a: CpuState, b: CpuState, compareCycles: boolean): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  if (a.pc !== b.pc) diffs.push({ field: "pc", a: hex(a.pc), b: hex(b.pc) });
  if (a.sreg !== b.sreg) {
    diffs.push({ field: "sreg", a: formatSreg(a.sreg), b: formatSreg(b.sreg) });
  }
  if (a.sp !== b.sp) diffs.push({ field: "sp", a: hex(a.sp), b: hex(b.sp) });
  for (let i = 0; i < 32; i++) {
    if (a.regs[i] !== b.regs[i]) {
      diffs.push({ field: `r${i}`, a: hex(a.regs[i]), b: hex(b.regs[i]) });
    }
  }
  if (compareCycles && a.cycles !== b.cycles) {
    diffs.push({ field: "cycles", a: a.cycles, b: b.cycles });
  }
  return diffs;
}

function hex(n: number): string {
  return "0x" + (n >>> 0).toString(16);
}

/** Compare two traces; return the first divergent step (or null if matching). */
export function diffTraces(a: CpuState[], b: CpuState[], opts: DiffOptions = {}): DiffResult {
  const compared = Math.min(a.length, b.length);
  const compareCycles = opts.compareCycles ?? false;
  for (let i = 0; i < compared; i++) {
    const diffs = compareStates(a[i], b[i], compareCycles);
    if (diffs.length > 0) {
      return {
        labelA: opts.labelA ?? "A",
        labelB: opts.labelB ?? "B",
        compared,
        divergence: { step: i, pc: a[i].pc, diffs },
      };
    }
  }
  return {
    labelA: opts.labelA ?? "A",
    labelB: opts.labelB ?? "B",
    compared,
    divergence: null,
  };
}

/** Render a divergence as a readable multi-line report. */
export function formatDivergence(result: DiffResult): string {
  if (!result.divergence) {
    return `✓ ${result.labelA} and ${result.labelB} agree across ${result.compared} steps`;
  }
  const d = result.divergence;
  const lines = [
    `✗ Divergence at step ${d.step} (pc=${hex(d.pc)}) — ${result.labelA} vs ${result.labelB}:`,
  ];
  for (const f of d.diffs) {
    lines.push(`    ${f.field.padEnd(6)} ${result.labelA}=${f.a}  ${result.labelB}=${f.b}`);
  }
  return lines.join("\n");
}
