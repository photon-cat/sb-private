#!/usr/bin/env npx tsx
/**
 * sparkbench run — 1:1 compatible CLI with `wokwi-cli` for headless
 * simulation and screenshots.
 *
 * Supports the same flags as wokwi-cli's main simulator mode:
 *
 *   --timeout <ms>              stop the simulation after this many ms
 *   --expect-text <string>      exit 0 when this appears in serial, 1 otherwise
 *   --fail-text <string>        exit 1 if this appears in serial
 *   --serial-log-file <path>    write serial output to a file
 *   --screenshot-part <id>      part id to screenshot (ssd1306, lcd1602)
 *   --screenshot-time <ms>      simulated time at which to capture
 *   --screenshot-file <path>    output PNG path (default: screenshot.png)
 *   -q, --quiet                 suppress status messages
 *
 * Usage:
 *   npx tsx scripts/sparkbench-run.ts <project-slug> [options]
 *   sparkbench run <project-slug> [options]
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import os from "os";
import { parseDiagram, findMCUs } from "../lib/diagram-parser";
import { AVRRunner } from "../lib/avr-runner";
import { wireComponents, cleanupWiring } from "../lib/wire-components";
import { wireCustomChipsAsync } from "../lib/chip-runtime";
import { mapArduinoPin, mapAtmega328Pin } from "../lib/pin-mapping";
import { findChipFiles } from "../lib/chip-json";
import type { CustomChipConfig } from "../lib/chip-runtime";
import { encodeSsd1306Png, encodeLcd1602Png } from "../lib/display-renderer";

const ROOT = path.resolve(__dirname, "..");
const PIO_CMD = path.join(os.homedir(), ".platformio-venv/bin/platformio");
const WOKWI_CLI = path.join(os.homedir(), "bin/wokwi-cli");

// ── Args ────────────────────────────────────────────────────

interface Args {
  slug: string;
  timeoutMs: number;
  expectText?: string;
  failText?: string;
  serialLogFile?: string;
  screenshotPart?: string;
  screenshotTimeMs?: number;
  screenshotFile: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    slug: "",
    timeoutMs: 30000,
    screenshotFile: "screenshot.png",
    quiet: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--timeout":          out.timeoutMs = parseInt(argv[++i], 10); break;
      case "--expect-text":      out.expectText = argv[++i]; break;
      case "--fail-text":        out.failText = argv[++i]; break;
      case "--serial-log-file":  out.serialLogFile = argv[++i]; break;
      case "--screenshot-part":  out.screenshotPart = argv[++i]; break;
      case "--screenshot-time":  out.screenshotTimeMs = parseInt(argv[++i], 10); break;
      case "--screenshot-file":  out.screenshotFile = argv[++i]; break;
      case "-q":
      case "--quiet":            out.quiet = true; break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        rest.push(a);
    }
  }
  if (rest.length === 0) {
    printUsage();
    process.exit(2);
  }
  out.slug = rest[0];
  return out;
}

function printUsage() {
  console.log(`Usage: sparkbench run <project-slug> [options]

Options:
  --timeout <ms>              Timeout in milliseconds (default: 30000)
  --expect-text <string>      Expect text in serial output (exit 0 on match)
  --fail-text <string>        Fail if text found in serial output
  --serial-log-file <path>    Log serial output to file
  --screenshot-part <id>      Part ID for screenshot (ssd1306 or lcd1602 controller)
  --screenshot-time <ms>      Simulated ms at which to capture the screenshot
  --screenshot-file <path>    Screenshot output file (default: screenshot.png)
  -q, --quiet                 Suppress status messages
  -h, --help                  Show this help`);
}

// ── Build firmware ──────────────────────────────────────────

const HEADER_TO_LIB: Record<string, string> = {
  "LiquidCrystal_I2C.h": "marcoschwartz/LiquidCrystal_I2C",
  "Adafruit_GFX.h": "adafruit/Adafruit GFX Library",
  "Adafruit_SSD1306.h": "adafruit/Adafruit SSD1306",
  "Adafruit_MPU6050.h": "adafruit/Adafruit MPU6050",
  "Adafruit_NeoPixel.h": "adafruit/Adafruit NeoPixel",
  "Adafruit_Sensor.h": "adafruit/Adafruit Unified Sensor",
  "DHT.h": "adafruit/DHT sensor library",
  "Servo.h": "arduino-libraries/Servo",
};

function detectLibs(source: string): string[] {
  const libs = new Set<string>();
  for (const m of source.matchAll(/#include\s*[<"]([^>"]+)[>"]/g)) {
    const lib = HEADER_TO_LIB[m[1]];
    if (lib) libs.add(lib);
  }
  return Array.from(libs);
}

function compileFirmware(slug: string, board: string, workDir: string, quiet: boolean): string {
  const projDir = path.join(ROOT, "projects", slug);
  const sketchPath = path.join(projDir, "sketch.ino");

  let sketch = readFileSync(sketchPath, "utf-8");
  if (!sketch.includes("#include <Arduino.h>") && !sketch.includes('#include "Arduino.h"')) {
    sketch = "#include <Arduino.h>\n" + sketch;
  }

  let librariesTxt = "";
  try { librariesTxt = readFileSync(path.join(projDir, "libraries.txt"), "utf-8"); } catch { /* optional */ }
  const baseLibDeps = [
    "arduino-libraries/Servo@^1.2.1",
    "adafruit/DHT sensor library@^1.4.6",
    "adafruit/Adafruit Unified Sensor@^1.1.14",
  ];
  const extraLibs = librariesTxt.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const detected = detectLibs(sketch);
  const seen = new Set(baseLibDeps.map((l) => l.toLowerCase()));
  const allLibs = [...baseLibDeps];
  for (const l of [...detected, ...extraLibs]) {
    const k = l.toLowerCase();
    if (!seen.has(k)) { seen.add(k); allLibs.push(l); }
  }

  const pioBoard = board === "atmega328p" ? "uno" : board;
  const pioIni = `[env:${board}]
platform = atmelavr
board = ${pioBoard}
framework = arduino
lib_deps =
${allLibs.map((l) => `  ${l}`).join("\n")}
`;
  mkdirSync(path.join(workDir, "src"), { recursive: true });
  writeFileSync(path.join(workDir, "platformio.ini"), pioIni);
  writeFileSync(path.join(workDir, "src/main.cpp"), sketch);

  if (!quiet) console.error(`[sparkbench] Compiling ${slug} for ${board}...`);
  try {
    execFileSync(PIO_CMD, ["run", "-e", board], {
      cwd: workDir,
      timeout: 120_000,
      stdio: quiet ? "pipe" : "pipe",
    });
  } catch (err) {
    const e = err as { stderr?: Buffer; stdout?: Buffer };
    console.error("Compilation failed:");
    if (e.stderr) console.error(e.stderr.toString());
    if (e.stdout) console.error(e.stdout.toString());
    process.exit(1);
  }
  return readFileSync(path.join(workDir, ".pio", "build", board, "firmware.hex"), "utf-8");
}

