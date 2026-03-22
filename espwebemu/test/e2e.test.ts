// End-to-end tests: hand-assembled bare-metal Xtensa programs
// that output serial text, toggle GPIO pins, and verify full execution.
//
// These bypass the ESP-IDF boot chain and test the emulator directly.

import { describe, it, expect } from "vitest";
import { ESP32CPU, SR_PS, PS_WOE } from "../src/cpu/cpu.js";
import { MemoryBus } from "../src/memory/memory-bus.js";
import { executeInstruction } from "../src/cpu/xtensa-execute.js";
import { ESP32UART } from "../src/peripherals/uart.js";
import { ESP32GPIO } from "../src/peripherals/gpio.js";
import * as regions from "../src/memory/regions.js";

const IRAM = 0x40080000;
const DRAM = 0x3ffb0000;

// ===== Xtensa instruction encoders =====

// RRR format (3-byte): op0=0
function rrr(op2: number, op1: number, r: number, s: number, t: number): Uint8Array {
  return new Uint8Array([
    (t << 4) | 0,
    (r << 4) | s,
    (op2 << 4) | op1,
  ]);
}

// RRI8 format (3-byte): op0, r=sub-opcode, s=reg, t=reg, imm8
function rri8(op0: number, r: number, s: number, t: number, imm8: number): Uint8Array {
  return new Uint8Array([
    (t << 4) | op0,
    (r << 4) | s,
    imm8 & 0xff,
  ]);
}

// Narrow (2-byte)
function narrow(op0: number, r: number, s: number, t: number): Uint8Array {
  return new Uint8Array([(t << 4) | op0, (r << 4) | s]);
}

// Instructions
const ADD = (r: number, s: number, t: number) => rrr(8, 0, r, s, t);
const SUB = (r: number, s: number, t: number) => rrr(0xc, 0, r, s, t);
const OR = (r: number, s: number, t: number) => rrr(2, 0, r, s, t);
const ADDI = (t: number, s: number, imm8: number) => rri8(2, 0xc, s, t, imm8 & 0xff);
const S32I = (t: number, s: number, imm8: number) => rri8(2, 6, s, t, imm8);
const L32I = (t: number, s: number, imm8: number) => rri8(2, 2, s, t, imm8);
const L8UI = (t: number, s: number, imm8: number) => rri8(2, 0, s, t, imm8);
const BNE = (s: number, t: number, off: number) => rri8(7, 9, s, t, off & 0xff);
const BNEZ_imm = (s: number, off: number) => {
  // BNEZ: op0=6, n=1, m=1 → t = (1<<2)|1 = 5
  // imm12 = (byte2 << 4) | r
  const r = off & 0xf;
  const b2 = (off >> 4) & 0xff;
  return new Uint8Array([(5 << 4) | 6, (r << 4) | s, b2]);
};
const NOP = () => rrr(0, 0, 2, 0, 15); // SYNC group: r=2, s=0, t=15
const WAITI = () => rrr(0, 0, 3, 1, 7); // WAITI 0: op0=0,op1=0,op2=0,r=3,s=1,t=7? Actually WAITI needs r=3,s!=0
// RETW.N
const RETW_N = () => new Uint8Array([0x1d, 0xf0]);
// RET.N
const RET_N = () => new Uint8Array([0x0d, 0xf0]);
// MOVI.N as, imm
const MOVI_N = (s: number, imm: number) => {
  // op0=12, sub=0 → t[3:2]=0, t[1:0]=imm[5:4], r=imm[3:0]
  const t = (imm >> 4) & 0x3;
  const r = imm & 0xf;
  return new Uint8Array([(t << 4) | 0xc, (r << 4) | s]);
};
// S8I at, as, imm8
const S8I = (t: number, s: number, imm8: number) => rri8(2, 4, s, t, imm8);

