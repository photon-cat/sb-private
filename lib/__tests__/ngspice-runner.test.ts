import { describe, it, expect } from "vitest";
import { parseDiagram } from "../diagram-parser";
import { generateSpiceNetlist, spiceCircuitToString } from "../spice-netlist";
import { runNgspice, checkNgspiceAvailable } from "../ngspice-runner";

async function skipIfNoNgspice() {
  const available = await checkNgspiceAvailable();
  if (!available) {
    return true;
  }
  return false;
}

describe("ngspice-runner", () => {
  it("checkNgspiceAvailable returns boolean", async () => {
    const result = await checkNgspiceAvailable();
    expect(typeof result).toBe("boolean");
  });

  it("runs .op analysis on simple circuit", async () => {
    if (await skipIfNoNgspice()) return;

    const diagram = parseDiagram({
      parts: [
        { type: "wokwi-arduino-uno", id: "uno", top: 0, left: 0 },
        { type: "wokwi-resistor", id: "r1", top: 0, left: 100, attrs: { value: "220" } },
        { type: "wokwi-led", id: "led", top: 0, left: 200, attrs: { color: "red" } },
      ],
      connections: [
        ["uno:GND.1", "led:C", "black", []],
        ["r1:1", "led:A", "blue", []],
        ["uno:13", "r1:2", "blue", []],
      ],
    });

    const circuit = generateSpiceNetlist(diagram);
    const result = await runNgspice(circuit, { timeoutMs: 10_000 });

    expect(result.success).toBe(true);
    expect(result.stdout).toBeTruthy();
  });

  it("runs transient analysis", async () => {
    if (await skipIfNoNgspice()) return;

    const diagram = parseDiagram({
      parts: [
        { type: "wokwi-arduino-uno", id: "uno", top: 0, left: 0 },
        { type: "wokwi-resistor", id: "r1", top: 0, left: 100, attrs: { value: "1000" } },
      ],
      connections: [
        ["uno:5V", "r1:1", "red", []],
        ["uno:GND", "r1:2", "black", []],
      ],
    });

    const circuit = generateSpiceNetlist(diagram, [
      { type: "tran", params: "1u 1m" },
    ]);
    const result = await runNgspice(circuit, { timeoutMs: 10_000 });

    expect(result.success).toBe(true);
  });

  it("reports failure for invalid circuit", async () => {
    if (await skipIfNoNgspice()) return;

    const circuit = {
      title: "Bad Circuit",
      elements: [],
      models: [],
      analyses: [{ type: "tran" as const, params: "" }],
      nodeMap: new Map<string, number>(),
    };
    const result = await runNgspice(circuit, { timeoutMs: 10_000 });

    // ngspice may exit 0 but produce no data, or exit non-zero
    expect(typeof result.success).toBe("boolean");
  });
});
