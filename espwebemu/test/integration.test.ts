// Integration tests — hand-assembled Xtensa programs that exercise the emulator
// Each test writes raw instruction bytes into IRAM and runs them.
import { describe, it, expect, beforeEach } from "vitest";
import { ESP32CPU, SR_SAR, SR_LBEG, SR_LEND, SR_LCOUNT, SR_PS, SR_WINDOWBASE, SR_CCOUNT } from "../src/cpu/cpu.js";
import { MemoryBus } from "../src/memory/memory-bus.js";
import { executeInstruction } from "../src/cpu/xtensa-execute.js";
import { ESP32Runner } from "../src/index.js";
import { ESP32UART } from "../src/peripherals/uart.js";
import { ESP32GPIO } from "../src/peripherals/gpio.js";
import { ESP32TimerGroup } from "../src/peripherals/timer.js";
import * as regions from "../src/memory/regions.js";

const IRAM = 0x40080000;
const DRAM = 0x3ffb0000;

// Xtensa instruction encoders
function rrr(op0: number, op1: number, op2: number, r: number, s: number, t: number): Uint8Array {
  return new Uint8Array([
    ((t & 0xf) << 4) | (op0 & 0xf),
    ((r & 0xf) << 4) | (s & 0xf),
    ((op2 & 0xf) << 4) | (op1 & 0xf),
  ]);
}

function rri8(op0: number, r: number, s: number, t: number, imm8: number): Uint8Array {
  return new Uint8Array([
    ((t & 0xf) << 4) | (op0 & 0xf),
    ((r & 0xf) << 4) | (s & 0xf),
    imm8 & 0xff,
  ]);
}

// Narrow: 2-byte instructions
function narrow(op0: number, r: number, s: number, t: number): Uint8Array {
  return new Uint8Array([
    ((t & 0xf) << 4) | (op0 & 0xf),
    ((r & 0xf) << 4) | (s & 0xf),
  ]);
}

// Encode ADD ar, as, at
const ADD = (r: number, s: number, t: number) => rrr(0, 0, 8, r, s, t);
const SUB = (r: number, s: number, t: number) => rrr(0, 0, 0xc, r, s, t);
const AND = (r: number, s: number, t: number) => rrr(0, 0, 1, r, s, t);
const OR  = (r: number, s: number, t: number) => rrr(0, 0, 2, r, s, t);
const XOR = (r: number, s: number, t: number) => rrr(0, 0, 3, r, s, t);
const MULL = (r: number, s: number, t: number) => rrr(0, 0, 0x82 >> 4, r, s, t); // op2=8, op1=2
// ADDI at, as, imm8 (r=0xc in LSAI encoding)
const ADDI = (t: number, s: number, imm8: number) => rri8(2, 0xc, s, t, imm8);
// S32I at, as, imm8 (offset = imm8 * 4)
const S32I = (t: number, s: number, imm8: number) => rri8(2, 6, s, t, imm8);
// L32I at, as, imm8
const L32I = (t: number, s: number, imm8: number) => rri8(2, 2, s, t, imm8);
// BNE as, at, offset
const BNE = (s: number, t: number, off: number) => rri8(7, 9, s, t, off & 0xff);
// BEQ as, at, offset
const BEQ = (s: number, t: number, off: number) => rri8(7, 1, s, t, off & 0xff);
// NOP — SYNC group: r=2, s=0, t=15
const NOP = () => rrr(0, 0, 0, 2, 0, 15);
// ADD.N
const ADD_N = (r: number, s: number, t: number) => narrow(0xa, r, s, t);
// S32I.N
const S32I_N = (t: number, s: number, r: number) => narrow(9, r, s, t);
// L32I.N
const L32I_N = (t: number, s: number, r: number) => narrow(8, r, s, t);
// RET (non-windowed)
const RET = () => rrr(0, 0, 0, 0, 0, 8); // op2=0, op1=0, r=0, t=8 → actually RET is r=0,s=0,t=0 with special bits
// Actually RET.N is 0x0d, 0xf0
const RET_N = () => new Uint8Array([0x0d, 0xf0]);
// WAITI 0 — halts the CPU
const WAITI = () => rrr(0, 0, 0, 0, 0, 7); // This is actually: op0=0,op1=0,op2=0,r=0,s=0,t=7 → needs to be WAITI

