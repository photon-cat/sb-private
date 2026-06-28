import type { WorkbenchState, WorkbenchAction } from "./types";
import { parseDiagram } from "../diagram-parser";

export function workbenchReducer(
  state: WorkbenchState,
  action: WorkbenchAction,
): WorkbenchState {
  switch (action.type) {
    case "SET_DIAGRAM":
      return { ...state, diagram: action.diagram, diagramJson: action.diagramJson };

    case "SET_DIAGRAM_JSON": {
      let diagram = state.diagram;
      if (action.diagram) {
        diagram = action.diagram;
      } else {
        try {
          diagram = parseDiagram(JSON.parse(action.diagramJson));
        } catch {
          // invalid JSON while user typing — keep old diagram
        }
      }
      return { ...state, diagramJson: action.diagramJson, diagram };
    }

    case "SET_SKETCH":
      return { ...state, sketch: action.sketch };

    case "SET_PCB":
      return { ...state, pcbText: action.pcbText };

    case "SET_LIBRARIES":
      return { ...state, librariesTxt: action.librariesTxt };

    case "SET_PROJECT_FILES":
      return { ...state, projectFiles: action.files };

    case "ADD_FILE":
      return {
        ...state,
        projectFiles: [...state.projectFiles, { name: action.name, content: "" }],
      };

    case "DELETE_FILE":
      return {
        ...state,
        projectFiles: state.projectFiles.filter((f) => f.name !== action.name),
      };

    case "RENAME_FILE":
      return {
        ...state,
        projectFiles: state.projectFiles.map((f) =>
          f.name === action.oldName ? { ...f, name: action.newName } : f,
        ),
      };

    case "UPDATE_FILE_CONTENT":
      return {
        ...state,
        projectFiles: state.projectFiles.map((f) =>
          f.name === action.name ? { ...f, content: action.content } : f,
        ),
      };

    case "SELECT_PART":
      return { ...state, selectedPartId: action.partId };

    case "SET_PLACING":
      return { ...state, placingPartId: action.partId };

    case "TOGGLE_GRID":
      return { ...state, showGrid: !state.showGrid };

    case "SET_GRID":
      return { ...state, showGrid: action.show };

    case "SET_SPARKY_OPEN":
      return { ...state, sparkyOpen: action.open };

    case "SET_SPARKY_MESSAGE":
      return { ...state, sparkyInitialMessage: action.message };

    case "SET_CHAT_WIDTH":
      return { ...state, chatWidth: action.width };

    case "SET_DIRTY":
      return { ...state, dirty: action.dirty };

    case "SET_SAVED":
      return { ...state, lastSaved: action.date, dirty: false };

    case "SET_MCU_TARGET":
      return { ...state, mcuTarget: action.target };

    case "SET_MCU_OPTIONS":
      return { ...state, mcuOptions: action.options };

    case "SET_MCU_BOARD_ID":
      return { ...state, mcuBoardId: action.boardId };

    case "SET_DEBUG_MODE":
      return { ...state, debugMode: action.debug };

    case "SET_PROJECT_SETTINGS":
      return { ...state, settings: action.settings };

    case "SET_STARRED":
      return { ...state, starred: action.starred };

    case "SET_UNDO_STATE":
      return { ...state, canUndo: action.canUndo, canRedo: action.canRedo };

    case "SET_PENDING_REVIEW":
      return { ...state, pendingReview: action.review };

    case "LOAD_PROJECT":
      return {
        ...state,
        diagram: action.doc.diagram,
        diagramJson: action.doc.diagramJson,
        sketch: action.doc.sketch,
        pcbText: action.doc.pcbText,
        librariesTxt: action.doc.librariesTxt,
        projectFiles: action.doc.projectFiles,
        dirty: false,
      };

    default:
      return state;
  }
}

export function createInitialState(projectId: string): WorkbenchState {
  return {
    // Document
    diagram: null,
    diagramJson: "",
    sketch: "",
    pcbText: null,
    librariesTxt: "",
    projectFiles: [],
    // UI
    selectedPartId: null,
    placingPartId: null,
    showGrid: true,
    sparkyOpen: false,
    sparkyInitialMessage: null,
    chatWidth: 400,
    dirty: false,
    lastSaved: null,
    // MCU
    mcuTarget: undefined,
    mcuOptions: [],
    mcuBoardId: "uno",
    debugMode: false,
    // Project
    projectId,
    settings: null,
    starred: false,
    // Undo
    canUndo: false,
    canRedo: false,
    // Review
    pendingReview: null,
  };
}
