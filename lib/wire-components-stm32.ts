// STM32 component wiring — the ARM counterpart of wire-components.ts.
//
// The AVR wiring path reaches into avr8js port objects directly; STM32 cores
// instead expose a port-name API (pinState / setPinInput / watchPin / setAnalog)
// on STM32Runner. This module produces the SAME WiredComponent map the UI binds
// to, so the render/event layer (useSimulationWiring) is identical for both.
//
// Covered today: LED, buzzer (output watch), pushbutton (input pull-up),
// potentiometer (ADC). Other parts fall through as un-driven (still rendered).

import type { STM32Runner } from "./stm32-runner";
import {
  type Diagram,
  findComponentPins,
  findMCUs,
} from "./diagram-parser";
import { mapSTM32Pin } from "./pin-mapping";
import type { WiredComponent, WireResult } from "./wire-components";

/**
 * Wire diagram components to an STM32 runner's GPIO/ADC. Returns the same shape
 * as wireComponents(); i2cBus is omitted (STM32 I2C devices attach via the
 * runner's attachI2CDevice and aren't part of the AVR I2CBus path).
 */
export function wireComponentsStm32(
  runner: STM32Runner,
  diagram: Diagram,
  mcuId?: string,
): Pick<WireResult, "wired"> {
  // Resolve which MCU part the components hang off (first simulatable STM32).
  let resolvedMcuId = mcuId;
  if (!resolvedMcuId) {
    const target = findMCUs(diagram).find((m) => m.simulatable) ?? findMCUs(diagram)[0];
    resolvedMcuId = target?.id;
  }

  const pinMap = findComponentPins(diagram, resolvedMcuId);
  const wired = new Map<string, WiredComponent>();

  for (const part of diagram.parts) {
    const mcuPin = pinMap.get(part.id);
    const loc = mcuPin ? mapSTM32Pin(mcuPin) : null;
    if (!loc) {
      wired.set(part.id, { part });
      continue;
    }
    const wc: WiredComponent = { part };

    if (part.type === "wokwi-led" || part.type === "wokwi-buzzer") {
      // Push current level immediately, then track changes.
      const emit = (high: boolean) => wc.onStateChange?.(high);
      emit(runner.pinState(loc.port, loc.pin));
      runner.watchPin(loc.port, loc.pin, emit);
    } else if (part.type === "wokwi-pushbutton") {
      // INPUT_PULLUP: idle HIGH, pressed pulls LOW.
      runner.setPinInput(loc.port, loc.pin, true);
      wc.setPressed = (pressed: boolean) =>
        runner.setPinInput(loc.port, loc.pin, !pressed);
    } else if (
      part.type === "wokwi-potentiometer" ||
      part.type === "wokwi-slide-potentiometer"
    ) {
      // Map the wired pin to its ADC channel (PA0→ch0 … on most STM32 the low
      // GPIOA pins are ADC_INx); deliver 12-bit samples.
      const channel = loc.port === "GPIOA" ? loc.pin : loc.pin;
      const initial = parseInt(part.attrs.value || "0", 10);
      runner.setAnalog(channel, Math.round((initial / 1023) * 4095));
      wc.setValue = (value: number) =>
        runner.setAnalog(channel, Math.round((Math.max(0, Math.min(1023, value)) / 1023) * 4095));
    }

    wired.set(part.id, wc);
  }

  return { wired };
}
