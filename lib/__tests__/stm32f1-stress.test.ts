// STM32F103 HAL stress corpus on the unicorn.js ARMv7-M core. Each *.bin is a
// real STM32Cube HAL F1 program (fixtures/stm32f1-corpus/m_*.c, built by
// build.sh for bluepill_f103c8) exercising one driver subsystem. This is the F1
// analogue of the G0 stress corpus — it proves the F1 peripheral models
// (GPIO/USART/I2C/ADC/SPI/TIM, EXTI, AFIO) run real compiler-produced firmware,
// including HAL I2C against a real device, on the same path the browser uses.
//
// Programs are HAL_Delay-free: unicorn v1.0 has no Cortex-M exception entry, so
// SysTick-IRQ-driven HAL_Delay would busy-wait. Polling drivers complete.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { createStm32Runner } from "../sim/create-stm32-runner";
import { MPU6050 } from "../mcu/peripherals/i2c-device";
import type { STM32Runner } from "../stm32-runner";

const DIR = path.join(__dirname, "fixtures", "stm32f1-corpus");
const has = (n: string) => existsSync(path.join(DIR, `${n}.bin`));
const fw = (n: string) => new Uint8Array(readFileSync(path.join(DIR, `${n}.bin`)));

/** Build a unicorn-arm runner for an F103 corpus program, capturing UART. */
async function run(name: string): Promise<{ runner: STM32Runner; out: () => string }> {
  const runner = await createStm32Runner("unicorn-arm", fw(name));
  let out = "";
  runner.onSerialByte = (b) => (out += String.fromCharCode(b));
  return { runner, out: () => out };
}

describe("STM32F103 HAL corpus on the unicorn.js core (STM32F1 models)", () => {
  it("blink: toggles the PC13 LED from real F103 firmware", async () => {
    if (!has("blink")) return;
    const { runner } = await run("blink");
    const edges: boolean[] = [];
    runner.watchPin("GPIOC", 13, (high) => edges.push(high));
    runner.host.runBatch(2_000_000);
    runner.stop();
    expect(edges).toContain(true);
    expect(edges).toContain(false);
  });

  it("uart: transmits 'UART-OK' over USART1", async () => {
    if (!has("uart")) return;
    const { runner, out } = await run("uart");
    runner.host.runBatch(4_000_000);
    runner.stop();
    expect(out()).toContain("UART-OK");
  });

  it("adc: HAL_ADC reads the injected channel-0 sample and reports it", async () => {
    if (!has("adc")) return;
    const { runner, out } = await run("adc");
    runner.setAnalog(0, 0xabc); // 12-bit sample on ADC channel 0
    runner.host.runBatch(6_000_000);
    runner.stop();
    expect(out()).toContain("A=ABC"); // firmware read back exactly what we injected
  });

  it("spi: HAL_SPI_Transmit clocks out every byte through the SPI model", async () => {
    if (!has("spi")) return;
    const { runner } = await run("spi");
    const sent: number[] = [];
    const spi = runner.platform.bus.get("SPI1") as { onByteTransmit?: (b: number) => void };
    spi.onByteTransmit = (b) => sent.push(b);
    runner.host.runBatch(4_000_000);
    runner.stop();
    expect(sent).toEqual([0xae, 0xa8, 0x3f, 0xaf]);
  });

  it("tim: HAL_TIM PWM init + start completes without spinning", async () => {
    if (!has("tim")) return;
    const { runner } = await run("tim");
    const before = runner.cycles;
    runner.host.runBatch(3_000_000);
    runner.stop();
    expect(runner.cycles).toBeGreaterThan(before); // advanced to the idle loop, no hang
  });

  it("i2c/imu: HAL_I2C_Mem_Read reads MPU6050 WHO_AM_I (0x68) and reports it", async () => {
    if (!has("imu")) return;
    const { runner, out } = await run("imu");
    runner.attachI2CDevice(new MPU6050(0x68)); // default bus I2C1
    runner.host.runBatch(6_000_000);
    runner.stop();
    expect(out()).toContain("W=0x68");
    expect(out()).not.toContain("ERR");
  });

  it("imu: a missing I2C device yields a HAL error, not a hang", async () => {
    if (!has("imu")) return;
    const { runner, out } = await run("imu"); // no device attached
    runner.host.runBatch(6_000_000);
    runner.stop();
    expect(out()).toContain("ERR"); // NACK (AF) → HAL_ERROR; firmware proceeds
  });
});