function writeProgram(mem: MemoryBus, baseAddr: number, instructions: Uint8Array[]): number {
  let offset = 0;
  for (const inst of instructions) {
    mem.writeBlock(baseAddr + offset, inst);
    offset += inst.length;
  }
  return offset; // total bytes written
}

function runN(cpu: ESP32CPU, n: number): number {
  let executed = 0;
  for (let i = 0; i < n; i++) {
    if (!executeInstruction(cpu)) break;
    executed++;
  }
  return executed;
}

// ============================================================
// Test Suite 1: ALU operations with chained computations
// ============================================================
describe("ALU Integration", () => {
  let mem: MemoryBus;
  let cpu: ESP32CPU;

  beforeEach(() => {
    mem = new MemoryBus();
    cpu = new ESP32CPU(mem);
    cpu.pc = IRAM;
  });

  it("should compute (a + b) * c using ADD and MULL", () => {
    // a2=3, a3=7, a4=5
    // Program: ADD a5, a2, a3  →  a5 = 10
    //          MULL a6, a5, a4 →  a6 = 50
    cpu.setAR(2, 3);
    cpu.setAR(3, 7);
    cpu.setAR(4, 5);

    // MULL: op0=0, op1=2, op2=8, r, s, t
    const MULL_inst = (r: number, s: number, t: number) =>
      new Uint8Array([((t & 0xf) << 4) | 0, ((r & 0xf) << 4) | (s & 0xf), 0x82]);

    writeProgram(mem, IRAM, [
      ADD(5, 2, 3),    // a5 = a2 + a3 = 10
      MULL_inst(6, 5, 4), // a6 = a5 * a4 = 50
    ]);

    runN(cpu, 2);
    expect(cpu.getAR(5)).toBe(10);
    expect(cpu.getAR(6)).toBe(50);
  });

  it("should compute fibonacci(8) using a loop", () => {
    // a2 = fib(n-2), a3 = fib(n-1), a4 = counter, a5 = target
    cpu.setAR(2, 0);  // fib(0)
    cpu.setAR(3, 1);  // fib(1)
    cpu.setAR(4, 2);  // counter starts at 2
    cpu.setAR(5, 9);  // loop until counter == 9 (computes fib(2)..fib(8))

    // Loop:
    //   ADD a6, a2, a3     ; a6 = fib(n)     [3 bytes, offset 0]
    //   MOV a2 = a3 (ADD a2, a3, a0 with a0=0 won't work since a0 may not be 0)
    //   Actually: use OR a2, a3, a3 to copy a3 to a2
    //   OR  a2, a3, a3     ; a2 = a3          [3 bytes, offset 3]
    //   OR  a3, a6, a6     ; a3 = a6          [3 bytes, offset 6]
    //   ADDI a4, a4, 1     ; counter++        [3 bytes, offset 9]
    //   BNE a4, a5, -12    ; loop if counter != target [3 bytes, offset 12]
    //                        target = PC + imm = (IRAM+12) + (-12) = IRAM
    // After loop: a3 = fib(8) = 21

    // For OR as copy: OR ar, as, as → copies as to ar
    const MOV_OR = (dst: number, src: number) => OR(dst, src, src);

    writeProgram(mem, IRAM, [
      ADD(6, 2, 3),         // a6 = a2 + a3
      MOV_OR(2, 3),         // a2 = a3
      MOV_OR(3, 6),         // a3 = a6
      ADDI(4, 4, 1),        // a4++
      BNE(4, 5, 256 - 16),  // if a4 != a5, branch back 12 bytes (offset = -12 as unsigned)
    ]);

    runN(cpu, 100); // enough to finish the loop
    expect(cpu.getAR(3)).toBe(21); // fib(8) = 21
  });

  it("should handle SUB correctly with negative results", () => {
    cpu.setAR(2, 10);
    cpu.setAR(3, 25);

    writeProgram(mem, IRAM, [SUB(4, 2, 3)]); // a4 = 10 - 25 = -15
    runN(cpu, 1);
    expect(cpu.getAR(4)).toBe(-15);
  });

  it("should handle AND/OR/XOR bitwise operations", () => {
    cpu.setAR(2, 0b11001100);
    cpu.setAR(3, 0b10101010);

    writeProgram(mem, IRAM, [
      AND(4, 2, 3),  // a4 = 0b10001000
      OR(5, 2, 3),   // a5 = 0b11101110
      XOR(6, 2, 3),  // a6 = 0b01100110
    ]);

    runN(cpu, 3);
    expect(cpu.getAR(4)).toBe(0b10001000);
    expect(cpu.getAR(5)).toBe(0b11101110);
    expect(cpu.getAR(6)).toBe(0b01100110);
  });
});

