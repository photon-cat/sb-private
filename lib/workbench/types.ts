import type { Diagram, DiagramPart, DiagramConnection, MCUInfo } from "../diagram-parser";
import type { AVRRunner } from "../avr-runner";
import type { AVRDebugRunner } from "../avr-debug-runner";
import type { SimulationStatus, UseSimulationReturn } from "@/hooks/useSimulation";
import type { CustomChipConfig, CustomChipRuntime } from "../chip-runtime";
import type { ProjectSettings } from "../api";
import type { FileSnapshot } from "@/components/SparkyChat";

export interface WorkbenchDocument {
  diagram: Diagram | null;
  diagramJson: string;
  sketch: string;
  pcbText: string | null;
  librariesTxt: string;
  projectFiles: { name: string; content: string }[];
}

export interface WorkbenchUIState {
  selectedPartId: string | null;
  placingPartId: string | null;
  showGrid: boolean;
  sparkyOpen: boolean;
  sparkyInitialMessage: string | null;
  chatWidth: number;
  dirty: boolean;
  lastSaved: Date | null;
}

export interface WorkbenchMCUState {
  mcuTarget: string | undefined;
  mcuOptions: { id: string; label: string }[];
  mcuBoardId: string;
  debugMode: boolean;
}

export interface WorkbenchProjectMeta {
  projectId: string;
  settings: ProjectSettings | null;
  starred: boolean;
}

export interface WorkbenchUndoState {
  canUndo: boolean;
  canRedo: boolean;
}

export interface WorkbenchPendingReview {
  pendingReview: FileSnapshot | null;
}

export interface WorkbenchState
  extends WorkbenchDocument,
    WorkbenchUIState,
    WorkbenchMCUState,
    WorkbenchProjectMeta,
    WorkbenchUndoState,
    WorkbenchPendingReview {}

export type WorkbenchAction =
  | { type: "SET_DIAGRAM"; diagram: Diagram; diagramJson: string }
  | { type: "SET_DIAGRAM_JSON"; diagramJson: string; diagram?: Diagram }
  | { type: "SET_SKETCH"; sketch: string }
  | { type: "SET_PCB"; pcbText: string | null }
  | { type: "SET_LIBRARIES"; librariesTxt: string }
  | { type: "SET_PROJECT_FILES"; files: { name: string; content: string }[] }
  | { type: "ADD_FILE"; name: string }
  | { type: "DELETE_FILE"; name: string }
  | { type: "RENAME_FILE"; oldName: string; newName: string }
  | { type: "UPDATE_FILE_CONTENT"; name: string; content: string }
  | { type: "SELECT_PART"; partId: string | null }
  | { type: "SET_PLACING"; partId: string | null }
  | { type: "TOGGLE_GRID" }
  | { type: "SET_GRID"; show: boolean }
  | { type: "SET_SPARKY_OPEN"; open: boolean }
  | { type: "SET_SPARKY_MESSAGE"; message: string | null }
  | { type: "SET_CHAT_WIDTH"; width: number }
  | { type: "SET_DIRTY"; dirty: boolean }
  | { type: "SET_SAVED"; date: Date }
  | { type: "SET_MCU_TARGET"; target: string | undefined }
  | { type: "SET_MCU_OPTIONS"; options: { id: string; label: string }[] }
  | { type: "SET_MCU_BOARD_ID"; boardId: string }
  | { type: "SET_DEBUG_MODE"; debug: boolean }
  | { type: "SET_PROJECT_SETTINGS"; settings: ProjectSettings | null }
  | { type: "SET_STARRED"; starred: boolean }
  | { type: "SET_UNDO_STATE"; canUndo: boolean; canRedo: boolean }
  | { type: "SET_PENDING_REVIEW"; review: FileSnapshot | null }
  | { type: "LOAD_PROJECT"; doc: WorkbenchDocument };

export interface WorkbenchCommands {
  saveProject: () => Promise<void>;
  updateDiagram: (diagram: Diagram) => void;
  updateDiagramFromJson: (json: string) => void;
  updateCode: (code: string) => void;
  updatePcb: (text: string) => void;
  addPart: (partType: string) => void;
  deletePart: (partId: string) => void;
  movePart: (partId: string, top: number, left: number) => void;
  rotatePart: (partId: string, angle: number) => void;
  duplicatePart: (partId: string) => void;
  setPartAttr: (partId: string, attr: string, value: string) => void;
  addConnection: (conn: DiagramConnection) => void;
  deleteConnection: (index: number) => void;
  updateConnection: (index: number, conn: DiagramConnection) => void;
  setConnectionColor: (index: number, color: string) => void;
  selectPart: (partId: string | null) => void;
  finishPlacing: () => void;
  undo: () => void;
  redo: () => void;
  toggleGrid: () => void;
  addFile: (name: string) => void;
  deleteFile: (name: string) => void;
  renameFile: (oldName: string, newName: string) => void;
  updateFileContent: (name: string, content: string) => void;
  updateLibraries: (text: string) => Promise<void>;
  savePcb: (text: string) => Promise<void>;
  syncPcbFromDiagram: () => Promise<void>;
  importProject: (json: unknown) => void;
  exportProject: () => void;
  downloadZip: () => Promise<void>;
  copyProject: () => Promise<void>;
  reloadProject: () => void;
  toggleSparky: () => void;
  setSparkyMessage: (message: string | null) => void;
}
