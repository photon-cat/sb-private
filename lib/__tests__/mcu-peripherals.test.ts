import { describe, it, expect } from "vitest";
import { MMIOBus, STM32GpioF1, STM32RccF1, STM32UsartF1, CortexMNvic } from "../mcu";

describe("MMIOBus", () => {
  it("routes reads/writes to the owning peripheral and rejects overlaps", () => {
    const bus = new MMIOBus();
    const a = new STM32GpioF1("GPIOA", 0x40010800, 0x400);
    bus.add(a);
    bus.write(0x40010800 + 0x10, 4, 1 << 5); // BSRR set PA5
    expect(a.pinOutput(5)).toBe(true);
    expect(() => bus.add(new STM32GpioF1("X", 0x40010800, 0x400))).toThrow(/overlap/);
    expect(bus.read(0x50000000, 4)).toBe(0); // unmapped reads 0
  });
});

describe("STM32 GPIO (F1)", () => {
  it("BSRR sets and resets ODR atomically; pinOutput reflects it", () => {
    const g = new STM32GpioF1("GPIOA", 0, 0x400);
    g.write(0x10, 4, 1 << 5); // set PA5
    expect(g.pinOutput(5)).toBe(true);
    g.write(0x10, 4, 1 << (5 + 16)); // reset PA5 (high half)
    expect(g.pinOutput(5)).toBe(false);
  });

  it("IDR reflects external inputs OR driven outputs; watch fires on change", () => {
    const g = new STM32GpioF1("GPIOB", 0, 0x400);
    const changes: Array<[number, boolean]> = [];
    g.watch((pin, high) => changes.push([pin, high]));
    g.setInput(3, true);
    expect((g.read(0x08, 4) >> 3) & 1).toBe(1); // IDR bit3
    g.write(0x0c, 4, 1 << 7); // ODR set PB7
    expect((g.read(0x08, 4) >> 7) & 1).toBe(1);
    expect(changes).toContainEqual([7, true]);
  });
});

describe("STM32 RCC (F1) — ready flags", () => {
  it("mirrors oscillator enables into ready bits so clock-init doesn't hang", () => {
    const rcc = new STM32RccF1("RCC", 0, 0x400);
    rcc.reset();
    expect(rcc.isReady(1)).toBe(true); // HSIRDY after reset
    rcc.write(0x00, 4, (1 << 24) | rcc.read(0x00, 4)); // PLLON
    expect(rcc.isReady(25)).toBe(true); // PLLRDY
    rcc.write(0x00, 4, (1 << 16) | rcc.read(0x00, 4)); // HSEON
    expect(rcc.isReady(17)).toBe(true); // HSERDY
  });

  it("SWS follows SW in CFGR (clock-switch acknowledged)", () => {
    const rcc = new STM32RccF1("RCC", 0, 0x400);
    rcc.write(0x04, 4, 0b10); // SW = PLL
    expect((rcc.read(0x04, 4) >> 2) & 0b11).toBe(0b10); // SWS = PLL
  });
});

describe("STM32 USART (F1)", () => {
  it("captures transmitted bytes and keeps TXE/TC set", () => {
    const u = new STM32UsartF1("USART1", 0, 0x400, 37);
    u.reset();
    const tx: number[] = [];
    u.onByteTransmit = (b) => tx.push(b);
    u.write(0x04, 4, 0x41); // DR = 'A'
    u.write(0x04, 4, 0x42); // DR = 'B'
    expect(tx).toEqual([0x41, 0x42]);
    expect((u.read(0x00, 4) >> 7) & 1).toBe(1); // TXE
  });

  it("feedByte sets RXNE; reading DR returns it and clears RXNE", () => {
    const u = new STM32UsartF1("USART1", 0, 0x400, null);
    u.reset();
    u.feedByte(0x5a);
    expect((u.read(0x00, 4) >> 5) & 1).toBe(1); // RXNE
    expect(u.read(0x04, 4)).toBe(0x5a); // DR
    expect((u.read(0x00, 4) >> 5) & 1).toBe(0); // RXNE cleared
  });

  it("asserts its IRQ when RXNE + RXNEIE", () => {
    const u = new STM32UsartF1("USART1", 0, 0x400, 37);
    u.reset();
    u.write(0x0c, 4, 1 << 5); // CR1 RXNEIE
    expect(u.pendingIRQ()).toBeNull();
    u.feedByte(1);
    expect(u.pendingIRQ()).toBe(37);
  });
});

describe("Cortex-M NVIC", () => {
  it("enable/pending bitsets and next-pending selection", () => {
    const n = new CortexMNvic();
    n.write(0x000, 4, 1 << 5); // ISER0: enable IRQ5
    n.setPending(5);
    n.setPending(20); // not enabled
    expect(n.isEnabled(5)).toBe(true);
    expect(n.nextPending()).toBe(5); // only enabled+pending
    n.acknowledge(5);
    expect(n.nextPending()).toBeNull();
  });

  it("ICER clears enable, ICPR clears pending", () => {
    const n = new CortexMNvic();
    n.write(0x000, 4, 1 << 3);
    n.setPending(3);
    expect(n.nextPending()).toBe(3);
    n.write(0x080, 4, 1 << 3); // ICER disable
    expect(n.nextPending()).toBeNull();
  });
});
