// Unit tests for the modern (G0/C0/L0) STM32 IP models: MODER GPIO, ISR/TDR
// USART, G0 RCC. Pins the fidelity behaviors (IDR by mode, BSRR set-priority,
// ready-flag tracking) that the Phase-3 review hardened.

import { describe, it, expect } from "vitest";
import { STM32GpioG0 } from "../mcu/peripherals/gpio-g0";
import { STM32RccG0 } from "../mcu/peripherals/rcc-g0";
import { STM32UsartG0 } from "../mcu/peripherals/usart-g0";
import { STM32I2CG0 } from "../mcu/peripherals/i2c-g0";
import { MPU6050, I2CRegisterDevice } from "../mcu/peripherals/i2c-device";

const MODER = 0x00;
const IDR = 0x10;
const ODR = 0x14;
const BSRR = 0x18;
const BRR = 0x28;

describe("STM32GpioG0", () => {
  it("IDR reads ODR for output pins and external level for input pins", () => {
    const g = new STM32GpioG0("GPIOA", 0x50000000, 0x400);
    g.reset();
    // PA5 = output (MODER bits 11:10 = 01), PA0 stays input (00).
    g.write(MODER, 4, 0b01 << 10);
    g.write(BSRR, 4, 1 << 5); // drive PA5 high via set
    g.setInput(0, true); // external high on input PA0
    g.setInput(5, false); // external low on PA5 must be ignored (it's output)
    const idr = g.read(IDR, 4);
    expect((idr >> 5) & 1).toBe(1); // output reads ODR (high)
    expect((idr >> 0) & 1).toBe(1); // input reads external (high)
  });

  it("BSRR set has priority over reset for the same pin", () => {
    const g = new STM32GpioG0("GPIOA", 0x50000000, 0x400);
    g.reset();
    // Set and reset PA3 in the same write: set wins.
    g.write(BSRR, 4, (1 << 3) | (1 << (16 + 3)));
    expect(g.pinOutput(3)).toBe(true);
  });

  it("BRR resets a pin", () => {
    const g = new STM32GpioG0("GPIOA", 0x50000000, 0x400);
    g.reset();
    g.write(BSRR, 4, 1 << 7);
    expect(g.pinOutput(7)).toBe(true);
    g.write(BRR, 4, 1 << 7);
    expect(g.pinOutput(7)).toBe(false);
  });

  it("notifies watchers on output changes only", () => {
    const g = new STM32GpioG0("GPIOA", 0x50000000, 0x400);
    g.reset();
    const edges: Array<[number, boolean]> = [];
    g.watch((pin, high) => edges.push([pin, high]));
    g.write(ODR, 4, 1 << 2);
    expect(edges).toContainEqual([2, true]);
  });
});

describe("STM32RccG0", () => {
  it("mirrors oscillator enable into ready and clears it when disabled", () => {
    const r = new STM32RccG0("RCC", 0x40021000, 0x400);
    r.reset();
    expect(r.isReady(10)).toBe(true); // HSI on at reset
    // Enable PLL (bit24) → PLLRDY (bit25).
    r.write(0x00, 4, (1 << 8) | (1 << 24));
    expect(r.isReady(25)).toBe(true);
    // Disable PLL while keeping HSI → PLLRDY clears, HSIRDY stays.
    r.write(0x00, 4, 1 << 8);
    expect(r.isReady(25)).toBe(false);
    expect(r.isReady(10)).toBe(true);
  });
});

describe("STM32UsartG0", () => {
  it("captures TX via TDR and asserts TXE/TC", () => {
    const u = new STM32UsartG0("USART1", 0x40013800, 0x400, 27);
    u.reset();
    const out: number[] = [];
    u.onByteTransmit = (b) => out.push(b);
    u.write(0x28, 4, 0x41); // TDR <- 'A'
    expect(out).toEqual([0x41]);
    expect((u.read(0x1c, 4) >> 7) & 1).toBe(1); // TXE
  });

  it("feeds RX, sets RXNE, clears on RDR read, and raises IRQ when enabled", () => {
    const u = new STM32UsartG0("USART1", 0x40013800, 0x400, 27);
    u.reset();
    u.write(0x00, 4, 1 << 5); // CR1 RXNEIE
    expect(u.pendingIRQ()).toBeNull();
    u.feedByte(0x42);
    expect(u.pendingIRQ()).toBe(27);
    expect(u.read(0x24, 4)).toBe(0x42); // RDR
    expect(u.pendingIRQ()).toBeNull(); // RXNE cleared
  });
});

describe("STM32I2CG0", () => {
  const CR2 = 0x04;
  const ISR = 0x18;
  const RXDR = 0x24;
  const TXDR = 0x28;
  const START = 1 << 13;
  const RD_WRN = 1 << 10;
  const AUTOEND = 1 << 25;
  const ISR_TXIS = 1 << 1;
  const ISR_RXNE = 1 << 2;
  const ISR_TC = 1 << 6;
  const ISR_STOPF = 1 << 5;
  const ISR_NACKF = 1 << 4;
  const cr2 = (addr: number, nbytes: number, read: boolean, autoend: boolean) =>
    (addr << 1) | (nbytes << 16) | (read ? RD_WRN : 0) | (autoend ? AUTOEND : 0) | START;

  function mk(): STM32I2CG0 {
    const i = new STM32I2CG0("I2C1", 0x40005400, 0x400);
    i.reset();
    return i;
  }

  it("register read: write pointer (SOFTEND→TC), repeated-start read returns the value", () => {
    const i = mk();
    const dev = new I2CRegisterDevice(0x68);
    dev.setReg(0x75, 0x68);
    i.attach(dev);
    // Phase 1: write the register pointer (1 byte, SOFTEND).
    i.write(CR2, 4, cr2(0x68, 1, false, false));
    expect(i.read(ISR, 4) & ISR_TXIS).toBeTruthy();
    i.write(TXDR, 4, 0x75);
    expect(i.read(ISR, 4) & ISR_TC).toBeTruthy(); // SOFTEND complete
    // Phase 2: repeated-start read (1 byte, AUTOEND).
    i.write(CR2, 4, cr2(0x68, 1, true, true));
    expect(i.read(ISR, 4) & ISR_RXNE).toBeTruthy();
    expect(i.read(RXDR, 4)).toBe(0x68);
    expect(i.read(ISR, 4) & ISR_STOPF).toBeTruthy();
  });

  it("MPU6050 WHO_AM_I round-trips through the master", () => {
    const i = mk();
    i.attach(new MPU6050(0x68));
    i.write(CR2, 4, cr2(0x68, 1, false, false));
    i.write(TXDR, 4, 0x75);
    i.write(CR2, 4, cr2(0x68, 1, true, true));
    expect(i.read(RXDR, 4)).toBe(0x68);
  });

  it("a missing device NACKs (sets NACKF + STOPF)", () => {
    const i = mk();
    i.write(CR2, 4, cr2(0x42, 1, false, true)); // nothing at 0x42
    const isr = i.read(ISR, 4);
    expect(isr & ISR_NACKF).toBeTruthy();
    expect(isr & ISR_STOPF).toBeTruthy();
  });
});
