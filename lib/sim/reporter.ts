import { writeFileSync } from "fs";
import type { SimulationState } from "./simulation-runner";
import type { ScenarioResult, StepResult } from "../scenario-runner";

export interface CIReport {
  project: string;
  passed: boolean;
  mcu: { id: string; board: string; clockHz: number } | null;
  build: { success: boolean; durationMs: number } | null;
  chips: { partId: string; name: string; compiled: boolean; wasmBytes: number }[];
  simulation: {
    cycles: number;
    simulatedMs: number;
    wallMs: number;
    serial: string;
  } | null;
  steps: { index: number; passed: boolean; description: string; error?: string }[];
}

export function buildReport(opts: {
  project: string;
  passed: boolean;
  mcu?: { id: string; board: string; clockHz: number };
  buildDurationMs?: number;
  chips?: { partId: string; name: string; wasmBytes: number }[];
  simulation?: SimulationState;
  scenarioResult?: ScenarioResult;
}): CIReport {
  return {
    project: opts.project,
    passed: opts.passed,
    mcu: opts.mcu ?? null,
    build: opts.buildDurationMs !== undefined
      ? { success: true, durationMs: opts.buildDurationMs }
      : null,
    chips: (opts.chips ?? []).map((c) => ({ ...c, compiled: true })),
    simulation: opts.simulation
      ? {
          cycles: opts.simulation.cycles,
          simulatedMs: opts.simulation.simulatedMs,
          wallMs: opts.simulation.wallMs,
          serial: opts.simulation.serial,
        }
      : null,
    steps: opts.scenarioResult
      ? opts.scenarioResult.steps.map((s) => ({
          index: s.step,
          passed: s.passed,
          description: s.description,
          error: s.error,
        }))
      : [],
  };
}

export function writeReport(report: CIReport, filePath: string): void {
  writeFileSync(filePath, JSON.stringify(report, null, 2), "utf-8");
}

export function printTextReport(report: CIReport): void {
  const GREEN = "\x1b[32m";
  const RED = "\x1b[31m";
  const DIM = "\x1b[2m";
  const BOLD = "\x1b[1m";
  const RESET = "\x1b[0m";

  if (report.mcu) {
    process.stderr.write(
      `${DIM}MCU: ${report.mcu.id} (${report.mcu.board}) @ ${(report.mcu.clockHz / 1e6).toFixed(1)} MHz${RESET}\n`,
    );
  }

  if (report.build) {
    process.stderr.write(
      `${DIM}Build: ${report.build.durationMs}ms${RESET}\n`,
    );
  }

  if (report.chips.length > 0) {
    for (const chip of report.chips) {
      process.stderr.write(
        `${DIM}Chip: ${chip.name} (${chip.partId}) ${chip.wasmBytes} bytes${RESET}\n`,
      );
    }
  }

  if (report.simulation) {
    const sim = report.simulation;
    const speed = sim.wallMs > 0 ? (sim.simulatedMs / sim.wallMs).toFixed(1) : "?";
    process.stderr.write(
      `${DIM}Simulation: ${sim.cycles} cycles, ${sim.simulatedMs.toFixed(1)}ms simulated, ${sim.wallMs}ms wall (${speed}x)${RESET}\n`,
    );
  }

  if (report.steps.length > 0) {
    process.stderr.write("─".repeat(50) + "\n");
    for (const step of report.steps) {
      const icon = step.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      process.stderr.write(`  ${icon} Step ${step.index + 1}: ${step.description}\n`);
      if (step.error) {
        process.stderr.write(`    ${RED}${step.error}${RESET}\n`);
      }
    }
    process.stderr.write("─".repeat(50) + "\n");
  }

  if (report.passed) {
    process.stderr.write(`${BOLD}${GREEN}PASSED${RESET}\n`);
  } else {
    process.stderr.write(`${BOLD}${RED}FAILED${RESET}\n`);
  }
}

/** Emit a single <testsuite> block (no XML prolog). Used by both toJUnit and toJUnitSuites. */
function junitSuite(report: CIReport, indent = ""): string[] {
  const lines: string[] = [];
  const failures = report.steps.filter((s) => !s.passed).length;
  // A build failure with no steps still counts as one failing test.
  const buildFailed = report.build ? !report.build.success : false;
  const testCount = report.steps.length || (buildFailed ? 1 : 0);
  const failureCount = failures || (buildFailed ? 1 : 0);

  lines.push(
    `${indent}<testsuite name="${escapeXml(report.project)}" tests="${testCount}" failures="${failureCount}">`,
  );

  if (report.steps.length === 0 && buildFailed) {
    lines.push(`${indent}  <testcase name="build" classname="${escapeXml(report.project)}">`);
    lines.push(`${indent}    <failure message="build failed">build failed</failure>`);
    lines.push(`${indent}  </testcase>`);
  }

  for (const step of report.steps) {
    lines.push(
      `${indent}  <testcase name="${escapeXml(step.description)}" classname="${escapeXml(report.project)}">`,
    );
    if (!step.passed && step.error) {
      lines.push(
        `${indent}    <failure message="${escapeXml(step.error)}">${escapeXml(step.error)}</failure>`,
      );
    }
    lines.push(`${indent}  </testcase>`);
  }

  lines.push(`${indent}</testsuite>`);
  return lines;
}

export function toJUnit(report: CIReport): string {
  return [`<?xml version="1.0" encoding="UTF-8"?>`, ...junitSuite(report)].join("\n");
}

/** Aggregate many project reports into a single <testsuites> document. */
export function toJUnitSuites(reports: CIReport[]): string {
  const lines: string[] = [`<?xml version="1.0" encoding="UTF-8"?>`];
  const totalTests = reports.reduce(
    (n, r) => n + (r.steps.length || (r.build && !r.build.success ? 1 : 0)),
    0,
  );
  const totalFailures = reports.reduce(
    (n, r) =>
      n +
      (r.steps.filter((s) => !s.passed).length ||
        (r.build && !r.build.success ? 1 : 0)),
    0,
  );
  lines.push(`<testsuites tests="${totalTests}" failures="${totalFailures}">`);
  for (const report of reports) {
    lines.push(...junitSuite(report, "  "));
  }
  lines.push(`</testsuites>`);
  return lines.join("\n");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
