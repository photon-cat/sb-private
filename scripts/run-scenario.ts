#!/usr/bin/env npx tsx
/**
 * CLI entry point for running automation scenarios.
 *
 * Usage:
 *   npx tsx scripts/run-scenario.ts <project-slug> [--scenario <file.yaml>]
 *
 * If --scenario is omitted, looks for projects/<slug>/test.scenario.yaml.
 *
 * The sketch is compiled via PlatformIO (must be installed).
 * No dev server required.
 */

import { readFileSync, readdirSync } from "fs";
import path from "path";
import { parseDiagram, findMCUs } from "../lib/diagram-parser";
import { parseScenario, runScenarioAsync, type ScenarioFirmware } from "../lib/scenario-runner";
import { buildFirmware } from "../lib/sim/firmware-builder";

const ROOT = path.resolve(__dirname, "..");
const BUILD_DIR = path.join(ROOT, "_build");

function usage(): never {
  console.error("Usage: npx tsx scripts/run-scenario.ts <project-slug> [--scenario <file.yaml>]");
  process.exit(2);
}

// Compile a project's sketch via the shared multi-platform builder, returning
// firmware for whichever core the board targets (AVR hex / STM32 .bin / RP2040 uf2).
function compileSketch(slug: string, board: string): ScenarioFirmware {
  const projDir = path.join(ROOT, "projects", slug);
  let sketch: string;
  try {
    sketch = readFileSync(path.join(projDir, "sketch.ino"), "utf-8");
  } catch {
    throw new Error(`Cannot read sketch: ${path.join(projDir, "sketch.ino")}`);
  }

  // Auto-add Arduino.h
  if (!sketch.includes("#include <Arduino.h>") && !sketch.includes('#include "Arduino.h"')) {
    sketch = "#include <Arduino.h>\n" + sketch;
  }

  let librariesTxt = "";
  try {
    librariesTxt = readFileSync(path.join(projDir, "libraries.txt"), "utf-8");
  } catch { /* no libraries.txt is fine */ }

  const headerFiles: { name: string; content: string }[] = [];
  try {
    for (const f of readdirSync(projDir)) {
      if (f.endsWith(".h")) headerFiles.push({ name: f, content: readFileSync(path.join(projDir, f), "utf-8") });
    }
  } catch { /* ignore */ }

  console.log(`Compiling sketch for ${board}...`);
  const result = buildFirmware(sketch, librariesTxt, { board, workDir: BUILD_DIR }, headerFiles);
  if (!result.simCore) {
    throw new Error(`Board "${board}" has no headless simulation core (compile-only).`);
  }
  return { simCore: result.simCore, hex: result.hex, bin: result.bin };
}

// --- Main ---
const args = process.argv.slice(2);
if (args.length === 0) usage();

const slug = args[0];
let scenarioPath: string | null = null;

for (let i = 1; i < args.length; i++) {
  if (args[i] === "--scenario" && args[i + 1]) {
    scenarioPath = args[++i];
  }
}

if (!scenarioPath) {
  scenarioPath = path.join(ROOT, "projects", slug, "test.scenario.yaml");
}

// Load diagram
const diagramPath = path.join(ROOT, "projects", slug, "diagram.json");
let diagramJson: unknown;
try {
  diagramJson = JSON.parse(readFileSync(diagramPath, "utf-8"));
} catch {
  console.error(`Cannot read diagram: ${diagramPath}`);
  process.exit(1);
}
const diagram = parseDiagram(diagramJson);

// Determine board
const mcus = findMCUs(diagram);
const target = mcus.find((m) => m.simulatable);
const board = target?.boardId ?? "uno";

// Compile
const firmware = compileSketch(slug, board);
console.log("Compilation successful.\n");

// Load scenario
let scenarioYaml: string;
try {
  scenarioYaml = readFileSync(scenarioPath, "utf-8");
} catch {
  console.error(`Cannot read scenario: ${scenarioPath}`);
  process.exit(1);
}
const scenario = parseScenario(scenarioYaml);

console.log(`Running scenario: ${scenario.name}`);
console.log("─".repeat(50));

(async () => {
  const result = await runScenarioAsync(firmware, diagram, scenario);

  // Print results
  for (const step of result.steps) {
    const icon = step.passed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  ${icon} Step ${step.step + 1}: ${step.description}`);
    if (step.error) {
      console.log(`    \x1b[31m${step.error}\x1b[0m`);
    }
  }

  console.log("─".repeat(50));
  if (result.passed) {
    console.log("\x1b[32mAll steps passed!\x1b[0m");
    process.exit(0);
  } else {
    console.log("\x1b[31mScenario failed.\x1b[0m");
    process.exit(1);
  }
})();
