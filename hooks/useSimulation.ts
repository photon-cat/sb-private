"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { Diagram } from "@/lib/diagram-parser";
import type { SimRunner } from "@/lib/sim/sim-runner";
import { buildProject, compileChip } from "@/lib/api";
import { findChipFiles } from "@/lib/chip-json";
import type { CustomChipConfig, CustomChipRuntime } from "@/lib/chip-runtime";

export type SimulationStatus = "idle" | "compiling" | "running" | "paused" | "error" | "compiled";

export interface UseSimulationOptions {
  projectId: string;
  diagram: Diagram | null;
  sketchCode: string;
  projectFiles: { name: string; content: string }[];
  board?: string;
  librariesTxt?: string;
}

export interface UseSimulationReturn {
  status: SimulationStatus;
  serialOutput: string;
  runner: SimRunner | null;
  firmwareBin: string | null;   // base64 .bin for ESP32 download
  firmwareName: string | null;  // "firmware.bin" or "firmware.hex"
  firmwareHex: string | null;   // raw Intel HEX string for AVR flashing
  chipConfigs: Map<string, CustomChipConfig> | null; // compiled custom chips
  chipRuntimes: Map<string, CustomChipRuntime>;      // live chip runtime instances (for setAttr, etc.)
  setChipRuntimes: (runtimes: Map<string, CustomChipRuntime>) => void;
  handleStart: () => Promise<void>;
  handleStop: () => void;
  handlePause: () => void;
  handleResume: () => void;
  handleRestart: () => void;
}

export function useSimulation({
  projectId,
  diagram,
  sketchCode,
  projectFiles,
  board,
  librariesTxt,
}: UseSimulationOptions): UseSimulationReturn {
  const [status, setStatus] = useState<SimulationStatus>("idle");
  const [serialOutput, setSerialOutput] = useState("");
  const [runner, setRunner] = useState<SimRunner | null>(null);
  const [firmwareBin, setFirmwareBin] = useState<string | null>(null);
  const [firmwareName, setFirmwareName] = useState<string | null>(null);
  const [firmwareHex, setFirmwareHex] = useState<string | null>(null);
  const [chipConfigs, setChipConfigs] = useState<Map<string, CustomChipConfig> | null>(null);
  const [chipRuntimes, setChipRuntimes] = useState<Map<string, CustomChipRuntime>>(new Map());
  const runnerRef = useRef<SimRunner | null>(null);

  const handleStart = useCallback(async () => {
    if (!diagram) return;

    setStatus("compiling");
    setSerialOutput("");

    try {
      const buildResult = await buildProject(projectId, sketchCode, projectFiles, board || "uno", librariesTxt || "");

      if (!buildResult.success) {
        setStatus("error");
        let errMsg = `Build error: ${buildResult.error}\n`;
        if (buildResult.stderr) errMsg += `\n${buildResult.stderr}\n`;
        setSerialOutput(errMsg);
        return;
      }

      // STM32 in-browser cores: cortex-m0 (G0/C0/L0) or unicorn-arm (F1/F4/…).
      // The .bin runs on the matching engine; serial + GPIO bridge to the UI.
      if (
        (buildResult.simCore === "unicorn-arm" || buildResult.simCore === "cortex-m0") &&
        buildResult.bin
      ) {
        const { createStm32Runner, decodeFirmwareBin } = await import(
          "@/lib/sim/create-stm32-runner"
        );
        if (runnerRef.current) runnerRef.current.stop();
        const fw = decodeFirmwareBin(buildResult.bin);
        const stm = await createStm32Runner(buildResult.simCore, fw);
        stm.onSerialByte = (byte: number) =>
          setSerialOutput((prev) => prev + String.fromCharCode(byte));
        runnerRef.current = stm;
        setFirmwareBin(buildResult.bin);
        setFirmwareName(buildResult.firmware || "firmware.bin");
        needsStartRef.current = true;
        setRunner(stm);
        setStatus("running");
        return;
      }

      // ESP32 / non-simulatable: compile-only, offer download
      if (buildResult.simulatable === false) {
        setFirmwareBin(buildResult.bin || null);
        setFirmwareName(buildResult.firmware || "firmware.bin");
        setStatus("compiled");
        setSerialOutput("Build successful! Simulation is not available for this board.\nUse the download button to get the firmware binary.\n");
        return;
      }

      // Store hex for flashing via Web Serial
      setFirmwareHex(buildResult.hex || null);

      // Compile custom chips (if any .chip.json + .chip.c pairs exist)
      const chipFiles = findChipFiles(projectFiles);
      if (chipFiles.length > 0) {
        const configs = new Map<string, CustomChipConfig>();
        for (const chip of chipFiles) {
          const result = await compileChip(projectId, chip.chipName, chip.source);
          if (!result.success) {
            setStatus("error");
            setSerialOutput(`Chip compile error (${chip.chipName}): ${result.error}\n`);
            return;
          }
          const wasmBytes = Uint8Array.from(atob(result.wasm!), (c) => c.charCodeAt(0)).buffer;
          // Map by part ID — find the matching part in the diagram
          const matchingPart = diagram.parts.find((p) => p.type === chip.partType);
          if (matchingPart) {
            configs.set(matchingPart.id, { chipJson: chip.chipJson, wasmBytes });
          }
        }
        setChipConfigs(configs.size > 0 ? configs : null);
      } else {
        setChipConfigs(null);
      }

      const { AVRRunner } = await import("@/lib/avr-runner");

      if (runnerRef.current) {
        runnerRef.current.stop();
      }

      const newRunner = new AVRRunner(buildResult.hex);
      runnerRef.current = newRunner;

      newRunner.usart.onByteTransmit = (byte: number) => {
        setSerialOutput((prev) => prev + String.fromCharCode(byte));
      };

      needsStartRef.current = true;
      setRunner(newRunner);
      setStatus("running");
    } catch (err) {
      setStatus("error");
      const msg = err instanceof Error ? err.message : String(err);
      setSerialOutput(`Error: ${msg}\n`);
    }
  }, [diagram, sketchCode, projectId, projectFiles, board, librariesTxt]);

  // Start execution after React renders and child effects (wiring) complete.
  // React runs child useEffects before parent useEffects, so DiagramCanvas's
  // wireComponents() will have run before this effect fires.
  const needsStartRef = useRef(false);
  useEffect(() => {
    if (!runner || !needsStartRef.current) return;
    needsStartRef.current = false;
    runner.execute?.(() => {});
  }, [runner]);

  const handleStop = useCallback(() => {
    if (runnerRef.current) {
      runnerRef.current.stop();
      runnerRef.current = null;
    }
    setRunner(null);
    setStatus("idle");
  }, []);

  const handlePause = useCallback(() => {
    if (runnerRef.current) {
      runnerRef.current.stop();
    }
    setStatus("paused");
  }, []);

  const handleResume = useCallback(() => {
    if (runnerRef.current) {
      runnerRef.current.resume?.();
      runnerRef.current.execute?.(() => {});
    }
    setStatus("running");
  }, []);

  const handleRestart = useCallback(() => {
    if (runnerRef.current) {
      runnerRef.current.stop();
      runnerRef.current = null;
    }
    setRunner(null);
    setStatus("idle");
    setTimeout(() => handleStart(), 0);
  }, [handleStart]);

  return {
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
  };
}
