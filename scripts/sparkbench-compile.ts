#!/usr/bin/env npx tsx
/**
 * sparkbench compile — Compile firmware without running simulation.
 *
 * Usage:
 *   sparkbench compile <project>
 *   sparkbench compile <project> --json
 *   sparkbench compile --sketch path/to/sketch.ino --mcu uno
 */

import { writeFileSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { loadProject } from "../lib/sim/project-loader";
import { buildFirmware, buildChips } from "../lib/sim/firmware-builder";

interface CompileArgs {
  slug?: string;
  sketch?: string;
  mcu?: string;
  json: boolean;
  outputHex?: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): CompileArgs {
  const out: CompileArgs = { json: false, quiet: false };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        out.json = true;
        break;
      case "--sketch":
        out.sketch = argv[++i];
        break;
      case "--mcu":
        out.mcu = argv[++i];
        break;
      case "--output":
      case "-o":
        out.outputHex = argv[++i];
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
  if (!out.slug && !out.sketch) {
    printUsage();
    process.exit(2);
  }
  return out;
}

function printUsage() {
  console.log(`Usage: sparkbench compile <project> [options]

Options:
  --json              Output build result as JSON
  --sketch <path>     Compile a standalone sketch file
  --mcu <board>       Board target (default: auto-detect from diagram)
  -o, --output <path> Write firmware hex to file
  -q, --quiet         Suppress status messages
  -h, --help          Show this help`);
}

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let sketch: string;
  let librariesTxt: string;
  let board: string;
  let projectName: string;
  let headerFiles: { name: string; content: string }[] = [];

  if (args.slug) {
    const project = loadProject(args.slug, path.join(ROOT, "projects"));
    sketch = project.sketch;
    librariesTxt = project.librariesTxt;
    board = args.mcu ?? project.target?.boardId ?? "uno";
    projectName = project.slug;
    headerFiles = project.files.filter((f) => f.name.endsWith(".h"));
  } else {
    const { readFileSync } = await import("fs");
    sketch = readFileSync(args.sketch!, "utf-8");
    if (!sketch.includes("#include <Arduino.h>") && !sketch.includes('#include "Arduino.h"')) {
      sketch = "#include <Arduino.h>\n" + sketch;
    }
    librariesTxt = "";
    board = args.mcu ?? "uno";
    projectName = path.basename(args.sketch!, ".ino");
  }

  const workDir = path.join(os.tmpdir(), `sparkbench-compile-${Date.now()}`);

  try {
    const result = buildFirmware(sketch, librariesTxt, {
      board,
      workDir,
      quiet: args.quiet || args.json,
    }, headerFiles);

    if (args.outputHex) {
      writeFileSync(args.outputHex, result.hex);
      if (!args.quiet && !args.json) {
        process.stderr.write(`[sparkbench] Firmware written to ${args.outputHex}\n`);
      }
    }

    if (args.json) {
      const report = {
        project: projectName,
        board: result.board,
        success: true,
        durationMs: result.durationMs,
        hexSize: result.hex.length,
      };
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else if (!args.quiet) {
      process.stderr.write(
        `[sparkbench] Build successful (${result.durationMs}ms)\n`,
      );
    }
  } catch (err) {
    if (args.json) {
      const report = {
        project: projectName,
        board,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      process.exit(1);
    }
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
