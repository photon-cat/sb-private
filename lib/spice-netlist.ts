import type { Diagram, DiagramPart } from "./diagram-parser";
import { extractNetlist, type Netlist } from "./netlist";

export interface SpiceElement {
  name: string;
  nodes: string[];
  value: string;
  model?: string;
}

export interface SpiceAnalysis {
  type: "tran" | "dc" | "ac" | "op";
  params: string;
}

export interface SpiceCircuit {
  title: string;
  elements: SpiceElement[];
  models: string[];
  analyses: SpiceAnalysis[];
  nodeMap: Map<string, number>;
}

const GROUND_PINS = new Set(["GND", "GND.1", "GND.2", "GND2"]);
const POWER_PINS: Record<string, number> = {
  "5V": 5,
  VCC: 5,
  "3.3V": 3.3,
  AVCC: 5,
};

function sanitizeSpiceValue(raw: string): string {
  return raw.replace(/[^\d.eE+\-kKmMgGpPnNuUfF]/g, "");
}

function parseResistance(raw: string): string {
  const cleaned = sanitizeSpiceValue(raw.trim()).toUpperCase();
  const match = cleaned.match(/^([\d.]+)\s*([KMG]?)$/);
  if (!match) return cleaned || "1000";
  const num = parseFloat(match[1]);
  const suffix = match[2];
  if (suffix === "K") return String(num * 1e3);
  if (suffix === "M") return String(num * 1e6);
  if (suffix === "G") return String(num * 1e9);
  return String(num);
}

function parseCapacitance(raw: string): string {
  const cleaned = sanitizeSpiceValue(raw.trim()).toUpperCase();
  const match = cleaned.match(/^([\d.]+)\s*([PNU]?F?)$/);
  if (!match) return cleaned || "100n";
  const num = parseFloat(match[1]);
  const suffix = match[2].replace("F", "");
  if (suffix === "P") return `${num}p`;
  if (suffix === "N") return `${num}n`;
  if (suffix === "U") return `${num}u`;
  return String(num);
}

function assignNodeNumbers(netlist: Netlist, diagram: Diagram): Map<string, number> {
  const nodeMap = new Map<string, number>();
  let nextNode = 1;

  const mcuParts = new Set<string>();
  for (const part of diagram.parts) {
    if (part.type.includes("arduino") || part.type.includes("atmega") || part.type.includes("esp32") || part.type.includes("stm32")) {
      mcuParts.add(part.id);
    }
  }

  for (const net of netlist.nets) {
    const isGround = net.pins.some((pin) => {
      const [partId, pinName] = pin.split(":");
      return GROUND_PINS.has(pinName) || net.name === "GND";
    });

    if (isGround) {
      nodeMap.set(net.name, 0);
    } else {
      nodeMap.set(net.name, nextNode++);
    }
  }

  return nodeMap;
}

