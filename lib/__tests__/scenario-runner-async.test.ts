import { describe, it, expect } from "vitest";
import { parseScenario, runScenario, runScenarioAsync } from "../scenario-runner";
import { parseDiagram } from "../diagram-parser";

// A minimal, deterministic Uno + LED diagram used for the parity test.
const DIAGRAM_JSON = {
  version: 1,
  author: "test",
  editor: "sparkbench",
  parts: [
    { id: "uno", type: "wokwi-arduino-uno", top: 0, left: 0, attrs: {} },
    { id: "led1", type: "wokwi-led", top: 0, left: 0, attrs: { color: "red" } },
  ],
  connections: [["uno:13", "led1:A", "green", []]],
};

// Pre-built Intel HEX for: `Serial.begin(9600); Serial.println("READY");` and loop empty.
// We don't ship a compiled fixture — so this test uses an empty sketch's HEX
// generated at runtime would require the build API. For a pure lib-side test
// we just verify that runScenarioAsync with no steps returns the same shape
// as runScenario and doesn't throw.
const EMPTY_HEX = ":00000001FF\n";

const EMPTY_SCENARIO = `
name: noop
version: 1
steps:
  - delay: 1
`;

describe("runScenarioAsync", () => {
  it("returns the same shape as runScenario without chip configs", async () => {
    const diagram = parseDiagram(DIAGRAM_JSON);
    const scenario = parseScenario(EMPTY_SCENARIO);

    const sync = runScenario(EMPTY_HEX, diagram, scenario);
    const async = await runScenarioAsync(EMPTY_HEX, diagram, scenario);

    expect(async.name).toBe(sync.name);
    expect(async.passed).toBe(sync.passed);
    expect(async.steps.length).toBe(sync.steps.length);
    expect(async.steps[0].description).toBe(sync.steps[0].description);
    // Serial output should be empty (or at most the same) for both runs.
    expect(async.serialOutput).toBe(sync.serialOutput);
  });

  it("accepts an empty chipConfigs map without error", async () => {
    const diagram = parseDiagram(DIAGRAM_JSON);
    const scenario = parseScenario(EMPTY_SCENARIO);
    const result = await runScenarioAsync(EMPTY_HEX, diagram, scenario, new Map());
    expect(result.passed).toBe(true);
  });

  it("accepts undefined chipConfigs", async () => {
    const diagram = parseDiagram(DIAGRAM_JSON);
    const scenario = parseScenario(EMPTY_SCENARIO);
    const result = await runScenarioAsync(EMPTY_HEX, diagram, scenario, undefined);
    expect(result.passed).toBe(true);
  });
});
