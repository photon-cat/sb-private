import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { PinState } from "avr8js";
import { AVRRunner } from "../avr-runner";

// Real compiled "blink" firmware (toggles pin 13 = PB5 every 1000ms at 16MHz).
// Committed fixture so this test needs no toolchain in CI.
const BLINK_HEX = readFileSync(
  path.join(__dirname, "fixtures", "blink.hex"),
  "utf-8",
);

const PIN13_PORT_BIT = 5; // Arduino D13 maps to PORTB bit 5

describe("clock speed affects simulated timing", () => {
  it("defaults to 16 MHz", () => {
    expect(new AVRRunner(BLINK_HEX).speed).toBe(16e6);
  });

  it("runMs converts milliseconds to cycles using the configured clock", () => {
    const r16 = new AVRRunner(BLINK_HEX, { clockHz: 16e6 });
    const r8 = new AVRRunner(BLINK_HEX, { clockHz: 8e6 });

    const before16 = r16.cpu.cycles;
    const before8 = r8.cpu.cycles;
    r16.runMs(1000);
    r8.runMs(1000);

    const ran16 = r16.cpu.cycles - before16;
    const ran8 = r8.cpu.cycles - before8;

    // 1000ms at 16MHz ≈ 16M cycles; at 8MHz ≈ 8M cycles. runCycles overshoots
    // the target by at most one multi-cycle instruction (a handful of cycles).
    expect(Math.abs(ran16 - 16_000_000)).toBeLessThan(10);
    expect(Math.abs(ran8 - 8_000_000)).toBeLessThan(10);
    // The defining contract: half the clock runs half the cycles per ms.
    expect(ran16 / ran8).toBeCloseTo(2, 4);

    r16.stop();
    r8.stop();
  });

  it("computation is clock-independent: equal cycles yield equal pin state", () => {
    const r16 = new AVRRunner(BLINK_HEX, { clockHz: 16e6 });
    const r8 = new AVRRunner(BLINK_HEX, { clockHz: 8e6 });

    // The clock changes only the time→cycle mapping, never the instruction
    // stream. After the same number of cycles both CPUs are in the same state.
    r16.runCycles(5_000_000);
    r8.runCycles(5_000_000);

    expect(r8.cpu.pc).toBe(r16.cpu.pc);
    expect(r8.portB.pinState(PIN13_PORT_BIT)).toBe(
      r16.portB.pinState(PIN13_PORT_BIT),
    );

    r16.stop();
    r8.stop();
  });

  it("blink toggles pin 13 within one second of simulated time at 16MHz", () => {
    const runner = new AVRRunner(BLINK_HEX, { clockHz: 16e6 });
    const stateAt = (ms: number): boolean => {
      // run forward to an absolute simulated-ms mark
      const targetCycles = Math.round((ms / 1000) * runner.speed);
      if (runner.cpu.cycles < targetCycles) {
        runner.runCycles(targetCycles - runner.cpu.cycles);
      }
      return runner.portB.pinState(PIN13_PORT_BIT) === PinState.High;
    };

    // Sample across two full 1s half-periods; the pin must take both states.
    const samples = [50, 250, 500, 1050, 1300, 1600].map(stateAt);
    expect(samples.some((s) => s === true)).toBe(true);
    expect(samples.some((s) => s === false)).toBe(true);

    runner.stop();
  });
});
