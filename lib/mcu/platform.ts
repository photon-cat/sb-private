// Platform assembler — builds an MMIO bus for an MCU from its CMSIS-SVD and a
// registry of behavioral IP-block models, keyed by SVD group name. This is the
// extensibility seam: a new STM32 = its SVD + a board file; models are reused.

import { MMIOBus } from "./mmio-bus";
import type { Peripheral } from "./peripheral";
import { parseSvd, type SvdDevice, type SvdPeripheral } from "./svd";
import { CortexMNvic } from "./peripherals/nvic";
import { STM32GpioF1 } from "./peripherals/gpio";
import { STM32RccF1 } from "./peripherals/rcc";
import { STM32UsartF1 } from "./peripherals/usart";
import { STM32ExtiF1 } from "./peripherals/exti";
import { STM32I2CF1 } from "./peripherals/i2c";
import { STM32AdcF1 } from "./peripherals/adc";
import { STM32AfioF1 } from "./peripherals/afio";
import { STM32GpioG0 } from "./peripherals/gpio-g0";
import { STM32RccG0 } from "./peripherals/rcc-g0";
import { STM32UsartG0 } from "./peripherals/usart-g0";
import { STM32FlashG0 } from "./peripherals/flash-g0";
import { STM32SpiG0 } from "./peripherals/spi-g0";
import { STM32I2CG0 } from "./peripherals/i2c-g0";
import { STM32TimG0 } from "./peripherals/tim-g0";
import { STM32AdcG0 } from "./peripherals/adc-g0";
import { STM32ExtiG0 } from "./peripherals/exti-g0";

/** Factory: build a behavioral model for an SVD peripheral instance. */
export type PeripheralFactory = (p: SvdPeripheral) => Peripheral;

/**
 * F1-family IP-model registry, keyed by SVD `groupName`. GPIO/USART use the F1
 * register flavor (CRL/CRH, SR/DR); I2C (I2Cv1), ADC (ADCv1) and EXTI (single PR)
 * use F1-specific models. TIM and SPI register layouts are family-generic, so the
 * G0 models are reused; FLASH is plain ACR storage (also reused). AFIO is F1-only.
 */
export const STM32F1_MODELS: Record<string, PeripheralFactory> = {
  GPIO: (p) => new STM32GpioF1(p.name, p.baseAddress, p.size),
  RCC: (p) => new STM32RccF1(p.name, p.baseAddress, p.size),
  USART: (p) => new STM32UsartF1(p.name, p.baseAddress, p.size, p.interrupts[0]?.value ?? null),
  AFIO: (p) => new STM32AfioF1(p.name, p.baseAddress, p.size),
  FLASH: (p) => new STM32FlashG0(p.name, p.baseAddress, p.size),
  EXTI: (p) => new STM32ExtiF1(p.name, p.baseAddress, p.size),
  I2C: (p) => new STM32I2CF1(p.name, p.baseAddress, p.size),
  ADC: (p) => new STM32AdcF1(p.name, p.baseAddress, p.size, p.interrupts[0]?.value ?? null),
  SPI: (p) => new STM32SpiG0(p.name, p.baseAddress, p.size),
  TIM: (p) => new STM32TimG0(p.name, p.baseAddress, p.size, p.interrupts[0]?.value ?? null),
};

/**
 * G0/C0/L0-family IP-model registry (MODER GPIO, ISR/TDR USART). The modern
 * register flavor shared across every post-F1 STM32; reused for the M0+ parts
 * and most M4/M7 families. Adding such a family = SVD + this registry.
 */
export const STM32G0_MODELS: Record<string, PeripheralFactory> = {
  GPIO: (p) => new STM32GpioG0(p.name, p.baseAddress, p.size),
  RCC: (p) => new STM32RccG0(p.name, p.baseAddress, p.size),
  USART: (p) => new STM32UsartG0(p.name, p.baseAddress, p.size, p.interrupts[0]?.value ?? null),
  FLASH: (p) => new STM32FlashG0(p.name, p.baseAddress, p.size),
  SPI: (p) => new STM32SpiG0(p.name, p.baseAddress, p.size),
  I2C: (p) => new STM32I2CG0(p.name, p.baseAddress, p.size),
  TIM: (p) => new STM32TimG0(p.name, p.baseAddress, p.size, p.interrupts[0]?.value ?? null),
  ADC: (p) => new STM32AdcG0(p.name, p.baseAddress, p.size, p.interrupts[0]?.value ?? null),
  EXTI: (p) => new STM32ExtiG0(p.name, p.baseAddress, p.size),
};

export interface Platform {
  device: SvdDevice;
  bus: MMIOBus;
  nvic: CortexMNvic;
  /** IRQ name → number, from the SVD. */
  irqs: Map<string, number>;
  reset(): void;
}

export interface BuildPlatformOptions {
  /** IP-model factories keyed by SVD group name. Defaults to STM32F1_MODELS. */
  models?: Record<string, PeripheralFactory>;
  /** Only instantiate these peripheral names (default: all with a known model). */
  include?: string[];
}

/** Build a platform from a CMSIS-SVD XML string. */
export function buildPlatform(svdXml: string, opts: BuildPlatformOptions = {}): Platform {
  const device = parseSvd(svdXml);
  const models = opts.models ?? STM32F1_MODELS;
  const bus = new MMIOBus();
  const nvic = new CortexMNvic();
  bus.add(nvic);

  const irqs = new Map<string, number>();
  for (const p of device.peripherals) {
    for (const it of p.interrupts) irqs.set(it.name, it.value);

    if (opts.include && !opts.include.includes(p.name)) continue;
    const factory = models[p.group] ?? models[p.name];
    if (factory) {
      try {
        bus.add(factory(p));
      } catch (e) {
        // Overlapping/duplicate window — skip with a note; keeps build resilient.
        if (process?.env?.SPARKBENCH_DEBUG) console.warn(`[mcu] skip ${p.name}: ${e}`);
      }
    }
  }

  return {
    device,
    bus,
    nvic,
    irqs,
    reset() {
      bus.reset();
    },
  };
}
