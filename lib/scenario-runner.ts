/**
 * Headless automation scenario runner for SparkBench.
 *
 * Parses YAML scenario files and executes steps against an AVR simulation.
 * Supports: delay, set-control, wait-serial, expect-serial.
 */

import * as yaml from "js-yaml";
import { AVRRunner } from "./avr-runner";
import { Diagram, parseDiagram, findMCUs } from "./diagram-parser";
import { wireComponents, cleanupWiring, WiredComponent } from "./wire-components";
import { wireCustomChipsAsync, type CustomChipConfig } from "./chip-runtime";
import { mapArduinoPin, mapAtmega328Pin } from "./pin-mapping";

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
    /** Check that at least this many bytes are non-zero in GDDRAM (SSD1306) */
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
  };
}

interface StepSendSerial {
  "send-serial": string; // text to send to MCU's USART RX
}

interface StepClearSerial {
  "clear-serial": true; // reset captured serial output
}

type ScenarioStep = StepDelay | StepSetControl | StepWaitSerial | StepExpectSerial | StepExpectDisplay | StepSendSerial | StepClearSerial;

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
}

export function parseScenario(yamlContent: string): Scenario {
  return yaml.load(yamlContent) as Scenario;
}

/**
 * Run a scenario headlessly against a compiled HEX.
 *
 * Synchronous variant — does not support custom chips. For chip support,
 * use {@link runScenarioAsync}.
 */
export function runScenario(
  hex: string,
  diagram: Diagram,
  scenario: Scenario,
): ScenarioResult {
  const runner = new AVRRunner(hex);
  const { wired } = wireComponents(runner, diagram);

  let serialOutput = "";
  runner.usart.onByteTransmit = (byte: number) => {
    serialOutput += String.fromCharCode(byte);
  };

  const results: StepResult[] = [];
  let allPassed = true;

  // Run some initial cycles to let the MCU boot and set up
  runner.runMs(10);

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i];

    // Handle clear-serial inline (needs mutable access to serialOutput)
    if ("clear-serial" in step) {
      serialOutput = "";
      results.push({ step: i, description: "clear-serial", passed: true });
      continue;
    }

    const result = executeStep(runner, wired, step, i, () => serialOutput);

    results.push(result);
    if (!result.passed) {
      allPassed = false;
      break; // Stop on first failure
    }

    // Capture serial after step
    serialOutput = serialOutput; // (already accumulated)
  }

  cleanupWiring(wired);
  runner.stop();

  return {
    name: scenario.name,
    passed: allPassed,
    steps: results,
    serialOutput,
  };
}

/**
 * Run a scenario headlessly with custom chip support.
 * Custom chip WASM instantiation is async, so this variant must be awaited.
 */
export async function runScenarioAsync(
  hex: string,
  diagram: Diagram,
  scenario: Scenario,
  chipConfigs?: Map<string, CustomChipConfig>,
): Promise<ScenarioResult> {
  const runner = new AVRRunner(hex);
  const { wired, i2cBus } = wireComponents(runner, diagram);

  let serialOutput = "";
  runner.usart.onByteTransmit = (byte: number) => {
    serialOutput += String.fromCharCode(byte);
  };

  // Wire custom chips (if any)
  let chipRuntimes: Map<string, import("./chip-runtime").CustomChipRuntime> = new Map();
  if (chipConfigs && chipConfigs.size > 0) {
    const mcus = findMCUs(diagram);
    const target = mcus.find((m) => m.simulatable);
    if (target) {
      const pinMapper = target.boardId === "atmega328p" ? mapAtmega328Pin : mapArduinoPin;
      chipRuntimes = await wireCustomChipsAsync(
        runner,
        diagram,
        target.id,
        pinMapper,
        wired,
        chipConfigs,
        i2cBus,
      );
      // Forward chip console output into the serial stream so tests can see it
      for (const rt of chipRuntimes.values()) {
        rt.setConsoleCallback((text) => {
          serialOutput += `[chip] ${text}`;
        });
      }
    }
  }

  const results: StepResult[] = [];
  let allPassed = true;

  // Boot cycles
  runner.runMs(10);

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i];

    if ("clear-serial" in step) {
      serialOutput = "";
      results.push({ step: i, description: "clear-serial", passed: true });
      continue;
    }

    const result = executeStep(runner, wired, step, i, () => serialOutput);
    results.push(result);
    if (!result.passed) {
      allPassed = false;
      break;
    }
  }

  for (const rt of chipRuntimes.values()) rt.dispose();
  cleanupWiring(wired);
  runner.stop();

  return {
    name: scenario.name,
    passed: allPassed,
    steps: results,
    serialOutput,
  };
}