function partToSpiceElements(
  part: DiagramPart,
  netlist: Netlist,
  nodeMap: Map<string, number>,
  counters: Map<string, number>,
): { elements: SpiceElement[]; models: string[] } {
  const elements: SpiceElement[] = [];
  const models: string[] = [];

  const getNode = (pinRef: string): string => {
    const netName = netlist.pinToNet.get(pinRef);
    if (!netName) return "?";
    const num = nodeMap.get(netName);
    return num !== undefined ? String(num) : "?";
  };

  const nextName = (prefix: string): string => {
    const count = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, count);
    return `${prefix}${count}`;
  };

  switch (part.type) {
    case "wokwi-resistor": {
      const value = parseResistance(part.attrs.value || "1000");
      elements.push({
        name: nextName("R"),
        nodes: [getNode(`${part.id}:1`), getNode(`${part.id}:2`)],
        value,
      });
      break;
    }

    case "wokwi-capacitor": {
      const value = parseCapacitance(part.attrs.value || "100n");
      elements.push({
        name: nextName("C"),
        nodes: [getNode(`${part.id}:1`), getNode(`${part.id}:2`)],
        value,
      });
      break;
    }

    case "wokwi-led": {
      elements.push({
        name: nextName("D"),
        nodes: [getNode(`${part.id}:A`), getNode(`${part.id}:C`)],
        value: "LED",
        model: "LED",
      });
      if (!models.includes(".model LED D(IS=1e-20 N=1.8 RS=5 BV=5 IBV=100u)")) {
        models.push(".model LED D(IS=1e-20 N=1.8 RS=5 BV=5 IBV=100u)");
      }
      break;
    }

    case "wokwi-potentiometer":
    case "wokwi-slide-potentiometer": {
      // For wokwi potentiometers, `attrs.value` is the WIPER POSITION (0-1023),
      // not the resistance. Total resistance comes from `attrs.resistance`
      // (ohms) when present, defaulting to a typical 10k pot.
      const totalR = parseFloat(parseResistance(part.attrs.resistance || "10000"));
      const wiper = parseInt(part.attrs.value || "512", 10);
      const ratio = Math.max(0, Math.min(1, wiper / 1023));
      // GND→wiper leg scales with position; wiper→VCC leg with its complement.
      const r1 = totalR * ratio;
      const r2 = totalR * (1 - ratio);
      const wiperNode = nextName("n_wiper_");
      elements.push({
        name: nextName("R"),
        nodes: [getNode(`${part.id}:GND`), wiperNode],
        value: String(Math.max(r1, 0.1)),
      });
      elements.push({
        name: nextName("R"),
        nodes: [wiperNode, getNode(`${part.id}:VCC`)],
        value: String(Math.max(r2, 0.1)),
      });
      elements.push({
        name: nextName("R"),
        nodes: [wiperNode, getNode(`${part.id}:SIG`)],
        value: "0.1",
      });
      break;
    }

    case "wokwi-buzzer": {
      elements.push({
        name: nextName("R"),
        nodes: [getNode(`${part.id}:1`), getNode(`${part.id}:2`)],
        value: "32",
      });
      break;
    }
  }

  return { elements, models };
}

export function generateSpiceNetlist(
  diagram: Diagram,
  analyses?: SpiceAnalysis[],
  title?: string,
): SpiceCircuit {
  const netlist = extractNetlist(diagram);
  const nodeMap = assignNodeNumbers(netlist, diagram);
  const counters = new Map<string, number>();
  const allElements: SpiceElement[] = [];
  const allModels: string[] = [];

  const powerNets = new Set<string>();
  for (const net of netlist.nets) {
    for (const pin of net.pins) {
      const [, pinName] = pin.split(":");
      if (pinName && POWER_PINS[pinName] !== undefined) {
        const voltage = POWER_PINS[pinName];
        const nodeNum = nodeMap.get(net.name);
        if (nodeNum !== undefined && nodeNum !== 0 && !powerNets.has(net.name)) {
          powerNets.add(net.name);
          const count = (counters.get("V") ?? 0) + 1;
          counters.set("V", count);
          allElements.push({
            name: `V${count}`,
            nodes: [String(nodeNum), "0"],
            value: `${voltage}`,
          });
        }
      }
    }
  }

  for (const part of diagram.parts) {
    const { elements, models } = partToSpiceElements(part, netlist, nodeMap, counters);
    allElements.push(...elements);
    for (const m of models) {
      if (!allModels.includes(m)) allModels.push(m);
    }
  }

  const defaultAnalyses: SpiceAnalysis[] = analyses ?? [
    { type: "op", params: "" },
  ];

  return {
    title: title ?? "SparkBench Circuit",
    elements: allElements,
    models: allModels,
    analyses: defaultAnalyses,
    nodeMap,
  };
}

export function spiceCircuitToString(circuit: SpiceCircuit): string {
  const lines: string[] = [];

  lines.push(`* ${circuit.title.replace(/[\r\n]/g, " ")}`);
  lines.push("");

  for (const model of circuit.models) {
    lines.push(model);
  }
  if (circuit.models.length > 0) lines.push("");

  for (const el of circuit.elements) {
    const nodePart = el.nodes.join(" ");
    if (el.model) {
      lines.push(`${el.name} ${nodePart} ${el.model}`);
    } else {
      lines.push(`${el.name} ${nodePart} ${el.value}`);
    }
  }
  lines.push("");

  for (const analysis of circuit.analyses) {
    switch (analysis.type) {
      case "op":
        lines.push(".op");
        break;
      case "tran":
        lines.push(`.tran ${analysis.params}`);
        break;
      case "dc":
        lines.push(`.dc ${analysis.params}`);
        break;
      case "ac":
        lines.push(`.ac ${analysis.params}`);
        break;
    }
  }

  lines.push(".end");
  return lines.join("\n");
}