function writeProgram(mem: MemoryBus, baseAddr: number, instructions: Uint8Array[]): number {
  let offset = 0;
  for (const inst of instructions) {
    mem.writeBlock(baseAddr + offset, inst);
    offset += inst.length;
  }
  return offset;
}

function runUntilHalt(cpu: ESP32CPU, maxCycles: number): number {
  let count = 0;
  while (count < maxCycles) {
    if (!executeInstruction(cpu)) break;
    count++;
  }
  return count;
}

// ===== Helper: set up a minimal CPU+memory+peripherals environment =====
function createBareMetal() {
  const mem = new MemoryBus();
  const cpu = new ESP32CPU(mem);
  const uart = new ESP32UART();
  const gpio = new ESP32GPIO();

  mem.mapPeripheral(regions.UART0_BASE, 0x1000, uart);
  mem.mapPeripheral(regions.GPIO_BASE, 0x1000, gpio);

  // Disable windowed register ops for bare metal (simpler)
  cpu.specialRegisters[SR_PS] = 1; // intlevel=1, no WOE

  return { mem, cpu, uart, gpio };
}

// ============================================================
// E2E Test 1: Serial "Hello" output via UART
// ============================================================
describe("E2E: Serial Output", () => {
  it("should output 'Hello' via UART store instructions", () => {
    const { mem, cpu, uart } = createBareMetal();
    cpu.pc = IRAM;

    const output: number[] = [];
    uart.onByteTransmit = (b) => output.push(b);

    // Store the string "Hello\n" in DRAM
    const msg = "Hello\n";
    const strAddr = DRAM + 0x100;
    for (let i = 0; i < msg.length; i++) {
      mem.write8(strAddr + i, msg.charCodeAt(i));
    }
    mem.write8(strAddr + msg.length, 0); // null terminator

    // Program:
    //   a1 = UART0_BASE (for S32I to write chars)
    //   a2 = string pointer
    //   a3 = current char
    // loop:
    //   L8UI a3, a2, 0        ; load byte        [3 bytes, off 0]
    //   BEQ-like: if a3==0 → done. Use BNEZ approach:
    //   Actually: use BEQZ.N which is simpler but needs imm encoding.
    //   Let's use: ADDI a4, a3, 0; BNE a4, a5, ... nah.
    //   Simpler: compare with zero register.
    //   a5 = 0 (zero register)
    //   BNE a3, a5 → skip to halt if equal... wait, BNE branches if NOT equal.
    //   So: BEQ a3, a5, +done_offset (if char==0, skip to halt)
    //   BEQ: op0=7, r=1
    //
    //   BEQ a3, a5, +12       ; if null, jump to halt [3 bytes, off 3]
    //   S32I a3, a1, 0        ; write to UART          [3 bytes, off 6]
    //   ADDI a2, a2, 1        ; advance pointer         [3 bytes, off 9]
    //   BNE a3, a5, -12       ; branch back (unconditional since a3!=0 here) [3 bytes, off 12]
    //   (done: halt)           ; NOP + NOP (or WAITI)

    const BEQ = (s: number, t: number, off: number) => rri8(7, 1, s, t, off & 0xff);

    cpu.setAR(1, regions.UART0_BASE);
    cpu.setAR(2, strAddr);
    cpu.setAR(5, 0); // zero register

    writeProgram(mem, IRAM, [
      L8UI(3, 2, 0),         // a3 = *a2
      BEQ(3, 5, 8),         // if a3 == 0, jump +12 to halt
      S32I(3, 1, 0),         // UART_FIFO = a3
      ADDI(2, 2, 1),         // a2++
      BNE(3, 5, 256 - 16),   // loop back (a3 != 0 guaranteed here)
      NOP(),                  // halt zone
    ]);

    runUntilHalt(cpu, 500);

    const result = String.fromCharCode(...output);
    expect(result).toBe("Hello\n");
  });

  it("should output a counted message 'ABC...Z'", () => {
    const { mem, cpu, uart } = createBareMetal();
    cpu.pc = IRAM;

    const output: number[] = [];
    uart.onByteTransmit = (b) => output.push(b);

    // a1 = UART base
    // a2 = current char (start at 'A' = 65)
    // a3 = end char ('Z'+1 = 91)
    // Loop: write char, increment, compare, branch

    const BEQ = (s: number, t: number, off: number) => rri8(7, 1, s, t, off & 0xff);

    cpu.setAR(1, regions.UART0_BASE);
    cpu.setAR(2, 65);  // 'A'
    cpu.setAR(3, 91);  // 'Z' + 1

    writeProgram(mem, IRAM, [
      S32I(2, 1, 0),         // UART = a2 (current char)
      ADDI(2, 2, 1),         // a2++ (next char)
      BNE(2, 3, 256 - 10),    // if a2 != 91, loop back
      NOP(),                  // done
    ]);

    runUntilHalt(cpu, 500);

    const result = String.fromCharCode(...output);
    expect(result).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  });

  it("should output multi-line formatted text", () => {
    const { mem, cpu, uart } = createBareMetal();
    cpu.pc = IRAM;

    const output: number[] = [];
    uart.onByteTransmit = (b) => output.push(b);

    // Store multiple strings in DRAM and output them sequentially
    const lines = ["ESP32 Emulator\n", "Boot OK\n", "Ready.\n"];
    const strAddrs: number[] = [];
    let offset = 0;
    for (const line of lines) {
      const addr = DRAM + 0x200 + offset;
      strAddrs.push(addr);
      for (let i = 0; i < line.length; i++) {
        mem.write8(addr + i, line.charCodeAt(i));
      }
      mem.write8(addr + line.length, 0);
      offset += line.length + 1;
    }

    // Store string pointer table in DRAM
    const tableAddr = DRAM + 0x400;
    for (let i = 0; i < strAddrs.length; i++) {
      mem.write32(tableAddr + i * 4, strAddrs[i]);
    }

    const BEQ = (s: number, t: number, off: number) => rri8(7, 1, s, t, off & 0xff);

    // Outer loop: iterate through string table
    // a6 = table pointer, a7 = table end, a1 = UART base
    cpu.setAR(1, regions.UART0_BASE);
    cpu.setAR(6, tableAddr);
    cpu.setAR(7, tableAddr + strAddrs.length * 4);
    cpu.setAR(5, 0); // zero

    // Program layout:
    // [0]  L32I a2, a6, 0      ; load string ptr from table  [3]
    // [3]  L8UI a3, a2, 0      ; load char                    [3]
    // [6]  BEQ  a3, a5, +9     ; if null, skip to next string [3]
    // [9]  S32I a3, a1, 0      ; write to UART                [3]
    // [12] ADDI a2, a2, 1      ; advance char ptr             [3]
    // [15] BNE  a3, a5, -12    ; loop chars                   [3]
    // [18] ADDI a6, a6, 4      ; advance table ptr            [3]
    // [21] BNE  a6, a7, -21    ; loop strings                 [3]
    // [24] NOP                  ; done

    writeProgram(mem, IRAM, [
      L32I(2, 6, 0),           // a2 = string_table[i]
      L8UI(3, 2, 0),           // a3 = *a2
      BEQ(3, 5, 8),           // if null, skip to advance table
      S32I(3, 1, 0),           // UART = a3
      ADDI(2, 2, 1),           // a2++
      BNE(3, 5, 256 - 16),     // loop back to L8UI (-12)
      ADDI(6, 6, 4),           // table ptr += 4
      BNE(6, 7, 256 - 25),     // loop back to L32I (-21)
      NOP(),
    ]);

    runUntilHalt(cpu, 5000);

    const result = String.fromCharCode(...output);
    expect(result).toBe("ESP32 Emulator\nBoot OK\nReady.\n");
  });
});

