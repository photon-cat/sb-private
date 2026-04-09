#!/usr/bin/env npx tsx
/**
 * Oracle test runner: compares SparkBench's avr8js simulator against the
 * official Wokwi CLI simulator on the same project + firmware.
 *
 * Both simulators receive the same compiled firmware.hex and the same
 * diagram.json — any divergence in serial output or timing indicates a
 * bug in SparkBench's avr8js-based runner.
 *
 * Usage:
 *   WOKWI_CLI_TOKEN=xxx npx tsx scripts/oracle-test.ts <slug> [--timeout 5000]
 *
 * Prerequisites:
 *   - Wokwi CLI installed (~/bin/wokwi-cli)
 *   - PlatformIO installed (~/.platformio-venv/bin/platformio)
 *   - WOKWI_CLI_TOKEN environment variable (from wokwi.com/dashboard/ci)
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, copyFileSync } from "fs";
import { execFileSync, spawnSync } from "child_process";
import path from "path";
import os from "os";
import { parseDiagram, findMCUs } from "../lib/diagram-parser";
import { runScenarioAsync, parseScenario } from "../lib/scenario-runner";
import { findChipFiles } from "../lib/chip-json";
import type { CustomChipConfig } from "../lib/chip-runtime";

const ROOT = path.resolve(__dirname, "..");
const PIO_CMD = path.join(os.homedir(), ".platformio-venv/bin/platformio");
const WOKWI_CLI = path.join(os.homedir(), "bin/wokwi-cli");

interface OracleResult {
  sparkbenchSerial: string;
  wokwiSerial: string;
  match: boolean;
  sparkbenchError?: string;
  wokwiError?: string;
}

function usage(): never {
  console.error("Usage: npx tsx scripts/oracle-test.ts <slug> [--timeout <ms>]");
  console.error("Set WOKWI_CLI_TOKEN environment variable to your Wokwi API token.");
  process.exit(2);
}

// Header → PlatformIO library mapping (subset of the dev server's build route)
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

function compile(slug: string, board: string, workDir: string): string {
  const projDir = path.join(ROOT, "projects", slug);
  const sketchPath = path.join(projDir, "sketch.ino");

  let sketch = readFileSync(sketchPath, "utf-8");
  if (!sketch.includes("#include <Arduino.h>") && !sketch.includes('#include "Arduino.h"')) {
    sketch = "#include <Arduino.h>\n" + sketch;
  }

  // Collect extra lib deps from the sketch + libraries.txt
  let librariesTxt = "";
  try {
    librariesTxt = readFileSync(path.join(projDir, "libraries.txt"), "utf-8");
  } catch { /* optional */ }
  const baseLibDeps = [
    "arduino-libraries/Servo@^1.2.1",
    "adafruit/DHT sensor library@^1.4.6",
    "adafruit/Adafruit Unified Sensor@^1.1.14",
  ];
  const extraLibs = librariesTxt
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const detected = detectLibs(sketch);
  const seen = new Set(baseLibDeps.map((l) => l.toLowerCase()));
  const allLibs = [...baseLibDeps];
  for (const l of [...detected, ...extraLibs]) {
    const k = l.toLowerCase();
    if (!seen.has(k)) { seen.add(k); allLibs.push(l); }
  }
  const libDepsStr = allLibs.map((l) => `  ${l}`).join("\n");

  const pioBoard = board === "atmega328p" ? "uno" : board;
  const pioIni = `[env:${board}]
platform = atmelavr
board = ${pioBoard}
framework = arduino
lib_deps =
${libDepsStr}
`;

  mkdirSync(path.join(workDir, "src"), { recursive: true });
  writeFileSync(path.join(workDir, "platformio.ini"), pioIni);
  writeFileSync(path.join(workDir, "src/main.cpp"), sketch);

  console.log(`Compiling ${slug} for ${board}...`);
  try {
    execFileSync(PIO_CMD, ["run", "-e", board], {
      cwd: workDir,
      timeout: 120_000,
      stdio: "pipe",
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

function runWokwiCli(workDir: string, timeoutMs: number): { serial: string; error?: string } {
  if (!process.env.WOKWI_CLI_TOKEN) {
    return { serial: "", error: "WOKWI_CLI_TOKEN not set" };
  }

  if (!existsSync(WOKWI_CLI)) {
    return { serial: "", error: `wokwi-cli not found at ${WOKWI_CLI}` };
  }

  const serialLog = path.join(workDir, "wokwi-serial.log");

  // Copy diagram.json to work dir (wokwi-cli expects it alongside firmware)
  const result = spawnSync(
    WOKWI_CLI,
    [
      "--timeout", String(timeoutMs),
      "--serial-log-file", serialLog,
      "--quiet",
      workDir,
    ],
    {
      env: process.env,
      timeout: timeoutMs + 10_000,
      encoding: "utf-8",
    },
  );

  let serial = "";
  if (existsSync(serialLog)) {
    serial = readFileSync(serialLog, "utf-8");
  }

  // Wokwi exits with 42 on timeout (which is normal for running sims)
  if (result.status !== 0 && result.status !== 42) {
    return { serial, error: `wokwi-cli exited ${result.status}: ${result.stderr || ""}` };
  }

  return { serial };
}

async function runSparkBench(
  hex: string,
  diagram: ReturnType<typeof parseDiagram>,
  durationMs: number,
  chipConfigs: Map<string, CustomChipConfig>,
): Promise<{ serial: string; error?: string }> {
  try {
    // Use scenario-runner with a synthetic scenario: wait for duration, capture output
    const scenario = parseScenario(`
name: oracle-capture
version: 1
steps:
  - delay: ${durationMs}
`);
    const result = await runScenarioAsync(hex, diagram, scenario, chipConfigs);
    return { serial: result.serialOutput || "" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { serial: "", error: message };
  }
}

interface CompiledChip {
  name: string;
  partType: string;
  chipJsonStr: string;
  wasmPath: string;
  wasmBytes: ArrayBuffer;
}

/**
 * Discover and locally compile each custom chip in a project.
 * Produces one .wasm per chip in a shared temp directory that survives
 * for both the SparkBench runtime and the wokwi-cli staging step.
 */
function compileProjectChips(slug: string, workDir: string): CompiledChip[] {
  const projDir = path.join(ROOT, "projects", slug);
  const compiled: CompiledChip[] = [];

  let entries: string[];
  try {
    entries = readdirSync(projDir);
  } catch {
    return compiled;
  }

  const projectFiles = entries
    .filter((n) => !n.startsWith(".") && n !== "diagram.json" && n !== "sketch.ino")
    .map((n) => ({ name: n, content: readFileSync(path.join(projDir, n), "utf-8") }));

  const chips = findChipFiles(projectFiles);
  if (chips.length === 0) return compiled;

  for (const chip of chips) {
    const srcName = `${chip.chipName}.c`;
    const wasmName = `${chip.chipName}.wasm`;
    writeFileSync(path.join(workDir, srcName), chip.source);

    console.log(`  compiling chip ${chip.chipName}...`);
    try {
      execFileSync(WOKWI_CLI, ["chip", "compile", srcName, "-o", wasmName], {
        cwd: workDir,
        timeout: 60_000,
        stdio: "pipe",
      });
    } catch (err) {
      const e = err as { stderr?: Buffer; stdout?: Buffer };
      console.error(`  chip compile failed for ${chip.chipName}:`);
      if (e.stderr) console.error(e.stderr.toString());
      if (e.stdout) console.error(e.stdout.toString());
      throw err;
    }

    const wasmPath = path.join(workDir, wasmName);
    const wasmBuf = readFileSync(wasmPath);
    // Copy to a fresh ArrayBuffer (not a shared view over Node's buffer pool)
    const wasmBytes = new Uint8Array(wasmBuf).slice().buffer;

    compiled.push({
      name: chip.chipName,
      partType: chip.partType,
      chipJsonStr: JSON.stringify(chip.chipJson),
      wasmPath,
      wasmBytes,
    });
  }

  return compiled;
}

function chipsToConfigs(
  compiled: CompiledChip[],
  diagram: ReturnType<typeof parseDiagram>,
): Map<string, CustomChipConfig> {
  const configs = new Map<string, CustomChipConfig>();
  for (const c of compiled) {
    const matchingPart = diagram.parts.find((p) => p.type === c.partType);
    if (!matchingPart) {
      console.warn(`  no diagram part with type "${c.partType}" — chip will be unused`);
      continue;
    }
    configs.set(matchingPart.id, {
      chipJson: JSON.parse(c.chipJsonStr),
      wasmBytes: c.wasmBytes,
    });
  }
  return configs;
}

/**
 * Stage compiled chips for wokwi-cli: write <name>.wasm and <name>.json
 * into the work dir and return the [[chip]] TOML fragments to append.
 */
function stageChipsForWokwi(workDir: string, chips: CompiledChip[]): string {
  let toml = "";
  for (const c of chips) {
    // wokwi-cli loads the chip JSON by swapping the binary extension, so the
    // file must sit alongside the .wasm as `<name>.json`. It separately
    // validates any `<name>.chip.json` files it finds in the work dir, so we
    // avoid writing that name to prevent duplicate validation.
    writeFileSync(path.join(workDir, `${c.name}.json`), c.chipJsonStr);
    toml += `\n[[chip]]\nname = '${c.name}'\nbinary = '${c.name}.wasm'\n`;
  }
  return toml;
}

function compareSerial(a: string, b: string): { match: boolean; details: string } {
  const normalize = (s: string): string[] =>
    s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const trimTrailingPartial = (lines: string[], ref: string[]): string[] => {
    // If one side was cut mid-line by the timeout, its last entry is a
    // proper prefix of the corresponding line on the other side. Drop it.
    if (lines.length === 0) return lines;
    const last = lines[lines.length - 1];
    const other = ref[lines.length - 1];
    if (other && other !== last && other.startsWith(last)) {
      return lines.slice(0, -1);
    }
    return lines;
  };

  let linesA = normalize(a);
  let linesB = normalize(b);
  linesA = trimTrailingPartial(linesA, linesB);
  linesB = trimTrailingPartial(linesB, linesA);

  // The two simulators don't run at identical wall-clock speed, so over a
  // fixed capture window one will emit more loop iterations than the other.
  // We compare up to the common length — if every line in that prefix matches,
  // the behavior is identical.
  const common = Math.min(linesA.length, linesB.length);
  if (common === 0) {
    return {
      match: false,
      details: `No output from ${linesA.length === 0 ? "sparkbench" : "wokwi"}`,
    };
  }

  let diverged = -1;
  for (let i = 0; i < common; i++) {
    if (linesA[i] !== linesB[i]) {
      diverged = i;
      break;
    }
  }

  if (diverged === -1) {
    const extraNote = linesA.length === linesB.length
      ? ""
      : ` (sparkbench produced ${linesA.length}, wokwi ${linesB.length} — trailing cycles ignored)`;
    return {
      match: true,
      details: `First ${common} lines match exactly${extraNote}`,
    };
  }

  const details: string[] = [];
  details.push(`Diverged at line ${diverged + 1}:`);
  details.push(`  sparkbench: ${JSON.stringify(linesA[diverged])}`);
  details.push(`  wokwi:      ${JSON.stringify(linesB[diverged])}`);
  return { match: false, details: details.join("\n") };
}

// --- Main ---
const args = process.argv.slice(2);
if (args.length === 0) usage();

const slug = args[0];
let timeoutMs = 5000;
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--timeout" && args[i + 1]) {
    timeoutMs = parseInt(args[++i], 10);
  }
}

const projDir = path.join(ROOT, "projects", slug);
if (!existsSync(projDir)) {
  console.error(`Project not found: ${projDir}`);
  process.exit(1);
}

// Parse diagram and find MCU
const diagramJson = JSON.parse(readFileSync(path.join(projDir, "diagram.json"), "utf-8"));
const diagram = parseDiagram(diagramJson);
const mcus = findMCUs(diagram);
const target = mcus.find((m) => m.simulatable);
if (!target) {
  console.error(`No simulatable MCU found in ${slug}`);
  process.exit(1);
}
const board = target.boardId;

// Set up work directory
const workDir = path.join(os.tmpdir(), `sparkbench-oracle-${slug}-${Date.now()}`);
mkdirSync(workDir, { recursive: true });

async function main() {
  // 1. Compile firmware
  const hex = compile(slug, board, workDir);

  // 2. Compile any custom chips (wokwi-cli chip compile). This writes .wasm
  //    files into workDir, which we then reference from wokwi.toml.
  console.log("\nCompiling custom chips (if any)...");
  const compiledChips = compileProjectChips(slug, workDir);
  console.log(`  ${compiledChips.length} chip(s) ready`);
  const chipConfigs = chipsToConfigs(compiledChips, diagram);

  // 3. Stage files for wokwi-cli
  writeFileSync(path.join(workDir, "diagram.json"), JSON.stringify(diagramJson, null, 2));
  writeFileSync(path.join(workDir, "firmware.hex"), hex);
  const chipsToml = stageChipsForWokwi(workDir, compiledChips);
  writeFileSync(
    path.join(workDir, "wokwi.toml"),
    `[wokwi]\nversion = 1\nfirmware = "firmware.hex"\nelf = "firmware.hex"\n${chipsToml}`,
  );

  console.log(`\nRunning oracle comparison (${timeoutMs}ms capture window)...`);
  console.log(`Work dir: ${workDir}\n`);

  // 4. Run SparkBench avr8js simulator
  console.log("[SparkBench] Running avr8js simulator...");
  const sb = await runSparkBench(hex, diagram, timeoutMs, chipConfigs);
  if (sb.error) {
    console.error(`  error: ${sb.error}`);
  } else {
    console.log(`  captured ${sb.serial.length} bytes of serial output`);
  }

  // 4. Run Wokwi CLI
  console.log("[Wokwi CLI] Running reference simulator...");
  const wk = runWokwiCli(workDir, timeoutMs);
  if (wk.error) {
    console.error(`  error: ${wk.error}`);
    if (wk.error.includes("WOKWI_CLI_TOKEN")) {
      console.error("\nGet a free token at https://wokwi.com/dashboard/ci");
      console.error("Then: export WOKWI_CLI_TOKEN=your_token_here");
    }
  } else {
    console.log(`  captured ${wk.serial.length} bytes of serial output`);
  }

  // 5. Compare
  console.log("\n" + "─".repeat(60));
  console.log("SparkBench serial output:");
  console.log("─".repeat(60));
  console.log(sb.serial || "(empty)");
  console.log("─".repeat(60));
  console.log("Wokwi CLI serial output:");
  console.log("─".repeat(60));
  console.log(wk.serial || "(empty)");
  console.log("─".repeat(60));

  if (sb.error || wk.error) {
    console.log("\nCannot compare — one or both simulators errored.");
    process.exit(1);
  }

  const cmp = compareSerial(sb.serial, wk.serial);
  if (cmp.match) {
    console.log(`\n\x1b[32m✓ ORACLE MATCH\x1b[0m — ${cmp.details}`);
    return 0;
  } else {
    console.log(`\n\x1b[31m✗ ORACLE MISMATCH\x1b[0m`);
    console.log(cmp.details);
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  })
  .finally(() => {
    if (!process.env.KEEP_WORK_DIR) {
      rmSync(workDir, { recursive: true, force: true });
    } else {
      console.log(`\nKept work dir: ${workDir}`);
    }
  });
