// Unit tests for the STM32 F1 (F103) peripheral models that complete the F1 IO
// surface: EXTI (single PR, F1 line→vector map), ADC (ADCv1 ADON/SWSTART → EOC),
// and I2C (I2Cv1 SB/ADDR/BTF state machine, exercised by a full write-then-read
// register round-trip). Also asserts the F1 SVD + STM32F1_MODELS wire every
// peripheral group onto the bus with its F1-flavor model.

import { describe, it, expect } from "vitest";
import { STM32ExtiF1 } from "../mcu/peripherals/exti";
import { STM32AdcF1 } from "../mcu/peripherals/adc";
import { STM32I2CF1 } from "../mcu/peripherals/i2c";
import { STM32SpiG0 } from "../mcu/peripherals/spi-g0";
import { STM32TimG0 } from "../mcu/peripherals/tim-g0";
import { STM32AfioF1 } from "../mcu/peripherals/afio";
import { I2CRegisterDevice } from "../mcu/peripherals/i2c-device";
import { buildPlatform, STM32F1_MODELS } from "../mcu/platform";
import { STM32F1_SVD } from "../sim/svd/stm32f1";

describe("STM32ExtiF1", () => {
  // F1 EXTI offsets
  const IMR = 0x00;
  const RTSR = 0x08;
  const FTSR = 0x0c;
  const SWIER = 0x10;
  const PR = 0x14;

  const mk = () => {
    const e = new STM32ExtiF1("EXTI", 0x40010400, 0x400);
    e.reset();
    return e;
  };

  it("maps lines to F1 NVIC vectors (0..4 individual, 9_5, 15_10)", () => {
    const e = mk();
    expect(e.irqForLine(0)).toBe(6);
    expect(e.irqForLine(4)).toBe(10);
    expect(e.irqForLine(5)).toBe(23);
    expect(e.irqForLine(9)).toBe(23);
    expect(e.irqForLine(10)).toBe(40);
    expect(e.irqForLine(15)).toBe(40);
    expect(e.irqForLine(16)).toBeNull();
  });

  it("sets PR on a triggered edge only when that edge's trigger is enabled", () => {
    const e = mk();
    e.write(RTSR, 4, 1 << 3); // rising enabled on line 3
    e.triggerLine(3, false); // falling — not enabled, ignored
    expect(e.read(PR, 4)).toBe(0);
    e.triggerLine(3, true); // rising — latches PR
    expect(e.read(PR, 4) & (1 << 3)).toBe(1 << 3);
  });

  it("asserts the IRQ only for masked (IMR) pending lines, and clears PR on w1c", () => {
    const e = mk();
    e.write(FTSR, 4, 1 << 6); // falling on line 6
    e.triggerLine(6, false);
    expect(e.pendingIRQ()).toBeNull(); // PR set but IMR masked
    e.write(IMR, 4, 1 << 6); // unmask
    expect(e.pendingIRQ()).toBe(23); // EXTI9_5
    e.write(PR, 4, 1 << 6); // write-1-to-clear
    expect(e.read(PR, 4) & (1 << 6)).toBe(0);
    expect(e.pendingIRQ()).toBeNull();
  });

  it("latches PR from a software trigger (SWIER)", () => {
    const e = mk();
    e.write(IMR, 4, 1 << 2);
    e.write(SWIER, 4, 1 << 2);
    expect(e.read(PR, 4) & (1 << 2)).toBe(1 << 2);
    expect(e.pendingIRQ()).toBe(8); // EXTI2
  });
});

describe("STM32AdcF1", () => {
  // F1 ADC offsets
  const SR = 0x00;
  const CR1 = 0x04;
  const CR2 = 0x08;
  const SQR3 = 0x34;
  const DR = 0x4c;
  const ADON = 1 << 0;
  const SWSTART = 1 << 22;
  const EOC = 1 << 1;

  const mk = (irq: number | null = 18) => {
    const a = new STM32AdcF1("ADC1", 0x40012400, 0x400, irq);
    a.reset();
    return a;
  };

  it("converts the SQR3-selected channel and clears EOC on DR read", () => {
    const a = mk();
    a.setChannel(7, 3000);
    a.write(SQR3, 4, 7); // SQ1 = channel 7
    a.write(CR2, 4, ADON); // power on (no conversion yet)
    expect(a.read(SR, 4) & EOC).toBe(0);
    a.write(CR2, 4, ADON | SWSTART); // start a conversion
    expect(a.read(SR, 4) & EOC).toBe(EOC);
    expect(a.read(DR, 4)).toBe(3000);
    expect(a.read(SR, 4) & EOC).toBe(0); // EOC cleared by the DR read
  });

  it("completes a conversion on a second ADON write (no SWSTART)", () => {
    const a = mk();
    a.setChannel(0, 1234);
    a.write(CR2, 4, ADON); // first ADON: wake only
    expect(a.read(SR, 4) & EOC).toBe(0);
    a.write(CR2, 4, ADON); // second ADON: start
    expect(a.read(SR, 4) & EOC).toBe(EOC);
    expect(a.read(DR, 4)).toBe(1234);
  });

  it("asserts the EOC IRQ only when EOCIE is set", () => {
    const a = mk(18);
    a.setChannel(1, 100);
    a.write(SQR3, 4, 1);
    a.write(CR2, 4, ADON | SWSTART);
    expect(a.pendingIRQ()).toBeNull(); // EOC set, EOCIE not
    a.write(CR1, 4, 1 << 5); // EOCIE
    expect(a.pendingIRQ()).toBe(18);
  });
});