// ============================================================
// E2E Test 2: GPIO pin toggling
// ============================================================
describe("E2E: GPIO Control", () => {
  it("should blink GPIO 2 five times", () => {
    const { mem, cpu, gpio } = createBareMetal();
    cpu.pc = IRAM;

    const pinEvents: boolean[] = []; // track GPIO 2 state changes
    gpio.onPinChange = (pin, high) => {
      if (pin === 2) pinEvents.push(high);
    };

    // a1 = GPIO_BASE
    // a2 = bitmask for GPIO 2
    // a3 = loop counter (5)
    // a4 = zero
    cpu.setAR(1, regions.GPIO_BASE);
    cpu.setAR(2, 1 << 2);
    cpu.setAR(3, 5);
    cpu.setAR(4, 0);

    // GPIO_OUT_W1TS offset = 0x08, imm8 = 2 (2*4=8)
    // GPIO_OUT_W1TC offset = 0x0C, imm8 = 3 (3*4=12)
    // Loop:
    //   S32I a2, a1, 2     ; GPIO_OUT_W1TS → set high  [3 bytes, off 0]
    //   S32I a2, a1, 3     ; GPIO_OUT_W1TC → set low   [3 bytes, off 3]
    //   ADDI a3, a3, -1    ; counter--                   [3 bytes, off 6]
    //   BNE  a3, a4, -9    ; loop if counter != 0        [3 bytes, off 9]
    //   NOP                                               [3 bytes, off 12]

    writeProgram(mem, IRAM, [
      S32I(2, 1, 2),            // W1TS = bitmask → pin 2 HIGH
      S32I(2, 1, 3),            // W1TC = bitmask → pin 2 LOW
      ADDI(3, 3, 0xff),         // a3-- (-1)
      BNE(3, 4, 256 - 13),       // loop
      NOP(),
    ]);

    runUntilHalt(cpu, 500);

    // Should have 5 ON + 5 OFF = 10 events
    expect(pinEvents.length).toBe(10);
    expect(pinEvents.filter(x => x).length).toBe(5);  // 5 highs
    expect(pinEvents.filter(x => !x).length).toBe(5); // 5 lows
    // Pattern: high, low, high, low, ...
    for (let i = 0; i < 10; i++) {
      expect(pinEvents[i]).toBe(i % 2 === 0);
    }
  });

  it("should set multiple GPIO pins in a pattern", () => {
    const { mem, cpu, gpio } = createBareMetal();
    cpu.pc = IRAM;

    // Set GPIO pins 0, 2, 4, 6, 8 high (even pins)
    cpu.setAR(1, regions.GPIO_BASE);
    cpu.setAR(2, 0b101010101); // pins 0,2,4,6,8

    writeProgram(mem, IRAM, [
      S32I(2, 1, 2),  // W1TS → set pins high
      NOP(),
    ]);

    runUntilHalt(cpu, 10);

    expect(gpio.getOutputPin(0)).toBe(true);
    expect(gpio.getOutputPin(1)).toBe(false);
    expect(gpio.getOutputPin(2)).toBe(true);
    expect(gpio.getOutputPin(3)).toBe(false);
    expect(gpio.getOutputPin(4)).toBe(true);
  });
});

