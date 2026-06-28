#!/usr/bin/env npx tsx
/**
 * sparkbench create — Scaffold a new SparkBench project.
 *
 * Usage:
 *   sparkbench create <name> [--template <template>] [--mcu <board>]
 *   sparkbench create <name> --mcu uno --part led:led1 --wire uno:13:led1:A
 */

import { mkdirSync, writeFileSync, existsSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const PROJECTS_DIR = path.join(ROOT, "projects");

interface CreateArgs {
  name: string;
  template: string;
  mcu: string;
  parts: string[];
  wires: string[];
}

function parseArgs(argv: string[]): CreateArgs {
  const out: CreateArgs = {
    name: "",
    template: "uno-led",
    mcu: "uno",
    parts: [],
    wires: [],
  };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--template":
      case "-t":
        out.template = argv[++i];
        break;
      case "--mcu":
        out.mcu = argv[++i];
        break;
      case "--part":
        out.parts.push(argv[++i]);
        break;
      case "--wire":
        out.wires.push(argv[++i]);
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        rest.push(a);
    }
  }

  if (rest.length === 0) {
    printUsage();
    process.exit(2);
  }
  out.name = rest[0];
  return out;
}

function printUsage() {
  console.log(`Usage: sparkbench create <name> [options]

Options:
  --template <name>   Template: uno-led, uno-serial, custom-chip (default: uno-led)
  --mcu <board>       MCU type: uno, nano, mega, atmega328p (default: uno)
  --part <type:id>    Add a part (e.g. led:led1, resistor:r1)
  --wire <from:to>    Add a wire (e.g. uno:13:r1:1)
  -h, --help          Show this help

Templates:
  uno-led             Arduino Uno + LED + resistor (blink)
  uno-serial          Arduino Uno with serial output
  custom-chip         Arduino Uno + custom chip scaffold`);
}

const MCU_TYPES: Record<string, string> = {
  uno: "wokwi-arduino-uno",
  nano: "wokwi-arduino-nano",
  mega: "wokwi-arduino-mega",
  atmega328p: "sb-atmega328",
};

interface Template {
  sketch: string;
  diagram: object;
  scenario?: string;
  chipJson?: string;
  chipC?: string;
}

function getTemplate(name: string, mcu: string): Template {
  const mcuType = MCU_TYPES[mcu] ?? "wokwi-arduino-uno";

  switch (name) {
    case "uno-led":
      return {
        sketch: `void setup() {
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, HIGH);
  delay(500);
  digitalWrite(13, LOW);
  delay(500);
}
`,
        diagram: {
          version: 1,
          author: "",
          editor: "sparkbench",
          parts: [
            { type: mcuType, id: "uno", top: 147, left: 15 },
            { type: "wokwi-resistor", id: "r1", top: 67, left: 115, rotate: 90, attrs: { value: "220" } },
            { type: "wokwi-led", id: "led1", top: 0, left: 120, attrs: { color: "red" } },
          ],
          connections: [
            ["uno:GND.1", "led1:C", "black", []],
            ["r1:1", "led1:A", "blue", []],
            ["uno:13", "r1:2", "blue", []],
          ],
        },
        scenario: `name: LED blink test
steps:
  # The sketch toggles pin 13 every 500ms; assert the pin actually changes state.
  - expect-pin:
      pin: "13"
      state: high
      timeout: 700
  - expect-pin:
      pin: "13"
      state: low
      timeout: 700
`,
      };

    case "uno-serial":
      return {
        sketch: `void setup() {
  Serial.begin(9600);
  Serial.println("READY");
}

void loop() {
  Serial.println("Hello, SparkBench!");
  delay(1000);
}
`,
        diagram: {
          version: 1,
          author: "",
          editor: "sparkbench",
          parts: [
            { type: mcuType, id: "uno", top: 0, left: 0 },
          ],
          connections: [],
          serialMonitor: { display: "terminal" },
        },
        scenario: `name: Serial output test
steps:
  - delay: 100
  - expect-serial: "READY"
  - delay: 1100
  - expect-serial: "Hello, SparkBench!"
`,
      };

    case "custom-chip":
      return {
        sketch: `void setup() {
  Serial.begin(9600);
  pinMode(2, OUTPUT);
  Serial.println("READY");
}

void loop() {
  digitalWrite(2, HIGH);
  delay(100);
  digitalWrite(2, LOW);
  delay(100);
}
`,
        diagram: {
          version: 1,
          author: "",
          editor: "sparkbench",
          parts: [
            { type: mcuType, id: "uno", top: 0, left: 0 },
            { type: "chip-inverter", id: "chip1", top: -100, left: 200, attrs: {} },
          ],
          connections: [
            ["uno:2", "chip1:IN", "green", []],
            ["chip1:VCC", "uno:5V", "red", []],
            ["chip1:GND", "uno:GND.1", "black", []],
          ],
        },
        chipJson: JSON.stringify(
          {
            name: "Inverter",
            author: "",
            pins: ["VCC", "GND", "IN", "OUT"],
            controls: {},
          },
          null,
          2,
        ),
        chipC: `#include "wokwi-api.h"
#include <stdio.h>

static pin_t pin_in;
static pin_t pin_out;

void chip_init() {
  pin_in = pin_init("IN", INPUT);
  pin_out = pin_init("OUT", OUTPUT);
  printf("inverter: init\\n");
}

void chip_pin_change(pin_t pin, uint32_t value) {
  if (pin == pin_in) {
    pin_write(pin_out, !value);
  }
}
`,
        scenario: `name: Custom chip inverter test
steps:
  - delay: 200
  - expect-serial: "READY"
`,
      };

    default:
      throw new Error(`Unknown template: ${name}. Available: uno-led, uno-serial, custom-chip`);
  }
}

