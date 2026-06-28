/**
 * Shared "set-control" mapping for SparkBench simulations.
 *
 * Translates a high-level control name + value (the vocabulary used by scenario
 * YAML `set-control` steps and the MCP `sparkbench_set_control` tool) onto the
 * per-component handlers exposed by {@link WiredComponent}. Keeping this in one
 * place means the scenario runner and the MCP server drive components
 * identically — a potentiometer `position` is always 0.0-1.0, an encoder always
 * runs the quadrature cycles, etc.
 */

import type { WiredComponent } from "../wire-components";

/** Cycles to advance per encoder detent so the quadrature sequence completes. */
export const ENCODER_STEP_CYCLES = 40000;

export type ControlResult = { ok: true } | { ok: false; error: string };

/**
 * Apply a control change to a wired component.
 *
 * @param wired      The simulation's wired-component map.
 * @param partId     Diagram part id to drive.
 * @param control    Control name: state | pressed | position | temperature |
 *                   humidity | pressure | accel | gyro | rotate-cw | rotate-ccw.
 * @param value      Control value. Booleans/numbers for toggles and positions;
 *                   "x,y,z" string for accel/gyro; detent count for rotation.
 * @param runCycles  Advances the simulation — required for encoder rotation so
 *                   the firmware sees the full quadrature transition.
 */
export function applyControl(
  wired: Map<string, WiredComponent>,
  partId: string,
  control: string,
  value: number | boolean | string,
  runCycles: (n: number) => void,
): ControlResult {
  const wc = wired.get(partId);
  if (!wc) {
    return { ok: false, error: `Part "${partId}" not found` };
  }

  if (control === "state" && wc.setState) {
    wc.setState(!!value);
  } else if (control === "pressed" && wc.setPressed) {
    wc.setPressed(!!value);
  } else if (control === "pressed" && wc.pressEncoderButton) {
    if (value) wc.pressEncoderButton();
    else if (wc.releaseEncoderButton) wc.releaseEncoderButton();
  } else if (control === "position" && wc.setValue) {
    // Potentiometer / slide-pot: position is 0.0-1.0, maps to 0-1023.
    wc.setValue(Math.round(Number(value) * 1023));
  } else if (control === "temperature" && wc.setTemperature) {
    wc.setTemperature(Number(value));
  } else if (control === "humidity" && wc.setHumidity) {
    wc.setHumidity(Number(value));
  } else if (control === "pressure" && wc.setPressure) {
    wc.setPressure(Number(value));
  } else if (control === "accel" && wc.setAccel) {
    const [x, y, z] = String(value).split(",").map(Number);
    wc.setAccel(x, y, z);
  } else if (control === "gyro" && wc.setGyro) {
    const [x, y, z] = String(value).split(",").map(Number);
    wc.setGyro(x, y, z);
  } else if (control === "rotate-cw" && wc.stepCW) {
    const steps = Number(value) || 1;
    for (let i = 0; i < steps; i++) {
      wc.stepCW();
      runCycles(ENCODER_STEP_CYCLES);
    }
  } else if (control === "rotate-ccw" && wc.stepCCW) {
    const steps = Number(value) || 1;
    for (let i = 0; i < steps; i++) {
      wc.stepCCW();
      runCycles(ENCODER_STEP_CYCLES);
    }
  } else {
    return {
      ok: false,
      error: `Control "${control}" not supported on part "${partId}"`,
    };
  }

  return { ok: true };
}