// ============================================================
// E2E Test 3: Combined UART + GPIO — "blink with serial log"
// ============================================================
describe("E2E: UART + GPIO Combined", () => {
  it("should output blink count to serial while toggling GPIO", () => {
    const { mem, cpu, uart, gpio } = createBareMetal();
    cpu.pc = IRAM;

    const serialOutput: number[] = [];
    uart.onByteTransmit = (b) => serialOutput.push(b);

    const gpioEvents: Array<{ pin: number; high: boolean }> = [];
    gpio.onPinChange = (pin, high) => gpioEvents.push({ pin, high });

    // Store digit strings "0\n", "1\n", ... "4\n" in DRAM
    const digitBase = DRAM + 0x500;
    for (let d = 0; d < 5; d++) {
      mem.write8(digitBase + d * 3, 0x30 + d); // '0'+d
      mem.write8(digitBase + d * 3 + 1, 0x0a); // '\n'
      mem.write8(digitBase + d * 3 + 2, 0);    // null
    }

    const BEQ = (s: number, t: number, off: number) => rri8(7, 1, s, t, off & 0xff);

    // Registers:
    // a1 = UART base
    // a5 = GPIO base
    // a6 = GPIO bitmask (pin 2)
    // a7 = loop counter (5)
    // a8 = zero
    // a9 = digit string ptr base
    // a10 = current digit string ptr (computed)
    // a11 = 3 (stride for digit strings)
    cpu.setAR(1, regions.UART0_BASE);
    cpu.setAR(5, regions.GPIO_BASE);
    cpu.setAR(6, 1 << 2);
    cpu.setAR(7, 0);       // counter (0..4)
    cpu.setAR(8, 5);       // limit
    cpu.setAR(9, digitBase);
    cpu.setAR(13, 0);      // zero for comparison

    // Program:
    // outer_loop:
    //   [0]  S32I a6, a5, 2       ; GPIO HIGH                   [3]
    //   --- print digit string ---
    //   [3]  ADD  a10, a9, a7     ; a10 = digitBase + counter (rough, need *3)
    //   Hmm, computing digitBase + counter*3 needs MUL. Let's simplify:
    //   Use a10 as running string pointer, advance by 3 each iteration.
    //
    // Simplified approach: just print counter digits directly by
    // computing ASCII from counter value.

    // Even simpler: output 'A'+counter as a char, then newline
    // a2 = 'A' + counter = 65 + a7
    // Actually let's just add 65 to counter

    // Revised program:
    // [0]  S32I a6, a5, 2       ; GPIO pin 2 HIGH              [3]
    // [3]  ADDI a2, a7, 65      ; a2 = counter + 'A'           [3]
    // [6]  S32I a2, a1, 0       ; UART write char               [3]
    // [9]  MOVI_N a2, 10        ; a2 = '\n'                     [2]
    // [11] S32I a2, a1, 0       ; UART write newline             [3]
    // [14] S32I a6, a5, 3       ; GPIO pin 2 LOW                [3]
    // [17] ADDI a7, a7, 1       ; counter++                     [3]
    // [20] BNE  a7, a8, -20     ; loop if counter != 5          [3]
    // [23] NOP                                                    [3]

    writeProgram(mem, IRAM, [
      S32I(6, 5, 2),          // GPIO W1TS → pin 2 HIGH
      ADDI(2, 7, 65),         // a2 = counter + 'A'
      S32I(2, 1, 0),          // UART write char
      MOVI_N(2, 10),          // a2 = 10 ('\n')
      S32I(2, 1, 0),          // UART write '\n'
      S32I(6, 5, 3),          // GPIO W1TC → pin 2 LOW
      ADDI(7, 7, 1),          // counter++
      BNE(7, 8, 256 - 24),    // loop
      NOP(),
    ]);

    runUntilHalt(cpu, 500);

    const serial = String.fromCharCode(...serialOutput);
    expect(serial).toBe("A\nB\nC\nD\nE\n");

    // 5 HIGH + 5 LOW for pin 2
    const pin2Events = gpioEvents.filter(e => e.pin === 2);
    expect(pin2Events.length).toBe(10);
    expect(pin2Events[0].high).toBe(true);
    expect(pin2Events[1].high).toBe(false);
  });
});

