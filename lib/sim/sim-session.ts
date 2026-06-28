/**
 * A long-lived SparkBench simulation session.
 *
 * `SimSession` owns one compiled project running on a {@link HeadlessMcu}, so an
 * external driver (the MCP server, a REPL, a test) can step it imperatively:
 * run a few ms, inspect serial/pins/displays, drive a control, run more. It is
 * multi-MCU from the start — AVR, STM32 and RP2040 all flow through the same
 * `HeadlessMcu` adapter, so a session behaves identically regardless of board.
 *
 * The heavy lifting (project load → firmware/chip build → wiring) happens once
 * in {@link SimSession.load}; {@link SimSession.restart} re-wires from the
 * already-built firmware without recompiling.
 */

import path from "path";
import os from "os";
import { mkdirSync, rmSync } from "fs";
import { loadProject, type ProjectFiles } from "./project-loader";
import { buildFirmware, buildChips } from "./firmware-builder";
import { createHeadlessMcu, type HeadlessMcu } from "./headless-mcu";
import { applyControl, type ControlResult } from "./controls";
import { findPartConnections } from "../wire-components";
import type { SimCore } from "./sim-core";
import type { CustomChipConfig } from "../chip-runtime";
import type { MCUInfo } from "../diagram-parser";
import {
  encodeSsd1306Png,
  encodeLcd1602Png,
  encodeFramebufferPng,
} from "../display-renderer";

export type SessionStatus = "idle" | "running" | "stopped" | "error";

/** Decoded display contents, tagged by controller kind. */
export type DisplayBuffer =
  | { type: "ssd1306"; width: number; height: number; gddram: Uint8Array }
  | {
      type: "lcd1602";
      cols: number;
      rows: number;
      characters: Uint8Array;
      backlight: boolean;
    }
  | {
      type: "framebuffer";
      source: "ili9341" | "chip";
      width: number;
      height: number;
      pixels: Uint8Array;
    };

export interface PartInfo {
  id: string;
  type: string;
}

export interface SimSessionStatus {
  status: SessionStatus;
  simCore: SimCore | null;
  board: string;
  clockHz: number;
  cycles: number;
  timeMs: number;
  serialBytes: number;
  parts: PartInfo[];
}

export interface RunResult {
  cyclesRun: number;
  timeMs: number;
  serialAppended: string;
}

export interface SimSessionLoadOptions {
  /** Project directory containing diagram.json + sketch.ino. */
  projectDir?: string;
  /** Alternative to projectDir: project slug under projectsRoot. */
  slug?: string;
  projectsRoot?: string;
  quiet?: boolean;
  clockHz?: number;
  /**
   * Skip the PlatformIO build by supplying firmware directly. Used by tests and
   * any caller that already has a compiled artifact.
   */
  prebuilt?: { simCore: SimCore; hex?: string; bin?: Uint8Array };
}

/** Internal: everything needed to (re)create the HeadlessMcu without rebuilding. */
interface BuiltFirmware {
  simCore: SimCore;
  hex?: string;
  bin?: Uint8Array;
  chipConfigs: Map<string, CustomChipConfig>;
  target: MCUInfo;
  board: string;
}

export class SimSession {
  readonly project: ProjectFiles;
  private readonly built: BuiltFirmware;
  private readonly clockHz?: number;
  private readonly workDir: string;
  private readonly ownWorkDir: boolean;
  private mcu: HeadlessMcu;
  private _status: SessionStatus = "idle";
  private cyclesAtReset = 0;

  private constructor(
    project: ProjectFiles,
    built: BuiltFirmware,
    mcu: HeadlessMcu,
    workDir: string,
    ownWorkDir: boolean,
    clockHz?: number,
  ) {
    this.project = project;
    this.built = built;
    this.mcu = mcu;
    this.workDir = workDir;
    this.ownWorkDir = ownWorkDir;
    this.clockHz = clockHz;
  }

