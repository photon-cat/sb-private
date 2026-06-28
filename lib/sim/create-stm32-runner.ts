// Browser/runtime factory: turn a compiled STM32 .bin + its sim-core tag into a
// ready STM32Runner backed by the right in-browser engine.
//
//   simCore "cortex-m0"  → CortexM0Host (ARMv6-M, rp2040js core) + G0 models
//   simCore "unicorn-arm" → UnicornArmHost (ARMv7-M, unicorn.js asm.js) + F1 models
//
// Async because the unicorn.js engine is code-split (~2.3 MB) and loaded on
// demand. The returned runner exposes the same execute()/pin/serial surface the
// UI drives for AVR, so the simulation loop and wiring are uniform.

import { STM32Runner, type STM32RunnerOptions } from "../stm32-runner";
import { STM32G0_MODELS, STM32F1_MODELS } from "../mcu/platform";
import type { SimCore } from "./sim-core";
import { STM32F1_SVD } from "./svd/stm32f1";
import { STM32G0_SVD } from "./svd/stm32g0";

/** Decode a base64 firmware payload (the build API's `bin`) to bytes. */
export function decodeFirmwareBin(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface CreateStm32RunnerOptions {
  /** Override the system clock (defaults per family). */
  clockHz?: number;
}

/**
 * Build an STM32Runner for the given core from raw firmware bytes. Throws if the
 * sim-core isn't an STM32 engine.
 */
export async function createStm32Runner(
  simCore: SimCore,
  firmware: Uint8Array,
  options: CreateStm32RunnerOptions = {},
): Promise<STM32Runner> {
  if (simCore === "unicorn-arm") {
    // Load the asm.js engine lazily, then build a host bound to the peripheral bus.
    const { UnicornArmHost } = await import("../mcu/unicorn-arm-host");
    const { loadUnicornArm } = await import("../mcu/unicorn/load-unicorn-arm");
    const uc = await loadUnicornArm();
    const opts: STM32RunnerOptions = {
      models: STM32F1_MODELS,
      clockHz: options.clockHz ?? 72_000_000, // F103 @ 72 MHz
      flashBytes: 128 * 1024,
      sramBytes: 20 * 1024,
      hostFactory: (bus) =>
        new UnicornArmHost(bus, { uc, flashBytes: 128 * 1024, sramBytes: 20 * 1024 }),
    };
    return new STM32Runner(firmware, STM32F1_SVD, opts);
  }

  if (simCore === "cortex-m0") {
    return new STM32Runner(firmware, STM32G0_SVD, {
      models: STM32G0_MODELS,
      clockHz: options.clockHz ?? 16_000_000, // HSI16 default
    });
  }

  throw new Error(`createStm32Runner: ${simCore} is not an STM32 core`);
}
