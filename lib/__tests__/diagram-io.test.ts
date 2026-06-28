import { describe, it, expect } from "vitest";
import { importWokwi, exportToWokwi } from "../diagram-io";
import { parseDiagram } from "../diagram-parser";

describe("importWokwi", () => {
  it("sets editor to sparkbench and promotes attrs.value to part.value", () => {
    const imported = importWokwi({
      editor: "wokwi",
      parts: [{ id: "r1", type: "wokwi-resistor", top: 0, left: 0, attrs: { value: "220" } }],
      connections: [],
    });
    expect(imported.editor).toBe("sparkbench");
    expect(imported.parts[0].value).toBe("220");
  });

  it("does not overwrite an existing part.value", () => {
    const imported = importWokwi({
      parts: [{ id: "r1", type: "wokwi-resistor", top: 0, left: 0, value: "1k", attrs: { value: "220" } }],
      connections: [],
    });
    expect(imported.parts[0].value).toBe("1k");
  });
});

describe("exportToWokwi", () => {
  it("strips sparkbench fields and serializes connections as arrays", () => {
    const diagram = parseDiagram({
      editor: "sparkbench",
      parts: [{ id: "led1", type: "wokwi-led", top: 0, left: 0, attrs: { color: "red" } }],
      connections: [{ from: "uno:13", to: "led1:A", color: "green", hints: [] }],
    });
    const wokwi = exportToWokwi(diagram) as {
      editor: string;
      connections: unknown[];
    };
    expect(wokwi.editor).toBe("wokwi");
    expect(wokwi.connections[0]).toEqual(["uno:13", "led1:A", "green", []]);
  });

  it("materializes label-only nets into explicit wires", () => {
    const diagram = parseDiagram({
      parts: [
        { id: "a", type: "wokwi-led", top: 0, left: 0, attrs: {} },
        { id: "b", type: "wokwi-led", top: 0, left: 0, attrs: {} },
      ],
      connections: [],
      labels: [
        { id: "l1", name: "SIG", pinRef: "a:A", x: 0, y: 0 },
        { id: "l2", name: "SIG", pinRef: "b:A", x: 0, y: 0 },
      ],
    });
    const wokwi = exportToWokwi(diagram) as { connections: unknown[][] };
    // The two SIG-labelled pins should now be joined by an explicit wire.
    const joined = wokwi.connections.some(
      (c) => (c[0] === "a:A" && c[1] === "b:A") || (c[0] === "b:A" && c[1] === "a:A"),
    );
    expect(joined).toBe(true);
  });
});

describe("import/export round-trip", () => {
  it("preserves parts and connections through a full cycle", () => {
    const original = {
      version: 1,
      author: "test",
      editor: "wokwi",
      parts: [
        { id: "uno", type: "wokwi-arduino-uno", top: 0, left: 0, attrs: {} },
        { id: "r1", type: "wokwi-resistor", top: 10, left: 20, attrs: { value: "220" }, rotate: 90 },
        { id: "led1", type: "wokwi-led", top: 5, left: 5, attrs: { color: "red" } },
      ],
      connections: [
        ["uno:13", "r1:1", "green", []],
        ["r1:2", "led1:A", "green", []],
        ["uno:GND.1", "led1:C", "black", []],
      ],
    };

    const roundTripped = exportToWokwi(importWokwi(original)) as {
      parts: { id: string; rotate?: number; attrs: Record<string, string> }[];
      connections: unknown[][];
    };

    expect(roundTripped.parts).toHaveLength(3);
    expect(roundTripped.connections).toHaveLength(3);

    const r1 = roundTripped.parts.find((p) => p.id === "r1")!;
    expect(r1.rotate).toBe(90);
    expect(r1.attrs.value).toBe("220"); // value round-trips back into attrs

    // Connection identity preserved
    const conn = roundTripped.connections.find((c) => c[0] === "uno:13");
    expect(conn).toEqual(["uno:13", "r1:1", "green", []]);
  });
});
