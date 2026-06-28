import { describe, it, expect } from "vitest";
import { CortexM3 } from "../src/cpu/cpu.js";
import { stepThumb } from "../src/cpu/thumb-execute.js";
import { MemoryBus } from "../src/memory/memory-bus.js";
import { FLASH_BASE } from "../src/memory/regions.js";

/**
 * Build a tiny firmware image starting at FLASH_BASE with a vector table:
 *   [0] = initial SP
 *   [1] = reset vector (PC | thumb bit)
 * followed by `code` bytes at FLASH_BASE + codeOffset.
 */
function makeFirmware(
  initialSp: number,
  codeOffset: number,
  code: number[],
): { bus: MemoryBus; cpu: CortexM3 } {
  const bus = new MemoryBus();
  const image = new Uint8Array(0x200);
  const view = new DataView(image.buffer);
  view.setUint32(0, initialSp, true);
  view.setUint32(4, (FLASH_BASE + codeOffset) | 1, true);
  for (let i = 0; i < code.length; i++) image[codeOffset + i] = code[i];
  bus.loadFlash(image);
  const cpu = new CortexM3(bus);
  cpu.reset();
  return { bus, cpu };
}

function u16(value: number): [number, number] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

describe("CortexM3 reset", () => {
  it("loads SP and PC from the vector table", () => {
    const { cpu } = makeFirmware(0x2000_0400, 0x10, [...u16(0xbf00)]);
    expect(cpu.sp).toBe(0x2000_0400);
    expect(cpu.pc).toBe(FLASH_BASE + 0x10);
  });
});

describe("Thumb decoder — movs / adds / subs imm8", () => {
  it("MOVS r0, #0x42 sets r0 and flags", () => {
    // 0x2042 = MOVS r0, #0x42
    const { cpu } = makeFirmware(0x2000_0400, 0x10, [...u16(0x2042)]);
    stepThumb(cpu);
    expect(cpu.regs[0]).toBe(0x42);
    expect(cpu.pc).toBe(FLASH_BASE + 0x12);
  });

  it("ADDS r0, #1 increments and updates flags", () => {
    // MOVS r0, #0x01 ; ADDS r0, #0x01
    const { cpu } = makeFirmware(0x2000_0400, 0x10, [
      ...u16(0x2001),
      ...u16(0x3001),
    ]);
    stepThumb(cpu);
    stepThumb(cpu);
    expect(cpu.regs[0]).toBe(2);
  });
});

describe("Thumb decoder — branches", () => {
  it("unconditional B jumps forward", () => {
    // At 0x10: B #+4  → PC = 0x10 + 4 + 4 = 0x18
    //   encoding: 11100 000 00000010  = 0xE002
    // At 0x18: BKPT 0 (halt)
    const { cpu } = makeFirmware(0x2000_0400, 0x10, [
      ...u16(0xe002),
      0, 0, 0, 0, 0, 0,
      ...u16(0xbe00),
    ]);
    stepThumb(cpu);
    expect(cpu.pc).toBe(FLASH_BASE + 0x18);
    stepThumb(cpu);
    expect(cpu.halted).toBe(true);
  });

  it("BL sets LR and branches", () => {
    // BL #+4 : 11110 0 0000000000 11 1 1 1 00000000010
    // For offset = +4 with PC+4 base → imm10=0, imm11=2, S/J1/J2 = 0
    // First half:  0xF000
    // Second half: 0xF802  (BL, J1=1, J2=1)
    const { cpu } = makeFirmware(0x2000_0400, 0x10, [
      ...u16(0xf000),
      ...u16(0xf802),
    ]);
    const pcBefore = cpu.pc;
    stepThumb(cpu);
    expect(cpu.regs[14] & ~1).toBe(pcBefore + 4);
    expect(cpu.regs[14] & 1).toBe(1); // LR has thumb bit
  });
});
