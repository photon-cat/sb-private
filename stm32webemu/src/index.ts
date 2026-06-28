// stm32webemu — STM32F103 browser emulator (scaffold)
//
// Status: slice 1 — scaffold only. Boots a vector table, steps a Thumb-2
// subset, and models GPIO / RCC / SysTick well enough for blinky-class
// firmware. Not yet wired into the SparkBench simulation UI; see
// hooks/useSimulation.ts. Fleshing out decoder coverage + integration is
// tracked as "slice 2".

import { CortexM3 } from "./cpu/cpu.js";
import { stepThumb, UnsupportedInstructionError } from "./cpu/thumb-execute.js";
import { MemoryBus } from "./memory/memory-bus.js";
import {
  GPIOA_BASE,
  GPIOB_BASE,
  GPIOC_BASE,
  GPIOD_BASE,
} from "./memory/regions.js";
import { Stm32GPIO } from "./peripherals/gpio.js";
import { Stm32RCC } from "./peripherals/rcc.js";
import { Stm32SysTick } from "./peripherals/systick.js";

export { CortexM3 } from "./cpu/cpu.js";
export { MemoryBus } from "./memory/memory-bus.js";
export { Stm32GPIO } from "./peripherals/gpio.js";
export { Stm32RCC } from "./peripherals/rcc.js";
export { Stm32SysTick } from "./peripherals/systick.js";
export { UnsupportedInstructionError } from "./cpu/thumb-execute.js";

export interface Stm32RunnerOptions {
  /** Raw firmware bytes (typically `firmware.bin` from PlatformIO ststm32). */
  firmware: Uint8Array;
}

/**
 * Facade that wires a CortexM3 CPU to an STM32F103 peripheral set.
 *
 * Typical use:
 *   const runner = new Stm32Runner({ firmware });
 *   runner.gpioC.onOdrChange = (odr) => ui.updateLeds(odr);
 *   runner.run(1_000_000); // step up to 1M cycles
 */
export class Stm32Runner {
  readonly memory: MemoryBus;
  readonly cpu: CortexM3;
  readonly rcc: Stm32RCC;
  readonly gpioA: Stm32GPIO;
  readonly gpioB: Stm32GPIO;
  readonly gpioC: Stm32GPIO;
  readonly gpioD: Stm32GPIO;
  readonly systick: Stm32SysTick;

  /** Set by {@link run} when an unsupported instruction is hit. */
  lastError: UnsupportedInstructionError | null = null;

  constructor(options: Stm32RunnerOptions) {
    this.memory = new MemoryBus();
    this.memory.loadFlash(options.firmware);
    this.cpu = new CortexM3(this.memory);
    this.rcc = new Stm32RCC();
    this.gpioA = new Stm32GPIO("GPIOA", GPIOA_BASE);
    this.gpioB = new Stm32GPIO("GPIOB", GPIOB_BASE);
    this.gpioC = new Stm32GPIO("GPIOC", GPIOC_BASE);
    this.gpioD = new Stm32GPIO("GPIOD", GPIOD_BASE);
    this.systick = new Stm32SysTick();

    this.memory.addMmio(this.rcc);
    this.memory.addMmio(this.gpioA);
    this.memory.addMmio(this.gpioB);
    this.memory.addMmio(this.gpioC);
    this.memory.addMmio(this.gpioD);
    this.memory.addMmio(this.systick);

    this.cpu.reset();
  }

  /**
   * Step at most `maxCycles` instructions. Stops early on halt or on an
   * unsupported instruction (captured in {@link lastError}).
   *
   * Returns the number of cycles actually consumed.
   */
  run(maxCycles: number): number {
    const startCycles = this.cpu.cycles;
    try {
      while (!this.cpu.halted && this.cpu.cycles - startCycles < maxCycles) {
        const consumed = stepThumb(this.cpu);
        this.systick.tick(consumed);
      }
    } catch (err) {
      if (err instanceof UnsupportedInstructionError) {
        this.lastError = err;
        this.cpu.halted = true;
      } else {
        throw err;
      }
    }
    return this.cpu.cycles - startCycles;
  }
}
