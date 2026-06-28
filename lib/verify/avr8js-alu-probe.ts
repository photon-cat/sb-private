// Execute a single AVR ALU instruction on avr8js with controlled operands and
// read back the result + SREG. Used to exhaustively diff avr8js against the
// independent datasheet reference (alu-reference.ts).

import { CPU, avrInstruction } from "avr8js";

const SREG_ADDR = 0x5f; // ATmega328 SREG
const FLAG_MASK = 0x3f; // H,S,V,N,Z,C (bits 5..0)
const Rd = 16;
const Rr = 17;

/** Two-operand ALU opcodes, with Rd/Rr field layout: base | r4<<9 | d[4:0]<<4 | r[3:0]. */
export const OPCODE_BASE = {
  ADD: 0x0c00,
  SUB: 0x1800,
  AND: 0x2000,
  OR: 0x2800,
  EOR: 0x2400,
} as const;

export type AluOp = keyof typeof OPCODE_BASE;

function encode(base: number, d: number, r: number): number {
  return base | ((r & 0x10) << 5) | ((d & 0x1f) << 4) | (r & 0x0f);
}

export interface ProbeResult {
  result: number;
  sreg: number; // masked to H,S,V,N,Z,C
}

/**
 * Run `op Rd, Rr` once on avr8js with Rd=a, Rr=b, SREG cleared.
 * Returns the 8-bit result (in Rd) and the flag bits.
 */
export function probeAvr8jsAlu(op: AluOp, a: number, b: number): ProbeResult {
  const prog = new Uint16Array(0x100);
  prog[0] = encode(OPCODE_BASE[op], Rd, Rr);
  const cpu = new CPU(prog);
  cpu.data[Rd] = a & 0xff;
  cpu.data[Rr] = b & 0xff;
  cpu.data[SREG_ADDR] = 0; // clear SREG so "unaffected" flags stay 0
  avrInstruction(cpu);
  return { result: cpu.data[Rd], sreg: cpu.SREG & FLAG_MASK };
}
