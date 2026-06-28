// Reference-oracle interface for differential testing.
//
// An oracle is an independent AVR model (an RTL core via Verilator→WASM, or a
// mature ISS like simavr) that produces a golden trace for the same firmware.
// Oracles run in CI only — never on the browser/user path.

import type { CpuState } from "./trace";

export interface ReferenceOracle {
  /** Human-readable name (e.g. "navre-rtl", "simavr"). */
  readonly name: string;
  /** True if the oracle's toolchain/binary is available in this environment. */
  available(): boolean;
  /** Produce a per-instruction trace for the given Intel HEX image. */
  trace(hex: string, maxSteps: number): CpuState[] | Promise<CpuState[]>;
}
