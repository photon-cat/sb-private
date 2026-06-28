import { describe, it, expect } from "vitest";
import { AVRRunner } from "../avr-runner";

// Minimal valid Intel HEX: 4 NOP instructions (0x0000) + EOF record
const NOP_HEX = [
  ":080000000000000000000000F8",
  ":00000001FF",
].join("\n");

describe("AVRRunner", () => {
  it("defaults to 16 MHz clock speed", () => {
    const runner = new AVRRunner(NOP_HEX);
    expect(runner.speed).toBe(16e6);
    runner.stop();
  });

  it("accepts custom clock speed via options", () => {
    const runner = new AVRRunner(NOP_HEX, { clockHz: 8e6 });
    expect(runner.speed).toBe(8e6);
    runner.stop();
  });

  it("accepts 1 MHz clock", () => {
    const runner = new AVRRunner(NOP_HEX, { clockHz: 1e6 });
    expect(runner.speed).toBe(1e6);
    runner.stop();
  });

  it("accepts 20 MHz clock (ATmega328P max)", () => {
    const runner = new AVRRunner(NOP_HEX, { clockHz: 20e6 });
    expect(runner.speed).toBe(20e6);
    runner.stop();
  });

  it("runs cycles synchronously with custom speed", () => {
    const runner = new AVRRunner(NOP_HEX, { clockHz: 8e6 });
    const startCycles = runner.cpu.cycles;
    runner.runMs(1);
    const elapsed = runner.cpu.cycles - startCycles;
    // 1ms at 8MHz = 8000 cycles
    expect(elapsed).toBe(8000);
    runner.stop();
  });

  it("runMs respects default 16 MHz speed", () => {
    const runner = new AVRRunner(NOP_HEX);
    const startCycles = runner.cpu.cycles;
    runner.runMs(1);
    const elapsed = runner.cpu.cycles - startCycles;
    expect(elapsed).toBe(16000);
    runner.stop();
  });

  it("rejects clockHz of 0", () => {
    expect(() => new AVRRunner(NOP_HEX, { clockHz: 0 })).toThrow("clockHz must be a positive finite number");
  });

  it("rejects negative clockHz", () => {
    expect(() => new AVRRunner(NOP_HEX, { clockHz: -1 })).toThrow("clockHz must be a positive finite number");
  });

  it("rejects NaN clockHz", () => {
    expect(() => new AVRRunner(NOP_HEX, { clockHz: NaN })).toThrow("clockHz must be a positive finite number");
  });

  it("rejects Infinity clockHz", () => {
    expect(() => new AVRRunner(NOP_HEX, { clockHz: Infinity })).toThrow("clockHz must be a positive finite number");
  });
});