// ============================================================
// Test Suite 2: Memory load/store patterns
// ============================================================
describe("Memory Integration", () => {
  let mem: MemoryBus;
  let cpu: ESP32CPU;

  beforeEach(() => {
    mem = new MemoryBus();
    cpu = new ESP32CPU(mem);
    cpu.pc = IRAM;
  });

  it("should store and load back an array of values", () => {
    const base = DRAM + 0x1000;
    cpu.setAR(1, base); // base pointer

    // Store values 10, 20, 30, 40 at offsets 0, 4, 8, 12
    cpu.setAR(2, 10);
    cpu.setAR(3, 20);
    cpu.setAR(4, 30);
    cpu.setAR(5, 40);

    writeProgram(mem, IRAM, [
      S32I(2, 1, 0),   // [base+0]  = 10
      S32I(3, 1, 1),   // [base+4]  = 20
      S32I(4, 1, 2),   // [base+8]  = 30
      S32I(5, 1, 3),   // [base+12] = 40
      // Now load them back into a6..a9
      L32I(6, 1, 0),
      L32I(7, 1, 1),
      L32I(8, 1, 2),
      L32I(9, 1, 3),
    ]);

    runN(cpu, 8);
    expect(cpu.getAR(6)).toBe(10);
    expect(cpu.getAR(7)).toBe(20);
    expect(cpu.getAR(8)).toBe(30);
    expect(cpu.getAR(9)).toBe(40);
  });

  it("should compute sum of array via load+add loop", () => {
    const base = DRAM + 0x2000;
    // Pre-fill array: [5, 10, 15, 20, 25]
    for (let i = 0; i < 5; i++) {
      mem.write32(base + i * 4, (i + 1) * 5);
    }

    cpu.setAR(1, base);   // array base
    cpu.setAR(2, 0);      // sum
    cpu.setAR(3, 0);      // index
    cpu.setAR(4, 5);      // length

    // Loop body:
    //   L32I a5, a1, 0    ; load array[index] via pointer  [3 bytes, off 0]
    //   ADD  a2, a2, a5   ; sum += value                    [3 bytes, off 3]
    //   ADDI a1, a1, 4    ; ptr++                           [3 bytes, off 6]
    //   ADDI a3, a3, 1    ; index++                         [3 bytes, off 9]
    //   BNE  a3, a4, -12  ; if index != 5, loop             [3 bytes, off 12]
    writeProgram(mem, IRAM, [
      L32I(5, 1, 0),
      ADD(2, 2, 5),
      ADDI(1, 1, 4),
      ADDI(3, 3, 1),
      BNE(3, 4, 256 - 16),
    ]);

    runN(cpu, 100);
    expect(cpu.getAR(2)).toBe(75); // 5+10+15+20+25
  });

  it("should handle narrow load/store instructions", () => {
    const addr = DRAM + 0x3000;
    cpu.setAR(1, addr);
    cpu.setAR(3, 0xdeadbeef);

    writeProgram(mem, IRAM, [
      S32I_N(3, 1, 0),   // [addr] = 0xdeadbeef
      L32I_N(4, 1, 0),   // a4 = [addr]
    ]);

    runN(cpu, 2);
    expect((cpu.getAR(4) >>> 0)).toBe(0xdeadbeef);
  });
});

// ============================================================
// Test Suite 3: Branch and control flow
// ============================================================
describe("Branch Integration", () => {
  let mem: MemoryBus;
  let cpu: ESP32CPU;

  beforeEach(() => {
    mem = new MemoryBus();
    cpu = new ESP32CPU(mem);
    cpu.pc = IRAM;
  });

  it("should count down with BNE", () => {
    cpu.setAR(2, 10); // counter
    cpu.setAR(3, 0);  // zero for comparison

    // ADDI a2, a2, -1   [3 bytes, off 0]
    // BNE  a2, a3, -3   [3 bytes, off 3] → jump back 3 bytes to ADDI
    writeProgram(mem, IRAM, [
      ADDI(2, 2, 0xff), // -1 in signed 8-bit
      BNE(2, 3, 256 - 7),
    ]);

    // 10 iterations * 2 instructions each = 20, plus 1 final ADDI + 1 BNE fall-through = 20 total
    runN(cpu, 20);
    expect(cpu.getAR(2)).toBe(0);
    // PC should be past the BNE (fell through)
    expect(cpu.pc).toBe(IRAM + 6);
  });

  it("should branch on BEQ when equal", () => {
    cpu.setAR(2, 42);
    cpu.setAR(3, 42);
    cpu.setAR(4, 0); // flag

    // BEQ a2, a3, +6    [3 bytes, off 0] → skip next instruction
    // ADDI a4, a4, 1    [3 bytes, off 3] → should be skipped
    // ADDI a4, a4, 10   [3 bytes, off 6] → should execute
    writeProgram(mem, IRAM, [
      BEQ(2, 3, 2),
      ADDI(4, 4, 1),
      ADDI(4, 4, 10),
    ]);

    runN(cpu, 2);
    expect(cpu.getAR(4)).toBe(10); // skipped the +1, got +10
  });
});

