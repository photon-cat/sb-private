#!/usr/bin/env npx tsx
/**
 * sparkbench test — Run YAML scenario tests with custom chip support.
 *
 * Async execution (custom chips), shared runtime, CI-grade JSON/JUnit output.
 *
 * Usage:
 *   sparkbench test <project> [--scenario <file>] [--json] [--report <path>]
 *   sparkbench test --all [--json] [--junit <path>]
 */

import { readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from "fs";
import path from "path";
import os from "os";
import { loadProject } from "../lib/sim/project-loader";
import { buildFirmware, buildChips } from "../lib/sim/firmware-builder";
import {
  buildReport,
  writeReport,
  printTextReport,
  toJUnit,
  toJUnitSuites,
  type CIReport,
} from "../lib/sim/reporter";
import { parseScenario, runScenarioAsync, type ScenarioFirmware } from "../lib/scenario-runner";

interface TestArgs {
  slug: string;
  all: boolean;
  scenario?: string;
  clockHz?: number;
  json: boolean;
  report?: string;
  junit?: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): TestArgs {
  const out: TestArgs = { slug: "", all: false, json: false, quiet: false };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--all":
        out.all = true;
        break;
      case "--scenario":
        out.scenario = argv[++i];
        break;
      case "--clock-hz":
        out.clockHz = parseInt(argv[++i], 10);
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

  if (!out.all && rest.length === 0) {
    printUsage();
    process.exit(2);
  }
  out.slug = rest[0] ?? "";
  return out;
}

function printUsage() {
  console.log(`Usage: sparkbench test <project> [options]
       sparkbench test --all [options]

Options:
  --all               Run every project that has a test.scenario.yaml
  --scenario <file>   Path to YAML scenario (default: test.scenario.yaml)
  --clock-hz <n>      MCU clock speed (default: per-core — AVR 16M, F1 72M, RP2040 125M)
  --json              Output JSON report to stdout
  --report <path>     Write JSON report to file
  --junit <path>      Write JUnit XML report
  -q, --quiet         Suppress status messages
  -h, --help          Show this help`);
}

const ROOT = path.resolve(__dirname, "..");
const PROJECTS_DIR = path.join(ROOT, "projects");

interface RunResult {
  report: CIReport;
  /** Non-scenario failure (build error, no MCU, parse error) — distinct from a failed assertion. */
  hardError?: string;
}

/**
 * Build + run one project's scenario. Never throws — failures are captured in the report.
 */
async function runProject(
  slug: string,
  opts: { scenarioPath?: string; clockHz?: number; quiet: boolean },
): Promise<RunResult> {
  let project: ReturnType<typeof loadProject>;
  try {
    project = loadProject(slug, PROJECTS_DIR);
  } catch (err) {
    return {
      report: buildReport({ project: slug, passed: false }),
      hardError: err instanceof Error ? err.message : String(err),
    };
  }

  if (!project.target) {
    return {
      report: buildReport({ project: slug, passed: false }),
      hardError: "No simulatable MCU found in diagram",
    };
  }

  const board = project.target.boardId;
  // Undefined → each core uses its own default clock; the report shows the
  // effective clock (result.clockHz). 0 is only a placeholder for failure reports.
  const clockHz = opts.clockHz;
  const mcu = { id: project.target.id, board, clockHz: clockHz ?? 0 };

  const scenarioPath = opts.scenarioPath ?? path.join(project.root, "test.scenario.yaml");
  if (!existsSync(scenarioPath)) {
    return {
      report: buildReport({ project: project.slug, passed: false, mcu }),
      hardError: `Scenario not found: ${scenarioPath}`,
    };
  }

  let scenario;
  try {
    scenario = parseScenario(readFileSync(scenarioPath, "utf-8"));
  } catch (err) {
    return {
      report: buildReport({ project: project.slug, passed: false, mcu }),
      hardError: `Invalid scenario YAML: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const workDir = path.join(os.tmpdir(), `sparkbench-test-${slug}-${Date.now()}`);
  const headerFiles = project.files.filter((f) => f.name.endsWith(".h"));

  try {
    let buildDurationMs = 0;
    let firmware: ScenarioFirmware;
    try {
      const result = buildFirmware(
        project.sketch,
        project.librariesTxt,
        { board, workDir, quiet: opts.quiet },
        headerFiles,
      );
      buildDurationMs = result.durationMs;
      if (!result.simCore) {
        const report = buildReport({ project: project.slug, passed: false, mcu });
        report.build = { success: true, durationMs: buildDurationMs };
        return { report, hardError: `Board "${board}" has no headless simulation core (compile-only).` };
      }
      firmware = { simCore: result.simCore, hex: result.hex, bin: result.bin };
    } catch (err) {
      const report = buildReport({ project: project.slug, passed: false, mcu });
      report.build = { success: false, durationMs: 0 };
      return {
        report,
        hardError: `Build failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const chipBuild = buildChips(project.files, project.diagram, workDir, opts.quiet);

    const result = await runScenarioAsync(
      firmware,
      project.diagram,
      scenario,
      chipBuild.configs.size > 0 ? chipBuild.configs : undefined,
      { clockHz },
    );

    const report = buildReport({
      project: project.slug,
      passed: result.passed,
      // Report the effective clock the scenario actually ran at (core default unless overridden).
      mcu: { ...mcu, clockHz: result.clockHz },
      buildDurationMs,
      chips: chipBuild.chips,
      scenarioResult: result,
    });
    return { report };
  } catch (err) {
    return {
      report: buildReport({ project: project.slug, passed: false, mcu }),
      hardError: err instanceof Error ? err.message : String(err),
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function discoverScenarioProjects(): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(PROJECTS_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((name) => {
      const dir = path.join(PROJECTS_DIR, name);
      try {
        return (
          statSync(dir).isDirectory() &&
          existsSync(path.join(dir, "test.scenario.yaml"))
        );
      } catch {
        return false;
      }
    })
    .sort();
}

async function runAll(args: TestArgs): Promise<never> {
  const slugs = discoverScenarioProjects();
  const log = args.json ? () => {} : (m: string) => process.stderr.write(m + "\n");

  if (slugs.length === 0) {
    log("No projects with test.scenario.yaml found.");
    process.exit(0);
  }

  log(`Running ${slugs.length} scenario test(s)...\n`);

  const results: RunResult[] = [];
  for (const slug of slugs) {
    const result = await runProject(slug, { clockHz: args.clockHz, quiet: true });
    results.push(result);
    const passed = result.report.passed;
    const icon = passed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    const detail = result.hardError
      ? `\x1b[31m${result.hardError.split("\n")[0]}\x1b[0m`
      : `${result.report.steps.filter((s) => s.passed).length}/${result.report.steps.length} steps`;
    log(`  ${icon} ${slug.padEnd(28)} ${detail}`);
  }

  const reports = results.map((r) => r.report);
  const passedCount = reports.filter((r) => r.passed).length;
  const failedCount = reports.length - passedCount;

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        { total: reports.length, passed: passedCount, failed: failedCount, projects: reports },
        null,
        2,
      ) + "\n",
    );
  } else {
    log("\n" + "─".repeat(50));
    log(
      failedCount === 0
        ? `\x1b[1m\x1b[32mAll ${passedCount} passed\x1b[0m`
        : `\x1b[1m\x1b[31m${failedCount} failed\x1b[0m, ${passedCount} passed`,
    );
  }

  if (args.junit) {
    writeFileSync(args.junit, toJUnitSuites(reports));
  }

  process.exit(failedCount === 0 ? 0 : 1);
}

async function runSingle(args: TestArgs): Promise<never> {
  const result = await runProject(args.slug, {
    scenarioPath: args.scenario ? path.resolve(args.scenario) : undefined,
    clockHz: args.clockHz,
    quiet: args.quiet || args.json,
  });

  if (result.hardError && !args.json) {
    console.error(result.hardError);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(result.report, null, 2) + "\n");
  } else if (!args.quiet) {
    printTextReport(result.report);
  }

  if (args.report) writeReport(result.report, args.report);
  if (args.junit) writeFileSync(args.junit, toJUnit(result.report));

  process.exit(result.report.passed ? 0 : 1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.all) {
    await runAll(args);
  } else {
    await runSingle(args);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
