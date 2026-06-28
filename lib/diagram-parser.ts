export interface DiagramPart {
  type: string;
  id: string;
  top: number;
  left: number;
  rotate?: number;
  attrs: Record<string, string>;
  value?: string;
  footprint?: string;
  pcbX?: number;
  pcbY?: number;
  pcbRotation?: number;
}

export interface DiagramConnection {
  from: string;
  to: string;
  color: string;
  hints: string[];
}

type RawDiagramConnection =
  | DiagramConnection
  | [string, string, string?, string[]?];

export interface DiagramLabel {
  id: string;
  name: string;
  pinRef: string;
  x: number;
  y: number;
  orientation?: number;
}

export interface Diagram {
  version: number;
  author: string;
  editor: string;
  parts: DiagramPart[];
  connections: DiagramConnection[];
  labels?: DiagramLabel[];
  serialMonitor?: { display: string };
  boardSize?: { width: number; height: number };
}

/**
 * Wokwi renamed some part types from wokwi-* to board-*.
 * Normalize them so all downstream code uses the wokwi-* form.
 */
const TYPE_ALIASES: Record<string, string> = {
  "board-ssd1306": "wokwi-ssd1306",
  "board-lcd1602": "wokwi-lcd1602",
  "board-lcd2004": "wokwi-lcd2004",
  "board-ili9341": "wokwi-ili9341",
};

function normalizePartType(type: string): string {
  return TYPE_ALIASES[type] || type;
}

/** MCU part type → metadata for simulation. */
export type PinStyle = "arduino" | "avr-port" | "stm32-port" | "rp2040";

export interface MCUInfo {
  id: string;           // part id from diagram (e.g. "uno", "u1")
  type: string;         // part type (e.g. "wokwi-arduino-uno")
  boardId: string;      // PlatformIO board env name
  pinStyle: PinStyle;
  label: string;
  simulatable: boolean; // true if the browser emulator can run this chip
}

const MCU_REGISTRY: Record<string, { boardId: string; pinStyle: PinStyle; label: string; simulatable: boolean }> = {
  // AVR boards
  "wokwi-arduino-uno":   { boardId: "uno",        pinStyle: "arduino",   label: "Arduino Uno",   simulatable: true },
  "wokwi-arduino-nano":  { boardId: "uno",        pinStyle: "arduino",   label: "Arduino Nano",  simulatable: true },
  "wokwi-arduino-mega":  { boardId: "mega",       pinStyle: "arduino",   label: "Arduino Mega",  simulatable: false },
  "sb-atmega328":        { boardId: "atmega328p",  pinStyle: "avr-port",  label: "ATmega328P",    simulatable: true },
  // ESP32 boards
  "wokwi-esp32-devkit-v1":  { boardId: "esp32dev",             pinStyle: "arduino", label: "ESP32 DevKit V1",   simulatable: false },
  "sb-esp32":               { boardId: "esp32dev",             pinStyle: "arduino", label: "ESP32",             simulatable: false },
  "sb-esp32-s3":            { boardId: "esp32-s3-devkitc-1",  pinStyle: "arduino", label: "ESP32-S3",          simulatable: false },
  "sb-esp32-c3":            { boardId: "esp32-c3-devkitm-1",  pinStyle: "arduino", label: "ESP32-C3",          simulatable: false },
  // STM32 boards
  "sb-stm32-bluepill":      { boardId: "bluepill_f103c8",      pinStyle: "stm32-port", label: "STM32F103 Blue Pill", simulatable: true },
  "sb-stm32f103":           { boardId: "bluepill_f103c8",      pinStyle: "stm32-port", label: "STM32F103C8",         simulatable: true },
  // RP2040 boards (Raspberry Pi Pico) — emulated via rp2040js (see lib/rp2040-runner.ts)
  "wokwi-pi-pico":          { boardId: "pico",  pinStyle: "rp2040", label: "Raspberry Pi Pico", simulatable: true },
  "sb-rp2040":              { boardId: "pico",  pinStyle: "rp2040", label: "RP2040",            simulatable: true },
};

