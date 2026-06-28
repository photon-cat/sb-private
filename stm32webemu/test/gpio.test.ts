import { describe, it, expect } from "vitest";
import { Stm32GPIO } from "../src/peripherals/gpio.js";
import { MemoryBus } from "../src/memory/memory-bus.js";
import { GPIOC_BASE } from "../src/memory/regions.js";

describe("Stm32GPIO BSRR / BRR semantics", () => {
  it("BSRR low 16 bits set ODR pins, high 16 reset them", () => {
    const bus = new MemoryBus();
    const gpio = new Stm32GPIO("GPIOC", GPIOC_BASE);
    bus.addMmio(gpio);

    const events: number[] = [];
    gpio.onOdrChange = (odr) => events.push(odr);

    // Set pin 13 (PC13 — the Blue Pill onboard LED)
    bus.write32(GPIOC_BASE + 0x10, 1 << 13);
    expect(gpio.odr & (1 << 13)).toBe(1 << 13);

    // Reset pin 13 via high half of BSRR
    bus.write32(GPIOC_BASE + 0x10, (1 << 13) << 16);
    expect(gpio.odr & (1 << 13)).toBe(0);

    // BRR clears too
    gpio.odr = 0xffff;
    bus.write32(GPIOC_BASE + 0x14, 1 << 5);
    expect(gpio.odr & (1 << 5)).toBe(0);

    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it("ODR writes land on ODR read", () => {
    const bus = new MemoryBus();
    const gpio = new Stm32GPIO("GPIOC", GPIOC_BASE);
    bus.addMmio(gpio);
    bus.write32(GPIOC_BASE + 0x0c, 0xabcd);
    expect(bus.read32(GPIOC_BASE + 0x0c)).toBe(0xabcd);
  });
});
