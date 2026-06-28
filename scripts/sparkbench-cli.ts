#!/usr/bin/env npx tsx
/**
 * sparkbench-cli — Command-line tools for SparkBench.
 *
 * Usage:
 *   sparkbench test <project>           Run a test scenario
 *   sparkbench fuzz <project>           AI security fuzzer (SparkyFuzzer)
 *   sparkbench list                     List all projects
 *   sparkbench help                     Show this help
 */

import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import path from "path";
import { execFileSync } from "child_process";

const ROOT = path.resolve(__dirname, "..");
const PROJECTS_DIR = path.join(ROOT, "projects");

// ─── Colors ────────────────────────────────────────────────
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const BANNER = `${BOLD}${CYAN}⚡ SparkBench CLI${RESET} ${DIM}v0.2.0${RESET}
${DIM}Hardware development platform — create, compile, simulate, test, and fuzz projects${RESET}
`;

function printHelp() {
  console.log(BANNER);
  console.log(`${BOLD}USAGE${RESET}`);
  console.log(`  sparkbench <command> [options]\n`);
  console.log(`${BOLD}COMMANDS${RESET}`);
  console.log(`  ${GREEN}create${RESET} <name> [--template <t>]       Scaffold a new project from a template`);
  console.log(`  ${GREEN}compile${RESET} <project> [--json]            Compile firmware without running simulation`);
  console.log(`  ${GREEN}simulate${RESET} <project> [options]          Run headless MCU simulation with timing controls`);
  console.log(`  ${GREEN}test${RESET} <project> [--scenario <file>]   Run YAML test scenarios (with custom chip support)`);
  console.log(`  ${GREEN}spice${RESET} <project> [--tran|--op|--dc]   Run SPICE circuit analysis via ngspice`);
  console.log(`  ${GREEN}serve${RESET} <project> [--port 8765]        Run headless sim with WebSocket API`);
  console.log(`  ${GREEN}mcp${RESET} <project>                        Run stdio MCP server for external AI clients`);
  console.log(`  ${GREEN}run${RESET} <project>                        Alias for simulate`);
  console.log(`  ${GREEN}fuzz${RESET} <project>                       AI-powered security fuzzer (Claude Opus 4.6)`);
  console.log(`  ${GREEN}list${RESET}                                 List all projects with metadata`);
  console.log(`  ${GREEN}help${RESET}                                 Show this help message\n`);
  console.log(`${BOLD}EXAMPLES${RESET}`);
  console.log(`  ${DIM}# Create a new project${RESET}`);
  console.log(`  sparkbench create my-project --template uno-led\n`);
  console.log(`  ${DIM}# Compile firmware only${RESET}`);
  console.log(`  sparkbench compile blink --json\n`);
  console.log(`  ${DIM}# Simulate with timing controls${RESET}`);
  console.log(`  sparkbench simulate blink --timeout-ms 5000 --clock-hz 8000000 --json\n`);
  console.log(`  ${DIM}# Run test scenarios in CI${RESET}`);
  console.log(`  sparkbench test combo-safe --json --report test-results/combo.json\n`);
  console.log(`  ${DIM}# Run SPICE analysis${RESET}`);
  console.log(`  sparkbench spice blink --op --json\n`);
  console.log(`  ${DIM}# Fuzz for security vulnerabilities${RESET}`);
  console.log(`  sparkbench fuzz combo-safe\n`);
  console.log(`${BOLD}ENVIRONMENT${RESET}`);
  console.log(`  ${DIM}ANTHROPIC_API_KEY${RESET}   Required for 'fuzz' command`);
  console.log(`  ${DIM}PLATFORMIO_CMD${RESET}      Override PlatformIO binary path`);
  console.log(`  ${DIM}WOKWI_CLI${RESET}           Override wokwi-cli binary path\n`);
}

