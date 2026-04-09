#!/usr/bin/env npx tsx
/**
 * Standalone test runner for custom chip support.
 *
 * Builds firmware + compiles chip via the local dev API, then runs the
 * scenario runner with chip wired in. Confirms that:
 *   1. .chip.c + .chip.json discovery works
 *   2. wokwi-cli compile-chip API call returns valid WASM
 *   3. CustomChipRuntime instantiates and bridges to avr8js
 *   4. Pin watches fire and pin writes propagate to MCU pins
 *
 * Usage: npx tsx scripts/test-chip.ts <project-slug>
 */

import { readFileSync, readdirSync } from "fs";
import path from "path";
import { parseDiagram, findMCUs } from "../lib/diagram-parser";
import { findChipFiles, type ChipJsonDef } from "../lib/chip-json";
import { runScenarioAsync, parseScenario } from "../lib/scenario-runner";
import type { CustomChipConfig } from "../lib/chip-runtime";

const ROOT = path.resolve(__dirname, "..");
const API_BASE = process.env.SPARKBENCH_URL || "http://localhost:3000";

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: npx tsx scripts/test-chip.ts <project-slug>");
    process.exit(2);
  }

  const projDir = path.join(ROOT, "projects", slug);
  console.log(`Testing project: ${slug}`);

  // 1. Read all project files
  const entries = readdirSync(projDir);
  const projectFiles = entries
    .filter((n) => !n.startsWith(".") && n !== "diagram.json" && n !== "sketch.ino")
    .map((n) => ({ name: n, content: readFileSync(path.join(projDir, n), "utf-8") }));

  const sketch = readFileSync(path.join(projDir, "sketch.ino"), "utf-8");
  const diagram = parseDiagram(JSON.parse(readFileSync(path.join(projDir, "diagram.json"), "utf-8")));

  // 2. Find MCU and board
  const mcus = findMCUs(diagram);
  const target = mcus.find((m) => m.simulatable);
  if (!target) throw new Error("No simulatable MCU in diagram");

  console.log(`MCU: ${target.id} (${target.boardId})`);

  // 3. Build firmware via the API
  console.log("\nBuilding firmware...");
  const buildRes = await fetch(`${API_BASE}/api/projects/${slug}/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sketch,
      files: projectFiles.filter((f) => /\.(h|c|cpp)$/.test(f.name) && !f.name.endsWith(".chip.c")),
      board: target.boardId,
    }),
  }).then((r) => r.json());

  if (!buildRes.success) {
    console.error("Build failed:", buildRes.error);
    if (buildRes.stderr) console.error(buildRes.stderr);
    process.exit(1);
  }
  console.log(`  ✓ Built ${buildRes.hex.length} bytes of HEX`);

  // 4. Discover and compile custom chips
  const chipFiles = findChipFiles(projectFiles);
  console.log(`\nFound ${chipFiles.length} custom chip(s):`);
  const chipConfigs = new Map<string, CustomChipConfig>();

  for (const chip of chipFiles) {
    console.log(`  - ${chip.chipName} (partType: ${chip.partType})`);
    const compRes = await fetch(`${API_BASE}/api/projects/${slug}/compile-chip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chipName: chip.chipName, source: chip.source }),
    }).then((r) => r.json());

    if (!compRes.success) {
      console.error(`    Chip compile failed: ${compRes.error}`);
      process.exit(1);
    }
    console.log(`    ✓ Compiled to ${compRes.size} bytes WASM`);

    const wasmBytes = Buffer.from(compRes.wasm, "base64").buffer;
    const matchingPart = diagram.parts.find((p) => p.type === chip.partType);
    if (!matchingPart) {
      console.warn(`    no diagram part with type "${chip.partType}" — chip will be unused`);
      continue;
    }
    chipConfigs.set(matchingPart.id, { chipJson: chip.chipJson as ChipJsonDef, wasmBytes });
  }

  // 5. Run scenario (use embedded if no scenario file)
  const scenarioPath = path.join(projDir, "test.scenario.yaml");
  let scenarioYaml: string;
  try {
    scenarioYaml = readFileSync(scenarioPath, "utf-8");
  } catch {
    // Default: just capture serial for 1 second
    scenarioYaml = `name: capture\nversion: 1\nsteps:\n  - delay: 1500\n`;
  }
  const scenario = parseScenario(scenarioYaml);

  console.log(`\nRunning scenario "${scenario.name}"...`);
  const result = await runScenarioAsync(buildRes.hex, diagram, scenario, chipConfigs);

  for (const step of result.steps) {
    const icon = step.passed ? "  ✓" : "  ✗";
    console.log(`${icon} step ${step.step + 1}: ${step.description}`);
    if (step.error) console.log(`    ${step.error}`);
  }

  console.log("\n--- Serial output ---");
  console.log(result.serialOutput || "(empty)");
  console.log("--- End serial ---\n");

  if (result.passed) {
    console.log("\x1b[32mPASS\x1b[0m");
    process.exit(0);
  } else {
    console.log("\x1b[31mFAIL\x1b[0m");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