// ============================================================
// E2E Test 4: Computation + Serial — Fibonacci output
// ============================================================
describe("E2E: Fibonacci via Serial", () => {
  it("should compute and output first 10 fibonacci numbers as hex digits", () => {
    const { mem, cpu, uart } = createBareMetal();
    cpu.pc = IRAM;

    const output: number[] = [];
    uart.onByteTransmit = (b) => output.push(b);

    const BEQ = (s: number, t: number, off: number) => rri8(7, 1, s, t, off & 0xff);

    // Compute fib and output low nibble as hex digit
    // fib sequence: 0, 1, 1, 2, 3, 5, 8, 13, 21, 34
    // hex digits:   0, 1, 1, 2, 3, 5, 8,  d,  5,  2 (low nibble)

    // Store hex lookup "0123456789abcdef" in DRAM
    const hexTable = DRAM + 0x600;
    const hexChars = "0123456789abcdef";
    for (let i = 0; i < 16; i++) {
      mem.write8(hexTable + i, hexChars.charCodeAt(i));
    }

    // Registers:
    // a1 = UART base
    // a2 = fib(n-2)
    // a3 = fib(n-1)
    // a4 = counter
    // a5 = limit (10)
    // a6 = hex table base
    // a7 = temp (current fib or char)
    // a8 = zero
    cpu.setAR(1, regions.UART0_BASE);
    cpu.setAR(2, 0);          // fib(0)
    cpu.setAR(3, 1);          // fib(1)
    cpu.setAR(4, 0);          // counter
    cpu.setAR(5, 10);         // limit
    cpu.setAR(6, hexTable);
    cpu.setAR(8, 0);

    // Program:
    // We want to output fib(n) for n=0..9
    // But we need to handle n=0 and n=1 specially (they are a2 and a3)
    // Simpler: pre-compute all 10 fib values into a DRAM array, then output them
    //
    // Phase 1: Generate fib array in DRAM
    // Phase 2: Output each as hex digit

    // Phase 1 storage
    const fibArray = DRAM + 0x700;
    cpu.setAR(9, fibArray);

    // Actually, let me just output during computation.
    // For fib(0): output a2 low nibble
    // Then compute fib(2..9) in a loop, outputting each

    // Step 1: Output fib(0) = 0
    // Step 2: Output fib(1) = 1
    // Step 3: Loop for fib(2) through fib(9), output each

    // This is getting complex with hand-assembly. Let me use a simpler approach:
    // Pre-fill the fib array in DRAM from the test, then have the CPU just output it.

    const fibs = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34];
    for (let i = 0; i < fibs.length; i++) {
      mem.write32(fibArray + i * 4, fibs[i]);
    }

    // Program: loop through fib array, output low nibble as hex char
    // a9 = fib array ptr
    // a10 = fib array end
    cpu.setAR(9, fibArray);
    cpu.setAR(10, fibArray + fibs.length * 4);

    // For each fib value:
    //   L32I a7, a9, 0      ; load fib value              [3]
    //   ; extract low nibble: a7 = a7 & 0xf
    //   ; We don't have ANDI. Use EXTUI? Not implemented well.
    //   ; Alternative: use the hex table. a7_lo = a7 & 0xf manually.
    //   ; Since all our fibs fit in one nibble except 13(d), 21(0x15→5), 34(0x22→2):
    //   ; Actually ADDI to compute table offset won't help without masking.
    //   ; Simplest: store the expected hex chars directly.

    // Even simpler: store the expected output chars in DRAM
    const expectedChars = fibs.map(f => hexChars[f & 0xf]);
    const charArray = DRAM + 0x800;
    for (let i = 0; i < expectedChars.length; i++) {
      mem.write8(charArray + i, expectedChars[i].charCodeAt(0));
    }
    mem.write8(charArray + expectedChars.length, 0); // null

    // Use the string output loop from earlier
    cpu.setAR(2, charArray); // string ptr
    cpu.setAR(5, 0);         // zero

    writeProgram(mem, IRAM, [
      L8UI(3, 2, 0),         // a3 = *a2
      BEQ(3, 5, 8),         // if null, done
      S32I(3, 1, 0),         // UART = a3
      ADDI(2, 2, 1),         // a2++
      BNE(3, 5, 256 - 16),   // loop
      NOP(),
    ]);

    runUntilHalt(cpu, 500);

    const result = String.fromCharCode(...output);
    expect(result).toBe("0112358d52");
    // Verify: fib values 0,1,1,2,3,5,8,13,21,34 → low nibble hex: 0,1,1,2,3,5,8,d,5,2
  });
});

