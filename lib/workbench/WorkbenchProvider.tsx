"use client";

import {
  createContext,
  useContext,
  useReducer,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import type {
  WorkbenchState,
  WorkbenchAction,
  WorkbenchCommands,
} from "./types";
import { workbenchReducer, createInitialState } from "./reducer";
import {
  parseDiagram,
  findMCUs,
  type Diagram,
  type DiagramPart,
  type DiagramConnection,
} from "../diagram-parser";
import {
  addPart,
  removePart,
  movePart,
  rotatePart,
  setPartAttr,
  setPartField,
  duplicatePart,
  addConnection,
  removeConnection,
  updateConnection,
  setConnectionColor,
} from "../diagram-ops";
import { generatePCBFromDiagram } from "../pcb-pipeline";
import { exportToWokwi, importWokwi } from "../diagram-io";
import {
  fetchDiagram,
  fetchSketch,
  saveDiagram,
  saveSketch,
  fetchPCB,
  savePCB,
  fetchLibraries,
  saveLibraries,
  fetchProjectSettings,
  fetchStarStatus,
} from "../api";

const SHORT_PREFIX: Record<string, string> = {
  "wokwi-pushbutton": "btn",
  "wokwi-pushbutton-6mm": "btn",
  "wokwi-resistor": "r",
  "wokwi-clock-generator": "clk",
  "wokwi-junction": "j",
  "sb-atmega328": "u",
  "sb-capacitor": "c",
  "sb-crystal": "y",
  "sb-diode": "d",
  "sb-usb-c": "j",
};

function typeToPrefix(type: string): string {
  if (SHORT_PREFIX[type]) return SHORT_PREFIX[type];
  return type
    .replace(/^wokwi-/, "")
    .replace(/^sb-/, "")
    .replace(/^board-/, "")
    .replace(/-\d+$/, "")
    .replace(/-/g, "");
}

// ── Context ──────────────────────────────────────────────────

const StateContext = createContext<WorkbenchState | null>(null);
const DispatchContext = createContext<React.Dispatch<WorkbenchAction> | null>(null);
const CommandsContext = createContext<WorkbenchCommands | null>(null);

export function useWorkbenchState(): WorkbenchState {
  const ctx = useContext(StateContext);
  if (!ctx) throw new Error("useWorkbenchState must be used inside WorkbenchProvider");
  return ctx;
}

export function useWorkbenchDispatch(): React.Dispatch<WorkbenchAction> {
  const ctx = useContext(DispatchContext);
  if (!ctx) throw new Error("useWorkbenchDispatch must be used inside WorkbenchProvider");
  return ctx;
}

export function useWorkbenchCommands(): WorkbenchCommands {
  const ctx = useContext(CommandsContext);
  if (!ctx) throw new Error("useWorkbenchCommands must be used inside WorkbenchProvider");
  return ctx;
}

export function useWorkbench() {
  return {
    state: useWorkbenchState(),
    dispatch: useWorkbenchDispatch(),
    commands: useWorkbenchCommands(),
  };
}

// ── Provider ─────────────────────────────────────────────────

interface WorkbenchProviderProps {
  projectId: string;
  children: ReactNode;
}

export function WorkbenchProvider({ projectId, children }: WorkbenchProviderProps) {
  const [state, dispatch] = useReducer(workbenchReducer, projectId, createInitialState);

  const stateRef = useRef(state);
  stateRef.current = state;

  // Undo/redo stacks
  const undoStackRef = useRef<Diagram[]>([]);
  const redoStackRef = useRef<Diagram[]>([]);
  const MAX_HISTORY = 50;

  // Part ID counters
  const prefixCountersRef = useRef<Record<string, number>>({});

  const generatePartId = useCallback((type: string, existingIds?: Set<string>): string => {
    const prefix = typeToPrefix(type);
    const counters = prefixCountersRef.current;
    counters[prefix] = (counters[prefix] || 0) + 1;
    let id = `${prefix}${counters[prefix]}`;
    if (existingIds) {
      while (existingIds.has(id)) {
        counters[prefix]++;
        id = `${prefix}${counters[prefix]}`;
      }
    }
    return id;
  }, []);

  const diagramToJson = useCallback((d: Diagram) => {
    return JSON.stringify(exportToWokwi(d), null, 2);
  }, []);

  const setDiagramAndJson = useCallback(
    (d: Diagram) => {
      dispatch({ type: "SET_DIAGRAM", diagram: d, diagramJson: diagramToJson(d) });
    },
    [diagramToJson],
  );

  const pushUndo = useCallback(() => {
    const current = stateRef.current.diagram;
    if (!current) return;
    undoStackRef.current.push(current);
    if (undoStackRef.current.length > MAX_HISTORY) undoStackRef.current.shift();
    redoStackRef.current = [];
    dispatch({ type: "SET_UNDO_STATE", canUndo: true, canRedo: false });
  }, []);

  const initPrefixCounters = useCallback((parts: DiagramPart[]) => {
    const counters = prefixCountersRef.current;
    for (const p of parts) {
      const match = p.id.match(/^([a-zA-Z_]+)(\d+)$/);
      if (match) {
        const prefix = match[1];
        const num = parseInt(match[2], 10);
        counters[prefix] = Math.max(counters[prefix] || 0, num);
      }
    }
  }, []);

  // ── Load project on mount ──────────────────────────────────

  const loadedRef = useRef(false);

  useEffect(() => {
    if (!projectId) return;

    fetchDiagram(projectId)
      .then((data) => {
        const parsed = parseDiagram(data.diagram);
        setDiagramAndJson(parsed);
        if (data.lastModified) dispatch({ type: "SET_SAVED", date: new Date(data.lastModified) });
        loadedRef.current = true;
        dispatch({ type: "SET_DIRTY", dirty: false });
        initPrefixCounters(parsed.parts);
      })
      .catch((err) => console.error("Failed to load diagram:", err));

    fetchSketch(projectId)
      .then((data) => {
        dispatch({ type: "SET_SKETCH", sketch: data.sketch || "" });
        dispatch({ type: "SET_PROJECT_FILES", files: data.files || [] });
      })
      .catch((err) => console.error("Failed to load sketch:", err));

    fetchPCB(projectId)
      .then((data) => dispatch({ type: "SET_PCB", pcbText: data?.pcbText ?? null }))
      .catch((err) => console.error("Failed to load PCB:", err));

    fetchLibraries(projectId)
      .then((text) => dispatch({ type: "SET_LIBRARIES", librariesTxt: text }))
      .catch((err) => console.error("Failed to load libraries:", err));

    fetchProjectSettings(projectId)
      .then((s) => dispatch({ type: "SET_PROJECT_SETTINGS", settings: s }))
      .catch((err) => console.error("Failed to load settings:", err));

    fetchStarStatus(projectId)
      .then((data) => dispatch({ type: "SET_STARRED", starred: data.starred }))
      .catch(() => {});
  }, [projectId, setDiagramAndJson, initPrefixCounters]);

  // ── Auto-detect MCUs ───────────────────────────────────────

  useEffect(() => {
    const { diagram, mcuTarget } = stateRef.current;
    if (!diagram) return;
    const mcus = findMCUs(diagram);
    dispatch({ type: "SET_MCU_OPTIONS", options: mcus.map((m) => ({ id: m.id, label: m.label })) });
    // Resolve the target locally: dispatch is async, so reading mcuTarget back
    // from state here is stale on first load and the board id would wrongly fall
    // back to "uno" (e.g. for an STM32 diagram, breaking the STM32 build path).
    let targetId = mcuTarget;
    if (!targetId || !mcus.find((m) => m.id === targetId)) {
      const simulatable = mcus.filter((m) => m.simulatable);
      targetId = simulatable[0]?.id || mcus[0]?.id;
      dispatch({ type: "SET_MCU_TARGET", target: targetId });
    }
    const target = mcus.find((m) => m.id === targetId);
    dispatch({ type: "SET_MCU_BOARD_ID", boardId: target?.boardId || "uno" });
  }, [state.diagram]);

  // ── Commands ───────────────────────────────────────────────

  const commands: WorkbenchCommands = useMemo(() => {
    const markDirty = () => {
      if (loadedRef.current) dispatch({ type: "SET_DIRTY", dirty: true });
    };

    const withUndo = (fn: (diagram: Diagram) => Diagram) => {
      pushUndo();
      const current = stateRef.current.diagram;
      if (!current) return;
      setDiagramAndJson(fn(current));
      markDirty();
    };

    return {
      saveProject: async () => {
        const s = stateRef.current;
        if (!s.projectId) return;
        const promises: Promise<void>[] = [
          saveDiagram(s.projectId, s.diagramJson),
          saveSketch(s.projectId, s.sketch, s.projectFiles),
        ];
        if (s.pcbText !== null) promises.push(savePCB(s.projectId, s.pcbText));
        if (s.librariesTxt) promises.push(saveLibraries(s.projectId, s.librariesTxt));
        await Promise.all(promises);
        dispatch({ type: "SET_SAVED", date: new Date() });
      },

      updateDiagram: (diagram: Diagram) => {
        setDiagramAndJson(diagram);
        markDirty();
      },

      updateDiagramFromJson: (json: string) => {
        dispatch({ type: "SET_DIAGRAM_JSON", diagramJson: json });
        markDirty();
      },

      updateCode: (code: string) => {
        dispatch({ type: "SET_SKETCH", sketch: code });
        markDirty();
      },

      updatePcb: (text: string) => {
        dispatch({ type: "SET_PCB", pcbText: text });
        markDirty();
      },

      addPart: (partType: string) => {
        const defaultAttrs: Record<string, Record<string, string>> = {
          "wokwi-led": { color: "red" },
          "wokwi-resistor": { value: "1000" },
          "wokwi-lcd1602": { pins: "i2c" },
          "wokwi-lcd2004": { pins: "i2c" },
        };
        pushUndo();
        const current = stateRef.current.diagram;
        if (!current) return;
        const existingIds = new Set(current.parts.map((p) => p.id));
        const id = generatePartId(partType, existingIds);
        const newPart: DiagramPart = {
          type: partType,
          id,
          top: 0,
          left: 0,
          attrs: defaultAttrs[partType] ?? {},
        };
        setDiagramAndJson(addPart(current, newPart));
        dispatch({ type: "SET_PLACING", partId: id });
        dispatch({ type: "SELECT_PART", partId: id });
        markDirty();
      },

      deletePart: (partId: string) => {
        withUndo((d) => removePart(d, partId));
        dispatch({ type: "SELECT_PART", partId: null });
      },

      movePart: (partId: string, top: number, left: number) => {
        withUndo((d) => movePart(d, partId, left, top));
      },

      rotatePart: (partId: string, angle: number) => {
        withUndo((d) => rotatePart(d, partId, angle));
      },

      duplicatePart: (partId: string) => {
        pushUndo();
        const current = stateRef.current.diagram;
        if (!current) return;
        const part = current.parts.find((p) => p.id === partId);
        if (!part) return;
        const existingIds = new Set(current.parts.map((p) => p.id));
        const newId = generatePartId(part.type, existingIds);
        setDiagramAndJson(duplicatePart(current, partId, newId));
        dispatch({ type: "SELECT_PART", partId: newId });
        markDirty();
      },

      setPartAttr: (partId: string, attr: string, value: string) => {
        pushUndo();
        const current = stateRef.current.diagram;
        if (!current) return;
        if (attr === "__value" || attr === "__footprint") {
          const field = attr === "__value" ? "value" : "footprint";
          setDiagramAndJson(setPartField(current, partId, field, value));
        } else {
          setDiagramAndJson(setPartAttr(current, partId, attr, value));
        }
        markDirty();
      },

      addConnection: (conn: DiagramConnection) => {
        withUndo((d) => addConnection(d, conn));
      },

      deleteConnection: (index: number) => {
        withUndo((d) => removeConnection(d, index));
      },

      updateConnection: (index: number, conn: DiagramConnection) => {
        withUndo((d) => updateConnection(d, index, conn));
      },

      setConnectionColor: (index: number, color: string) => {
        withUndo((d) => setConnectionColor(d, index, color));
      },

      selectPart: (partId: string | null) => {
        dispatch({ type: "SELECT_PART", partId });
      },

      finishPlacing: () => {
        dispatch({ type: "SET_PLACING", partId: null });
      },

      undo: () => {
        const prev = undoStackRef.current.pop();
        if (!prev) return;
        const current = stateRef.current.diagram;
        if (current) redoStackRef.current.push(current);
        setDiagramAndJson(prev);
        dispatch({
          type: "SET_UNDO_STATE",
          canUndo: undoStackRef.current.length > 0,
          canRedo: true,
        });
        dispatch({ type: "SET_DIRTY", dirty: true });
      },

      redo: () => {
        const next = redoStackRef.current.pop();
        if (!next) return;
        const current = stateRef.current.diagram;
        if (current) undoStackRef.current.push(current);
        setDiagramAndJson(next);
        dispatch({
          type: "SET_UNDO_STATE",
          canUndo: true,
          canRedo: redoStackRef.current.length > 0,
        });
        dispatch({ type: "SET_DIRTY", dirty: true });
      },

      toggleGrid: () => {
        dispatch({ type: "TOGGLE_GRID" });
      },

      addFile: (name: string) => {
        dispatch({ type: "ADD_FILE", name });
        markDirty();
      },

      deleteFile: (name: string) => {
        dispatch({ type: "DELETE_FILE", name });
        markDirty();
      },

      renameFile: (oldName: string, newName: string) => {
        dispatch({ type: "RENAME_FILE", oldName, newName });
        markDirty();
      },

      updateFileContent: (name: string, content: string) => {
        dispatch({ type: "UPDATE_FILE_CONTENT", name, content });
        markDirty();
      },

      updateLibraries: async (text: string) => {
        dispatch({ type: "SET_LIBRARIES", librariesTxt: text });
        markDirty();
        const pid = stateRef.current.projectId;
        if (pid) {
          try {
            await saveLibraries(pid, text);
          } catch (err) {
            console.error("Failed to save libraries:", err);
          }
        }
      },

      savePcb: async (text: string) => {
        const pid = stateRef.current.projectId;
        if (!pid) return;
        try {
          await savePCB(pid, text);
          dispatch({ type: "SET_PCB", pcbText: text });
        } catch (err) {
          console.error("PCB save error:", err);
        }
      },

      syncPcbFromDiagram: async () => {
        const s = stateRef.current;
        if (!s.diagram) return;
        const result = generatePCBFromDiagram(s.diagram, s.pcbText);
        for (const w of result.warnings) console.warn("[PCB]", w);
        dispatch({ type: "SET_PCB", pcbText: result.pcbText });
        if (s.projectId) {
          await savePCB(s.projectId, result.pcbText);
        }
      },

      importProject: (json: unknown) => {
        const imported = importWokwi(json);
        setDiagramAndJson(imported);
        markDirty();
        initPrefixCounters(imported.parts);
      },

      exportProject: () => {
        const s = stateRef.current;
        if (!s.diagram) return;
        const wokwi = exportToWokwi(s.diagram);
        const json = JSON.stringify(wokwi, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "diagram.json";
        a.click();
        URL.revokeObjectURL(url);
      },

      downloadZip: async () => {
        const s = stateRef.current;
        const JSZip = (await import("jszip")).default;
        const zip = new JSZip();
        zip.file("diagram.json", s.diagramJson);
        zip.file("sketch.ino", s.sketch);
        for (const f of s.projectFiles) zip.file(f.name, f.content);
        if (s.pcbText) zip.file("board.kicad_pcb", s.pcbText);
        if (s.librariesTxt) zip.file("libraries.txt", s.librariesTxt);
        const blob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${s.projectId}.zip`;
        a.click();
        URL.revokeObjectURL(url);
      },

      copyProject: async () => {
        const pid = stateRef.current.projectId;
        if (!pid) return;
        const res = await fetch("/api/projects/copy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceId: pid }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { id: newId } = await res.json();
        window.location.href = `/projects/${newId}`;
      },

      reloadProject: () => {
        const pid = stateRef.current.projectId;
        if (!pid) return;
        fetchDiagram(pid)
          .then((data) => setDiagramAndJson(parseDiagram(data.diagram)))
          .catch((err) => console.error("Failed to reload diagram:", err));
        fetchSketch(pid)
          .then((data) => {
            dispatch({ type: "SET_SKETCH", sketch: data.sketch || "" });
            dispatch({ type: "SET_PROJECT_FILES", files: data.files || [] });
          })
          .catch((err) => console.error("Failed to reload sketch:", err));
        fetchPCB(pid)
          .then((data) => dispatch({ type: "SET_PCB", pcbText: data?.pcbText ?? null }))
          .catch((err) => console.error("Failed to reload PCB:", err));
        fetchLibraries(pid)
          .then((text) => dispatch({ type: "SET_LIBRARIES", librariesTxt: text }))
          .catch((err) => console.error("Failed to reload libraries:", err));
      },

      toggleSparky: () => {
        dispatch({ type: "SET_SPARKY_OPEN", open: !stateRef.current.sparkyOpen });
      },

      setSparkyMessage: (message: string | null) => {
        dispatch({ type: "SET_SPARKY_MESSAGE", message });
      },
    };
  }, [pushUndo, setDiagramAndJson, generatePartId, initPrefixCounters]);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        <CommandsContext.Provider value={commands}>{children}</CommandsContext.Provider>
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}
