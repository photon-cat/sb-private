// Shared runner type for the UI: either the AVR engine (avr8js) or an STM32 core
// (CortexM0Host / unicorn.js, via STM32Runner). Both expose execute()/stop()/
// resume(); the wiring layer branches on isStm32Runner to pick the GPIO surface.

import type { AVRRunnerLike } from "../pin-mapping";
import type { STM32Runner } from "../stm32-runner";

export type SimRunner = AVRRunnerLike | STM32Runner;

/** Narrow a runner to STM32Runner (has a peripheral platform + ms stepping). */
export function isStm32Runner(r: SimRunner | null | undefined): r is STM32Runner {
  return !!r && "platform" in r && typeof (r as STM32Runner).runMs === "function";
}

/** Retired-cycle counter, whichever engine. */
export function runnerCycles(r: SimRunner): number {
  return isStm32Runner(r) ? r.cycles : r.cpu.cycles;
}

/** System clock in Hz, whichever engine. */
export function runnerClockHz(r: SimRunner): number {
  return isStm32Runner(r) ? r.clockHz : r.speed;
}
