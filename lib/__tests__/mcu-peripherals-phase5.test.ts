// Unit tests for the Phase-5 STM32 G0 peripheral models: TIMx (counting + PWM
// duty + update IRQ), ADC (channel injection / DR read / EOC), and EXTI (G0
// rising/falling pending, IMR masking, write-1-to-clear).

import { describe, it, expect } from "vitest";
import { STM32TimG0 } from "../mcu/peripherals/tim-g0";
import { STM32AdcG0 } from "../mcu/peripherals/adc-g0";
import { STM32ExtiG0 } from "../mcu/peripherals/exti-g0";

// TIM register offsets
const CR1 = 0x00;
const DIER = 0x0c;
const SR = 0x10;
const CCER = 0x20;
const CNT = 0x24;
const PSC = 0x28;
const ARR = 0x2c;
const CCR1 = 0x34;
const CCR2 = 0x38;

describe("STM32TimG0", () => {
  function mk(irq: number | null = 28): STM32TimG0 {
    const t = new STM32TimG0("TIM1", 0x40012c00, 0x400, irq);
    t.reset();
    return t;
  }

  it("counts up with prescaler division when CEN is set", () => {
    const t = mk();
    t.write(PSC, 4, 1); // divide by 2
    t.write(ARR, 4, 1000);
    t.write(CR1, 4, 1); // CEN
    t.tick(10); // 10 clocks / (PSC+1=2) = 5 counts
    expect(t.counter()).toBe(5);
  });

  it("does not count while CEN is clear", () => {
    const t = mk();
    t.write(ARR, 4, 1000);
    t.tick(100);
    expect(t.counter()).toBe(0);
  });

  it("wraps and sets UIF on overflow, asserting the update IRQ when UIE set", () => {
    const t = mk(28);
    t.write(PSC, 4, 0); // no division
    t.write(ARR, 4, 4); // wraps after reaching 4 (period 5)
    t.write(DIER, 4, 1); // UIE
    t.write(CR1, 4, 1); // CEN
    expect(t.pendingIRQ()).toBeNull();
    t.tick(5); // 0->...->4 then wrap to 0
    expect(t.read(SR, 4) & 1).toBe(1); // UIF
    expect(t.counter()).toBe(0);
    expect(t.pendingIRQ()).toBe(28);
  });

  it("computes PWM duty as CCRx/(ARR+1) only for CCER-enabled channels", () => {
    const t = mk();
    t.write(ARR, 4, 99); // period 100
    t.write(CCR1, 4, 25);
    t.write(CCR2, 4, 50);
    t.write(CCER, 4, 1 << 0); // enable channel 1 only (CC1E)
    expect(t.pwmDuty(1)).toBeCloseTo(0.25, 5);
    expect(t.pwmDuty(2)).toBe(0); // channel 2 not enabled
    t.write(CCER, 4, (1 << 0) | (1 << 4)); // enable ch1 + ch2
    expect(t.pwmDuty(2)).toBeCloseTo(0.5, 5);
  });

  it("clamps PWM duty to 1.0 when CCR exceeds the period", () => {
    const t = mk();
    t.write(ARR, 4, 99);
    t.write(CCR1, 4, 500);
    t.write(CCER, 4, 1 << 0);
    expect(t.pwmDuty(1)).toBe(1);
  });
});

describe("STM32AdcG0", () => {
  const ISR = 0x00;
  const IER = 0x04;
  const CR = 0x08;
  const CHSELR = 0x28;
  const DR = 0x40;

  function mk(irq: number | null = 12): STM32AdcG0 {
    const a = new STM32AdcG0("ADC1", 0x40012400, 0x400, irq);
    a.reset();
    return a;
  }

  it("returns the selected channel's injected value on DR read and sets EOC", () => {
    const a = mk();
    a.setChannel(3, 2048);
    a.write(CHSELR, 4, 1 << 3); // select channel 3
    a.write(CR, 4, 1 << 0); // ADEN
    a.write(CR, 4, (1 << 0) | (1 << 2)); // ADSTART
    expect(a.read(DR, 4)).toBe(2048);
    expect(a.read(ISR, 4) & (1 << 2)).toBeTruthy(); // EOC
  });

  it("clamps injected samples to 12 bits and defaults channels to 0", () => {
    const a = mk();
    a.setChannel(0, 99999); // over-range
    a.write(CHSELR, 4, 1 << 0);
    expect(a.read(DR, 4)).toBe(0xfff);
    const b = mk();
    b.write(CHSELR, 4, 1 << 5); // no value set
    expect(b.read(DR, 4)).toBe(0);
  });

  it("raises the EOC IRQ only when EOCIE is set", () => {
    const a = mk(12);
    a.setChannel(1, 100);
    a.write(CHSELR, 4, 1 << 1);
    a.write(CR, 4, (1 << 0) | (1 << 2)); // ADEN + ADSTART -> EOC
    expect(a.pendingIRQ()).toBeNull(); // EOCIE not set
    a.write(IER, 4, 1 << 2); // EOCIE
    expect(a.pendingIRQ()).toBe(12);
  });
});

describe("STM32ExtiG0", () => {
  const RTSR1 = 0x00;
  const FTSR1 = 0x04;
  const RPR1 = 0x0c;
  const FPR1 = 0x10;
  const IMR1 = 0x80;

  function mk(): STM32ExtiG0 {
    const e = new STM32ExtiG0("EXTI", 0x40021800, 0x400);
    e.reset();
    return e;
  }

  it("sets rising pending only when the rising trigger is enabled", () => {
    const e = mk();
    e.triggerLine(4, true); // trigger not enabled yet
    expect(e.read(RPR1, 4) & (1 << 4)).toBe(0);
    e.write(RTSR1, 4, 1 << 4); // enable rising on line 4
    e.triggerLine(4, true);
    expect(e.read(RPR1, 4) & (1 << 4)).toBeTruthy();
  });

  it("sets falling pending independently via FTSR", () => {
    const e = mk();
    e.write(FTSR1, 4, 1 << 2);
    e.triggerLine(2, false);
    expect(e.read(FPR1, 4) & (1 << 2)).toBeTruthy();
    expect(e.read(RPR1, 4)).toBe(0);
  });

  it("asserts the mapped IRQ only when the IMR line is unmasked", () => {
    const e = mk();
    e.write(RTSR1, 4, 1 << 0); // line 0
    e.triggerLine(0, true);
    expect(e.pendingIRQ()).toBeNull(); // masked by default (IMR=0)
    e.write(IMR1, 4, 1 << 0); // unmask line 0
    expect(e.pendingIRQ()).toBe(5); // EXTI0_1 -> IRQ 5
  });

  it("maps lines to the condensed G0 vectors", () => {
    const e = mk();
    expect(e.irqForLine(1)).toBe(5); // EXTI0_1
    expect(e.irqForLine(3)).toBe(6); // EXTI2_3
    expect(e.irqForLine(10)).toBe(7); // EXTI4_15
  });

  it("clears pending bits on write-1-to-clear", () => {
    const e = mk();
    e.write(RTSR1, 4, 1 << 7);
    e.write(IMR1, 4, 1 << 7);
    e.triggerLine(7, true);
    expect(e.pendingIRQ()).toBe(7); // EXTI4_15
    e.write(RPR1, 4, 1 << 7); // w1c
    expect(e.read(RPR1, 4) & (1 << 7)).toBe(0);
    expect(e.pendingIRQ()).toBeNull();
  });
});
