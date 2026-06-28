// Verilog / SystemVerilog custom chip builder.
//
// Pipeline (the same route Wokwi uses on its server, run locally here):
//   .chip.sv  →  Verilator (--cc)  →  C++  →  WASI-SDK clang++  →  WASM
// targeting the Wokwi custom-chip ABI that CustomChipRuntime already implements.
//
// A generated shim binds the Verilated top-level module's ports to the Wokwi
// pin API: each input port (incl. clk/rst) is an input pin watched for changes;
// each output port is an output pin written after every eval(). Multi-bit ports
// expand to one pin per bit (NAME0, NAME1, ...).

import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "fs";
import path from "path";
import os from "os";

export interface VerilogPort {
  name: string;
  dir: "input" | "output";
  width: number; // number of bits (1 for scalar)
}

export interface ParsedModule {
  module: string;
  ports: VerilogPort[];
}

const WASI_SDK = process.env.WASI_SDK_PATH || path.join(os.homedir(), ".wokwi/wasi-sdk");

export function findVerilator(): string {
  const candidates = [process.env.VERILATOR, "verilator", "/opt/homebrew/bin/verilator"].filter(
    (c): c is string => !!c,
  );
  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ["--version"], { stdio: "pipe", timeout: 5000 });
      return cmd;
    } catch { /* next */ }
  }
  throw new Error("verilator not found. Install it (e.g. `brew install verilator`).");
}

