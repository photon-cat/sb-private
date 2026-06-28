import { describe, it, expect } from "vitest";
import { workbenchReducer, createInitialState } from "../workbench/reducer";
import type { WorkbenchState } from "../workbench/types";
import { parseDiagram } from "../diagram-parser";

function initial(): WorkbenchState {
  return createInitialState("proj-1");
}

describe("createInitialState", () => {
  it("starts clean with sane defaults", () => {
    const s = initial();
    expect(s.projectId).toBe("proj-1");
    expect(s.diagram).toBeNull();
    expect(s.dirty).toBe(false);
    expect(s.showGrid).toBe(true);
    expect(s.mcuBoardId).toBe("uno");
    expect(s.canUndo).toBe(false);
  });
});

describe("workbenchReducer document actions", () => {
  it("SET_DIAGRAM sets both diagram and json without mutating prior state", () => {
    const s = initial();
    const diagram = parseDiagram({ parts: [], connections: [] });
    const next = workbenchReducer(s, { type: "SET_DIAGRAM", diagram, diagramJson: "{}" });
    expect(next.diagram).toBe(diagram);
    expect(next.diagramJson).toBe("{}");
    expect(s.diagram).toBeNull(); // original untouched
    expect(next).not.toBe(s);
  });

  it("SET_DIAGRAM_JSON keeps the previous diagram when JSON is invalid", () => {
    const diagram = parseDiagram({ parts: [{ id: "a", type: "wokwi-led", top: 0, left: 0 }], connections: [] });
    const s: WorkbenchState = { ...initial(), diagram, diagramJson: "old" };
    const next = workbenchReducer(s, { type: "SET_DIAGRAM_JSON", diagramJson: "{ not json" });
    expect(next.diagramJson).toBe("{ not json");
    expect(next.diagram).toBe(diagram); // unchanged because parse failed
  });

  it("SET_DIAGRAM_JSON reparses the diagram when JSON is valid", () => {
    const s = initial();
    const json = JSON.stringify({ parts: [{ id: "x", type: "wokwi-led", top: 0, left: 0 }], connections: [] });
    const next = workbenchReducer(s, { type: "SET_DIAGRAM_JSON", diagramJson: json });
    expect(next.diagram?.parts).toHaveLength(1);
    expect(next.diagram?.parts[0].id).toBe("x");
  });

  it("SET_SKETCH / SET_PCB / SET_LIBRARIES update their fields", () => {
    let s = initial();
    s = workbenchReducer(s, { type: "SET_SKETCH", sketch: "void loop(){}" });
    s = workbenchReducer(s, { type: "SET_PCB", pcbText: "(kicad_pcb)" });
    s = workbenchReducer(s, { type: "SET_LIBRARIES", librariesTxt: "Servo" });
    expect(s.sketch).toBe("void loop(){}");
    expect(s.pcbText).toBe("(kicad_pcb)");
    expect(s.librariesTxt).toBe("Servo");
  });
});

describe("workbenchReducer file actions", () => {
  it("ADD_FILE / UPDATE_FILE_CONTENT / RENAME_FILE / DELETE_FILE", () => {
    let s = initial();
    s = workbenchReducer(s, { type: "ADD_FILE", name: "util.h" });
    expect(s.projectFiles).toEqual([{ name: "util.h", content: "" }]);

    s = workbenchReducer(s, { type: "UPDATE_FILE_CONTENT", name: "util.h", content: "#pragma once" });
    expect(s.projectFiles[0].content).toBe("#pragma once");

    s = workbenchReducer(s, { type: "RENAME_FILE", oldName: "util.h", newName: "helpers.h" });
    expect(s.projectFiles[0].name).toBe("helpers.h");
    expect(s.projectFiles[0].content).toBe("#pragma once"); // content preserved

    s = workbenchReducer(s, { type: "DELETE_FILE", name: "helpers.h" });
    expect(s.projectFiles).toHaveLength(0);
  });

  it("file actions do not mutate the prior files array", () => {
    const s = initial();
    const next = workbenchReducer(s, { type: "ADD_FILE", name: "a.h" });
    expect(s.projectFiles).toHaveLength(0);
    expect(next.projectFiles).toHaveLength(1);
    expect(next.projectFiles).not.toBe(s.projectFiles);
  });
});

describe("workbenchReducer UI and lifecycle", () => {
  it("TOGGLE_GRID flips the flag", () => {
    const s = initial();
    expect(workbenchReducer(s, { type: "TOGGLE_GRID" }).showGrid).toBe(false);
  });

  it("SET_DIRTY and SET_SAVED manage the dirty/lastSaved lifecycle", () => {
    let s = workbenchReducer(initial(), { type: "SET_DIRTY", dirty: true });
    expect(s.dirty).toBe(true);
    const when = new Date("2026-01-01T00:00:00Z");
    s = workbenchReducer(s, { type: "SET_SAVED", date: when });
    expect(s.dirty).toBe(false); // saving clears dirty
    expect(s.lastSaved).toBe(when);
  });

  it("SET_UNDO_STATE tracks undo/redo availability", () => {
    const s = workbenchReducer(initial(), { type: "SET_UNDO_STATE", canUndo: true, canRedo: false });
    expect(s.canUndo).toBe(true);
    expect(s.canRedo).toBe(false);
  });

  it("LOAD_PROJECT replaces the document and resets dirty", () => {
    const dirtyState: WorkbenchState = { ...initial(), dirty: true };
    const diagram = parseDiagram({ parts: [], connections: [] });
    const next = workbenchReducer(dirtyState, {
      type: "LOAD_PROJECT",
      doc: {
        diagram,
        diagramJson: "{}",
        sketch: "loaded",
        pcbText: null,
        librariesTxt: "",
        projectFiles: [{ name: "f.h", content: "x" }],
      },
    });
    expect(next.sketch).toBe("loaded");
    expect(next.projectFiles).toHaveLength(1);
    expect(next.dirty).toBe(false);
  });

  it("returns the same state for an unknown action", () => {
    const s = initial();
    // @ts-expect-error — exercising the default branch
    expect(workbenchReducer(s, { type: "NONEXISTENT" })).toBe(s);
  });
});
