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
  };
}

/** Generate a diagram part type string from a chip name */
export function chipPartType(chipName: string): string {
  return "chip-" + chipName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
}

/**
 * Scan project files for chip definition pairs: <name>.chip.json + <name>.chip.c
 * Returns matched chip definitions with their source code.
 */
export function findChipFiles(
  projectFiles: { name: string; content: string }[],
): { chipName: string; source: string; chipJson: ChipJsonDef; partType: string }[] {
  const results: { chipName: string; source: string; chipJson: ChipJsonDef; partType: string }[] = [];
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
      });
    } catch {
      // Skip malformed chip.json
    }
  }
  return results;
}
