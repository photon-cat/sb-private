/**
 * Diagram linter — walks `diagram.connections` and warns on pin references
 * that don't exist on the target part's `pinInfo`.
 *
 * Catches the #1 most common import bug: using the wrong pin name on a
 * Wokwi element. For example, `wokwi-ssd1306` exposes pins named `DATA`,
 * `CLK`, `VIN`, `3V3`, `GND`, `DC`, `RST`, `CS` — not `SDA`, `SCL`, `VCC`.
 * Writing `oled:SDA` silently fails: the wire has no endpoint so the
 * canvas shows nothing but the controller still registers on I2C, hiding
 * the mistake.
 *
 * Usage:
 *   - Call from the UI to show warnings in a panel
 *   - Call from a test to fail CI on pin typos
 *   - Call from the oracle test to flag imports that won't work in Wokwi
 */

import type { Diagram } from "./diagram-parser";

export interface LintIssue {
  severity: "error" | "warning";
  ref: string;           // "partId:pinName" that failed to resolve
  partId: string;
  pinName: string;
  partType: string;
  message: string;
  validPins?: string[];  // what the user probably meant
  connectionIndex: number;
}

interface ElementLike {
  pinInfo?: { name: string }[];
}

/**
 * Lint a diagram against the live custom element registry. Elements must
 * already be registered via customElements.define — this function queries
 * the DOM to discover pin names.
 *
 * For server-side / headless linting, pass a `pinRegistry` that maps
 * `partType` → array of valid pin names.
 */
export function lintDiagram(
  diagram: Diagram,
  pinRegistry?: Map<string, string[]>,
): LintIssue[] {
  const issues: LintIssue[] = [];

  // Build a per-part pin-name lookup so we don't re-query the DOM for every
  // connection endpoint.
  const partPins = new Map<string, { type: string; pins: string[] }>();
  for (const part of diagram.parts) {
    let pins: string[] | undefined;
    // First check the explicit registry (for headless tests)
    if (pinRegistry?.has(part.type)) {
      pins = pinRegistry.get(part.type);
    } else if (typeof customElements !== "undefined") {
      // Instantiate the element and read its pinInfo (matches how
      // DiagramCanvas does pin resolution).
      const ctor = customElements.get(part.type);
      if (ctor) {
        try {
          const instance = new (ctor as unknown as new () => HTMLElement)() as unknown as ElementLike;
          if (instance.pinInfo) {
            pins = instance.pinInfo.map((p) => p.name);
          }
        } catch {
          // Constructing a custom element outside the DOM sometimes throws;
          // fall through to "unknown part" handling below.
        }
      }
    }
    if (pins) partPins.set(part.id, { type: part.type, pins });
  }

  // Walk every connection endpoint
  for (let i = 0; i < diagram.connections.length; i++) {
    const [fromRef, toRef] = diagram.connections[i];
    for (const ref of [fromRef, toRef]) {
      const idx = ref.indexOf(":");
      if (idx === -1) continue;
      const partId = ref.substring(0, idx);
      const pinName = ref.substring(idx + 1);

      const partInfo = partPins.get(partId);
      if (!partInfo) {
        // Unknown part — either a stale ref from an import or a custom
        // element that isn't registered yet. Emit a warning, not an error.
        const part = diagram.parts.find((p) => p.id === partId);
        if (!part) {
          issues.push({
            severity: "error",
            ref,
            partId,
            pinName,
            partType: "?",
            message: `Connection refers to unknown part "${partId}" — this is likely a stale reference from an imported project.`,
            connectionIndex: i,
          });
        }
        continue;
      }

      // Wokwi pin names sometimes include grouping suffixes like ".1", ".2",
      // ".l", ".r" — these are distinct pin instances on the element (e.g.
      // GND.1 / GND.2 / GND.3 on the Uno). Try the raw name first, then fall
      // back to the suffix-stripped base name.
      const strippedName = pinName.replace(/\.\d+$/, "").replace(/\.[lr]$/, "");
      const pinMatches =
        partInfo.pins.includes(pinName) || partInfo.pins.includes(strippedName);
      if (!pinMatches) {
        // Special-case common aliases so the message is helpful
        const suggestions = findSimilarPins(pinName, partInfo.pins);
        const validList = partInfo.pins.slice(0, 12).join(", ");
        const suggestionNote = suggestions.length > 0
          ? ` — did you mean ${suggestions.map((s) => `"${s}"`).join(" or ")}?`
          : "";
        issues.push({
          severity: "warning",
          ref,
          partId,
          pinName,
          partType: partInfo.type,
          validPins: partInfo.pins,
          message:
            `Pin "${pinName}" does not exist on ${partInfo.type} (id "${partId}")${suggestionNote} ` +
            `Valid pins: ${validList}${partInfo.pins.length > 12 ? ", ..." : ""}`,
          connectionIndex: i,
        });
      }
    }
  }

  return issues;
}

/**
 * Suggest pin names that might be what the user meant. Covers common aliases:
 *   SDA ↔ DATA, SCL ↔ CLK, VCC ↔ VIN/3V3, GND ↔ GND
 * plus simple case-insensitive matches.
 */
function findSimilarPins(typed: string, valid: string[]): string[] {
  const up = typed.toUpperCase();
  const aliases: Record<string, string[]> = {
    SDA: ["DATA", "SDA0", "SDA1"],
    SCL: ["CLK", "SCL0", "SCL1", "SCK"],
    VCC: ["VIN", "3V3", "5V", "VDD"],
    GND: ["GND", "VSS"],
    MOSI: ["SDI", "SI"],
    MISO: ["SDO", "SO"],
    RX: ["RXD", "RX0"],
    TX: ["TXD", "TX0"],
  };
  const hints = aliases[up] ?? [];
  const matches: string[] = [];
  for (const h of hints) {
    const found = valid.find((v) => v.toUpperCase() === h);
    if (found) matches.push(found);
  }
  if (matches.length > 0) return matches;

  // Fallback: case-insensitive match
  const ci = valid.find((v) => v.toUpperCase() === up);
  return ci ? [ci] : [];
}