export function verilatorAvailable(): boolean {
  try {
    findVerilator();
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse the top module name and its ANSI-style port list from Verilog/SV source.
 * Handles `module name ( input wire [3:0] a, output reg b, ... );`.
 */
export function parseVerilogPorts(src: string): ParsedModule {
  // Strip comments to simplify matching.
  const clean = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const modMatch = clean.match(/\bmodule\s+(\w+)\s*(?:#\s*\([\s\S]*?\))?\s*\(([\s\S]*?)\)\s*;/);
  if (!modMatch) throw new Error("Could not find a module declaration with a port list");
  const module = modMatch[1];
  const portText = modMatch[2];

  const ports: VerilogPort[] = [];
  // Split on commas at top level (port list has no nested parens in ANSI form).
  for (const rawDecl of portText.split(",")) {
    const decl = rawDecl.trim();
    if (!decl) continue;
    const m = decl.match(/\b(input|output)\b\s+(?:wire|reg|logic|bit)?\s*(?:\[\s*(\d+)\s*:\s*(\d+)\s*\]\s*)?(\w+)/);
    if (!m) continue;
    const dir = m[1] as "input" | "output";
    const msb = m[2] !== undefined ? parseInt(m[2], 10) : undefined;
    const lsb = m[3] !== undefined ? parseInt(m[3], 10) : undefined;
    const width = msb !== undefined && lsb !== undefined ? Math.abs(msb - lsb) + 1 : 1;
    ports.push({ name: m[4], dir, width });
  }
  if (ports.length === 0) throw new Error("No input/output ports found in module declaration");
  return { module, ports };
}

/** Pin name for a port bit: scalar → "NAME", vector → "NAME<bit>". */
function pinName(port: VerilogPort, bit: number): string {
  return port.width === 1 ? port.name : `${port.name}${bit}`;
}

/** Generate the C++ shim that binds Verilated ports to the Wokwi pin API. */
export function generateShim(parsed: ParsedModule): string {
  const { module, ports } = parsed;
  const inputs = ports.filter((p) => p.dir === "input");
  const outputs = ports.filter((p) => p.dir === "output");

  const lines: string[] = [];
  lines.push(`#include "V${module}.h"`);
  lines.push(`#define timer_t wokwi_timer_t   // avoid clash with WASI <time.h> timer_t`);
  lines.push(`#include "wokwi-api.h"`);
  lines.push(`#undef timer_t`);
  lines.push(``);
  lines.push(`static V${module}* top;`);
  // Output pin handles
  for (const o of outputs) {
    for (let b = 0; b < o.width; b++) lines.push(`static pin_t out_${pinName(o, b)};`);
  }
  lines.push(``);
  // write_outputs(): push every output bit to its pin
  lines.push(`static void write_outputs() {`);
  for (const o of outputs) {
    for (let b = 0; b < o.width; b++) {
      lines.push(`  pin_write(out_${pinName(o, b)}, ((top->${o.name} >> ${b}) & 1) ? HIGH : LOW);`);
    }
  }
  lines.push(`}`);
  lines.push(``);
  // One change-handler per input bit
  for (const inp of inputs) {
    for (let b = 0; b < inp.width; b++) {
      lines.push(`static void on_${pinName(inp, b)}(void* ud, pin_t pin, uint32_t value) {`);
      lines.push(`  if (value) top->${inp.name} |= (1u << ${b}); else top->${inp.name} &= ~(1u << ${b});`);
      lines.push(`  top->eval();`);
      lines.push(`  write_outputs();`);
      lines.push(`}`);
    }
  }
  lines.push(``);
  lines.push(`void chip_init(void) {`);
  lines.push(`  top = new V${module}();`);
  // init inputs + watch
  for (const inp of inputs) {
    for (let b = 0; b < inp.width; b++) {
      const pn = pinName(inp, b);
      lines.push(`  {`);
      lines.push(`    pin_t p = pin_init("${pn}", INPUT);`);
      lines.push(`    if (pin_read(p)) top->${inp.name} |= (1u << ${b});`);
      lines.push(`    pin_watch_config_t w = {};`);
      lines.push(`    w.edge = BOTH; w.pin_change = on_${pn};`);
      lines.push(`    pin_watch(p, &w);`);
      lines.push(`  }`);
    }
  }
  // init outputs
  for (const o of outputs) {
    for (let b = 0; b < o.width; b++) {
      lines.push(`  out_${pinName(o, b)} = pin_init("${pinName(o, b)}", OUTPUT);`);
    }
  }
  lines.push(`  top->eval();`);
  lines.push(`  write_outputs();`);
  lines.push(`}`);
  lines.push(``);
  return lines.join("\n");
}

export interface VerilogBuildResult {
  wasmBytes: ArrayBuffer;
  module: string;
  ports: VerilogPort[];
}

/**
 * Build a Verilog/SystemVerilog source into a Wokwi-compatible WASM chip.
 * Requires Verilator and the WASI-SDK (auto-detected). Synchronous.
 */
export function buildVerilogChip(
  svSource: string,
  apiHeader: string,
  workDir?: string,
): VerilogBuildResult {
  const verilator = findVerilator();
  const clangpp = path.join(WASI_SDK, "bin/clang++");
  const sysroot = path.join(WASI_SDK, "share/wasi-sysroot");
  if (!existsSync(clangpp)) throw new Error(`WASI-SDK clang++ not found at ${clangpp}`);

  const dir = workDir ?? path.join(os.tmpdir(), `sparkbench-verilog-${Date.now()}`);
  mkdirSync(dir, { recursive: true });

  const parsed = parseVerilogPorts(svSource);
  const svFile = path.join(dir, `${parsed.module}.v`);
  writeFileSync(svFile, svSource);
  writeFileSync(path.join(dir, "wokwi-api.h"), apiHeader);
  writeFileSync(path.join(dir, "shim.cpp"), generateShim(parsed));

  // 1) Verilate → C++
  execFileSync(verilator, ["--cc", "--no-trace", `${parsed.module}.v`], {
    cwd: dir,
    timeout: 60_000,
    stdio: "pipe",
  });

  const vincl = execFileSync(verilator, ["--getenv", "VERILATOR_ROOT"], { stdio: "pipe" })
    .toString()
    .trim() + "/include";

  // 2) Compile shim + Verilated model + runtime → WASM
  const objDir = path.join(dir, "obj_dir");
  const genCpps = readdirSync(objDir)
    .filter((f) => f.startsWith(`V${parsed.module}`) && f.endsWith(".cpp"))
    .map((f) => path.join(objDir, f));

  const args = [
    `--target=wasm32-wasip1-threads`,
    `--sysroot=${sysroot}`,
    "-nostartfiles", "-pthread", "-O2", "-fno-exceptions",
    "-std=gnu++20", "-faligned-new", "-fbracket-depth=4096",
    "-DVL_IGNORE_UNKNOWN_ARCH", "-DCLOCK_PROCESS_CPUTIME_ID=CLOCK_MONOTONIC",
    "-Wno-unused-parameter",
    "-I.", "-Iobj_dir", `-I${vincl}`,
    "-Wl,--no-entry", "-Wl,--import-memory", "-Wl,--shared-memory", "-Wl,--export-table",
    "shim.cpp", ...genCpps.map((f) => path.relative(dir, f)),
    `${vincl}/verilated.cpp`, `${vincl}/verilated_threads.cpp`,
    "-o", "chip.wasm",
  ];
  execFileSync(clangpp, args, { cwd: dir, timeout: 120_000, stdio: "pipe" });

  const wasm = readFileSync(path.join(dir, "chip.wasm"));
  return {
    wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    module: parsed.module,
    ports: parsed.ports,
  };
}
