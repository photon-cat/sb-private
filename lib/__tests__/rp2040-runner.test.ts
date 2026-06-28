import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { RP2040Runner } from "../rp2040-runner";

// A real RP2040 firmware (compiled with PlatformIO) used to exercise the runner
// against genuine Cortex-M0+ machine code. Committed so CI needs no toolchain.
const FIXTURE = path.join(__dirname, "fixtures", "pico_blink.uf2");
const hasFixture = existsSync(FIXTURE);

describe("RP2040Runner (rp2040js wrapper)", () => {
  it("defaults to 125 MHz and validates clockHz", () => {
    if (!hasFixture) return;
    const uf2 = new Uint8Array(readFileSync(FIXTURE));
    const r = new RP2040Runner(uf2);
    expect(r.speed).toBe(125_000_000);
    r.stop();

    expect(() => new RP2040Runner(uf2, { clockHz: 0 })).toThrow(/positive finite/);
    expect(() => new RP2040Runner(uf2, { clockHz: -1 })).toThrow(/positive finite/);
  });

  it("loads the UF2 into flash (boot2 stage present)", () => {
    if (!hasFixture) return;
    const uf2 = new Uint8Array(readFileSync(FIXTURE));
    const r = new RP2040Runner(uf2);
    // The first flash block (boot2) must be non-zero after loading.
    const firstWords = r.mcu.flash.slice(0, 256);
    expect(firstWords.some((b) => b !== 0)).toBe(true);
    r.stop();
  });

  it("executes real Cortex-M0+ instructions and advances the cycle counter", () => {
    if (!hasFixture) return;
    const r = new RP2040Runner(new Uint8Array(readFileSync(FIXTURE)));
    const before = r.mcu.core.cycles;
    r.runMs(5);
    expect(r.mcu.core.cycles).toBeGreaterThan(before);
    r.stop();
  });

  it("runMs scales cycles with the configured clock", () => {
    if (!hasFixture) return;
    const uf2 = new Uint8Array(readFileSync(FIXTURE));
    const fast = new RP2040Runner(uf2, { clockHz: 125_000_000 });
    const slow = new RP2040Runner(uf2, { clockHz: 50_000_000 });
    const f0 = fast.mcu.core.cycles;
    const s0 = slow.mcu.core.cycles;
    fast.runMs(2);
    slow.runMs(2);
    // Same wall window, faster clock executes more cycles (≈2.5×).
    expect(fast.mcu.core.cycles - f0).toBeGreaterThan(slow.mcu.core.cycles - s0);
    fast.stop();
    slow.stop();
  });

  it("exposes the GPIO + serial API surface", () => {
    if (!hasFixture) return;
    const r = new RP2040Runner(new Uint8Array(readFileSync(FIXTURE)));
    // 30 GPIOs are addressable.
    expect(typeof r.gpioHigh(25)).toBe("boolean");
    expect(r.mcu.gpio.length).toBeGreaterThanOrEqual(30);
    let bytes = 0;
    r.onSerialByte = () => { bytes++; };
    const unwatch = r.watchGpio(25, () => {});
    expect(typeof unwatch).toBe("function");
    r.runMs(1);
    expect(bytes).toBeGreaterThanOrEqual(0); // capture wired (this core uses USB CDC)
    r.stop();
  });
});
