// Parse Wokwi-compatible chip.json definitions

export interface ChipJsonDef {
  name: string;
  author?: string;
  pins: string[];
  controls?: {
    id: string;
    label: string;
    type: string;
    min: number;
    max: number;
    step: number;
  }[];
  display?: {
    type?: string;
    width?: number;
    height?: number;
  };
  /**
   * Optional explicit pin positions (in SparkBench px, relative to the
   * chip's local origin). When present, each pin listed here overrides
   * the default grid placement computed from the `pins` array, which is
   * useful when you want the chip to match an external simulator's pin
   * layout exactly (e.g. Wokwi's chip-cd4051b places its 16 holes in a
   * vertical column layout that doesn't fit SparkBench's default DIP
   * horizontal grid).
   *
   * Pins not listed here fall back to the default grid position.
   *
   * Example:
   *   "pinPositions": {
   *     "CIO4": { "x": 4.80, "y": 3.78 },
   *     "CIO6": { "x": 4.80, "y": 13.38 },
   *     ...
   *   }
   */
  pinPositions?: Record<string, { x: number; y: number }>;
  /**
   * Optional explicit chip body dimensions (in SparkBench px). Used to
   * compute the rotation center and pinToCanvas transforms. When absent,
   * the body size is derived from the default pin grid or the
   * pinPositions extents.
   *
   * Usually required alongside `pinPositions` to match an external
   * simulator exactly — pin extents alone underestimate the PCB body
   * because Wokwi-style breakouts inset the pin pads from the board
   * edges, and rotation around the wrong center misplaces the pins
   * after 180° rotation.
   */
  bodySize?: { width: number; height: number };
  /**
   * Optional pin-count template. When set, instances of this chip can
   * override the pin count via `attrs.pins` in diagram.json, and the
   * chip.json's `pins` array acts as the default at the default count.
   *
   * Supported templates:
   *   "numeric-dip": pins are numbered 1..N in standard DIP order
   *                  (bottom row L→R, top row R→L). Useful for generic
   *                  DIP breakouts (8/14/16/20/28/40 pin).
   *   "alpha-dip":   pins are A1..AN (single-letter column, numeric row)
   *
   * Example in chip.json:
   *   "pinTemplate": "numeric-dip",
   *   "defaultPinCount": 16
   *
   * Example in diagram.json:
   *   { "type": "chip-dip", "attrs": { "pins": "20" } }
   *
   * The DiagramCanvas passes `attrs.pins` through to the custom element,
   * which re-generates pinInfo per instance.
   */
  pinTemplate?: "numeric-dip" | "alpha-dip";
  /** Default pin count when no `attrs.pins` is set on the instance. */
  defaultPinCount?: number;
}

/** Parse a chip.json string into a typed definition */
export function parseChipJson(jsonStr: string): ChipJsonDef {
  const raw = JSON.parse(jsonStr);
  if (!raw.name || typeof raw.name !== "string") {
    throw new Error("chip.json must have a 'name' field");
  }
  if (!Array.isArray(raw.pins)) {
    throw new Error("chip.json must have a 'pins' array");
  }
  return {
    name: raw.name,
    author: raw.author,
    pins: raw.pins.map((p: unknown) => (typeof p === "string" ? p : "")),
    controls: raw.controls,
    display: raw.display,
    pinPositions: raw.pinPositions,
    bodySize: raw.bodySize,
    pinTemplate: raw.pinTemplate,
    defaultPinCount: raw.defaultPinCount,
  };
}

/**
 * Generate pin names for a template + count. Used when diagram.json's
 * `attrs.pins` overrides the default count from chip.json.
 */
export function generatePinNames(template: "numeric-dip" | "alpha-dip", count: number): string[] {
  if (count < 2) count = 2;
  if (template === "numeric-dip") {
    return Array.from({ length: count }, (_, i) => String(i + 1));
  }
  if (template === "alpha-dip") {
    // A1..An/2 on bottom row, then B1..Bn/2 on top
    const half = Math.ceil(count / 2);
    const bottom = Array.from({ length: half }, (_, i) => `A${i + 1}`);
    const top = Array.from({ length: count - half }, (_, i) => `B${i + 1}`);
    return [...bottom, ...top];
  }
  return [];
}

/** Generate a diagram part type string from a chip name */
export function chipPartType(chipName: string): string {
  return "chip-" + chipName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
}

