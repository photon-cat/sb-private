"use client";

import { useCallback, useEffect, useRef, useMemo } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import Toolbar from "@/components/Toolbar";
import EditorPanel from "@/components/EditorPanel";
import SimulationPanel from "@/components/SimulationPanel";
import SparkyChat, { type FileSnapshot } from "@/components/SparkyChat";
import { useWorkbench } from "@/lib/workbench";
import { useSimulation } from "@/hooks/useSimulation";
import { useDebugger } from "@/hooks/useDebugger";
import { parseDiagram } from "@/lib/diagram-parser";
import {
  updateProjectSettings,
  deleteProject,
  toggleStar,
  saveDiagram,
  saveSketch,
  savePCB,
  saveLibraries,
} from "@/lib/api";
import wbStyles from "@/components/Workbench.module.css";

const SplitPane = dynamic(() => import("@/components/SplitPane"), { ssr: false });

export default function WorkbenchShell() {
  const { state, dispatch, commands } = useWorkbench();
  const router = useRouter();

  const {
    projectId,
    diagram,
    diagramJson,
    sketch,
    pcbText,
    projectFiles,
    librariesTxt,
    selectedPartId,
    placingPartId,
    showGrid,
    sparkyOpen,
    sparkyInitialMessage,
    chatWidth,
    dirty,
    lastSaved,
    mcuTarget,
    mcuOptions,
    mcuBoardId,
    debugMode,
    settings: projectSettings,
    starred,
    canUndo,
    canRedo,
    pendingReview,
  } = state;

  // ── Simulation ─────────────────────────────────────────────

  const {
    status,
    serialOutput,
    runner,
    firmwareBin,
    firmwareName,
    firmwareHex,
    chipConfigs,
    chipRuntimes,
    setChipRuntimes,
    handleStart,
    handleStop,
    handlePause,
    handleResume,
    handleRestart,
  } = useSimulation({
    projectId,
    diagram,
    sketchCode: sketch,
    projectFiles,
    board: mcuBoardId,
    librariesTxt,
  });

  // ── Debug ──────────────────────────────────────────────────

  const debugState = useDebugger({
    projectId,
    diagram,
    sketchCode: sketch,
    projectFiles,
    board: mcuBoardId,
    librariesTxt,
  });

  const handleStartDebug = useCallback(() => {
    if (status !== "idle") handleStop();
    dispatch({ type: "SET_DEBUG_MODE", debug: true });
    debugState.handleStartDebug();
  }, [status, handleStop, debugState, dispatch]);

  const handleDebugStop = useCallback(() => {
    debugState.handleStop();
    dispatch({ type: "SET_DEBUG_MODE", debug: false });
  }, [debugState, dispatch]);

  const activeRunner = debugMode && debugState.debugRunner ? debugState.debugRunner : runner;
  const activeStatus = debugMode ? debugState.status : status;

  const breakpointLines = useMemo(() => {
    if (!debugMode || !debugState?.sourceMap || !debugState?.breakpoints) return undefined;
    const lines = new Set<number>();
    for (const entry of debugState.sourceMap) {
      if (entry.file === "main.cpp" && debugState.breakpoints.has(entry.address)) {
        lines.add(entry.line - 1);
      }
    }
    return lines.size > 0 ? lines : undefined;
  }, [debugMode, debugState?.sourceMap, debugState?.breakpoints]);

  const currentDebugLine = useMemo(() => {
    if (!debugMode || !debugState?.sourceMap || debugState.status === "idle") return null;
    const pc = debugState.pc;
    const entry = debugState.sourceMap.find((e) => e.file === "main.cpp" && e.address === pc);
    return entry ? entry.line - 1 : null;
  }, [debugMode, debugState?.sourceMap, debugState?.pc, debugState?.status]);

  // ── Chat resize ────────────────────────────────────────────

  const dividerRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handleDividerDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dividerRef.current = { startX: e.clientX, startWidth: chatWidth };
      const div = e.currentTarget as HTMLElement;
      div.classList.add(wbStyles.chatDividerActive);
      const onMove = (ev: MouseEvent) => {
        if (!dividerRef.current) return;
        const delta = dividerRef.current.startX - ev.clientX;
        dispatch({
          type: "SET_CHAT_WIDTH",
          width: Math.min(Math.max(dividerRef.current.startWidth + delta, 280), 700),
        });
      };
      const onUp = () => {
        dividerRef.current = null;
        div.classList.remove(wbStyles.chatDividerActive);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [chatWidth, dispatch],
  );

  // ── Keyboard shortcuts ─────────────────────────────────────

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (el.isContentEditable || el.closest(".monaco-editor")) return;

      if (debugMode) {
        if (e.key === "F5") {
          e.preventDefault();
          if (debugState.status === "paused") debugState.handleRun();
          else if (debugState.status === "running") debugState.handlePause();
          return;
        }
        if (e.key === "F10") { e.preventDefault(); debugState.handleStep(); return; }
        if (e.key === "F11") { e.preventDefault(); debugState.handleStepOver(); return; }
        if (e.key === "F9") { e.preventDefault(); debugState.handleReset(); return; }
        if (e.key === "Escape") { e.preventDefault(); handleDebugStop(); return; }
      }

      if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (e.shiftKey) commands.redo();
        else commands.undo();
        return;
      }
      if ((e.key === "y" || e.key === "Y") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        commands.redo();
        return;
      }
      if ((e.key === "g" || e.key === "G") && !e.ctrlKey && !e.metaKey) {
        commands.toggleGrid();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [commands, debugMode, debugState, handleDebugStop]);

  // ── Debug with Sparky event ────────────────────────────────

  useEffect(() => {
    const handler = (e: Event) => {
      const errorText = (e as CustomEvent).detail as string;
      commands.setSparkyMessage(`Debug this build error:\n\n${errorText}`);
      dispatch({ type: "SET_SPARKY_OPEN", open: true });
    };
    window.addEventListener("sparkbench:debug-with-sparky", handler);
    return () => window.removeEventListener("sparkbench:debug-with-sparky", handler);
  }, [commands, dispatch]);

  // ── Clipboard ──────────────────────────────────────────────
  // (kept in shell for now — will extract to useSchematicClipboard later)

  // ── Project settings handlers ──────────────────────────────

  const handleToggleVisibility = useCallback(async () => {
    if (!projectSettings?.isOwner) return;
    const newValue = !projectSettings.isPublic;
    await updateProjectSettings(projectId, { isPublic: newValue });
    dispatch({
      type: "SET_PROJECT_SETTINGS",
      settings: { ...projectSettings, isPublic: newValue },
    });
  }, [projectId, projectSettings, dispatch]);

  const handleRenameProject = useCallback(
    async (newName: string) => {
      if (!projectSettings?.isOwner) return;
      await updateProjectSettings(projectId, { title: newName });
      dispatch({
        type: "SET_PROJECT_SETTINGS",
        settings: { ...projectSettings, title: newName },
      });
    },
    [projectId, projectSettings, dispatch],
  );

  const handleDeleteProject = useCallback(async () => {
    const result = await deleteProject(projectId);
    if (result.error) return;
    router.push("/dashboard/projects");
  }, [projectId, router]);

  const handleToggleStar = useCallback(async () => {
    const result = await toggleStar(projectId);
    dispatch({ type: "SET_STARRED", starred: result.starred });
  }, [projectId, dispatch]);

  // ── Sparky agent handlers ──────────────────────────────────

  const handleChangesReady = useCallback(
    (snapshot: FileSnapshot) => {
      dispatch({ type: "SET_PENDING_REVIEW", review: snapshot });
      commands.reloadProject();
    },
    [commands, dispatch],
  );

  const handleAcceptChanges = useCallback(() => {
    dispatch({ type: "SET_PENDING_REVIEW", review: null });
    dispatch({ type: "SET_DIRTY", dirty: true });
  }, [dispatch]);

  const handleRevertChanges = useCallback(
    async (snapshot: FileSnapshot) => {
      await Promise.all([
        saveDiagram(projectId, snapshot.diagram),
        saveSketch(projectId, snapshot.sketch, snapshot.files),
        ...(snapshot.pcb !== null ? [savePCB(projectId, snapshot.pcb)] : []),
        ...(snapshot.libraries ? [saveLibraries(projectId, snapshot.libraries)] : []),
      ]);
      dispatch({
        type: "LOAD_PROJECT",
        doc: {
          diagram: parseDiagram(JSON.parse(snapshot.diagram)),
          diagramJson: snapshot.diagram,
          sketch: snapshot.sketch,
          pcbText: snapshot.pcb,
          librariesTxt: snapshot.libraries,
          projectFiles: snapshot.files,
        },
      });
      dispatch({ type: "SET_PENDING_REVIEW", review: null });
    },
    [projectId, dispatch],
  );

  const currentSnapshot: FileSnapshot = {
    diagram: diagramJson,
    sketch,
    pcb: pcbText,
    libraries: librariesTxt,
    files: projectFiles,
  };

  const isOwner = projectSettings?.isOwner ?? false;
  const isPublic = projectSettings?.isPublic ?? true;

  // ── Render ─────────────────────────────────────────────────

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <Toolbar
        projectName={projectSettings?.title || projectSettings?.slug || projectId}
        onSave={isOwner ? commands.saveProject : undefined}
        onImportWokwi={isOwner ? commands.importProject : undefined}
        onExportWokwi={commands.exportProject}
        onDownloadZip={commands.downloadZip}
        onCopyProject={commands.copyProject}
        lastSaved={lastSaved}
        dirty={dirty}
        sparkyOpen={sparkyOpen}
        onSparkyToggle={commands.toggleSparky}
        isPublic={isPublic}
        isOwner={isOwner}
        onToggleVisibility={handleToggleVisibility}
        ownerUsername={projectSettings?.ownerUsername}
        onRenameProject={isOwner ? handleRenameProject : undefined}
        onDeleteProject={isOwner ? handleDeleteProject : undefined}
        starred={starred}
        onToggleStar={handleToggleStar}
      />
      <div className={wbStyles.workbench}>
        <div className={wbStyles.mainRow}>
          <div className={wbStyles.splitContainer}>
            <SplitPane
              left={
                <EditorPanel
                  sketchCode={sketch}
                  diagramJson={diagramJson}
                  pcbText={pcbText}
                  projectFiles={projectFiles}
                  onSketchChange={commands.updateCode}
                  onDiagramChange={commands.updateDiagramFromJson}
                  onPcbChange={commands.updatePcb}
                  onAddFile={commands.addFile}
                  onDeleteFile={commands.deleteFile}
                  onRenameFile={commands.renameFile}
                  onFileContentChange={commands.updateFileContent}
                  librariesTxt={librariesTxt}
                  onLibrariesChange={commands.updateLibraries}
                  debugMode={debugMode}
                  breakpointLines={breakpointLines}
                  currentDebugLine={currentDebugLine}
                  onToggleBreakpointLine={debugState?.handleToggleBreakpointLine}
                />
              }
              right={
                <SimulationPanel
                  diagram={diagram}
                  runner={activeRunner}
                  status={activeStatus}
                  serialOutput={debugMode ? debugState.serialOutput : serialOutput}
                  pcbText={pcbText}
                  firmwareBin={firmwareBin}
                  firmwareName={firmwareName}
                  firmwareHex={firmwareHex}
                  chipConfigs={chipConfigs}
                  chipRuntimes={chipRuntimes}
                  onChipRuntimesReady={setChipRuntimes}
                  projectFiles={projectFiles}
                  onPcbSave={commands.savePcb}
                  onStart={handleStart}
                  onStop={handleStop}
                  onPause={handlePause}
                  onResume={handleResume}
                  onRestart={handleRestart}
                  onAddPart={commands.addPart}
                  onPartMove={commands.movePart}
                  onAddConnection={commands.addConnection}
                  onUpdateConnection={commands.updateConnection}
                  onDeleteConnection={commands.deleteConnection}
                  onWireColorChange={commands.setConnectionColor}
                  selectedPartId={selectedPartId}
                  onPartSelect={commands.selectPart}
                  onDeletePart={commands.deletePart}
                  onPartRotate={commands.rotatePart}
                  onDuplicatePart={commands.duplicatePart}
                  onPartAttrChange={commands.setPartAttr}
                  placingPartId={placingPartId}
                  onFinishPlacing={commands.finishPlacing}
                  showGrid={showGrid}
                  onUndo={commands.undo}
                  onRedo={commands.redo}
                  canUndo={canUndo}
                  canRedo={canRedo}
                  onToggleGrid={commands.toggleGrid}
                  onUpdateFromDiagram={commands.syncPcbFromDiagram}
                  onSaveOutline={async (svgText: string) => {
                    commands.updateFileContent("outline.svg", svgText);
                    // Add outline.svg if it doesn't exist
                    if (!projectFiles.find((f) => f.name === "outline.svg")) {
                      commands.addFile("outline.svg");
                      // Immediately set its content since addFile creates empty
                      commands.updateFileContent("outline.svg", svgText);
                    }
                  }}
                  mcuId={mcuTarget}
                  mcuOptions={mcuOptions}
                  onMcuChange={(target) => dispatch({ type: "SET_MCU_TARGET", target })}
                  board={mcuBoardId}
                  librariesTxt={librariesTxt}
                  onLibrariesChange={commands.updateLibraries}
                  projectId={projectId}
                  debugMode={debugMode}
                  debugState={debugMode ? { ...debugState, handleStop: handleDebugStop } : null}
                  onStartDebug={handleStartDebug}
                />
              }
            />
          </div>
          {!!sparkyOpen && projectId && (
            <>
              <div className={wbStyles.chatDivider} onMouseDown={handleDividerDown} />
              <div className={wbStyles.chatSidePanel} style={{ width: chatWidth }}>
                <SparkyChat
                  open={!!sparkyOpen}
                  onToggle={commands.toggleSparky}
                  projectId={projectId}
                  diagramJson={diagramJson}
                  sketchCode={sketch}
                  pcbText={pcbText}
                  librariesTxt={librariesTxt || ""}
                  projectFiles={projectFiles}
                  onProjectChanged={commands.reloadProject}
                  onChangesReady={handleChangesReady}
                  onRevertChanges={handleRevertChanges}
                  onAcceptChanges={handleAcceptChanges}
                  onSimStart={handleStart}
                  onSimStop={handleStop}
                  onUpdatePCB={commands.syncPcbFromDiagram}
                  pendingReview={pendingReview}
                  currentSnapshot={pendingReview ? currentSnapshot : null}
                  initialMessage={sparkyInitialMessage}
                  onInitialMessageConsumed={() => commands.setSparkyMessage(null)}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