// ── Compile chips (matches oracle-test.ts approach) ─────────

async function compileChips(
  slug: string,
  workDir: string,
  diagram: ReturnType<typeof parseDiagram>,
  quiet: boolean,
): Promise<Map<string, CustomChipConfig>> {
  const configs = new Map<string, CustomChipConfig>();
  const projDir = path.join(ROOT, "projects", slug);
  let entries: string[] = [];
  try { entries = readdirSync(projDir); } catch { return configs; }
  const projectFiles = entries
    .filter((n) => !n.startsWith(".") && n !== "diagram.json" && n !== "sketch.ino")
    .map((n) => ({ name: n, content: readFileSync(path.join(projDir, n), "utf-8") }));

  const chips = findChipFiles(projectFiles);
  for (const chip of chips) {
    const srcName = `${chip.chipName}.c`;
    const wasmName = `${chip.chipName}.wasm`;
    writeFileSync(path.join(workDir, srcName), chip.source);
    if (!quiet) console.error(`[sparkbench] Compiling chip ${chip.chipName}...`);
    execFileSync(WOKWI_CLI, ["chip", "compile", srcName, "-o", wasmName], {
      cwd: workDir,
      timeout: 60_000,
      stdio: "pipe",
    });
    const wasmBytes = new Uint8Array(readFileSync(path.join(workDir, wasmName))).slice().buffer;
    const matchingPart = diagram.parts.find((p) => p.type === chip.partType);
    if (matchingPart) {
      configs.set(matchingPart.id, { chipJson: chip.chipJson, wasmBytes });
    }
  }
  return configs;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const projDir = path.join(ROOT, "projects", args.slug);
  if (!existsSync(projDir)) {
    console.error(`Project not found: ${projDir}`);
    process.exit(1);
  }

  const diagramJson = JSON.parse(readFileSync(path.join(projDir, "diagram.json"), "utf-8"));
  const diagram = parseDiagram(diagramJson);
  const mcus = findMCUs(diagram);
  const target = mcus.find((m) => m.simulatable);
  if (!target) {
    console.error(`No simulatable MCU found in ${args.slug}`);
    process.exit(1);
  }

  const workDir = path.join(os.tmpdir(), `sparkbench-run-${args.slug}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  let exitCode = 0;
  try {
    const hex = compileFirmware(args.slug, target.boardId, workDir, args.quiet);
    const chipConfigs = await compileChips(args.slug, workDir, diagram, args.quiet);

    if (!args.quiet) console.error(`[sparkbench] Starting simulation (timeout: ${args.timeoutMs}ms)...`);

    const runner = new AVRRunner(hex);
    const { wired, i2cBus } = wireComponents(runner, diagram);

    // Wire custom chips
    if (chipConfigs.size > 0) {
      const pinMapper = target.boardId === "atmega328p" ? mapAtmega328Pin : mapArduinoPin;
      await wireCustomChipsAsync(runner, diagram, target.id, pinMapper, wired, chipConfigs, i2cBus);
    }

    // Serial capture
    let serialOutput = "";
    runner.usart.onByteTransmit = (byte: number) => {
      serialOutput += String.fromCharCode(byte);
      if (!args.quiet) process.stdout.write(String.fromCharCode(byte));
    };

    // Simulated-time snapshot for screenshot
    let screenshotTaken = false;
    let expectMatched = false;
    let failMatched = false;

    const checkSerial = () => {
      if (args.expectText && !expectMatched && serialOutput.includes(args.expectText)) {
        expectMatched = true;
      }
      if (args.failText && serialOutput.includes(args.failText)) {
        failMatched = true;
      }
    };

    // Run the simulator in small time slices so we can check for serial
    // matches and take screenshots at the right simulated time.
    const sliceMs = 10;
    const cyclesPerMs = runner.speed / 1000;
    const screenshotAtCycles = args.screenshotTimeMs ?? -1;
    let totalCycles = 0;
    const totalTargetCycles = args.timeoutMs * cyclesPerMs;

    while (totalCycles < totalTargetCycles) {
      runner.runCycles(sliceMs * cyclesPerMs);
      totalCycles += sliceMs * cyclesPerMs;
      checkSerial();

      // Take screenshot at the requested simulated time
      if (!screenshotTaken && screenshotAtCycles > 0 && args.screenshotPart
        && totalCycles >= screenshotAtCycles * cyclesPerMs) {
        const wc = wired.get(args.screenshotPart);
        if (!wc) {
          console.error(`[sparkbench] Error: screenshot-part '${args.screenshotPart}' not found in diagram`);
          exitCode = 1;
          break;
        }
        if (wc.ssd1306) {
          const png = encodeSsd1306Png(wc.ssd1306);
          writeFileSync(args.screenshotFile, png);
          if (!args.quiet) console.error(`[sparkbench] Screenshot saved to ${args.screenshotFile}`);
        } else if (wc.lcd1602) {
          const png = encodeLcd1602Png(wc.lcd1602);
          writeFileSync(args.screenshotFile, png);
          if (!args.quiet) console.error(`[sparkbench] Screenshot saved to ${args.screenshotFile}`);
        } else {
          console.error(`[sparkbench] Error: part '${args.screenshotPart}' has no display controller`);
          exitCode = 1;
          break;
        }
        screenshotTaken = true;
      }

      if (expectMatched) {
        if (!args.quiet) console.error(`\n[sparkbench] Expected text found: "${args.expectText}"`);
        break;
      }
      if (failMatched) {
        if (!args.quiet) console.error(`\n[sparkbench] Fail text found: "${args.failText}"`);
        exitCode = 1;
        break;
      }
    }

    // Write serial log
    if (args.serialLogFile) {
      writeFileSync(args.serialLogFile, serialOutput);
    }

    // Exit code semantics matching wokwi-cli
    if (!expectMatched && args.expectText) {
      if (!args.quiet) console.error(`\n[sparkbench] Timeout: expected text not found`);
      exitCode = 42; // matches wokwi-cli default timeout exit code
    }

    cleanupWiring(wired);
    runner.stop();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
