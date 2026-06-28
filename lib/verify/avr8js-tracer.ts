// avr8js trace producer — the production model under test.

import { CPU, avrInstruction } from "avr8js";
import { loadHex } from "../intelhex";
import type { CpuState } from "./trace";

const FLASH = 0x8000; // ATmega328P flash size (bytes)

export interface TraceOptions {
  /** Max instructions to execute. */
  maxSteps: number;
  /** Process clock events / peripheral ticks between instructions (default true). */
  tick?: boolean;
  /** SRAM size in bytes. Default 2048 (ATmega328P) so RAMEND/SP match real hardware. */
  sramBytes?: number;
}

function capture(cpu: CPU, step: number): CpuState {
  const regs = new Array<number>(32);
  for (let i = 0; i < 32; i++) regs[i] = cpu.data[i];
  return {
    step,
    pc: cpu.pc * 2, // avr8js pc is a word address; normalize to bytes
    regs,
    sreg: cpu.SREG,
    sp: cpu.SP,
    cycles: cpu.cycles,
  };
}

/** Execute a hex image on avr8js and capture one CpuState per instruction. */
export function traceAvr8js(hex: string, opts: TraceOptions): CpuState[] {
  const program = new Uint16Array(FLASH / 2);
  loadHex(hex, new Uint8Array(program.buffer));
  const cpu = new CPU(program, opts.sramBytes ?? 2048);
  const tick = opts.tick ?? true;
  const trace: CpuState[] = [];
  for (let step = 0; step < opts.maxSteps; step++) {
    avrInstruction(cpu);
    if (tick) cpu.tick();
    trace.push(capture(cpu, step));
  }
  return trace;
}
