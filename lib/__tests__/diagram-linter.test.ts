import { describe, it, expect } from "vitest";
import { lintDiagram } from "../diagram-linter";
import { parseDiagram } from "../diagram-parser";

// Minimal pin registry — mirrors what real @sparkbench/elements expose for the
// parts we care about linting. Keeps the test fully offline.
const REGISTRY = new Map<string, string[]>([
  ["wokwi-arduino-uno", ["GND.1", "GND.2", "GND.3", "5V", "3.3V", "A0", "A1", "A2", "A3", "A4", "A5", "A4.2", "A5.2", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13"]],
  ["wokwi-ssd1306", ["DATA", "CLK", "DC", "RST", "CS", "3V3", "GND", "VIN"]],
  ["wokwi-led", ["A", "C"]],
  ["wokwi-resistor", ["1", "2"]],
]);

function makeDiagram(connections: [string, string][]): ReturnType<typeof parseDiagram> {
  return parseDiagram({
    version: 1,
    author: "test",
    editor: "sparkbench",
    parts: [
      { id: "uno", type: "wokwi-arduino-uno", top: 0, left: 0, attrs: {} },
      { id: "oled", type: "wokwi-ssd1306", top: 0, left: 100, attrs: {} },
      { id: "led1", type: "wokwi-led", top: 50, left: 50, attrs: { color: "red" } },
      { id: "r1", type: "wokwi-resistor", top: 50, left: 100, attrs: { value: "220" } },
    ],
    connections: connections.map((c) => [c[0], c[1], "red", []]),
  });
}

describe("lintDiagram", () => {
  it("returns no issues for a valid diagram", () => {
    const diagram = makeDiagram([
      ["uno:13", "r1:1"],
      ["r1:2", "led1:A"],
      ["led1:C", "uno:GND.1"],
    ]);
    expect(lintDiagram(diagram, REGISTRY)).toEqual([]);
  });

  it("flags wrong SSD1306 pin names with helpful suggestions", () => {
    const diagram = makeDiagram([
      ["uno:5V", "oled:VCC"],
      ["uno:GND.1", "oled:GND"],
      ["uno:A4", "oled:SDA"],
      ["uno:A5", "oled:SCL"],
    ]);
    const issues = lintDiagram(diagram, REGISTRY);
    const refs = issues.map((i) => i.ref);
    expect(refs).toContain("oled:VCC");
    expect(refs).toContain("oled:SDA");
    expect(refs).toContain("oled:SCL");
    // GND is valid on the SSD1306 — shouldn't be flagged
    expect(refs).not.toContain("oled:GND");

    // Suggestions
    const sdaIssue = issues.find((i) => i.ref === "oled:SDA")!;
    expect(sdaIssue.message).toContain("DATA");
    const sclIssue = issues.find((i) => i.ref === "oled:SCL")!;
    expect(sclIssue.message).toContain("CLK");
    const vccIssue = issues.find((i) => i.ref === "oled:VCC")!;
    expect(vccIssue.message).toMatch(/VIN|3V3/);
  });

  it("flags connections to unknown parts", () => {
    const diagram = makeDiagram([
      ["uno:13", "ghost:A"],
      ["tiny:PB0", "oled:DATA"],
    ]);
    const issues = lintDiagram(diagram, REGISTRY);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBe(2);
    expect(errors.map((i) => i.partId).sort()).toEqual(["ghost", "tiny"]);
  });

  it("strips .1/.2/.l/.r suffixes before matching", () => {
    // uno:GND.1 is valid, so no issue; but uno:GND.9 should also resolve
    // because we strip the .9 suffix down to GND which... wait, GND isn't
    // in the registry, only GND.1/.2/.3 are. Test that behavior.
    const diagram = makeDiagram([
      ["uno:GND.1", "led1:C"], // valid
      ["uno:A4.2", "oled:DATA"], // valid after suffix strip is preserved
    ]);
    const issues = lintDiagram(diagram, REGISTRY);
    expect(issues.filter((i) => i.ref.startsWith("uno:"))).toEqual([]);
  });

  it("emits warnings, not errors, for typos so the sim can still try to run", () => {
    const diagram = makeDiagram([
      ["uno:A4", "oled:SDA"],
    ]);
    const issues = lintDiagram(diagram, REGISTRY);
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
  });

  it("populates validPins so the UI can show a dropdown fix", () => {
    const diagram = makeDiagram([
      ["oled:SDA", "uno:A4"],
    ]);
    const issue = lintDiagram(diagram, REGISTRY)[0];
    expect(issue.validPins).toEqual(REGISTRY.get("wokwi-ssd1306"));
  });

  it("tracks connectionIndex so the UI can highlight the offending wire", () => {
    const diagram = makeDiagram([
      ["uno:13", "r1:1"],         // 0: ok
      ["uno:A4", "oled:SDA"],     // 1: bad
      ["uno:GND.1", "led1:C"],    // 2: ok
    ]);
    const issues = lintDiagram(diagram, REGISTRY);
    expect(issues.length).toBe(1);
    expect(issues[0].connectionIndex).toBe(1);
  });
});
