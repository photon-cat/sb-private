import { describe, it, expect } from "vitest";
import { buildReport, toJUnit, toJUnitSuites } from "../sim/reporter";
import type { ScenarioResult } from "../scenario-runner";

const passingScenario: ScenarioResult = {
  name: "demo",
  passed: true,
  serialOutput: "READY\n",
  clockHz: 16e6,
  steps: [
    { step: 0, description: 'wait-serial "READY"', passed: true },
    { step: 1, description: "delay 100ms", passed: true },
  ],
};

const failingScenario: ScenarioResult = {
  name: "demo",
  passed: false,
  serialOutput: "",
  clockHz: 16e6,
  steps: [
    { step: 0, description: 'wait-serial "READY"', passed: false, error: "Timeout waiting for READY" },
  ],
};

describe("buildReport", () => {
  it("produces the documented report shape", () => {
    const report = buildReport({
      project: "blink",
      passed: true,
      mcu: { id: "uno", board: "uno", clockHz: 16e6 },
      buildDurationMs: 1234,
      chips: [{ partId: "chip1", name: "inverter", wasmBytes: 4096 }],
      scenarioResult: passingScenario,
    });
    expect(report.project).toBe("blink");
    expect(report.passed).toBe(true);
    expect(report.build).toEqual({ success: true, durationMs: 1234 });
    expect(report.chips[0]).toEqual({ partId: "chip1", name: "inverter", wasmBytes: 4096, compiled: true });
    expect(report.steps).toHaveLength(2);
    expect(report.steps[0]).toMatchObject({ index: 0, passed: true });
  });

  it("defaults optional fields to null/empty", () => {
    const report = buildReport({ project: "x", passed: false });
    expect(report.mcu).toBeNull();
    expect(report.build).toBeNull();
    expect(report.simulation).toBeNull();
    expect(report.chips).toEqual([]);
    expect(report.steps).toEqual([]);
  });
});

describe("toJUnit", () => {
  it("emits a valid single testsuite with correct counts", () => {
    const report = buildReport({ project: "demo", passed: false, scenarioResult: failingScenario });
    const xml = toJUnit(report);
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<testsuite name="demo" tests="1" failures="1">');
    expect(xml).toContain("<failure");
    expect(xml).toContain("</testsuite>");
  });

  it("escapes XML special characters in descriptions", () => {
    const result: ScenarioResult = {
      name: "esc",
      passed: false,
      serialOutput: "",
      clockHz: 16e6,
      steps: [{ step: 0, description: 'wait-serial "<a> & \'b\'"', passed: false, error: "x < y & z" }],
    };
    const xml = toJUnit(buildReport({ project: "esc", passed: false, scenarioResult: result }));
    expect(xml).toContain("&lt;a&gt;");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&quot;");
    expect(xml).not.toMatch(/<a>/); // raw angle brackets must not survive
  });

  it("counts a build failure with no steps as one failing test", () => {
    const report = buildReport({ project: "broken", passed: false });
    report.build = { success: false, durationMs: 0 };
    const xml = toJUnit(report);
    expect(xml).toContain('tests="1" failures="1"');
    expect(xml).toContain('name="build"');
  });
});

describe("toJUnitSuites", () => {
  it("aggregates multiple reports with summed totals", () => {
    const pass = buildReport({ project: "a", passed: true, scenarioResult: passingScenario });
    const fail = buildReport({ project: "b", passed: false, scenarioResult: failingScenario });
    const xml = toJUnitSuites([pass, fail]);
    expect(xml).toContain("<testsuites ");
    // 2 passing steps + 1 failing step = 3 tests, 1 failure
    expect(xml).toContain('tests="3" failures="1"');
    expect(xml).toContain('<testsuite name="a"');
    expect(xml).toContain('<testsuite name="b"');
    expect(xml).toContain("</testsuites>");
  });
});
