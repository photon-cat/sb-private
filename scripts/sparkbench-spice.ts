#!/usr/bin/env npx tsx
/**
 * sparkbench spice — Run SPICE analysis on circuit diagrams.
 *
 * Generates a SPICE netlist from diagram.json, runs ngspice, and outputs
 * results as CSV or JSON waveform data.
 *
 * Usage:
 *   sparkbench spice <project> [--tran 0 10ms 1us] [--json]
 *   sparkbench spice <project> --op --json
 */

import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { parseDiagram } from "../lib/diagram-parser";
import {
  generateSpiceNetlist,
  spiceCircuitToString,
  type SpiceAnalysis,
} from "../lib/spice-netlist";
import {
  runNgspice,
  checkNgspiceAvailable,
  type NgspiceOptions,
} from "../lib/ngspice-runner";

interface SpiceArgs {
  slug?: string;
  diagram?: string;
  analyses: SpiceAnalysis[];
  json: boolean;
  csv: boolean;
  netlistOnly: boolean;
  output?: string;
  timeout: number;
  quiet: boolean;
}

function parseArgs(argv: string[]): SpiceArgs {
  const out: SpiceArgs = {
    analyses: [],
    json: false,
    csv: false,
    netlistOnly: false,
    timeout: 30000,
    quiet: false,
  };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--tran": {
        const params: string[] = [];
        while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
          params.push(argv[++i]);
        }
        out.analyses.push({ type: "tran", params: params.join(" ") });
        break;
      }
      case "--dc": {
        const params: string[] = [];
        while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
          params.push(argv[++i]);
        }
        out.analyses.push({ type: "dc", params: params.join(" ") });
        break;
      }
      case "--ac": {
        const params: string[] = [];
        while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
          params.push(argv[++i]);
        }
        out.analyses.push({ type: "ac", params: params.join(" ") });
        break;
      }
      case "--op":
        out.analyses.push({ type: "op", params: "" });
        break;
      case "--json":
        out.json = true;
        break;
      case "--csv":
        out.csv = true;
        break;
      case "--netlist":
        out.netlistOnly = true;
        break;
      case "--diagram":
        out.diagram = argv[++i];
        break;
      case "-o":
      case "--output":
        out.output = argv[++i];
        break;
      case "--timeout":
        out.timeout = parseInt(argv[++i], 10);
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
  if (!out.slug && !out.diagram) {
    printUsage();
    process.exit(2);
  }
  if (out.analyses.length === 0) {
    out.analyses.push({ type: "op", params: "" });
  }
  return out;
}

function printUsage() {
  console.log(`Usage: sparkbench spice <project> [options]

Analysis types:
  --op                      DC operating point (default)
  --tran <step> <stop>      Transient analysis (e.g. --tran 1u 10m)
  --dc <src> <start> <stop> <step>   DC sweep
  --ac <type> <pts> <fstart> <fstop>  AC analysis

Options:
  --diagram <path>    Explicit diagram.json path
  --netlist           Output SPICE netlist only (don't run simulation)
  --json              Output results as JSON
  --csv               Output results as CSV
  -o, --output <path> Write output to file
  --timeout <ms>      ngspice timeout (default: 30000)
  -q, --quiet         Suppress status messages
  -h, --help          Show this help`);
}

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = args.quiet || args.json ? () => {} : (msg: string) => process.stderr.write(msg + "\n");

  // Load diagram
  let diagramPath: string;
  if (args.slug) {
    diagramPath = path.join(ROOT, "projects", args.slug, "diagram.json");
  } else {
    diagramPath = path.resolve(args.diagram!);
  }

  const diagramJson = JSON.parse(readFileSync(diagramPath, "utf-8"));
  const diagram = parseDiagram(diagramJson);

  // Generate SPICE netlist
  const projectName = args.slug ?? path.basename(path.dirname(diagramPath));
  const circuit = generateSpiceNetlist(diagram, args.analyses, `${projectName} circuit`);
  const netlistStr = spiceCircuitToString(circuit);

  if (args.netlistOnly) {
    if (args.output) {
      writeFileSync(args.output, netlistStr);
      log(`[sparkbench] Netlist written to ${args.output}`);
    } else {
      process.stdout.write(netlistStr + "\n");
    }
    process.exit(0);
  }

  // Check ngspice availability
  const available = await checkNgspiceAvailable();
  if (!available) {
    console.error("ngspice not found. Install ngspice to run SPICE simulation.");
    console.error("  macOS: brew install ngspice");
    console.error("  Ubuntu: sudo apt install ngspice");
    process.exit(1);
  }

  log(`[sparkbench] Running SPICE analysis...`);

  const ngspiceOpts: NgspiceOptions = { timeoutMs: args.timeout };
  const result = await runNgspice(circuit, ngspiceOpts);

  if (!result.success) {
    console.error("ngspice failed:");
    console.error(result.stderr);
    process.exit(1);
  }

  // Format output
  if (args.json) {
    const output = {
      project: projectName,
      success: true,
      analyses: args.analyses.map((a) => `${a.type}${a.params ? " " + a.params : ""}`),
      nodeMap: Object.fromEntries(circuit.nodeMap),
      elements: circuit.elements.length,
      data: result.data ?? null,
      stdout: result.stdout,
    };
    const jsonStr = JSON.stringify(output, null, 2);
    if (args.output) {
      writeFileSync(args.output, jsonStr);
      log(`[sparkbench] Results written to ${args.output}`);
    } else {
      process.stdout.write(jsonStr + "\n");
    }
  } else if (args.csv && result.data) {
    const header = result.data.variables.map((v) => v.name).join(",");
    const rows = result.data.values.map((row) => row.join(","));
    const csvStr = [header, ...rows].join("\n");
    if (args.output) {
      writeFileSync(args.output, csvStr);
      log(`[sparkbench] CSV written to ${args.output}`);
    } else {
      process.stdout.write(csvStr + "\n");
    }
  } else {
    // Text output
    if (result.data) {
      log(`[sparkbench] Variables: ${result.data.variables.map((v) => v.name).join(", ")}`);
      log(`[sparkbench] Data points: ${result.data.values.length}`);
    }
    process.stdout.write(result.stdout);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