export interface ChipFileSet {
  chipName: string;
  source: string;
  chipJson: ChipJsonDef;
  partType: string;
  /** Optional breakout SVG (contents of <name>.chip.svg) — overrides the generic DIP visual. */
  breakoutSvg?: string;
}

/**
 * Scan project files for chip definition pairs: <name>.chip.json + <name>.chip.c
 * and optional <name>.chip.svg for breakout board art.
 * Returns matched chip definitions with their source code.
 */
export function findChipFiles(
  projectFiles: { name: string; content: string }[],
): ChipFileSet[] {
  const results: ChipFileSet[] = [];
  const fileMap = new Map(projectFiles.map((f) => [f.name, f.content]));

  for (const file of projectFiles) {
    if (!file.name.endsWith(".chip.json")) continue;
    const baseName = file.name.replace(/\.chip\.json$/, "");
    const cFile = fileMap.get(`${baseName}.chip.c`);
    if (!cFile) continue;

    try {
      const chipJson = parseChipJson(file.content);
      results.push({
        chipName: baseName,
        source: cFile,
        chipJson,
        partType: chipPartType(baseName),
        breakoutSvg: fileMap.get(`${baseName}.chip.svg`),
      });
    } catch {
      // Skip malformed chip.json
    }
  }
  return results;
}

/** Verilog/SystemVerilog chip source extensions (compiled via Verilator). */
const VERILOG_CHIP_EXTENSIONS = [".chip.sv", ".chip.v"];
/** HDL source extensions not yet compilable (no Verilator path). */
const HDL_CHIP_EXTENSIONS = [".chip.vhd", ".chip.vhdl"];

export interface VerilogChipFileSet {
  chipName: string;
  /** Verilog/SystemVerilog source. */
  source: string;
  chipJson: ChipJsonDef;
  partType: string;
}

/**
 * Scan project files for Verilog chip pairs: <name>.chip.json + <name>.chip.(sv|v).
 * These are compiled to WASM via Verilator (see lib/sim/verilog-chip-builder).
 */
export function findVerilogChipFiles(
  projectFiles: { name: string; content: string }[],
): VerilogChipFileSet[] {
  const fileMap = new Map(projectFiles.map((f) => [f.name, f.content]));
  const results: VerilogChipFileSet[] = [];
  for (const file of projectFiles) {
    if (!file.name.endsWith(".chip.json")) continue;
    const baseName = file.name.replace(/\.chip\.json$/, "");
    if (fileMap.has(`${baseName}.chip.c`)) continue; // C chip takes precedence
    const ext = VERILOG_CHIP_EXTENSIONS.find((e) => fileMap.has(`${baseName}${e}`));
    if (!ext) continue;
    try {
      results.push({
        chipName: baseName,
        source: fileMap.get(`${baseName}${ext}`)!,
        chipJson: parseChipJson(file.content),
        partType: chipPartType(baseName),
      });
    } catch {
      /* skip malformed chip.json */
    }
  }
  return results;
}

export interface UnsupportedChip {
  chipName: string;
  /** The HDL source file present (e.g. "counter.chip.sv"). */
  sourceFile: string;
  reason: string;
}

/**
 * Detect chip definitions that use an authoring format we cannot compile yet
 * (e.g. SystemVerilog/Verilog). These have a <name>.chip.json paired with an
 * HDL source but no <name>.chip.c. Without this check such chips are silently
 * ignored, so the caller should surface a warning.
 */
export function findUnsupportedChips(
  projectFiles: { name: string; content: string }[],
): UnsupportedChip[] {
  const names = new Set(projectFiles.map((f) => f.name));
  const out: UnsupportedChip[] = [];

  for (const file of projectFiles) {
    if (!file.name.endsWith(".chip.json")) continue;
    const baseName = file.name.replace(/\.chip\.json$/, "");
    if (names.has(`${baseName}.chip.c`)) continue; // compilable C chip — fine

    const hdlExt = HDL_CHIP_EXTENSIONS.find((ext) => names.has(`${baseName}${ext}`));
    if (hdlExt) {
      out.push({
        chipName: baseName,
        sourceFile: `${baseName}${hdlExt}`,
        reason: `HDL chips (${hdlExt}) are not yet supported — only C/WASM (.chip.c) chips compile. This chip will not be simulated.`,
      });
    }
  }
  return out;
}
