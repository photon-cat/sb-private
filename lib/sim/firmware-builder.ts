import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import os from "os";
import { findChipFiles, findUnsupportedChips, findVerilogChipFiles } from "../chip-json";
import { buildVerilogChip, verilatorAvailable } from "./verilog-chip-builder";
import type { CustomChipConfig } from "../chip-runtime";
import type { Diagram } from "../diagram-parser";
import { pickSimCore, type SimCore } from "./sim-core";

const HEADER_TO_LIB: Record<string, string> = {
  "LiquidCrystal_I2C.h": "marcoschwartz/LiquidCrystal_I2C",
  "Adafruit_GFX.h": "adafruit/Adafruit GFX Library",
  "Adafruit_SSD1306.h": "adafruit/Adafruit SSD1306",
  "Adafruit_MPU6050.h": "adafruit/Adafruit MPU6050",
  "Adafruit_NeoPixel.h": "adafruit/Adafruit NeoPixel",
  "Adafruit_Sensor.h": "adafruit/Adafruit Unified Sensor",
  "Adafruit_BusIO.h": "adafruit/Adafruit BusIO",
  "Adafruit_BMP085.h": "adafruit/Adafruit BMP085 Library",
  "DHT.h": "adafruit/DHT sensor library",
  "Servo.h": "arduino-libraries/Servo",
  "ArduinoJson.h": "bblanchon/ArduinoJson",
};

const BASE_LIB_DEPS = [
  "arduino-libraries/Servo@^1.2.1",
  "adafruit/DHT sensor library@^1.4.6",
  "adafruit/Adafruit Unified Sensor@^1.1.14",
];

export interface BuildResult {
  /** Intel HEX (AVR). Empty string for non-AVR targets. */
  hex: string;
  /** Raw firmware bytes for the runner — `.bin` (STM32) or `.uf2` (RP2040). */
  bin?: Uint8Array;
  /** In-browser/headless core that runs this firmware, or null (e.g. ESP32). */
  simCore: SimCore | null;
  board: string;
  durationMs: number;
  workDir: string;
}

type PioTarget = { platform: string; framework: string };

/** PlatformIO platform/framework for a board id (mirrors the build API route). */
function pioTargetFor(board: string): PioTarget {
  const core = pickSimCore(board);
  if (core === "rp2040") return { platform: "raspberrypi", framework: "arduino" };
  if (core === "cortex-m0" || core === "unicorn-arm") return { platform: "ststm32", framework: "arduino" };
  if (board.toLowerCase().includes("esp32")) return { platform: "espressif32", framework: "arduino" };
  return { platform: "atmelavr", framework: "arduino" };
}

export interface ChipBuildResult {
  configs: Map<string, CustomChipConfig>;
  chips: { partId: string; name: string; wasmBytes: number }[];
}

export interface BuildOptions {
  board: string;
  workDir?: string;
  quiet?: boolean;
  projectDir?: string;
}

function detectLibs(source: string): string[] {
  const libs = new Set<string>();
  for (const m of source.matchAll(/#include\s*[<"]([^>"]+)[>"]/g)) {
    const lib = HEADER_TO_LIB[m[1]];
    if (lib) libs.add(lib);
  }
  return Array.from(libs);
}

export function findPlatformio(): string {
  const candidates = [
    process.env.PLATFORMIO_CMD,
    path.join(os.homedir(), ".platformio-venv/bin/platformio"),
    path.join(os.homedir(), ".platformio/penv/bin/platformio"),
    "platformio",
    "pio",
  ].filter((c): c is string => !!c);

  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ["--version"], { timeout: 5000, stdio: "pipe" });
      return cmd;
    } catch { /* try next */ }
  }

  throw new Error(
    "PlatformIO not found. Install it or set PLATFORMIO_CMD environment variable.",
  );
}

export function findWokwiCli(): string {
  const candidates = [
    process.env.WOKWI_CLI,
    path.join(os.homedir(), "bin/wokwi-cli"),
    "wokwi-cli",
  ].filter((c): c is string => !!c);

  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ["--version"], { timeout: 5000, stdio: "pipe" });
      return cmd;
    } catch { /* try next */ }
  }

  throw new Error(
    "wokwi-cli not found. Install it or set WOKWI_CLI environment variable.",
  );
}

export function generatePlatformioIni(
  sketch: string,
  librariesTxt: string,
  board: string,
): string {
  const detected = detectLibs(sketch);
  const extraLibs = librariesTxt
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  // Dedup by package name, ignoring any "@version" constraint, so a header-detected
  // "arduino-libraries/Servo" collapses into the base "arduino-libraries/Servo@^1.2.1".
  // The AVR base libs (Servo/DHT/…) are AVR-targeted, so only seed them for AVR;
  // STM32/RP2040 builds take just the user-declared + header-detected libs.
  const target = pioTargetFor(board);
  const baseDeps = target.platform === "atmelavr" ? BASE_LIB_DEPS : [];
  const depKey = (lib: string) => lib.split("@", 1)[0].trim().toLowerCase();
  const seen = new Set(baseDeps.map(depKey));
  const allLibs = [...baseDeps];
  for (const lib of [...detected, ...extraLibs]) {
    const key = depKey(lib);
    if (!seen.has(key)) {
      seen.add(key);
      allLibs.push(lib);
    }
  }

  const pioBoard = board === "atmega328p" ? "uno" : board;
  return `[env:${board}]
platform = ${target.platform}
board = ${pioBoard}
framework = ${target.framework}
lib_deps =
${allLibs.map((l) => `  ${l}`).join("\n")}
`;
}

