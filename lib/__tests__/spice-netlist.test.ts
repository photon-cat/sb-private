import { describe, it, expect } from "vitest";
import { parseDiagram } from "../diagram-parser";
import {
  generateSpiceNetlist,
  spiceCircuitToString,
  type SpiceAnalysis,
} from "../spice-netlist";

function blinkDiagram() {
  return parseDiagram({
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
}

describe("generateSpiceNetlist", () => {
  it("generates elements for resistor + LED circuit", () => {
    const diagram = blinkDiagram();
    const circuit = generateSpiceNetlist(diagram);

    const resistors = circuit.elements.filter((e) => e.name.startsWith("R"));
    const diodes = circuit.elements.filter((e) => e.name.startsWith("D"));

    expect(resistors.length).toBeGreaterThanOrEqual(1);
    expect(diodes).toHaveLength(1);
    expect(diodes[0].model).toBe("LED");
  });

  it("includes LED model definition", () => {
    const diagram = blinkDiagram();
    const circuit = generateSpiceNetlist(diagram);

    expect(circuit.models.some((m) => m.includes(".model LED"))).toBe(true);
  });

  it("assigns node 0 to GND nets", () => {
    const diagram = blinkDiagram();
    const circuit = generateSpiceNetlist(diagram);

    let hasGroundNode = false;
    for (const [, nodeNum] of circuit.nodeMap) {
      if (nodeNum === 0) {
        hasGroundNode = true;
        break;
      }
    }
    expect(hasGroundNode).toBe(true);
  });

  it("defaults to .op analysis", () => {
    const diagram = blinkDiagram();
    const circuit = generateSpiceNetlist(diagram);
    expect(circuit.analyses).toEqual([{ type: "op", params: "" }]);
  });

  it("accepts custom analyses", () => {
    const diagram = blinkDiagram();
    const analyses: SpiceAnalysis[] = [
      { type: "tran", params: "1u 10m" },
    ];
    const circuit = generateSpiceNetlist(diagram, analyses);
    expect(circuit.analyses).toEqual(analyses);
  });

  it("handles potentiometer as split resistors", () => {
    const diagram = parseDiagram({
      parts: [
        { type: "wokwi-arduino-uno", id: "uno", top: 0, left: 0 },
        // attrs.value is the WIPER POSITION (0-1023), not resistance.
        { type: "wokwi-potentiometer", id: "pot1", top: 0, left: 100, attrs: { value: "512" } },
      ],
      connections: [
        ["uno:A0", "pot1:SIG", "green", []],
        ["uno:5V", "pot1:VCC", "red", []],
        ["uno:GND", "pot1:GND", "black", []],
      ],
    });
    const circuit = generateSpiceNetlist(diagram);
    const resistors = circuit.elements.filter((e) => e.name.startsWith("R"));
    expect(resistors.length).toBeGreaterThanOrEqual(2);

    // At wiper midpoint the two divider legs of a default 10k pot should each
    // be ~5k — NOT collapsed to the 0.1 floor (regression: value was misread
    // as total resistance, making "value":"0" produce a 0Ω pot).
    const legs = resistors
      .map((r) => parseFloat(r.value))
      .filter((v) => v > 1) // ignore the 0.1 wiper-tap resistor
      .sort((a, b) => a - b);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toBeGreaterThan(4000);
    expect(legs[1]).toBeLessThan(6000);
  });

  it("treats potentiometer attrs.value as wiper position, not resistance", () => {
    const diagram = parseDiagram({
      parts: [
        { type: "wokwi-arduino-uno", id: "uno", top: 0, left: 0 },
        { type: "wokwi-potentiometer", id: "pot1", top: 0, left: 100, attrs: { value: "0" } },
      ],
      connections: [
        ["uno:A0", "pot1:SIG", "green", []],
        ["uno:5V", "pot1:VCC", "red", []],
        ["uno:GND", "pot1:GND", "black", []],
      ],
    });
    const circuit = generateSpiceNetlist(diagram);
    const legs = circuit.elements
      .filter((e) => e.name.startsWith("R"))
      .map((r) => parseFloat(r.value));
    // value:"0" wiper → one leg is the full ~10k, not a 0Ω short across the board.
    expect(Math.max(...legs)).toBeGreaterThan(9000);
  });

  it("handles empty diagram", () => {
    const diagram = parseDiagram({});
    const circuit = generateSpiceNetlist(diagram);
    expect(circuit.elements).toHaveLength(0);
    expect(circuit.models).toHaveLength(0);
  });
});

describe("spiceCircuitToString", () => {
  it("produces valid SPICE format with .end", () => {
    const diagram = blinkDiagram();
    const circuit = generateSpiceNetlist(diagram);
    const output = spiceCircuitToString(circuit);

    expect(output).toContain("* SparkBench Circuit");
    expect(output).toContain(".op");
    expect(output.trim()).toMatch(/\.end$/);
  });

  it("includes model lines before elements", () => {
    const diagram = blinkDiagram();
    const circuit = generateSpiceNetlist(diagram);
    const output = spiceCircuitToString(circuit);

    const modelIdx = output.indexOf(".model LED");
    const elementIdx = output.indexOf("D1");
    expect(modelIdx).toBeLessThan(elementIdx);
  });

  it("formats transient analysis", () => {
    const diagram = blinkDiagram();
    const circuit = generateSpiceNetlist(diagram, [
      { type: "tran", params: "1u 10m" },
    ]);
    const output = spiceCircuitToString(circuit);
    expect(output).toContain(".tran 1u 10m");
  });

  it("does not contain unresolved nodes (?)", () => {
    const diagram = blinkDiagram();
    const circuit = generateSpiceNetlist(diagram);
    const output = spiceCircuitToString(circuit);

    const elementLines = output.split("\n").filter(
      (l) => /^[RCLVD]/.test(l)
    );
    for (const line of elementLines) {
      expect(line).not.toContain("?");
    }
  });
});
