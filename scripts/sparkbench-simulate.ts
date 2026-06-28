#!/usr/bin/env npx tsx
/**
 * sparkbench simulate — Run headless MCU simulation with timing controls.
 *
 * Replaces `sparkbench run` with a superset of features. `run` is kept as an alias.
 *
 * Usage:
 *   sparkbench simulate <project> [options]
 *   sparkbench simulate --diagram diagram.json --sketch sketch.ino --mcu uno
 */

import { writeFileSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { loadProject, type LoadOptions } from "../lib/sim/project-loader";
import { buildFirmware, buildChips } from "../lib/sim/firmware-builder";
import { createSimulationAsync, type SimulationConfig } from "../lib/sim/simulation-runner";
import { buildReport, writeReport, printTextReport, toJUnit } from "../lib/sim/reporter";
import { encodeSsd1306Png, encodeLcd1602Png, encodeFramebufferPng } from "../lib/display-renderer";

interface SimArgs {
  slug?: string;
  diagram?: string;
  sketch?: string;
  mcu?: string;
  clockHz?: number;
  realtime: boolean;
  speed?: number;
  maxCycles?: number;
  timeoutMs: number;
  expectText?: string;
  failText?: string;
  serialLogFile?: string;
  screenshotPart?: string;
  screenshotTimeMs?: number;
  screenshotFile: string;
  json: boolean;
  report?: string;
  junit?: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): SimArgs {
  const out: SimArgs = {
    realtime: false,
    timeoutMs: 30000,
    screenshotFile: "screenshot.png",
    json: false,
    quiet: false,
  };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--timeout":
      case "--timeout-ms":
        out.timeoutMs = parseInt(argv[++i], 10);
        break;
      case "--clock-hz":
        out.clockHz = parseInt(argv[++i], 10);
        break;
      case "--realtime":
        out.realtime = true;
        break;
      case "--speed":
        out.speed = parseFloat(argv[++i]);
        break;
      case "--max-cycles":
        out.maxCycles = parseInt(argv[++i], 10);
        break;
      case "--expect-text":
        out.expectText = argv[++i];
        break;
      case "--fail-text":
        out.failText = argv[++i];
        break;
      case "--serial-log-file":
        out.serialLogFile = argv[++i];
        break;
      case "--screenshot-part":
        out.screenshotPart = argv[++i];
        break;
      case "--screenshot-time":
        out.screenshotTimeMs = parseInt(argv[++i], 10);
        break;
      case "--screenshot-file":
        out.screenshotFile = argv[++i];
        break;
      case "--diagram":
        out.diagram = argv[++i];
        break;
      case "--sketch":
        out.sketch = argv[++i];
        break;
      case "--mcu":
        out.mcu = argv[++i];
        break;
      case "--json":
        out.json = true;
        break;
      case "--report":
        out.report = argv[++i];
        break;
      case "--junit":
        out.junit = argv[++i];
        break;
      case "-q":
      case "--quiet":
        out.quiet = true;
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        rest.push(a);
    }
  }

  if (rest.length > 0) out.slug = rest[0];
  if (!out.slug && (!out.diagram || !out.sketch)) {
    printUsage();
    process.exit(2);
  }
  return out;
}

