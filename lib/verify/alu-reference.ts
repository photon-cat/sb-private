// Independent AVR ALU + flag reference, derived directly from the Atmel AVR
// Instruction Set Manual (not from avr8js). Used as a golden oracle to
// exhaustively differential-test avr8js's arithmetic/logic + SREG handling —
// the most bug-prone part of any CPU emulator.
//
// SREG bits: I T H S V N Z C  (bit 7 → bit 0)

export const SREG_C = 1 << 0;
export const SREG_Z = 1 << 1;
export const SREG_N = 1 << 2;
export const SREG_V = 1 << 3;
export const SREG_S = 1 << 4;
export const SREG_H = 1 << 5;

export interface AluResult {
  result: number; // 8-bit
  /** SREG with only H,S,V,N,Z,C meaningful (I,T left 0). */
  sreg: number;
}

const bit = (v: number, n: number) => (v >> n) & 1;

function pack(result: number, h: number, v: number, c: number): AluResult {
  const r = result & 0xff;
  const n = bit(r, 7);
  const z = r === 0 ? 1 : 0;
  const s = n ^ v;
  let sreg = 0;
  if (c) sreg |= SREG_C;
  if (z) sreg |= SREG_Z;
  if (n) sreg |= SREG_N;
  if (v) sreg |= SREG_V;
  if (s) sreg |= SREG_S;
  if (h) sreg |= SREG_H;
  return { result: r, sreg };
}

/** ADD Rd, Rr — Rd ← Rd + Rr. */
export function refADD(Rd: number, Rr: number): AluResult {
  const R = (Rd + Rr) & 0xff;
  const Rd3 = bit(Rd, 3), Rr3 = bit(Rr, 3), R3 = bit(R, 3);
  const Rd7 = bit(Rd, 7), Rr7 = bit(Rr, 7), R7 = bit(R, 7);
  const h = (Rd3 & Rr3) | (Rr3 & (1 - R3)) | ((1 - R3) & Rd3);
  const v = (Rd7 & Rr7 & (1 - R7)) | ((1 - Rd7) & (1 - Rr7) & R7);
  const c = (Rd7 & Rr7) | (Rr7 & (1 - R7)) | ((1 - R7) & Rd7);
  return pack(R, h, v, c);
}

/** SUB Rd, Rr — Rd ← Rd − Rr. */
export function refSUB(Rd: number, Rr: number): AluResult {
  const R = (Rd - Rr) & 0xff;
  const Rd3 = bit(Rd, 3), Rr3 = bit(Rr, 3), R3 = bit(R, 3);
  const Rd7 = bit(Rd, 7), Rr7 = bit(Rr, 7), R7 = bit(R, 7);
  const h = ((1 - Rd3) & Rr3) | (Rr3 & R3) | (R3 & (1 - Rd3));
  const v = (Rd7 & (1 - Rr7) & (1 - R7)) | ((1 - Rd7) & Rr7 & R7);
  const c = ((1 - Rd7) & Rr7) | (Rr7 & R7) | (R7 & (1 - Rd7));
  return pack(R, h, v, c);
}

/** AND Rd, Rr — logical AND. V cleared; H,C unaffected (reported 0 here). */
export function refAND(Rd: number, Rr: number): AluResult {
  return pack(Rd & Rr, 0, 0, 0);
}

/** OR Rd, Rr. */
export function refOR(Rd: number, Rr: number): AluResult {
  return pack(Rd | Rr, 0, 0, 0);
}

/** EOR Rd, Rr. */
export function refEOR(Rd: number, Rr: number): AluResult {
  return pack(Rd ^ Rr, 0, 0, 0);
}