/**
 * Find all MCU parts in the diagram, in parts-array order.
 * First simulatable MCU is the default target (Wokwi convention).
 */
export function findMCUs(diagram: Diagram): MCUInfo[] {
  const mcus: MCUInfo[] = [];
  for (const part of diagram.parts) {
    const reg = MCU_REGISTRY[part.type];
    if (reg) {
      mcus.push({ id: part.id, type: part.type, ...reg });
    }
  }
  return mcus;
}

export function parseDiagram(json: unknown): Diagram {
  const d = json as Diagram;
  return {
    version: d.version ?? 1,
    author: d.author ?? "",
    editor: d.editor ?? "sparkbench",
    parts: (d.parts ?? []).map((p) => ({
      ...p,
      type: normalizePartType(p.type),
      attrs: p.attrs ?? {},
      value: p.value,
      footprint: p.footprint,
    })),
    connections: normalizeConnections(d.connections ?? []),
    labels: d.labels ?? [],
    serialMonitor: d.serialMonitor,
    boardSize: d.boardSize,
  };
}

export function normalizeConnection(c: RawDiagramConnection): DiagramConnection {
  if (Array.isArray(c)) {
    return { from: c[0], to: c[1], color: c[2] ?? "green", hints: c[3] ?? [] };
  }
  return {
    from: c.from,
    to: c.to,
    color: c.color ?? "green",
    hints: c.hints ?? [],
  };
}

export function normalizeConnections(connections: RawDiagramConnection[]): DiagramConnection[] {
  return connections.map(normalizeConnection);
}

/**
 * Find which Arduino pin a component is connected to.
 * Returns mapping: componentId -> { pinName, arduinoPin }
 */
export function findComponentPins(
  diagram: Diagram,
  mcuId = "uno"
): Map<string, string> {
  const map = new Map<string, string>();

  const partsById = new Map<string, DiagramPart>();
  for (const part of diagram.parts) {
    partsById.set(part.id, part);
  }

  // Passive components that pass signals through (e.g. resistors)
  const passiveTypes = new Set(["wokwi-resistor"]);

  // Step 1: Direct MCU connections
  for (const conn of diagram.connections) {
    let mcuPin: string | null = null;
    let componentId: string | null = null;

    if (conn.from.startsWith(`${mcuId}:`)) {
      mcuPin = conn.from.split(":")[1];
      componentId = conn.to.split(":")[0];
    } else if (conn.to.startsWith(`${mcuId}:`)) {
      mcuPin = conn.to.split(":")[1];
      componentId = conn.from.split(":")[0];
    }

    if (!mcuPin || !componentId) continue;
    if (mcuPin.startsWith("GND") || mcuPin === "5V" || mcuPin === "3.3V"
        || mcuPin === "VCC" || mcuPin === "AVCC" || mcuPin === "AREF" || mcuPin === "GND2")
      continue;

    if (!map.has(componentId)) {
      map.set(componentId, mcuPin);
    }
  }

  // Step 2: Propagate through passive components (e.g. resistors between MCU and LED)
  let changed = true;
  while (changed) {
    changed = false;
    for (const conn of diagram.connections) {
      const aId = conn.from.split(":")[0];
      const bId = conn.to.split(":")[0];

      if (aId === mcuId || bId === mcuId) continue;

      if (map.has(aId) && !map.has(bId)) {
        const part = partsById.get(aId);
        if (part && passiveTypes.has(part.type)) {
          map.set(bId, map.get(aId)!);
          changed = true;
        }
      } else if (map.has(bId) && !map.has(aId)) {
        const part = partsById.get(bId);
        if (part && passiveTypes.has(part.type)) {
          map.set(aId, map.get(bId)!);
          changed = true;
        }
      }
    }
  }

  return map;
}