export function buildFirmware(
  sketch: string,
  librariesTxt: string,
  options: BuildOptions,
  headerFiles?: { name: string; content: string }[],
): BuildResult {
  const { board, quiet } = options;
  const workDir =
    options.workDir ??
    path.join(os.tmpdir(), `sparkbench-build-${Date.now()}`);

  mkdirSync(path.join(workDir, "src"), { recursive: true });
  mkdirSync(path.join(workDir, "include"), { recursive: true });

  writeFileSync(
    path.join(workDir, "platformio.ini"),
    generatePlatformioIni(sketch, librariesTxt, board),
  );
  writeFileSync(path.join(workDir, "src/main.cpp"), sketch);

  if (headerFiles) {
    for (const f of headerFiles) {
      writeFileSync(path.join(workDir, "include", f.name), f.content);
    }
  }

  const pioCmd = findPlatformio();
  const startMs = performance.now();

  if (!quiet) {
    process.stderr.write(`[sparkbench] Compiling for ${board}...\n`);
  }

  try {
    execFileSync(pioCmd, ["run", "-e", board], {
      cwd: workDir,
      // Generous: the first STM32/RP2040 build may resolve+download a framework.
      timeout: 300_000,
      stdio: "pipe",
    });
  } catch (err) {
    const e = err as { stderr?: Buffer; stdout?: Buffer };
    const stderr = e.stderr?.toString() ?? "";
    const stdout = e.stdout?.toString() ?? "";
    throw new Error(`Compilation failed:\n${stderr}\n${stdout}`);
  }

  const simCore = pickSimCore(board);
  const buildDir = path.join(workDir, ".pio", "build", board);
  const readArtifact = (name: string) => new Uint8Array(readFileSync(path.join(buildDir, name)));

  // AVR runs from Intel HEX; STM32 from a raw .bin; RP2040 from a .uf2.
  let hex = "";
  let bin: Uint8Array | undefined;
  if (simCore === "avr8js") {
    hex = readFileSync(path.join(buildDir, "firmware.hex"), "utf-8");
  } else if (simCore === "rp2040") {
    bin = readArtifact("firmware.uf2");
  } else {
    bin = readArtifact("firmware.bin");
  }

  return {
    hex,
    bin,
    simCore,
    board,
    durationMs: Math.round(performance.now() - startMs),
    workDir,
  };
}

export function buildChips(
  projectFiles: { name: string; content: string }[],
  diagram: Diagram,
  workDir: string,
  quiet?: boolean,
): ChipBuildResult {
  const configs = new Map<string, CustomChipConfig>();
  const chipsMeta: { partId: string; name: string; wasmBytes: number }[] = [];

  // Surface chips authored in an unsupported format (HDL) so they don't silently no-op.
  if (!quiet) {
    for (const unsupported of findUnsupportedChips(projectFiles)) {
      process.stderr.write(
        `[sparkbench] WARNING: ${unsupported.sourceFile}: ${unsupported.reason}\n`,
      );
    }
  }

  // --- Verilog / SystemVerilog chips (compiled via Verilator → WASM) ---
  const verilogChips = findVerilogChipFiles(projectFiles);
  if (verilogChips.length > 0) {
    if (verilatorAvailable()) {
      const apiHeader = readFileSync(path.join(__dirname, "wokwi-api.h"), "utf-8");
      for (const vchip of verilogChips) {
        if (!quiet) process.stderr.write(`[sparkbench] Compiling Verilog chip ${vchip.chipName} (Verilator)...\n`);
        const built = buildVerilogChip(
          vchip.source,
          apiHeader,
          path.join(workDir, `vlog-${vchip.chipName}`),
        );
        const matchingPart = diagram.parts.find((p) => p.type === vchip.partType);
        if (matchingPart) {
          configs.set(matchingPart.id, { chipJson: vchip.chipJson, wasmBytes: built.wasmBytes });
          chipsMeta.push({ partId: matchingPart.id, name: vchip.chipName, wasmBytes: built.wasmBytes.byteLength });
        }
      }
    } else if (!quiet) {
      for (const v of verilogChips) {
        process.stderr.write(`[sparkbench] WARNING: ${v.chipName}.chip.sv: Verilator not installed — Verilog chip will not be simulated. Install with 'brew install verilator'.\n`);
      }
    }
  }

  const chips = findChipFiles(projectFiles);
  if (chips.length === 0) {
    return { configs, chips: chipsMeta };
  }

  const wokwiCli = findWokwiCli();

  for (const chip of chips) {
    const srcName = `${chip.chipName}.c`;
    const wasmName = `${chip.chipName}.wasm`;
    writeFileSync(path.join(workDir, srcName), chip.source);

    if (!quiet) {
      process.stderr.write(`[sparkbench] Compiling chip ${chip.chipName}...\n`);
    }

    execFileSync(wokwiCli, ["chip", "compile", srcName, "-o", wasmName], {
      cwd: workDir,
      timeout: 60_000,
      stdio: "pipe",
    });

    const wasmBytes = new Uint8Array(
      readFileSync(path.join(workDir, wasmName)),
    ).slice().buffer;
    const matchingPart = diagram.parts.find((p) => p.type === chip.partType);
    if (matchingPart) {
      configs.set(matchingPart.id, { chipJson: chip.chipJson, wasmBytes });
      chipsMeta.push({
        partId: matchingPart.id,
        name: chip.chipName,
        wasmBytes: wasmBytes.byteLength,
      });
    }
  }

  return { configs, chips: chipsMeta };
}