function listProjects() {
  console.log(BANNER);
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR).filter(d => {
      const full = path.join(PROJECTS_DIR, d);
      return statSync(full).isDirectory() && existsSync(path.join(full, "sketch.ino"));
    });
  } catch {
    console.log(`${RED}No projects directory found.${RESET}`);
    return;
  }

  if (dirs.length === 0) {
    console.log(`${DIM}No projects found.${RESET}`);
    return;
  }

  console.log(`${BOLD}PROJECTS${RESET} (${dirs.length})\n`);

  for (const slug of dirs.sort()) {
    const projDir = path.join(PROJECTS_DIR, slug);
    const hasTest = existsSync(path.join(projDir, "test.scenario.yaml"));
    const hasPCB = existsSync(path.join(projDir, "board.kicad_pcb"));
    const hasDiagram = existsSync(path.join(projDir, "diagram.json"));

    let partCount = 0;
    if (hasDiagram) {
      try {
        const d = JSON.parse(readFileSync(path.join(projDir, "diagram.json"), "utf-8"));
        partCount = d.parts?.length || 0;
      } catch { /* ignore */ }
    }

    let lineCount = 0;
    try {
      lineCount = readFileSync(path.join(projDir, "sketch.ino"), "utf-8").split("\n").length;
    } catch { /* ignore */ }

    const badges = [
      hasDiagram ? `${GREEN}diagram${RESET}` : null,
      hasPCB ? `${CYAN}pcb${RESET}` : null,
      hasTest ? `${YELLOW}test${RESET}` : null,
    ].filter(Boolean).join(" ");

    console.log(`  ${GREEN}●${RESET} ${BOLD}${slug}${RESET}`);
    console.log(`    ${DIM}${partCount} parts, ${lineCount} lines${RESET}  ${badges}`);
  }
  console.log();
}

// ─── Main dispatch ─────────────────────────────────────────
const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

if (command === "list" || command === "ls") {
  listProjects();
  process.exit(0);
}

if (command === "create") {
  const subArgs = args.slice(1);
  if (subArgs.length === 0) {
    console.error(`${RED}Error: 'create' requires a project name${RESET}`);
    console.error(`Usage: sparkbench create <name> [--template <t>]`);
    process.exit(2);
  }
  try {
    execFileSync("npx", ["tsx", path.join(__dirname, "sparkbench-create.ts"), ...subArgs], {
      stdio: "inherit",
      cwd: ROOT,
    });
  } catch (e: any) {
    process.exit(e.status || 1);
  }
  process.exit(0);
}

if (command === "compile") {
  const subArgs = args.slice(1);
  if (subArgs.length === 0) {
    console.error(`${RED}Error: 'compile' requires a project slug${RESET}`);
    console.error(`Usage: sparkbench compile <project> [--json]`);
    process.exit(2);
  }
  try {
    execFileSync("npx", ["tsx", path.join(__dirname, "sparkbench-compile.ts"), ...subArgs], {
      stdio: "inherit",
      cwd: ROOT,
    });
  } catch (e: any) {
    process.exit(e.status || 1);
  }
  process.exit(0);
}

if (command === "simulate") {
  const subArgs = args.slice(1);
  if (subArgs.length === 0) {
    console.error(`${RED}Error: 'simulate' requires a project slug${RESET}`);
    console.error(`Usage: sparkbench simulate <project> [options]`);
    process.exit(2);
  }
  try {
    execFileSync("npx", ["tsx", path.join(__dirname, "sparkbench-simulate.ts"), ...subArgs], {
      stdio: "inherit",
      cwd: ROOT,
    });
  } catch (e: any) {
    process.exit(e.status || 1);
  }
  process.exit(0);
}