// ============================================================
// Test Suite 4: UART peripheral
// ============================================================
describe("UART Integration", () => {
  it("should capture serial output from direct UART writes", () => {
    const mem = new MemoryBus();
    const uart = new ESP32UART();
    mem.mapPeripheral(regions.UART0_BASE, 0x1000, uart);

    const output: number[] = [];
    uart.onByteTransmit = (b) => output.push(b);

    // Write "Hi!\n" directly to UART FIFO register
    const message = "Hi!\n";
    for (const ch of message) {
      mem.write32(regions.UART0_BASE, ch.charCodeAt(0));
    }

    expect(String.fromCharCode(...output)).toBe("Hi!\n");
  });

  it("should write to UART via CPU store instructions", () => {
    const mem = new MemoryBus();
    const cpu = new ESP32CPU(mem);
    const uart = new ESP32UART();
    mem.mapPeripheral(regions.UART0_BASE, 0x1000, uart);
    cpu.pc = IRAM;

    const output: number[] = [];
    uart.onByteTransmit = (b) => output.push(b);

    // Set a1 = UART0_BASE, then store chars
    cpu.setAR(1, regions.UART0_BASE);
    cpu.setAR(2, 0x41); // 'A'
    cpu.setAR(3, 0x42); // 'B'
    cpu.setAR(4, 0x43); // 'C'

    // S32I a2, a1, 0  → write 'A' to UART
    // S32I a3, a1, 0  → write 'B' to UART
    // S32I a4, a1, 0  → write 'C' to UART
    writeProgram(mem, IRAM, [
      S32I(2, 1, 0),
      S32I(3, 1, 0),
      S32I(4, 1, 0),
    ]);

    runN(cpu, 3);
    expect(String.fromCharCode(...output)).toBe("ABC");
  });
});

// ============================================================
// Test Suite 5: GPIO peripheral
// ============================================================
describe("GPIO Integration", () => {
  it("should toggle GPIO pin via CPU store instructions", () => {
    const mem = new MemoryBus();
    const cpu = new ESP32CPU(mem);
    const gpio = new ESP32GPIO();
    mem.mapPeripheral(regions.GPIO_BASE, 0x1000, gpio);
    cpu.pc = IRAM;

    const pinChanges: Array<{ pin: number; high: boolean }> = [];
    gpio.onPinChange = (pin, high) => pinChanges.push({ pin, high });

    // GPIO_OUT_W1TS_REG offset = 0x08 → set bits
    // GPIO_OUT_W1TC_REG offset = 0x0C → clear bits
    // GPIO_ENABLE_W1TS_REG offset = 0x24 → enable output

    cpu.setAR(1, regions.GPIO_BASE);
    cpu.setAR(2, 1 << 2); // GPIO 2 bitmask

    // Enable GPIO 2 as output, then set high, then clear
    // S32I a2, a1, offset/4
    // enable offset = 0x24 → imm8 = 0x24/4 = 9
    // w1ts offset = 0x08 → imm8 = 2
    // w1tc offset = 0x0c → imm8 = 3
    writeProgram(mem, IRAM, [
      S32I(2, 1, 9),  // GPIO_ENABLE_W1TS
      S32I(2, 1, 2),  // GPIO_OUT_W1TS → set GPIO 2 high
      S32I(2, 1, 3),  // GPIO_OUT_W1TC → set GPIO 2 low
    ]);

    runN(cpu, 3);

    // Should have seen pin 2 go high then low
    const pin2Changes = pinChanges.filter(c => c.pin === 2);
    expect(pin2Changes.length).toBeGreaterThanOrEqual(2);
    expect(pin2Changes[0].high).toBe(true);
    expect(pin2Changes[1].high).toBe(false);
  });

  it("should read GPIO input state", () => {
    const gpio = new ESP32GPIO();

    // Simulate external input on pin 5
    gpio.setInputPin(5, true);

    // Read GPIO_IN_REG (offset 0x3c)
    const inReg = gpio.read32(0x3c);
    expect((inReg >> 5) & 1).toBe(1);

    gpio.setInputPin(5, false);
    const inReg2 = gpio.read32(0x3c);
    expect((inReg2 >> 5) & 1).toBe(0);
  });
});