function buildCustomDiagram(mcu: string, parts: string[], wires: string[]): object {
  const mcuType = MCU_TYPES[mcu] ?? "wokwi-arduino-uno";
  const diagramParts: object[] = [
    { type: mcuType, id: "uno", top: 0, left: 0 },
  ];

  const partTypeMap: Record<string, string> = {
    led: "wokwi-led",
    resistor: "wokwi-resistor",
    button: "wokwi-pushbutton",
    pot: "wokwi-potentiometer",
    servo: "wokwi-servo",
    buzzer: "wokwi-buzzer",
    switch: "wokwi-slide-switch",
    encoder: "wokwi-ky-040",
    dht22: "wokwi-dht22",
    ssd1306: "wokwi-ssd1306",
    lcd1602: "wokwi-lcd1602",
  };

  let topOffset = -80;
  for (const partSpec of parts) {
    const [type, id] = partSpec.split(":");
    if (!type || !id) {
      throw new Error(`Invalid part spec: ${partSpec}. Expected type:id (e.g. led:led1)`);
    }
    const wokwiType = partTypeMap[type] ?? `wokwi-${type}`;
    diagramParts.push({
      type: wokwiType,
      id,
      top: topOffset,
      left: 200,
      attrs: type === "resistor" ? { value: "220" } : {},
    });
    topOffset -= 60;
  }

  const connections: string[][] = [];
  for (const wireSpec of wires) {
    const segments = wireSpec.split(":");
    if (segments.length !== 4) {
      throw new Error(`Invalid wire spec: ${wireSpec}. Expected from_part:from_pin:to_part:to_pin`);
    }
    const [fromPart, fromPin, toPart, toPin] = segments;
    connections.push([`${fromPart}:${fromPin}`, `${toPart}:${toPin}`, "green", []]);
  }

  return {
    version: 1,
    author: "",
    editor: "sparkbench",
    parts: diagramParts,
    connections,
  };
}

// ── Main ──────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const projDir = path.join(PROJECTS_DIR, args.name);

if (existsSync(projDir)) {
  console.error(`Error: Project '${args.name}' already exists at ${projDir}`);
  process.exit(1);
}

if (args.parts.length > 0 || args.wires.length > 0) {
  // Custom project from --part/--wire flags
  mkdirSync(projDir, { recursive: true });

  const diagram = buildCustomDiagram(args.mcu, args.parts, args.wires);
  writeFileSync(path.join(projDir, "diagram.json"), JSON.stringify(diagram, null, 2));
  writeFileSync(
    path.join(projDir, "sketch.ino"),
    `void setup() {
  Serial.begin(9600);
  Serial.println("READY");
}

void loop() {
  delay(1000);
}
`,
  );
  console.log(`Created project: ${args.name}`);
  console.log(`  ${projDir}/diagram.json`);
  console.log(`  ${projDir}/sketch.ino`);
} else {
  // Template-based project
  const template = getTemplate(args.template, args.mcu);

  mkdirSync(projDir, { recursive: true });

  writeFileSync(path.join(projDir, "diagram.json"), JSON.stringify(template.diagram, null, 2));
  writeFileSync(path.join(projDir, "sketch.ino"), template.sketch);

  if (template.scenario) {
    writeFileSync(path.join(projDir, "test.scenario.yaml"), template.scenario);
  }
  if (template.chipJson) {
    writeFileSync(path.join(projDir, "inverter.chip.json"), template.chipJson);
  }
  if (template.chipC) {
    writeFileSync(path.join(projDir, "inverter.chip.c"), template.chipC);
  }

  console.log(`Created project: ${args.name} (template: ${args.template})`);
  console.log(`  ${projDir}/diagram.json`);
  console.log(`  ${projDir}/sketch.ino`);
  if (template.scenario) console.log(`  ${projDir}/test.scenario.yaml`);
  if (template.chipJson) console.log(`  ${projDir}/inverter.chip.json`);
  if (template.chipC) console.log(`  ${projDir}/inverter.chip.c`);
}
