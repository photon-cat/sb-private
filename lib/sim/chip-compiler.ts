/**
 * Compile a single custom-chip source to a Wokwi-compatible WASM module.
 *
 * SparkBench supports two chip authoring formats:
 *  - **C** (Wokwi chip API)  → compiled with `wokwi-cli chip compile`.
 *  - **Verilog / SystemVerilog** → compiled via Verilator + WASI-SDK
 *    ({@link buildVerilogChip}).
 *
 * The format is auto-detected from the source (overridable). Used by the MCP
 * `sparkbench_compile_chip` tool so an external agent can build a chip on the
 * fly without a project on disk.
 */

import os from "os";
import path from "path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { findWokwiCli } from "./firmware-builder";
import { buildVerilogChip, verilatorAvailable } from "./verilog-chip-builder";

export type ChipLanguage = "c" | "verilog";

export interface ChipCompileResult {
  language: ChipLanguage;
  /** Compiled module bytes. */
  wasm: Uint8Array;
  /** Byte length of `wasm`. */
  size: number;
}

/** Heuristic: Verilog if it declares a module, otherwise C. */
export function detectChipLanguage(source: string): ChipLanguage {
  return /^\s*(?:`[^\n]*\n\s*)*module\s+\w+/m.test(source) && /\bendmodule\b/.test(source)
    ? "verilog"
    : "c";
}

const API_HEADER = path.join(__dirname, "wokwi-api.h");

/**
 * Compile chip `name` from `source`. Auto-detects the language unless given.
 * Throws a clear error when the required toolchain is unavailable.
 */
export function compileChipSource(opts: {
  name: string;
  source: string;
  language?: ChipLanguage;
}): ChipCompileResult {
  const language = opts.language ?? detectChipLanguage(opts.source);
  const safeName = opts.name.replace(/[^a-zA-Z0-9_-]/g, "_") || "chip";

  if (language === "verilog") {
    if (!verilatorAvailable()) {
      throw new Error("Verilog chip compilation needs Verilator (+ WASI-SDK); neither was found.");
    }
    if (!existsSync(API_HEADER)) {
      throw new Error(`wokwi-api.h not found at ${API_HEADER}`);
    }
    const apiHeader = readFileSync(API_HEADER, "utf-8");
    const built = buildVerilogChip(opts.source, apiHeader);
    const wasm = new Uint8Array(built.wasmBytes);
    return { language, wasm, size: wasm.byteLength };
  }

  // C chip via wokwi-cli.
  const wokwiCli = findWokwiCli(); // throws a clear message if absent
  const workDir = path.join(os.tmpdir(), `sparkbench-chip-${process.pid}-${safeName}`);
  mkdirSync(workDir, { recursive: true });
  try {
    const srcName = `${safeName}.c`;
    const wasmName = `${safeName}.wasm`;
    writeFileSync(path.join(workDir, srcName), opts.source);
    try {
      execFileSync(wokwiCli, ["chip", "compile", srcName, "-o", wasmName], {
        cwd: workDir,
        timeout: 120_000,
        stdio: "pipe",
      });
    } catch (err) {
      const e = err as { stderr?: Buffer; stdout?: Buffer };
      const detail = (e.stderr?.toString() || e.stdout?.toString() || "").trim();
      throw new Error(`wokwi-cli chip compile failed${detail ? `:\n${detail}` : ""}`);
    }
    const wasm = new Uint8Array(readFileSync(path.join(workDir, wasmName)));
    return { language, wasm, size: wasm.byteLength };
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