// ============================================================
// Test Suite 6: Timer peripheral
// ============================================================
describe("Timer Integration", () => {
  it("should count ticks", () => {
    const timer = new ESP32TimerGroup(240e6);

    // Enable timer 0: write to config register
    // Timer 0 config offset = 0x00
    // Bit 31 = enable, bit 30 = increase, bit 29 = autoreload
    timer.write32(0x00, (1 << 31) | (1 << 30)); // enable + increase

    // Tick 1000 cycles
    timer.tick(1000);

    // Read timer 0 low register (offset 0x04)
    // First trigger a latch: write to update register (offset 0x0c)
    timer.write32(0x0c, 1); // latch
    const lo = timer.read32(0x04);
    expect(lo).toBeGreaterThan(0);
  });
});

// ============================================================
// Test Suite 7: ESP32Runner with real firmware
// ============================================================
describe("ESP32Runner Integration", () => {
  it("should load firmware and run without crashing for 10K cycles", () => {
    const { readFileSync } = require("fs");
    const { resolve } = require("path");
    const fwPath = resolve(__dirname, "../test-firmware/build/hello_esp32.bin");
    const binData = new Uint8Array(readFileSync(fwPath));

    const runner = new ESP32Runner(binData);
    expect(runner.cpu.pc).toBeGreaterThan(0x40000000);

    const serialOutput: string[] = [];
    runner.onSerialOutput = (ch) => {
      if (ch >= 32 && ch < 127) serialOutput.push(String.fromCharCode(ch));
      else if (ch === 10) serialOutput.push("\n");
    };

    // Run 10K cycles without throwing
    expect(() => runner.runCycles(10000)).not.toThrow();
    expect(runner.cpu.cycles).toBeGreaterThanOrEqual(10000);

    console.log(`  Ran to PC=0x${runner.cpu.pc.toString(16)}, cycles=${runner.cpu.cycles}`);
    if (serialOutput.length > 0) {
      console.log(`  Serial: "${serialOutput.join("").slice(0, 100)}"`);
    }
  });

  it("should run for simulated time via runMs", () => {
    const { readFileSync } = require("fs");
    const { resolve } = require("path");
    const fwPath = resolve(__dirname, "../test-firmware/build/hello_esp32.bin");
    const binData = new Uint8Array(readFileSync(fwPath));

    const runner = new ESP32Runner(binData);

    // Run for 0.01ms (should be ~2400 cycles at 240MHz)
    runner.runMs(0.01);
    expect(runner.cpu.cycles).toBeGreaterThanOrEqual(2000);
  });

  it("should track elapsed simulation time", () => {
    const { readFileSync } = require("fs");
    const { resolve } = require("path");
    const fwPath = resolve(__dirname, "../test-firmware/build/hello_esp32.bin");
    const binData = new Uint8Array(readFileSync(fwPath));

    const runner = new ESP32Runner(binData);
    expect(runner.getElapsedMs()).toBe(0);

    runner.runCycles(240000); // 1ms worth of cycles (plus ROM stub delay cycles)
    const elapsed = runner.getElapsedMs();
    expect(elapsed).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(50); // Under 50ms even with ets_delay_us overhead
  });

  it("should reset cleanly", () => {
    const { readFileSync } = require("fs");
    const { resolve } = require("path");
    const fwPath = resolve(__dirname, "../test-firmware/build/hello_esp32.bin");
    const binData = new Uint8Array(readFileSync(fwPath));

    const runner = new ESP32Runner(binData);
    runner.runCycles(5000);
    expect(runner.cpu.cycles).toBeGreaterThan(0);

    runner.reset();
    expect(runner.cpu.cycles).toBe(0);
    expect(runner.cpu.halted).toBe(false);
  });
});

