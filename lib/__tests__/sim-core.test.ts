// Board → in-browser simulation core routing (used by the build response).

import { describe, it, expect } from "vitest";
import { pickSimCore } from "../sim/sim-core";

describe("pickSimCore", () => {
  it("routes AVR boards to avr8js", () => {
    expect(pickSimCore("uno")).toBe("avr8js");
    expect(pickSimCore("atmega328p")).toBe("avr8js");
  });

  it("routes ARMv7-M STM32 (F1/F4/F7/H7/G4) to the unicorn.js core", () => {
    expect(pickSimCore("bluepill_f103c8")).toBe("unicorn-arm");
    expect(pickSimCore("genericSTM32F103C8")).toBe("unicorn-arm");
    expect(pickSimCore("blackpill_f401cc")).toBe("unicorn-arm");
  });

  it("routes ARMv6-M STM32 (G0/C0/L0) to the Cortex-M0+ core", () => {
    expect(pickSimCore("nucleo_g071rb")).toBe("cortex-m0");
    expect(pickSimCore("nucleo_l011k4")).toBe("cortex-m0");
  });

  it("routes RP2040 / Pico to the rp2040 core", () => {
    expect(pickSimCore("pico")).toBe("rp2040");
    expect(pickSimCore("rpipico")).toBe("rp2040");
    expect(pickSimCore("rpipicow")).toBe("rp2040");
  });

  it("returns null for boards with no in-browser core yet (ESP32)", () => {
    expect(pickSimCore("esp32dev")).toBeNull();
  });
});
