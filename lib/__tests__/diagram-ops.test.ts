import { describe, it, expect } from "vitest";
import type { Diagram, DiagramConnection } from "../diagram-parser";
import {
  addPart,
  removePart,
  updatePart,
  movePart,
  rotatePart,
  setPartAttr,
  setPartField,
  duplicatePart,
  addConnection,
  removeConnection,
  updateConnection,
  setConnectionColor,
  addLabel,
  removeLabel,
  emptyDiagram,
} from "../diagram-ops";

function fixture(): Diagram {
  return {
    version: 1,
    author: "test",
    editor: "sparkbench",
    parts: [
      { id: "uno", type: "wokwi-arduino-uno", top: 0, left: 0, attrs: {} },
      { id: "led1", type: "wokwi-led", top: 10, left: 20, attrs: { color: "red" } },
      { id: "r1", type: "wokwi-resistor", top: 5, left: 5, attrs: { value: "220" } },
    ],
    connections: [
      { from: "uno:13", to: "r1:1", color: "green", hints: [] },
      { from: "r1:2", to: "led1:A", color: "green", hints: [] },
      { from: "uno:GND.1", to: "led1:C", color: "black", hints: [] },
    ],
    labels: [{ id: "l1", name: "SIG", pinRef: "led1:A", x: 0, y: 0 }],
  };
}

describe("diagram-ops immutability", () => {
  it("addPart does not mutate the input diagram", () => {
    const d = fixture();
    const before = d.parts.length;
    const next = addPart(d, { id: "btn1", type: "wokwi-pushbutton", top: 0, left: 0, attrs: {} });
    expect(d.parts.length).toBe(before); // original unchanged
    expect(next.parts.length).toBe(before + 1);
    expect(next).not.toBe(d);
  });

  it("movePart returns a new diagram and leaves the original intact", () => {
    const d = fixture();
    const next = movePart(d, "led1", 99, 88);
    expect(d.parts.find((p) => p.id === "led1")!.left).toBe(20);
    expect(next.parts.find((p) => p.id === "led1")!.left).toBe(99);
    expect(next.parts.find((p) => p.id === "led1")!.top).toBe(88);
  });
});

describe("removePart", () => {
  it("removes the part and all connections that touch it", () => {
    const d = fixture();
    const next = removePart(d, "led1");
    expect(next.parts.find((p) => p.id === "led1")).toBeUndefined();
    // Both connections referencing led1 must be gone; the uno→r1 one remains.
    expect(next.connections).toHaveLength(1);
    expect(next.connections[0].from).toBe("uno:13");
  });

  it("removes labels pinned to the removed part", () => {
    const d = fixture();
    const next = removePart(d, "led1");
    expect(next.labels).toHaveLength(0);
  });

  it("is a no-op for an unknown part id (but still returns a copy)", () => {
    const d = fixture();
    const next = removePart(d, "does-not-exist");
    expect(next.parts).toHaveLength(d.parts.length);
    expect(next.connections).toHaveLength(d.connections.length);
  });
});

describe("rotatePart", () => {
  it("accumulates rotation modulo 360", () => {
    let d = fixture();
    d = rotatePart(d, "led1", 90);
    expect(d.parts.find((p) => p.id === "led1")!.rotate).toBe(90);
    d = rotatePart(d, "led1", 300);
    expect(d.parts.find((p) => p.id === "led1")!.rotate).toBe(30); // 390 % 360
  });

  it("returns the same diagram reference for an unknown part", () => {
    const d = fixture();
    expect(rotatePart(d, "nope", 90)).toBe(d);
  });
});

describe("setPartAttr / setPartField", () => {
  it("sets and clears attributes (empty string deletes)", () => {
    const d = fixture();
    const set = setPartAttr(d, "led1", "color", "blue");
    expect(set.parts.find((p) => p.id === "led1")!.attrs.color).toBe("blue");
    const cleared = setPartAttr(set, "led1", "color", "");
    expect(cleared.parts.find((p) => p.id === "led1")!.attrs.color).toBeUndefined();
  });

  it("setPartField sets value/footprint, undefined when empty", () => {
    const d = fixture();
    const withVal = setPartField(d, "r1", "value", "1000");
    expect(withVal.parts.find((p) => p.id === "r1")!.value).toBe("1000");
    const cleared = setPartField(withVal, "r1", "value", "");
    expect(cleared.parts.find((p) => p.id === "r1")!.value).toBeUndefined();
  });
});

describe("duplicatePart", () => {
  it("clones a part with a new id and positional offset", () => {
    const d = fixture();
    const next = duplicatePart(d, "led1", "led2");
    const orig = d.parts.find((p) => p.id === "led1")!;
    const dup = next.parts.find((p) => p.id === "led2")!;
    expect(dup.type).toBe(orig.type);
    expect(dup.attrs.color).toBe("red");
    expect(dup.top).toBe(orig.top + 20);
    expect(dup.left).toBe(orig.left + 20);
  });
});

describe("connection ops", () => {
  it("addConnection appends immutably", () => {
    const d = fixture();
    const conn: DiagramConnection = { from: "uno:12", to: "led1:A", color: "red", hints: [] };
    const next = addConnection(d, conn);
    expect(d.connections).toHaveLength(3);
    expect(next.connections).toHaveLength(4);
  });

  it("removeConnection drops the indexed entry", () => {
    const d = fixture();
    const next = removeConnection(d, 0);
    expect(next.connections).toHaveLength(2);
    expect(next.connections[0].from).toBe("r1:2");
  });

  it("setConnectionColor updates only the color of one connection", () => {
    const d = fixture();
    const next = setConnectionColor(d, 0, "blue");
    expect(next.connections[0].color).toBe("blue");
    expect(next.connections[0].from).toBe("uno:13"); // rest preserved
    expect(d.connections[0].color).toBe("green"); // original untouched
  });

  it("setConnectionColor is a no-op for out-of-range index", () => {
    const d = fixture();
    expect(setConnectionColor(d, 99, "blue")).toBe(d);
  });
});

describe("labels and emptyDiagram", () => {
  it("addLabel/removeLabel round-trip", () => {
    const d = emptyDiagram();
    const withLabel = addLabel(d, { id: "x", name: "VCC", pinRef: "a:1", x: 0, y: 0 });
    expect(withLabel.labels).toHaveLength(1);
    const without = removeLabel(withLabel, "x");
    expect(without.labels).toHaveLength(0);
  });

  it("emptyDiagram has the expected empty shape", () => {
    const d = emptyDiagram();
    expect(d.parts).toHaveLength(0);
    expect(d.connections).toHaveLength(0);
    expect(d.labels).toHaveLength(0);
    expect(d.editor).toBe("sparkbench");
  });
});