function printUsage() {
  console.log(`Usage: sparkbench simulate <project> [options]

Options:
  --timeout-ms <n>          Simulated time cutoff (default: 30000)
  --clock-hz <n>            MCU clock speed (default: 16000000)
  --realtime                Throttle to wall-clock time
  --speed <n>               Speed multiplier (e.g. 10 = 10x realtime)
  --max-cycles <n>          Deterministic cycle cutoff
  --expect-text <string>    Exit 0 when text found in serial
  --fail-text <string>      Exit 1 when text found in serial
  --serial-log-file <path>  Write serial output to file
  --screenshot-part <id>    Capture display screenshot
  --screenshot-time <ms>    Simulated time for screenshot
  --screenshot-file <path>  Screenshot output (default: screenshot.png)
  --diagram <path>          Explicit diagram.json path
  --sketch <path>           Explicit sketch.ino path
  --mcu <board>             Board target override
  --json                    Output JSON report to stdout
  --report <path>           Write JSON report to file
  --junit <path>            Write JUnit XML report
  -q, --quiet               Suppress status messages
  -h, --help                Show this help`);
}

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = args.quiet || args.json ? () => {} : (msg: string) => process.stderr.write(msg + "\n");

  // Load project
  let project;
  if (args.slug) {
    project = loadProject(args.slug, path.join(ROOT, "projects"));
  } else {
    const opts: LoadOptions = {};
    if (args.diagram) opts.diagramPath = path.resolve(args.diagram);
    if (args.sketch) opts.sketchPath = path.resolve(args.sketch);
    if (args.diagram) opts.projectDir = path.dirname(path.resolve(args.diagram));
    project = loadProject(opts);
  }

  if (!project.target) {
    console.error("No simulatable MCU found in diagram");
    process.exit(1);
  }

  const board = args.mcu ?? project.target.boardId;
  const clockHz = args.clockHz ?? 16e6;

  // Build firmware
  const workDir = path.join(os.tmpdir(), `sparkbench-sim-${Date.now()}`);
  const headerFiles = project.files.filter((f) => f.name.endsWith(".h"));

  let buildResult;
  try {
    buildResult = buildFirmware(project.sketch, project.librariesTxt, {
      board,
      workDir,
      quiet: args.quiet || args.json,
    }, headerFiles);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (args.json) {
      const report = buildReport({
        project: project.slug,
        passed: false,
        mcu: { id: project.target.id, board, clockHz },
      });
      report.build = { success: false, durationMs: 0 };
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      console.error(msg);
    }
    process.exit(1);
  }

  log(`[sparkbench] Build: ${buildResult.durationMs}ms`);

  // Build custom chips
  let chipMeta: { partId: string; name: string; wasmBytes: number }[] = [];
  const chipBuild = buildChips(project.files, project.diagram, workDir, args.quiet || args.json);
  chipMeta = chipBuild.chips;

  // Create simulation
  const simConfig: SimulationConfig = {
    // Undefined → each core applies its own default (AVR 16 MHz, F1 72 MHz, RP2040 125 MHz).
    clockHz: args.clockHz,
    realtimeThrottle: args.realtime,
    speedMultiplier: args.speed,
    maxCycles: args.maxCycles,
    timeoutMs: args.timeoutMs,
  };

  if (!buildResult.simCore) {
    const msg = `Board "${board}" has no headless simulation core (compile-only).`;
    if (args.json) {
      const report = buildReport({ project: project.slug, passed: false, mcu: { id: project.target.id, board, clockHz } });
      report.build = { success: true, durationMs: buildResult.durationMs };
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      console.error(msg);
    }
    process.exit(1);
  }

  // Build the simulation for whichever core the board compiles to (AVR/STM32/RP2040).
  // Custom chips (AVR) wire in via chipConfigs.
  const handle = await createSimulationAsync(
    { simCore: buildResult.simCore, hex: buildResult.hex, bin: buildResult.bin },
    project.diagram,
    project.target,
    simConfig,
    chipBuild.configs,
  );

  // Attach serial logging
  if (!args.quiet && !args.json) {
    handle.addSerialListener((byte: number) => {
      process.stdout.write(String.fromCharCode(byte));
    });
  }

  // Use the core's actual clock for cycle/time math (AVR 16, F1 72, RP2040 125 MHz…).
  const effClockHz = handle.clockHz;
  log(`[sparkbench] Simulating (timeout: ${args.timeoutMs}ms, clock: ${(effClockHz / 1e6).toFixed(1)}MHz, core: ${buildResult.simCore})...`);

  // Run simulation in slices
  const sliceMs = 10;
  const cyclesPerMs = effClockHz / 1000;
  const totalTargetCycles = args.maxCycles ?? args.timeoutMs * cyclesPerMs;
  let totalCycles = 0;
  let screenshotTaken = false;
  let expectMatched = false;
  let failMatched = false;
  let exitCode = 0;

  const checkSerial = () => {
    const serial = handle.getSerial();
    if (args.expectText && !expectMatched && serial.includes(args.expectText)) {
      expectMatched = true;
    }
    if (args.failText && serial.includes(args.failText)) {
      failMatched = true;
    }
  };

  const startWall = performance.now();

  while (totalCycles < totalTargetCycles) {
    const cyclesToRun = Math.min(sliceMs * cyclesPerMs, totalTargetCycles - totalCycles);
    handle.runCycles(cyclesToRun);
    totalCycles += cyclesToRun;
    checkSerial();

    // Screenshot capture
    if (
      !screenshotTaken &&
      args.screenshotPart &&
      args.screenshotTimeMs !== undefined &&
      totalCycles >= args.screenshotTimeMs * cyclesPerMs
    ) {
      const wc = handle.wired.get(args.screenshotPart);
      const fb = wc?.chipRuntime?.getFramebuffer() ?? wc?.ili9341?.getFramebuffer();
      if (wc?.ssd1306) {
        writeFileSync(args.screenshotFile, encodeSsd1306Png(wc.ssd1306));
        log(`[sparkbench] Screenshot saved to ${args.screenshotFile}`);
      } else if (wc?.lcd1602) {
        writeFileSync(args.screenshotFile, encodeLcd1602Png(wc.lcd1602));
        log(`[sparkbench] Screenshot saved to ${args.screenshotFile}`);
      } else if (fb && fb.width > 0 && fb.height > 0) {
        writeFileSync(args.screenshotFile, encodeFramebufferPng(fb));
        log(`[sparkbench] Screenshot saved to ${args.screenshotFile}`);
      }
      screenshotTaken = true;
    }

    // Realtime throttle
    if (args.realtime || args.speed) {
      const simElapsedMs = totalCycles / cyclesPerMs;
      const wallElapsedMs = performance.now() - startWall;
      const multiplier = args.speed ?? 1;
      const targetWallMs = simElapsedMs / multiplier;
      const aheadMs = targetWallMs - wallElapsedMs;
      if (aheadMs > 2) {
        await new Promise((r) => setTimeout(r, aheadMs));
      }
    }

    if (expectMatched) {
      log(`\n[sparkbench] Expected text found: "${args.expectText}"`);
      break;
    }
    if (failMatched) {
      log(`\n[sparkbench] Fail text found: "${args.failText}"`);
      exitCode = 1;
      break;
    }
  }

  if (!expectMatched && args.expectText) {
    log(`\n[sparkbench] Timeout: expected text not found`);
    exitCode = 42;
  }

  // Serial log
  if (args.serialLogFile) {
    writeFileSync(args.serialLogFile, handle.getSerial());
  }

  // Build report
  const state = handle.getState();
  const passed = exitCode === 0;
  const report = buildReport({
    project: project.slug,
    passed,
    mcu: { id: project.target.id, board, clockHz: effClockHz },
    buildDurationMs: buildResult.durationMs,
    chips: chipMeta,
    simulation: state,
  });

  // Output
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else if (!args.quiet) {
    printTextReport(report);
  }

  if (args.report) {
    writeReport(report, args.report);
  }

  if (args.junit) {
    writeFileSync(args.junit, toJUnit(report));
  }

  // Cleanup
  handle.dispose();
  rmSync(workDir, { recursive: true, force: true });
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
