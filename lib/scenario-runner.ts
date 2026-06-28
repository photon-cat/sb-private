/**
 * Headless automation scenario runner for SparkBench.
 *
 * Parses YAML scenario files and executes steps against a simulation. Works for
 * any MCU: the AVR path stays synchronous (back-compat), while STM32/RP2040 run
 * through the async {@link runScenarioAsync} via the unified HeadlessMcu adapter.
 * Supports: delay, set-control, wait-serial, expect-serial, expect-display,
 * send-serial, clear-serial, expect-pin.
 */

import * as yaml from "js-yaml";
import { PinState } from "avr8js";
import { AVRRunner } from "./avr-runner";
import { Diagram, findMCUs } from "./diagram-parser";
import { wireComponents, cleanupWiring, WiredComponent } from "./wire-components";
import { type CustomChipConfig } from "./chip-runtime";
import { mapArduinoPin, mapAtmega328Pin, getPort } from "./pin-mapping";
import { createHeadlessMcu, type HeadlessMcu } from "./sim/headless-mcu";
import { applyControl } from "./sim/controls";
import type { SimCore } from "./sim/sim-core";

// --- Scenario types ---

interface StepDelay {
  delay: number; // milliseconds
}

interface StepSetControl {
  "set-control": {
    "part-id": string;
    control: string; // "state" for switches, "pressed" for buttons
    value: number | boolean;
  };
}

interface StepWaitSerial {
  "wait-serial": string;
  timeout?: number; // ms, default 5000
}

interface StepExpectSerial {
  "expect-serial": string;
}

interface StepExpectDisplay {
  "expect-display": {
    "part-id": string;
    /** SSD1306: min non-zero GDDRAM bytes. Framebuffer: min non-black pixels. */
    "min-filled"?: number;
    /** Hex pattern to match at a specific byte offset (SSD1306), e.g. "55 aa 55 aa" */
    pattern?: string;
    offset?: number;
    /** Substring to search for across the decoded LCD1602 character buffer */
    text?: string;
    /** Exact match for LCD1602 row 0 (16 chars, trailing spaces ignored) */
    "line-0"?: string;
    /** Exact match for LCD1602 row 1 */
    "line-1"?: string;
    /** Framebuffer (custom chip / TFT): assert at least one non-black pixel. */
    "not-blank"?: boolean;
    /** Framebuffer: assert a pixel. {x,y} alone = lit; with rgba = exact color. */
    pixel?: { x: number; y: number; rgba?: [number, number, number, number] };
  };
}

interface StepSendSerial {
  "send-serial": string; // text to send to MCU's USART RX
}

interface StepClearSerial {
  "clear-serial": true; // reset captured serial output
}

interface StepExpectPin {
  "expect-pin": {
    /** Board-native pin name: "13"/"D13"/"A0" (AVR), "PC13" (STM32), "GP25" (RP2040). */
    pin: string;
    /** Expected logic level: "high"/"low", "1"/"0", or boolean. */
    state: "high" | "low" | "1" | "0" | boolean | number;
    /** If set, wait up to this many simulated ms for the pin to reach `state`. */
    timeout?: number;
  };
}

type ScenarioStep = StepDelay | StepSetControl | StepWaitSerial | StepExpectSerial | StepExpectDisplay | StepSendSerial | StepClearSerial | StepExpectPin;

export interface Scenario {
  name: string;
  version: number;
  steps: ScenarioStep[];
}

export interface StepResult {
  step: number;
  description: string;
  passed: boolean;
  error?: string;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  steps: StepResult[];
  serialOutput: string;
  /** Effective MCU clock the scenario ran at (Hz) — core default unless overridden. */
  clockHz: number;
}

export interface ScenarioOptions {
  /** MCU clock in Hz. Defaults per core. Affects timer/serial timing and simulated-time math. */
  clockHz?: number;
}

/** Firmware for a scenario: a hex string (AVR) or a {simCore, hex|bin} object. */
export type ScenarioFirmware =
  | string
  | { simCore: SimCore; hex?: string; bin?: Uint8Array };

/**
 * The slice of a runner the step executor needs. Both the synchronous AVR path
 * and the async {@link HeadlessMcu} adapter satisfy this, so executeStep is
 * MCU-agnostic.
 */
interface StepHost {
  readonly clockHz: number;
  readonly wired: Map<string, WiredComponent>;
  runCycles(n: number): void;
  runMs(ms: number): void;
  serial(): string;
  clearSerial(): void;
  sendSerial(text: string): void;
  pinHigh(pinName: string): boolean;
}

