import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { buildPlatform, STM32GpioF1, STM32UsartF1 } from "../mcu";

const svdXml = readFileSync(path.join(__dirname, "fixtures", "stm32-mini.svd"), "utf-8");

describe("Platform assembly from SVD", () => {
  it("instantiates known IP models at their SVD base addresses", () => {
    const plat = buildPlatform(svdXml);
    expect(plat.bus.get("RCC")?.base).toBe(0x40021000);
    expect(plat.bus.get("GPIOA")?.base).toBe(0x40010800);
    expect(plat.bus.get("GPIOB")?.base).toBe(0x40010c00); // derivedFrom GPIO model
    expect(plat.bus.get("USART1")?.base).toBe(0x40013800);
    expect(plat.bus.get("NVIC")).toBeDefined();
    expect(plat.irqs.get("USART1")).toBe(37);
  });

  // Acceptance: drive the boot sequence a real STM32 sketch performs, through the
  // MMIO bus (the CPU core is mocked — we issue the loads/stores it would).
  it("boots: enable clocks → toggle GPIO → print over USART (core mocked)", () => {
    const plat = buildPlatform(svdXml);
    plat.reset();
    const { bus } = plat;

    // 1) RCC: enable GPIOA + USART1 peripheral clocks (APB2ENR @ +0x18:
    //    IOPAEN bit2, USART1EN bit14).
    bus.write(0x40021000 + 0x18, 4, (1 << 2) | (1 << 14));

    // 2) GPIOA: drive PA5 high via BSRR (@ +0x10).
    bus.write(0x40010800 + 0x10, 4, 1 << 5);
    const gpioa = bus.get("GPIOA") as STM32GpioF1;
    expect(gpioa.pinOutput(5)).toBe(true);
    // Read back via IDR (@ +0x08).
    expect((bus.read(0x40010800 + 0x08, 4) >> 5) & 1).toBe(1);

    // 3) USART1: capture transmitted bytes, then "print" HI (DR @ +0x04).
    const usart = bus.get("USART1") as STM32UsartF1;
    const out: number[] = [];
    usart.onByteTransmit = (b) => out.push(b);
    for (const ch of "HI") bus.write(0x40013800 + 0x04, 4, ch.charCodeAt(0));
    expect(String.fromCharCode(...out)).toBe("HI");

    // 4) USART RX → NVIC: feed a byte with RXNE IRQ enabled; the bus surfaces the
    //    pending IRQ and the NVIC latches it when enabled.
    bus.write(0x40013800 + 0x0c, 4, 1 << 5); // CR1 RXNEIE
    plat.nvic.write(0x000, 4, 1 << 37 % 32 << 0); // enable (word 1 in real life)
    plat.nvic.write(0x004, 4, 1 << (37 - 32)); // ISER1: enable IRQ37
    usart.feedByte(0x7e);
    for (const irq of bus.pendingIRQs()) plat.nvic.setPending(irq);
    expect(plat.nvic.nextPending()).toBe(37);
  });
});