if (command === "test") {
  const subArgs = args.slice(1);
  if (subArgs.length === 0) {
    console.error(`${RED}Error: 'test' requires a project slug or --all${RESET}`);
    console.error(`Usage: sparkbench test <project> [--scenario <file>] [--json]`);
    console.error(`       sparkbench test --all [--json] [--junit <path>]`);
    process.exit(2);
  }
  try {
    execFileSync("npx", ["tsx", path.join(__dirname, "sparkbench-test.ts"), ...subArgs], {
      stdio: "inherit",
      cwd: ROOT,
    });
  } catch (e: any) {
    process.exit(e.status || 1);
  }
  process.exit(0);
}

if (command === "spice") {
  const subArgs = args.slice(1);
  if (subArgs.length === 0) {
    console.error(`${RED}Error: 'spice' requires a project slug or --diagram${RESET}`);
    console.error(`Usage: sparkbench spice <project> [--op|--tran|--dc]`);
    process.exit(2);
  }
  try {
    execFileSync("npx", ["tsx", path.join(__dirname, "sparkbench-spice.ts"), ...subArgs], {
      stdio: "inherit",
      cwd: ROOT,
    });
  } catch (e: any) {
    process.exit(e.status || 1);
  }
  process.exit(0);
}

if (command === "run") {
  // Alias for simulate (backward compatibility)
  const subArgs = args.slice(1);
  if (subArgs.length === 0) {
    console.error(`${RED}Error: 'run' requires a project slug${RESET}`);
    console.error(`Usage: sparkbench run <project> [options] (alias for 'simulate')`);
    process.exit(2);
  }
  try {
    execFileSync("npx", ["tsx", path.join(__dirname, "sparkbench-simulate.ts"), ...subArgs], {
      stdio: "inherit",
      cwd: ROOT,
    });
  } catch (e: any) {
    process.exit(e.status || 1);
  }
  process.exit(0);
}

if (command === "serve") {
  const subArgs = args.slice(1);
  if (subArgs.length === 0) {
    console.error(`${RED}Error: 'serve' requires a project slug${RESET}`);
    console.error(`Usage: sparkbench serve <project> [--port 8765]`);
    process.exit(2);
  }
  try {
    execFileSync("npx", ["tsx", path.join(__dirname, "serve-api.ts"), ...subArgs], {
      stdio: "inherit",
      cwd: ROOT,
    });
  } catch (e: any) {
    process.exit(e.status || 1);
  }
  process.exit(0);
}

if (command === "mcp") {
  const subArgs = args.slice(1);
  if (subArgs.length === 0) {
    console.error(`${RED}Error: 'mcp' requires a project slug or directory${RESET}`);
    console.error(`Usage: sparkbench mcp <project>`);
    process.exit(2);
  }
  // Resolve a bare slug to projects/<slug> so the server finds the project.
  const target = subArgs[0];
  const asSlug = path.join(PROJECTS_DIR, target);
  const projectArg =
    !path.isAbsolute(target) && !target.includes(path.sep) && existsSync(asSlug)
      ? asSlug
      : target;
  try {
    execFileSync("npx", ["tsx", path.join(__dirname, "sparkbench-mcp.ts"), projectArg, ...subArgs.slice(1)], {
      stdio: "inherit",
      cwd: ROOT,
    });
  } catch (e: any) {
    process.exit(e.status || 1);
  }
  process.exit(0);
}

if (command === "fuzz") {
  const subArgs = args.slice(1);
  if (subArgs.length === 0) {
    console.error(`${RED}Error: 'fuzz' requires a project slug${RESET}`);
    console.error(`Usage: sparkbench fuzz <project>`);
    process.exit(2);
  }
  try {
    execFileSync("npx", ["tsx", path.join(__dirname, "sparky-fuzzer.ts"), ...subArgs], {
      stdio: "inherit",
      cwd: ROOT,
    });
  } catch (e: any) {
    process.exit(e.status || 1);
  }
  process.exit(0);
}

console.error(`${RED}Unknown command: ${command}${RESET}`);
console.error(`Run 'sparkbench help' for available commands.`);
process.exit(2);