export function parseScenario(yamlContent: string): Scenario {
  return yaml.load(yamlContent) as Scenario;
}

/** Drive the step list against any StepHost. Shared by sync + async runners. */
function runSteps(host: StepHost, scenario: Scenario): ScenarioResult {
  const results: StepResult[] = [];
  let allPassed = true;

  // Boot cycles to let the MCU come up.
  host.runMs(10);

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i];

    if ("clear-serial" in step) {
      host.clearSerial();
      results.push({ step: i, description: "clear-serial", passed: true });
      continue;
    }

    const result = executeStep(host, step, i);
    results.push(result);
    if (!result.passed) {
      allPassed = false;
      break; // Stop on first failure
    }
  }

  return { name: scenario.name, passed: allPassed, steps: results, serialOutput: host.serial(), clockHz: host.clockHz };
}

/**
 * Run a scenario headlessly against a compiled AVR HEX.
 *
 * Synchronous variant — AVR only, no custom chips. For chip support or non-AVR
 * cores (STM32/RP2040), use {@link runScenarioAsync}.
 */
export function runScenario(
  hex: string,
  diagram: Diagram,
  scenario: Scenario,
  options?: ScenarioOptions,
): ScenarioResult {
  const runner = new AVRRunner(hex, { clockHz: options?.clockHz });
  const { wired } = wireComponents(runner, diagram);

  let serialOutput = "";
  runner.usart.onByteTransmit = (byte: number) => {
    serialOutput += String.fromCharCode(byte);
  };

  const host: StepHost = {
    clockHz: runner.speed,
    wired,
    runCycles: (n) => runner.runCycles(n),
    runMs: (ms) => runner.runMs(ms),
    serial: () => serialOutput,
    clearSerial: () => { serialOutput = ""; },
    sendSerial: (text) => { for (const ch of text) runner.usart.writeByte(ch.charCodeAt(0)); },
    pinHigh: (pinName) => {
      const info = mapArduinoPin(pinName) ?? mapAtmega328Pin(pinName);
      if (!info) throw new Error(`Unknown pin "${pinName}"`);
      return getPort(runner, info.port).pinState(info.pin) === PinState.High;
    },
  };

  const result = runSteps(host, scenario);

  cleanupWiring(wired);
  runner.stop();
  return result;
}

/**
 * Run a scenario headlessly with custom-chip support and any MCU core.
 *
 * `firmware` may be a hex string (AVR, back-compat) or a {simCore, hex|bin}
 * object (STM32/RP2040). Async because non-AVR cores load their engines lazily
 * and custom-chip WASM instantiation is async.
 */
export async function runScenarioAsync(
  firmware: ScenarioFirmware,
  diagram: Diagram,
  scenario: Scenario,
  chipConfigs?: Map<string, CustomChipConfig>,
  options?: ScenarioOptions,
): Promise<ScenarioResult> {
  const fw = typeof firmware === "string" ? { simCore: "avr8js" as SimCore, hex: firmware } : firmware;
  const target = findMCUs(diagram).find((m) => m.simulatable) ?? findMCUs(diagram)[0];

  const mcu: HeadlessMcu = await createHeadlessMcu({
    simCore: fw.simCore,
    hex: fw.hex,
    bin: fw.bin,
    diagram,
    target,
    clockHz: options?.clockHz,
    chipConfigs,
  });

  // Forward chip console output into the serial stream so tests can see it.
  for (const rt of mcu.chipRuntimes.values()) {
    rt.setConsoleCallback((text) => mcu.injectSerial(`[chip] ${text}`));
  }

  const result = runSteps(mcu, scenario);
  mcu.dispose();
  return result;
}