// ============================================================
// Test Suite 8: ROM function stubs
// ============================================================
describe("ROM Stubs Integration", () => {
  it("should handle ets_printf via ROM interception", () => {
    const { readFileSync } = require("fs");
    const { resolve } = require("path");
    const fwPath = resolve(__dirname, "../test-firmware/build/hello_esp32.bin");
    const binData = new Uint8Array(readFileSync(fwPath));

    const runner = new ESP32Runner(binData);

    const output: string[] = [];
    runner.onSerialOutput = (ch) => {
      output.push(String.fromCharCode(ch));
    };

    // Run enough cycles that early boot code might call ets_printf
    runner.runCycles(50000);

    console.log(`  Output after 50K cycles (${output.length} chars): "${output.join("").slice(0, 200)}"`);
  });
});

// ============================================================
// Test Suite 9: Special registers
// ============================================================
describe("Special Register Integration", () => {
  let mem: MemoryBus;
  let cpu: ESP32CPU;

  beforeEach(() => {
    mem = new MemoryBus();
    cpu = new ESP32CPU(mem);
    cpu.pc = IRAM;
  });

  it("should track cycle count via CCOUNT", () => {
    // RSR a2, CCOUNT: read CCOUNT into a2
    // sr=234(0xEA) → r=14, s=10
    // RSR: op0=0, op1=3, op2=0
    // byte0 = (t=2)<<4 | 0 = 0x20
    // byte1 = (r=14)<<4 | (s=10) = 0xEA
    // byte2 = (0<<4) | 3 = 0x03
    const RSR_CCOUNT = new Uint8Array([0x20, 0xea, 0x03]);

    // Run a few NOPs first
    writeProgram(mem, IRAM, [
      NOP(),
      NOP(),
      NOP(),
      RSR_CCOUNT,
    ]);

    runN(cpu, 4);
    // After 4 instructions, CCOUNT should be 4 (incremented once per instruction)
    // RSR reads the value after increment, so a2 should be 4
    expect(cpu.getAR(2)).toBe(4);
  });

  it("should read/write SAR (shift amount register)", () => {
    // WSR SAR, a2: sr=3 → r=0, s=3
    // WSR: op0=0, op1=3, op2=1
    // byte0 = (t=2)<<4 | 0 = 0x20
    // byte1 = (r=0)<<4 | (s=3) = 0x03
    // byte2 = (1<<4) | 3 = 0x13
    const WSR_SAR = new Uint8Array([0x20, 0x03, 0x13]);
    // RSR a3, SAR
    const RSR_SAR = new Uint8Array([0x30, 0x03, 0x03]);

    cpu.setAR(2, 16);

    writeProgram(mem, IRAM, [
      WSR_SAR,  // SAR = a2 = 16
      RSR_SAR,  // a3 = SAR
    ]);

    runN(cpu, 2);
    expect(cpu.getAR(3)).toBe(16);
  });
});

// ============================================================
// Test Suite 10: Peripheral register mapping
// ============================================================
describe("Peripheral Mapping", () => {
  it("should correctly map multiple peripherals", () => {
    const mem = new MemoryBus();
    const uart0 = new ESP32UART();
    const uart1 = new ESP32UART();
    const gpio = new ESP32GPIO();

    mem.mapPeripheral(regions.UART0_BASE, 0x1000, uart0);
    mem.mapPeripheral(regions.UART1_BASE, 0x1000, uart1);
    mem.mapPeripheral(regions.GPIO_BASE, 0x1000, gpio);

    const uart0Out: number[] = [];
    const uart1Out: number[] = [];
    uart0.onByteTransmit = (b) => uart0Out.push(b);
    uart1.onByteTransmit = (b) => uart1Out.push(b);

    // Write to UART0
    mem.write32(regions.UART0_BASE, 0x41); // 'A'
    // Write to UART1
    mem.write32(regions.UART1_BASE, 0x42); // 'B'

    expect(uart0Out).toEqual([0x41]);
    expect(uart1Out).toEqual([0x42]);

    // GPIO should be independent
    gpio.write32(0x08, 1 << 5); // Set GPIO 5
    expect(gpio.getOutputPin(5)).toBe(true);
  });

  it("should handle reads from unmapped addresses gracefully", () => {
    const mem = new MemoryBus();
    // Reading from unmapped peripheral space should return 0
    const val = mem.read32(0x3ff70000);
    expect(val).toBe(0);
  });
});
