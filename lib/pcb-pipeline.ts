import type { List } from "@kicanvas/kicad/tokenizer";
import { listify } from "@kicanvas/kicad/tokenizer";
import type { Diagram } from "./diagram-parser";
import type { PCBDesign } from "./pcb-types";
import { buildKicadPCBTree } from "./kicanvas-factory";
import { extractNetlist } from "./netlist";
import { initPCBFromSchematic } from "./pcb-parser";
import { serializeSExpr } from "./sexpr-serializer";
import {
  findChildren,
  getAt,
  getFootprintRef,
  getLayer,
  replaceEdgeCuts,
} from "./sexpr-mutate";

export interface ExistingFootprintPosition {
  x: number;
  y: number;
  rotation: number;
}

export interface PCBPipelineResult {
  design: PCBDesign;
  tree: List;
  pcbText: string;
  warnings: string[];
}

function parsePcbTree(pcbText: string): List {
  return listify(pcbText)[0] as List;
}

export function extractExistingFootprintPositions(
  pcbText: string | null | undefined,
): Map<string, ExistingFootprintPosition> {
  const positions = new Map<string, ExistingFootprintPosition>();
  if (!pcbText) return positions;

  const tree = parsePcbTree(pcbText);
  for (const fp of findChildren(tree, "footprint")) {
    const ref = getFootprintRef(fp);
    const at = getAt(fp);
    if (ref && at) {
      positions.set(ref, { x: at.x, y: at.y, rotation: at.rotation });
    }
  }
  return positions;
}

export function extractEdgeCuts(pcbText: string | null | undefined): List[] {
  if (!pcbText) return [];
  const tree = parsePcbTree(pcbText);
  const edgeCutNodes: List[] = [];
  for (const tag of ["gr_line", "gr_arc", "gr_rect", "gr_poly"]) {
    for (const node of findChildren(tree, tag)) {
      if (getLayer(node) === "Edge.Cuts") {
        edgeCutNodes.push(structuredClone(node) as List);
      }
    }
  }
  return edgeCutNodes;
}

export function buildPCBDesignFromDiagram(
  diagram: Diagram,
  existingPcbText?: string | null,
): { design: PCBDesign; warnings: string[] } {
  const warnings: string[] = [];
  let existingPositions: Map<string, ExistingFootprintPosition> | undefined;

  try {
    existingPositions = extractExistingFootprintPositions(existingPcbText);
  } catch (err) {
    warnings.push(
      `Could not read existing footprint positions: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const netlist = extractNetlist(diagram);
  const design = initPCBFromSchematic(
    diagram,
    netlist,
    existingPositions,
    diagram.boardSize,
  );

  return { design, warnings };
}

export function generatePCBFromDiagram(
  diagram: Diagram,
  existingPcbText?: string | null,
): PCBPipelineResult {
  const { design, warnings } = buildPCBDesignFromDiagram(diagram, existingPcbText);
  const tree = buildKicadPCBTree(design) as List;

  if (existingPcbText && !diagram.boardSize) {
    try {
      const edgeCutNodes = extractEdgeCuts(existingPcbText);
      if (edgeCutNodes.length > 0) {
        replaceEdgeCuts(tree, edgeCutNodes);
      }
    } catch (err) {
      warnings.push(
        `Could not preserve existing board outline: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    design,
    tree,
    pcbText: serializeSExpr(tree),
    warnings,
  };
}

export function validateKiCadPcbForAutoroute(pcbText: string): string[] {
  const issues: string[] = [];
  let tree: List;
  try {
    tree = parsePcbTree(pcbText);
  } catch (err) {
    return [`Invalid KiCad PCB syntax: ${err instanceof Error ? err.message : String(err)}`];
  }

  if (findChildren(tree, "footprint").length === 0) {
    issues.push("Board has no footprints.");
  }
  if (extractEdgeCuts(pcbText).length === 0) {
    issues.push("Board has no Edge.Cuts outline.");
  }
  const routedItems = findChildren(tree, "segment").length + findChildren(tree, "via").length;
  if (routedItems === 0 && findChildren(tree, "net").length <= 1) {
    issues.push("Board has no routed items or named nets.");
  }

  return issues;
}