function executeStep(
  host: StepHost,
  step: ScenarioStep,
  index: number,
): StepResult {
  const wired = host.wired;
  const getSerial = () => host.serial();
  if ("delay" in step) {
    const ms = step.delay;
    host.runMs(ms);
    return { step: index, description: `delay ${ms}ms`, passed: true };
  }

  if ("set-control" in step) {
    const { "part-id": partId, control, value } = step["set-control"];
    const result = applyControl(wired, partId, control, value, (n) => host.runCycles(n));
    return {
      step: index,
      description: `set-control ${partId}.${control} = ${value}`,
      passed: result.ok,
      ...(result.ok ? {} : { error: result.error }),
    };
  }

  if ("wait-serial" in step) {
    const expected = step["wait-serial"];
    const timeout = step.timeout ?? 5000;
    const cyclesPerMs = host.clockHz / 1000;
    const maxCycles = timeout * cyclesPerMs;
    const batchCycles = 1000; // Run in small batches to check serial frequently
    let cyclesRun = 0;

    while (cyclesRun < maxCycles) {
      host.runCycles(batchCycles);
      cyclesRun += batchCycles;

      if (getSerial().includes(expected)) {
        return {
          step: index,
          description: `wait-serial "${expected}"`,
          passed: true,
        };
      }
    }

    return {
      step: index,
      description: `wait-serial "${expected}"`,
      passed: false,
      error: `Timeout (${timeout}ms) waiting for "${expected}". Serial output:\n${getSerial()}`,
    };
  }

  if ("expect-serial" in step) {
    const expected = step["expect-serial"];
    const serial = getSerial();
    if (serial.includes(expected)) {
      return {
        step: index,
        description: `expect-serial "${expected}"`,
        passed: true,
      };
    }
    return {
      step: index,
      description: `expect-serial "${expected}"`,
      passed: false,
      error: `Serial output does not contain "${expected}". Got:\n${serial}`,
    };
  }

  if ("expect-display" in step) {
    const {
      "part-id": partId,
      "min-filled": minFilled,
      pattern,
      offset,
      text,
      "line-0": line0,
      "line-1": line1,
      "not-blank": notBlank,
      pixel,
    } = step["expect-display"];
    const wc = wired.get(partId);
    if (!wc) {
      return {
        step: index,
        description: `expect-display ${partId}`,
        passed: false,
        error: `Part "${partId}" not found`,
      };
    }

    // --- Framebuffer path (custom chips / TFT displays via RGBA pixels) ---
    const fb = wc.chipRuntime?.getFramebuffer() ?? wc.ili9341?.getFramebuffer();
    if (fb && (notBlank !== undefined || pixel !== undefined || (minFilled !== undefined && !wc.ssd1306))) {
      const { width, height, pixels } = fb;

      if (notBlank) {
        let any = false;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] || pixels[i + 1] || pixels[i + 2]) { any = true; break; }
        }
        if (!any) {
          return { step: index, description: `expect-display ${partId} not-blank`, passed: false, error: "Framebuffer is entirely blank (no non-black pixels)" };
        }
      }

      if (minFilled !== undefined) {
        let lit = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] || pixels[i + 1] || pixels[i + 2]) lit++;
        }
        if (lit < minFilled) {
          return { step: index, description: `expect-display ${partId} min-filled=${minFilled}`, passed: false, error: `Only ${lit} non-black pixels (expected >= ${minFilled})` };
        }
      }

      if (pixel) {
        const { x, y, rgba } = pixel;
        if (x < 0 || y < 0 || x >= width || y >= height) {
          return { step: index, description: `expect-display ${partId} pixel`, passed: false, error: `Pixel (${x},${y}) out of bounds ${width}x${height}` };
        }
        const idx = (y * width + x) * 4;
        const got: [number, number, number, number] = [pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]];
        if (rgba) {
          if (got[0] !== rgba[0] || got[1] !== rgba[1] || got[2] !== rgba[2] || got[3] !== rgba[3]) {
            return { step: index, description: `expect-display ${partId} pixel(${x},${y})`, passed: false, error: `Pixel (${x},${y}) is [${got}], expected [${rgba}]` };
          }
        } else if (!(got[0] || got[1] || got[2])) {
          return { step: index, description: `expect-display ${partId} pixel(${x},${y})`, passed: false, error: `Pixel (${x},${y}) is not lit` };
        }
      }

      return { step: index, description: `expect-display ${partId} framebuffer ok`, passed: true };
    }

    // --- LCD1602 path (text-based assertions) ---
    if (wc.lcd1602) {
      const [row0, row1] = wc.lcd1602.toText();
      const stripped0 = row0.replace(/\s+$/, "");
      const stripped1 = row1.replace(/\s+$/, "");
      const fullText = `${row0}\n${row1}`;

      if (text !== undefined && !fullText.includes(text)) {
        return {
          step: index,
          description: `expect-display ${partId} text="${text}"`,
          passed: false,
          error: `LCD does not contain "${text}". Got:\n[${row0}]\n[${row1}]`,
        };
      }
      if (line0 !== undefined && stripped0 !== line0.replace(/\s+$/, "")) {
        return {
          step: index,
          description: `expect-display ${partId} line-0`,
          passed: false,
          error: `LCD row 0 mismatch. Expected "${line0}", got "${row0}"`,
        };
      }
      if (line1 !== undefined && stripped1 !== line1.replace(/\s+$/, "")) {
        return {
          step: index,
          description: `expect-display ${partId} line-1`,
          passed: false,
          error: `LCD row 1 mismatch. Expected "${line1}", got "${row1}"`,
        };
      }
      return {
        step: index,
        description: `expect-display ${partId} LCD ok`,
        passed: true,
      };
    }

    if (!wc.ssd1306) {
      return {
        step: index,
        description: `expect-display ${partId}`,
        passed: false,
        error: `Part "${partId}" is not an SSD1306 or LCD1602 display`,
      };
    }

    const gddram = wc.ssd1306.gddramBuffer;

    // Check min-filled
    if (minFilled !== undefined) {
      let nonZero = 0;
      for (let i = 0; i < gddram.length; i++) {
        if (gddram[i] !== 0) nonZero++;
      }
      if (nonZero < minFilled) {
        return {
          step: index,
          description: `expect-display ${partId} min-filled=${minFilled}`,
          passed: false,
          error: `Only ${nonZero} non-zero bytes in GDDRAM (expected >= ${minFilled})`,
        };
      }
    }

    // Check pattern at offset
    if (pattern !== undefined) {
      const patternBytes = pattern.split(/\s+/).map((h) => parseInt(h, 16));
      const off = offset ?? 0;
      for (let i = 0; i < patternBytes.length; i++) {
        if (gddram[off + i] !== patternBytes[i]) {
          const actual = Array.from(gddram.slice(off, off + patternBytes.length))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(" ");
          return {
            step: index,
            description: `expect-display ${partId} pattern at offset ${off}`,
            passed: false,
            error: `Pattern mismatch at offset ${off + i}. Expected: ${pattern}, Got: ${actual}`,
          };
        }
      }
    }

    return {
      step: index,
      description: `expect-display ${partId}` +
        (minFilled !== undefined ? ` min-filled=${minFilled}` : "") +
        (pattern !== undefined ? ` pattern="${pattern}"` : ""),
      passed: true,
    };
  }

  if ("send-serial" in step) {
    const text = step["send-serial"];
    try {
      // Append CRLF to trigger line-based parsing (matches the prior AVR behavior).
      host.sendSerial(text + "\r\n");
    } catch (err) {
      return {
        step: index,
        description: `send-serial "${text}"`,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      step: index,
      description: `send-serial "${text}"`,
      passed: true,
    };
  }

  if ("expect-pin" in step) {
    const { pin: pinName, state, timeout } = step["expect-pin"];
    const want = parsePinState(state);
    const desc = `expect-pin ${pinName} = ${want ? "HIGH" : "LOW"}`;

    let isHigh: () => boolean;
    try {
      // Probe once to surface unknown-pin errors before the timing loop.
      host.pinHigh(pinName);
      isHigh = () => host.pinHigh(pinName);
    } catch (err) {
      return { step: index, description: desc, passed: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (timeout && timeout > 0) {
      // Poll the pin in small batches until it reaches the desired state.
      const cyclesPerMs = host.clockHz / 1000;
      const maxCycles = timeout * cyclesPerMs;
      const batchCycles = 1000;
      let cyclesRun = 0;
      while (cyclesRun < maxCycles) {
        if (isHigh() === want) return { step: index, description: desc, passed: true };
        host.runCycles(batchCycles);
        cyclesRun += batchCycles;
      }
      if (isHigh() === want) return { step: index, description: desc, passed: true };
      return {
        step: index,
        description: desc,
        passed: false,
        error: `Timeout (${timeout}ms): pin ${pinName} did not reach ${want ? "HIGH" : "LOW"}`,
      };
    }

    // Instantaneous assertion
    if (isHigh() === want) return { step: index, description: desc, passed: true };
    return {
      step: index,
      description: desc,
      passed: false,
      error: `Pin ${pinName} is ${isHigh() ? "HIGH" : "LOW"}, expected ${want ? "HIGH" : "LOW"}`,
    };
  }

  return {
    step: index,
    description: `unknown step type`,
    passed: false,
    error: `Unrecognized step: ${JSON.stringify(step)}`,
  };
}

/** Normalize a scenario pin-state value to a boolean (true = HIGH). */
function parsePinState(state: "high" | "low" | "1" | "0" | boolean | number): boolean {
  if (typeof state === "boolean") return state;
  if (typeof state === "number") return state !== 0;
  return state === "high" || state === "1";
}
