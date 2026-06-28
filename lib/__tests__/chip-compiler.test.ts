// Single-chip compiler — backs the MCP sparkbench_compile_chip tool.

import { describe, it, expect } from "vitest";
import { detectChipLanguage, compileChipSource } from "../sim/chip-compiler";
import { findWokwiCli } from "../sim/firmware-builder";

const C_CHIP = `#include "wokwi-api.h"
void chip_init() {}
`;

const VERILOG_CHIP = `module inverter(input wire a, output wire y);
  assign y = ~a;
endmodule
`;

function wokwiCliAvailable(): boolean {
  try {
    findWokwiCli();
    return true;
  } catch {
    return false;
  }
}

describe("detectChipLanguage", () => {
  it("detects Verilog from module/endmodule", () => {
    expect(detectChipLanguage(VERILOG_CHIP)).toBe("verilog");
  });
  it("detects C otherwise", () => {
    expect(detectChipLanguage(C_CHIP)).toBe("c");
    expect(detectChipLanguage("int main(){return 0;}")).toBe("c");
  });
});

describe("compileChipSource (C)", () => {
  it.skipIf(!wokwiCliAvailable())("compiles a minimal C chip to valid wasm", () => {
    const r = compileChipSource({ name: "min", source: C_CHIP });
    expect(r.language).toBe("c");
    expect(r.size).toBeGreaterThan(0);
    // WASM magic: \0asm
    expect(Array.from(r.wasm.subarray(0, 4))).toEqual([0x00, 0x61, 0x73, 0x6d]);
  }, 120_000);

  it("reports a clear error for an uncompilable C chip", () => {
    if (!wokwiCliAvailable()) {
      expect(() => compileChipSource({ name: "bad", source: "this is not c", language: "c" })).toThrow();
      return;
    }
    expect(() => compileChipSource({ name: "bad", source: "void chip_init(){ syntax error here }", language: "c" }))
      .toThrow(/chip compile failed/);
  }, 120_000);
});