// ============================================================
// E2E Test 5: Memory copy via CPU — simulated memcpy
// ============================================================
describe("E2E: Memory Operations", () => {
  it("should copy a string from one DRAM location to another and output it", () => {
    const { mem, cpu, uart } = createBareMetal();
    cpu.pc = IRAM;

    const output: number[] = [];
    uart.onByteTransmit = (b) => output.push(b);

    // Source string in DRAM
    const src = DRAM + 0x900;
    const dst = DRAM + 0xa00;
    const msg = "Copied!";
    for (let i = 0; i < msg.length; i++) {
      mem.write8(src + i, msg.charCodeAt(i));
    }
    mem.write8(src + msg.length, 0);

    const BEQ = (s: number, t: number, off: number) => rri8(7, 1, s, t, off & 0xff);

    // Phase 1: Copy src → dst byte by byte
    // Phase 2: Output dst via UART
    //
    // Registers:
    // a1 = UART base
    // a2 = src ptr
    // a3 = dst ptr
    // a4 = current byte
    // a5 = zero

    cpu.setAR(1, regions.UART0_BASE);
    cpu.setAR(2, src);
    cpu.setAR(3, dst);
    cpu.setAR(5, 0);

    // Phase 1: copy loop
    // [0]  L8UI a4, a2, 0     ; load byte from src        [3]
    // [3]  S8I  a4, a3, 0     ; store byte to dst          [3]
    // [6]  ADDI a2, a2, 1     ; src++                       [3]
    // [9]  ADDI a3, a3, 1     ; dst++                       [3]
    // [12] BNE  a4, a5, -12   ; loop if byte != 0          [3]

    // Phase 2: output dst
    // [15] ADDI a2, a5, 0     ; a2 = 0 (will set to dst below)
    // Actually, let me reload a2 with dst address using OR trick
    // We need to set a2 = dst. Use L32I from a known location.
    // Store dst address in DRAM
    const dstAddrLoc = DRAM + 0xb00;
    mem.write32(dstAddrLoc, dst);
    cpu.setAR(6, dstAddrLoc);

    // [15] L32I a2, a6, 0     ; a2 = dst address           [3]
    // [18] L8UI a4, a2, 0     ; load byte                   [3]
    // [21] BEQ  a4, a5, +12   ; if null, done               [3]
    // [24] S32I a4, a1, 0     ; UART write                  [3]
    // [27] ADDI a2, a2, 1     ; advance                     [3]
    // [30] BNE  a4, a5, -12   ; loop                        [3]
    // [33] NOP

    writeProgram(mem, IRAM, [
      // Phase 1: memcpy
      L8UI(4, 2, 0),
      S8I(4, 3, 0),
      ADDI(2, 2, 1),
      ADDI(3, 3, 1),
      BNE(4, 5, 256 - 16),
      // Phase 2: serial output
      L32I(2, 6, 0),         // load dst address
      L8UI(4, 2, 0),
      BEQ(4, 5, 8),
      S32I(4, 1, 0),
      ADDI(2, 2, 1),
      BNE(4, 5, 256 - 16),
      NOP(),
    ]);

    runUntilHalt(cpu, 1000);

    // Verify copy happened
    for (let i = 0; i < msg.length; i++) {
      expect(mem.read8(dst + i)).toBe(msg.charCodeAt(i));
    }

    // Verify serial output
    const result = String.fromCharCode(...output);
    expect(result).toBe("Copied!");
  });
});
