import { describe, it, expect } from "vitest";
import { Stm32Runner } from "../src/index.js";
import { GPIOC_BASE } from "../src/memory/regions.js";

/**
 * Hand-assembled "blinky" that toggles PC13 using BSRR and falls through to a
 * BKPT. This exercises the memory bus, GPIO MMIO, immediate moves, high-reg
 * MOV, and STR through a register base — enough to prove the scaffold boots.
 *
 * Program (at 0x0800_0010):
 *   MOVS r0, #0x13           ; 0x2013  → r0 = 0x13
 *   LSLS r0, r0, #12         ; 0x02c0  → r0 = 0x13000 (high bits of GPIOC base)
 *   MOVS r1, #0x40           ; 0x2140  → r1 = 0x40
 *   LSLS r1, r1, #24         ; 0x0609  → r1 = 0x40000000  (APB2)
 *   ADDS r0, r0, r1          ; 0x1840  → r0 = 0x40013000 (not GPIOC, so use different approach)
 *   MOVS r2, #0x20           ; 0x2220  → r2 = 0x20  (bit 13 = 0x2000)
 *   BKPT                     ; 0xBE00
 *
 * In practice this test just checks the runner can step through several
 * instructions and halt on BKPT without throwing.
 */
describe("Stm32Runner smoke test", () => {
  it("boots a vector table and halts on BKPT", () => {
    const firmware = new Uint8Array(0x200);
    const view = new DataView(firmware.buffer);
    // Vector table
    view.setUint32(0, 0x2000_0400, true);       // initial SP
    view.setUint32(4, (0x0800_0010) | 1, true); // reset vector (thumb bit set)

    // Code at 0x10
    const code = [
      0x13, 0x20,            // MOVS r0, #0x13
      0xc0, 0x02,            // LSLS r0, r0, #11
      0x40, 0x21,            // MOVS r1, #0x40
      0x09, 0x06,            // LSLS r1, r1, #24
      0x40, 0x18,            // ADDS r0, r0, r1
      0x20, 0x22,            // MOVS r2, #0x20
      0x00, 0xbe,            // BKPT #0
    ];
    for (let i = 0; i < code.length; i++) firmware[0x10 + i] = code[i];

    const runner = new Stm32Runner({ firmware });
    const consumed = runner.run(1000);
    expect(runner.lastError).toBeNull();
    expect(runner.cpu.halted).toBe(true);
    expect(consumed).toBeGreaterThan(0);
    // r2 should have been loaded with 0x20
    expect(runner.cpu.regs[2]).toBe(0x20);
  });

  it("GPIOC BSRR writes from firmware propagate to ODR", () => {
    const firmware = new Uint8Array(0x200);
    const view = new DataView(firmware.buffer);
    view.setUint32(0, 0x2000_0400, true);
    view.setUint32(4, 0x0800_0010 | 1, true);

    // Load GPIOC base and BSRR offset from a literal pool, then STR.
    //   LDR r0, [pc, #8]   ; r0 = GPIOC BSRR address
    //   LDR r1, [pc, #8]   ; r1 = value to write (1 << 13)
    //   STR r1, [r0]
    //   BKPT
    //   .word GPIOC_BSRR
    //   .word 0x2000
    const code = [
      0x02, 0x48,            // LDR r0, [pc, #8]
      0x02, 0x49,            // LDR r1, [pc, #8]
      0x01, 0x60,            // STR r1, [r0]
      0x00, 0xbe,            // BKPT
      0x00, 0x00,            // padding for 4-byte literal alignment
      0x00, 0x00,
    ];
    for (let i = 0; i < code.length; i++) firmware[0x10 + i] = code[i];
    // Literal pool at 0x20 (PC+4 rounded down from 0x14 → 0x14; (pc+4)&~3 + imm8*4)
    const bsrrAddr = GPIOC_BASE + 0x10;
    // First LDR at 0x10: PC=0x14, aligned 0x14, +8 = 0x1C → literal at 0x1C
    // Second LDR at 0x12: PC=0x16, aligned 0x14, +8 = 0x1C → same slot (duplicated)
    // Simplest: point both LDRs at separate slots by using different imm8s.
    // To avoid redoing encoding, we rewrite using a known-good encoding below.
    const bytes = new Uint8Array([
      // 0x10: LDR r0, [pc, #12]   → (pc_aligned=0x14) + 12 = 0x20
      0x03, 0x48,
      // 0x12: LDR r1, [pc, #12]   → (pc_aligned=0x14) + 12 = 0x20 (first literal)
      //   but we want r1 to get the second literal, so use #16
      0x04, 0x49,
      // 0x14: STR r1, [r0]
      0x01, 0x60,
      // 0x16: BKPT
      0x00, 0xbe,
      // 0x18-0x1F: padding
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      // 0x20: GPIOC BSRR addr (little-endian)
      bsrrAddr & 0xff, (bsrrAddr >>> 8) & 0xff, (bsrrAddr >>> 16) & 0xff, (bsrrAddr >>> 24) & 0xff,
      // 0x24: value (bit 13)
      0x00, 0x20, 0x00, 0x00,
    ]);
    for (let i = 0; i < bytes.length; i++) firmware[0x10 + i] = bytes[i];

    const runner = new Stm32Runner({ firmware });
    runner.run(1000);
    expect(runner.lastError).toBeNull();
    expect(runner.cpu.halted).toBe(true);
    expect(runner.gpioC.odr & (1 << 13)).toBe(1 << 13);
  });
});