  /** Load a project, build its firmware/chips, wire it, and return a ready session. */
  static async load(opts: SimSessionLoadOptions): Promise<SimSession> {
    const project = opts.slug
      ? loadProject(opts.slug, opts.projectsRoot)
      : loadProject({ projectDir: opts.projectDir });

    if (!project.target) {
      throw new Error(
        `No simulatable MCU found in ${project.slug} (parts: ${project.diagram.parts
          .map((p) => p.type)
          .join(", ")})`,
      );
    }
    const target = project.target;
    const board = target.boardId;

    const workDir = opts.prebuilt
      ? path.join(os.tmpdir(), `sparkbench-session-${process.pid}`)
      : path.join(os.tmpdir(), `sparkbench-session-${process.pid}-${Date.now()}`);
    const ownWorkDir = !opts.prebuilt;
    mkdirSync(workDir, { recursive: true });

    let built: BuiltFirmware;
    if (opts.prebuilt) {
      built = {
        simCore: opts.prebuilt.simCore,
        hex: opts.prebuilt.hex,
        bin: opts.prebuilt.bin,
        chipConfigs: new Map(),
        target,
        board,
      };
    } else {
      const result = buildFirmware(
        project.sketch,
        project.librariesTxt,
        { board, workDir, quiet: opts.quiet, projectDir: project.root },
      );
      if (!result.simCore) {
        throw new Error(
          `Board "${board}" has no headless simulation core (compile-only).`,
        );
      }
      const chipBuild = buildChips(project.files, project.diagram, workDir, opts.quiet);
      built = {
        simCore: result.simCore,
        hex: result.hex,
        bin: result.bin,
        chipConfigs: chipBuild.configs,
        target,
        board,
      };
    }

    const mcu = await SimSession.createMcu(project, built, opts.clockHz);
    const session = new SimSession(project, built, mcu, workDir, ownWorkDir, opts.clockHz);
    session._status = "running";
    return session;
  }