describe("STM32I2CF1", () => {
  // F1 I2C offsets / flags
  const CR1 = 0x00;
  const DR = 0x10;
  const SR1 = 0x14;
  const SR2 = 0x18;
  const PE = 1 << 0;
  const START = 1 << 8;
  const STOP = 1 << 9;
  const SB = 1 << 0;
  const ADDR = 1 << 1;
  const TXE = 1 << 7;
  const RXNE = 1 << 6;
  const AF = 1 << 10;

  const ADDR7 = 0x50;
  const WR = ADDR7 << 1; // 0xA0
  const RD = (ADDR7 << 1) | 1; // 0xA1

  const mk = () => {
    const i = new STM32I2CF1("I2C1", 0x40005400, 0x400);
    i.reset();
    return i;
  };

  it("NACKs (AF) when no slave acknowledges the address", () => {
    const i = mk();
    i.write(CR1, 4, PE | START);
    expect(i.read(SR1, 4) & SB).toBe(SB);
    i.write(DR, 4, 0x60 << 1); // nobody at 0x60
    expect(i.read(SR1, 4) & AF).toBe(AF);
  });

  it("drives a full write-register then read-register round-trip", () => {
    const i = mk();
    const dev = new I2CRegisterDevice(ADDR7);
    i.attach(dev);

    // --- Write 0xAB to register 0x05 ---
    i.write(CR1, 4, PE | START);
    expect(i.read(SR1, 4) & SB).toBe(SB);
    i.write(DR, 4, WR); // address (write)
    expect(i.read(SR1, 4) & ADDR).toBe(ADDR);
    expect(i.read(SR1, 4) & TXE).toBe(TXE);
    i.read(SR1, 4);
    i.read(SR2, 4); // EV6 clear sequence
    expect(i.read(SR1, 4) & ADDR).toBe(0);
    i.write(DR, 4, 0x05); // register pointer
    i.write(DR, 4, 0xab); // data → reg 5
    i.write(CR1, 4, PE | STOP);

    // --- Read register 0x05 back ---
    i.write(CR1, 4, PE | START);
    i.write(DR, 4, WR); // address (write) to set pointer
    i.read(SR1, 4);
    i.read(SR2, 4);
    i.write(DR, 4, 0x05); // pointer = 5
    i.write(CR1, 4, PE | START); // repeated start
    i.write(DR, 4, RD); // address (read)
    i.read(SR1, 4);
    i.read(SR2, 4); // clears ADDR, prefetches first byte
    expect(i.read(SR1, 4) & RXNE).toBe(RXNE);
    const value = i.read(DR, 4);
    i.write(CR1, 4, PE | STOP);

    expect(value).toBe(0xab);
  });
});

describe("STM32F1 SVD + STM32F1_MODELS wiring", () => {
  it("instantiates every F1 peripheral group with its F1-flavor model", () => {
    const { bus } = buildPlatform(STM32F1_SVD, { models: STM32F1_MODELS });
    // New IO peripherals are present on the bus with the right models.
    expect(bus.get("EXTI")).toBeInstanceOf(STM32ExtiF1);
    expect(bus.get("I2C1")).toBeInstanceOf(STM32I2CF1);
    expect(bus.get("I2C2")).toBeInstanceOf(STM32I2CF1);
    expect(bus.get("ADC1")).toBeInstanceOf(STM32AdcF1);
    expect(bus.get("AFIO")).toBeInstanceOf(STM32AfioF1);
    // TIM/SPI reuse the family-generic G0 models.
    expect(bus.get("TIM2")).toBeInstanceOf(STM32TimG0);
    expect(bus.get("SPI1")).toBeInstanceOf(STM32SpiG0);
  });
});