function executeStep(
  runner: AVRRunner,
  wired: Map<string, WiredComponent>,
  step: ScenarioStep,
  index: number,
  getSerial: () => string,
): StepResult {
  if ("delay" in step) {
    const ms = step.delay;
    runner.runMs(ms);
    return { step: index, description: `delay ${ms}ms`, passed: true };
  }

  if ("set-control" in step) {
    const { "part-id": partId, control, value } = step["set-control"];
    const wc = wired.get(partId);
    if (!wc) {
      return {
        step: index,
        description: `set-control ${partId}.${control} = ${value}`,
        passed: false,
        error: `Part "${partId}" not found`,
      };
    }

    if (control === "state" && wc.setState) {
      wc.setState(!!value);
    } else if (control === "pressed" && wc.setPressed) {
      wc.setPressed(!!value);
    } else if (control === "pressed" && wc.pressEncoderButton) {
      if (value) wc.pressEncoderButton();
      else if (wc.releaseEncoderButton) wc.releaseEncoderButton();
    } else if (control === "position" && wc.setValue) {
      // Potentiometer: position is 0.0-1.0, maps to 0-1023
      wc.setValue(Math.round(Number(value) * 1023));
    } else if (control === "temperature" && wc.setTemperature) {
      wc.setTemperature(Number(value));
    } else if (control === "humidity" && wc.setHumidity) {
      wc.setHumidity(Number(value));
    } else if (control === "pressure" && wc.setPressure) {
      wc.setPressure(Number(value));
    } else if (control === "accel" && wc.setAccel) {
      // value is "x,y,z" string
      const [x, y, z] = String(value).split(",").map(Number);
      wc.setAccel(x, y, z);
    } else if (control === "gyro" && wc.setGyro) {
      const [x, y, z] = String(value).split(",").map(Number);
      wc.setGyro(x, y, z);
    } else if (control === "rotate-cw" && wc.stepCW) {
      const steps = Number(value) || 1;
      for (let i = 0; i < steps; i++) {
        wc.stepCW();
        // Run enough cycles for the quadrature sequence to complete
        // (4 transitions × 8000 cycles = 32000, plus margin)
        runner.runCycles(40000);
      }
    } else if (control === "rotate-ccw" && wc.stepCCW) {
      const steps = Number(value) || 1;
      for (let i = 0; i < steps; i++) {
        wc.stepCCW();
        runner.runCycles(40000);
      }
    } else {
      return {
        step: index,
        description: `set-control ${partId}.${control} = ${value}`,
        passed: false,
        error: `Control "${control}" not supported on part "${partId}"`,
      };
    }

    return {
      step: index,
      description: `set-control ${partId}.${control} = ${value}`,
      passed: true,
    };
  }

  if ("wait-serial" in step) {
    const expected = step["wait-serial"];
    const timeout = step.timeout ?? 5000;
    const cyclesPerMs = runner.speed / 1000;
    const maxCycles = timeout * cyclesPerMs;
    const batchCycles = 1000; // Run in small batches to check serial frequently
    let cyclesRun = 0;

    while (cyclesRun < maxCycles) {
      runner.runCycles(batchCycles);
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
    for (let i = 0; i < text.length; i++) {
      runner.usart.writeByte(text.charCodeAt(i));
    }
    // Send newline to trigger line-based parsing
    runner.usart.writeByte(13); // CR
    runner.usart.writeByte(10); // LF
    return {
      step: index,
      description: `send-serial "${text}"`,
      passed: true,
    };
  }

  return {
    step: index,
    description: `unknown step type`,
    passed: false,
    error: `Unrecognized step: ${JSON.stringify(step)}`,
  };
}
