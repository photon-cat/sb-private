import { describe, expect, it } from "vitest";
import { parseDiagram } from "../diagram-parser";
import {
  extractEdgeCuts,
  extractExistingFootprintPositions,
  generatePCBFromDiagram,
  validateKiCadPcbForAutoroute,
} from "../pcb-pipeline";

const EXISTING_PCB = `(kicad_pcb
  (version 20240108)
  (generator sparkbench)
  (layers
    (0 F.Cu signal)
    (31 B.Cu signal)
    (44 Edge.Cuts user)
  )
  (net 0 "")
  (gr_line (start 0 0) (end 42 0) (layer Edge.Cuts) (stroke (width 0.05) (type solid)))
  (gr_line (start 42 0) (end 42 24) (layer Edge.Cuts) (stroke (width 0.05) (type solid)))
  (footprint "LED_THT:LED_D5.0mm"
    (layer "F.Cu")
    (uuid "abc")
    (at 12.5 13.5 90)
    (fp_text reference "led1" (at 0 -2) (layer "F.SilkS"))
  )
)`;

describe("pcb-pipeline", () => {
  it("extracts existing footprint positions by reference", () => {
    const positions = extractExistingFootprintPositions(EXISTING_PCB);
    expect(positions.get("led1")).toEqual({ x: 12.5, y: 13.5, rotation: 90 });
  });

  it("extracts existing Edge.Cuts nodes", () => {
    const edgeCuts = extractEdgeCuts(EXISTING_PCB);
    expect(edgeCuts).toHaveLength(2);
    expect(edgeCuts[0][0]).toBe("gr_line");
  });

  it("generates KiCad PCB text while preserving existing placement and outline", () => {
    const diagram = parseDiagram({
      parts: [
        { type: "wokwi-led", id: "led1", top: 0, left: 0 },
      ],
      connections: [],
    });

    const result = generatePCBFromDiagram(diagram, EXISTING_PCB);
    expect(result.warnings).toEqual([]);
    expect(result.pcbText).toContain("(at 12.5 13.5 90)");
    expect(result.pcbText).toContain("(end 42 24)");
  });

  it("uses explicit diagram boardSize instead of preserving old outline", () => {
    const diagram = parseDiagram({
      parts: [
        { type: "wokwi-led", id: "led1", top: 0, left: 0 },
      ],
      connections: [],
      boardSize: { width: 10, height: 8 },
    });

    const result = generatePCBFromDiagram(diagram, EXISTING_PCB);
    expect(result.pcbText).toContain("(end 10 0)");
    expect(result.pcbText).not.toContain("(end 42 24)");
  });

  it("reports invalid autoroute input", () => {
    expect(validateKiCadPcbForAutoroute("not a pcb")).not.toEqual([]);
  });
});