  private static createMcu(
    project: ProjectFiles,
    built: BuiltFirmware,
    clockHz?: number,
  ): Promise<HeadlessMcu> {
    return createHeadlessMcu({
      simCore: built.simCore,
      hex: built.hex,
      bin: built.bin,
      diagram: project.diagram,
      target: built.target,
      clockHz,
      chipConfigs: built.chipConfigs,
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Advance the simulation by `ms` and return what changed. */
  runMs(ms: number): RunResult {
    if (this._status === "stopped") {
      throw new Error("Simulation is stopped — call restart() first");
    }
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error(`runMs requires a positive duration (got ${ms})`);
    }
    const before = this.mcu.cycles;
    const serialBefore = this.mcu.serial().length;
    this.mcu.runMs(ms);
    const cyclesRun = this.mcu.cycles - before;
    return {
      cyclesRun,
      timeMs: this.timeMs,
      serialAppended: this.mcu.serial().slice(serialBefore),
    };
  }

  stop(): void {
    this.mcu.stop();
    this._status = "stopped";
  }

  /** Tear down and rebuild the runner from the already-compiled firmware. */
  async restart(): Promise<void> {
    this.mcu.dispose();
    this.mcu = await SimSession.createMcu(this.project, this.built, this.clockHz);
    this.cyclesAtReset = 0;
    this._status = "running";
  }

  /** Release the runner and (if owned) the temp build directory. */
  dispose(): void {
    try {
      this.mcu.dispose();
    } finally {
      this._status = "stopped";
      if (this.ownWorkDir) {
        try {
          rmSync(this.workDir, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  }

  // ── Serial ─────────────────────────────────────────────────────────────

  /** Read accumulated serial output; optionally clear the buffer. */
  readSerial(opts?: { clear?: boolean }): string {
    const text = this.mcu.serial();
    if (opts?.clear) this.mcu.clearSerial();
    return text;
  }

  /** Send text to the MCU's serial RX. Throws if the core has no RX feed. */
  writeSerial(text: string): void {
    this.mcu.sendSerial(text);
  }

  // ── Pins & controls ────────────────────────────────────────────────────

  /**
   * Read a pin's logic level.
   *
   * Two modes, matching Wokwi's `wokwi_read_pin` while staying back-compatible:
   *  - `readPin("GP15")` — a board-native pin name ("13"/"A0"/"PB5"/"PC13"/"GP15").
   *  - `readPin("A", "led1")` — a part's pin; resolved through the diagram to the
   *    MCU GPIO it connects to. When `partId` is the MCU itself, `pin` is read
   *    directly as a board-native name.
   */
  readPin(pin: string, partId?: string): { state: 0 | 1; high: boolean; voltage: number; mcuPin: string } {
    const mcuPin = partId ? this.resolveMcuPin(partId, pin) : pin;
    const high = this.mcu.pinHigh(mcuPin);
    return { state: high ? 1 : 0, high, voltage: high ? 3.3 : 0, mcuPin };
  }

  /** Resolve `partId:pin` to the board-native MCU pin it is wired to. */
  private resolveMcuPin(partId: string, pin: string): string {
    const mcuId = this.built.target.id;
    if (partId === mcuId) return pin;

    const conns = findPartConnections(this.project.diagram, partId);
    const endpoints = conns.get(pin);
    if (!endpoints || endpoints.length === 0) {
      throw new Error(`Part "${partId}" has no pin "${pin}" in the diagram connections`);
    }
    const prefix = `${mcuId}:`;
    const mcuEndpoint = endpoints.find((e) => e.startsWith(prefix));
    if (!mcuEndpoint) {
      throw new Error(
        `Pin "${partId}:${pin}" is not connected to the MCU "${mcuId}" (connects to: ${endpoints.join(", ")})`,
      );
    }
    return mcuEndpoint.slice(prefix.length);
  }

  /** Drive a component control (delegates to the shared {@link applyControl}). */
  setControl(partId: string, control: string, value: number | boolean | string): ControlResult {
    return applyControl(this.mcu.wired, partId, control, value, (n) => this.mcu.runCycles(n));
  }

  // ── Displays ───────────────────────────────────────────────────────────

  /** Parts that expose a readable display buffer. */
  listDisplayParts(): PartInfo[] {
    const out: PartInfo[] = [];
    for (const [id, wc] of this.mcu.wired) {
      if (wc.ssd1306 || wc.lcd1602 || wc.ili9341 || wc.chipRuntime?.getFramebuffer()) {
        out.push({ id, type: wc.part.type });
      }
    }
    return out;
  }

  /** Decode a display part's current contents, or null if it has no display. */
  readDisplayBuffer(partId: string): DisplayBuffer | null {
    const wc = this.mcu.wired.get(partId);
    if (!wc) return null;

    if (wc.ssd1306) {
      const gddram = wc.ssd1306.gddramBuffer;
      return { type: "ssd1306", width: 128, height: 64, gddram };
    }
    if (wc.lcd1602) {
      return {
        type: "lcd1602",
        cols: 16,
        rows: 2,
        characters: wc.lcd1602.characters,
        backlight: wc.lcd1602.backlight,
      };
    }
    if (wc.ili9341) {
      return {
        type: "framebuffer",
        source: "ili9341",
        width: wc.ili9341.width,
        height: wc.ili9341.height,
        pixels: wc.ili9341.pixels,
      };
    }
    const fb = wc.chipRuntime?.getFramebuffer();
    if (fb) {
      return {
        type: "framebuffer",
        source: "chip",
        width: fb.width,
        height: fb.height,
        pixels: fb.pixels,
      };
    }
    return null;
  }

  /** Render a display part to PNG bytes. Throws if the part has no display. */
  takeScreenshot(partId: string): Buffer {
    const wc = this.mcu.wired.get(partId);
    if (!wc) throw new Error(`Part "${partId}" not found`);

    if (wc.ssd1306) return encodeSsd1306Png(wc.ssd1306);
    if (wc.lcd1602) return encodeLcd1602Png(wc.lcd1602);
    if (wc.ili9341) {
      return encodeFramebufferPng({
        width: wc.ili9341.width,
        height: wc.ili9341.height,
        pixels: wc.ili9341.pixels,
      });
    }
    const fb = wc.chipRuntime?.getFramebuffer();
    if (fb) return encodeFramebufferPng(fb);

    throw new Error(`Part "${partId}" (${wc.part.type}) has no renderable display`);
  }

  // ── Introspection ──────────────────────────────────────────────────────

  listParts(): PartInfo[] {
    return this.project.diagram.parts.map((p) => ({ id: p.id, type: p.type }));
  }

  get timeMs(): number {
    return ((this.mcu.cycles - this.cyclesAtReset) / this.mcu.clockHz) * 1000;
  }

  get simCore(): SimCore {
    return this.built.simCore;
  }

  status(): SimSessionStatus {
    return {
      status: this._status,
      simCore: this.built.simCore,
      board: this.built.board,
      clockHz: this.mcu.clockHz,
      cycles: this.mcu.cycles,
      timeMs: this.timeMs,
      serialBytes: this.mcu.serial().length,
      parts: this.listParts(),
    };
  }
}
