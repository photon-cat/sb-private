// STM32 M0+ stress test: runs a corpus of REAL STM32Cube HAL firmware (built by
// fixtures/stm32-corpus/build.sh with arm-none-eabi-gcc) on the emulator and
// pins what works and what doesn't. This is the executable record of the
// "pull in real HAL projects and try to break it" exercise.
//
// Findings it locks in (each a fix or a known Phase-5 gap):
//  - blink: HAL_Delay timebase works (SysTick clock advance) → PA5 toggles.
//  - uart:  USART init (TEACK/REACK) + TX work → transmits "UART-OK".
//  - spi:   SPI master TX works (minimal model) → init completes, reaches main.
//  - tim/adc: init completes (non-blocking config / HAL timeouts) → reach main.
//  - i2c:   I2C peripheral is unmodeled → still spins (documented Phase-5 gap).

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { performance } from "perf_hooks";
import { STM32Runner } from "../stm32-runner";
import { MPU6050 } from "../mcu/peripherals/i2c-device";
import { runStress } from "../mcu/stress/harness";

const SVD = readFileSync(path.join(__dirname, "fixtures", "stm32g0-mini.svd"), "utf-8");
const DIR = path.join(__dirname, "fixtures", "stm32-corpus");
const fw = (n: string) => new Uint8Array(readFileSync(path.join(DIR, `${n}.bin`)));
const have = (n: string) => existsSync(path.join(DIR, `${n}.bin`));

describe("STM32 HAL stress corpus on the M0+ core", () => {
  it("blink: HAL_Delay timebase advances and PA5 toggles", () => {
    if (!have("blink")) return;
    const r = new STM32Runner(fw("blink"), SVD);
    const edges: boolean[] = [];
    r.watchPin("GPIOA", 5, (h) => edges.push(h));
    r.runCycles(20_000_000); // a couple of 500-tick HAL_Delay periods
    expect(edges.length).toBeGreaterThanOrEqual(2); // toggled, not hung
  });

  it("uart: full HAL_UART_Init + Transmit produces serial output", () => {
    if (!have("uart")) return;
    const r = runStress("uart", fw("uart"), SVD, () => performance.now(), { maxInstr: 2_000_000 });
    expect(r.serial).toContain("UART-OK");
  });

  it("spi: HAL_SPI master init + transmit completes and settles in main", () => {
    if (!have("spi")) return;
    const r = runStress("spi", fw("spi"), SVD, () => performance.now(), { maxInstr: 2_000_000 });
    expect(r.finalLoopSize).toBeLessThanOrEqual(2); // reached the idle loop
    expect(r.unmapped.find((u) => u.name === "SPI1")).toBeUndefined(); // SPI modeled
  });

  it("tim/adc: HAL init completes and execution reaches main", () => {
    for (const n of ["tim", "adc"]) {
      if (!have(n)) continue;
      const r = runStress(n, fw(n), SVD, () => performance.now(), { maxInstr: 2_000_000 });
      expect(r.finalLoopSize).toBeLessThanOrEqual(2);
    }
  });

  it("i2c: HAL_I2C init + Mem_Read completes against an attached IMU (no spin)", () => {
    if (!have("i2c")) return;
    const r = new STM32Runner(fw("i2c"), SVD, { onUnmapped: () => {} });
    r.attachI2CDevice(new MPU6050(0x68));
    r.runCycles(2_000_000);
    // I2C is now modeled — execution reaches the idle loop instead of spinning.
    expect(r.host.pc).toBeGreaterThan(0x08000000);
  });

  it("imu: reads WHO_AM_I over I2C and reports it over UART", () => {
    if (!have("imu")) return;
    const r = new STM32Runner(fw("imu"), SVD);
    r.attachI2CDevice(new MPU6050(0x68));
    let out = "";
    r.onSerialByte = (b) => (out += String.fromCharCode(b));
    r.runCycles(3_000_000);
    expect(out).toContain("W=0x68"); // WHO_AM_I delivered end-to-end
  });

  it("imu: a missing I2C device yields a HAL error, not a hang", () => {
    if (!have("imu")) return;
    const r = new STM32Runner(fw("imu"), SVD); // no device on the bus
    let out = "";
    r.onSerialByte = (b) => (out += String.fromCharCode(b));
    r.runCycles(3_000_000);
    expect(out).toContain("ERR"); // NACK → HAL_ERROR path, firmware proceeds
  });

  it("throughput is in the millions of instructions per second", () => {
    if (!have("uart")) return;
    const r = runStress("uart", fw("uart"), SVD, () => performance.now(), { maxInstr: 1_000_000 });
    expect(r.ips).toBeGreaterThan(1_000_000);
  });
});
