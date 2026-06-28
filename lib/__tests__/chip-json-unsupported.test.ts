import { describe, it, expect } from "vitest";
import { findChipFiles, findUnsupportedChips } from "../chip-json";

const CHIP_JSON = JSON.stringify({ name: "counter", pins: ["CLK", "VCC", "GND"] });

describe("findUnsupportedChips", () => {
  it("does NOT flag SystemVerilog/Verilog — they are supported via Verilator", () => {
    expect(
      findUnsupportedChips([
        { name: "counter.chip.json", content: CHIP_JSON },
        { name: "counter.chip.sv", content: "module counter(); endmodule" },
      ]),
    ).toHaveLength(0);
    expect(
      findUnsupportedChips([
        { name: "a.chip.json", content: CHIP_JSON },
        { name: "a.chip.v", content: "" },
      ]),
    ).toHaveLength(0);
  });

  it("flags VHDL (no compile path yet)", () => {
    const vhd = findUnsupportedChips([
      { name: "b.chip.json", content: CHIP_JSON },
      { name: "b.chip.vhd", content: "" },
    ]);
    expect(vhd).toHaveLength(1);
    expect(vhd[0].sourceFile).toBe("b.chip.vhd");
  });

  it("does NOT flag a chip that has a compilable .chip.c", () => {
    const files = [
      { name: "counter.chip.json", content: CHIP_JSON },
      { name: "counter.chip.c", content: "void chip_init(){}" },
      { name: "counter.chip.sv", content: "module counter(); endmodule" },
    ];
    expect(findUnsupportedChips(files)).toHaveLength(0);
    // ...and the C chip IS picked up by the normal discovery.
    expect(findChipFiles(files)).toHaveLength(1);
  });

  it("returns empty when there are no chip definitions", () => {
    expect(findUnsupportedChips([{ name: "sketch.ino", content: "" }])).toEqual([]);
  });
});
