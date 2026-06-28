import { describe, it, expect } from "vitest";
import { generatePlatformioIni } from "../sim/firmware-builder";

describe("generatePlatformioIni", () => {
  it("emits the env header and base lib_deps", () => {
    const ini = generatePlatformioIni("void setup(){}\nvoid loop(){}", "", "uno");
    expect(ini).toContain("[env:uno]");
    expect(ini).toContain("platform = atmelavr");
    expect(ini).toContain("board = uno");
    expect(ini).toContain("framework = arduino");
    // Base deps are always present
    expect(ini).toContain("arduino-libraries/Servo");
  });

  it("aliases atmega328p board to uno", () => {
    const ini = generatePlatformioIni("", "", "atmega328p");
    expect(ini).toContain("[env:atmega328p]");
    expect(ini).toContain("board = uno");
  });

  it("detects libraries from #include headers", () => {
    const sketch = `#include <Adafruit_SSD1306.h>\n#include <Adafruit_GFX.h>\nvoid setup(){}`;
    const ini = generatePlatformioIni(sketch, "", "uno");
    expect(ini).toContain("adafruit/Adafruit SSD1306");
    expect(ini).toContain("adafruit/Adafruit GFX Library");
  });

  it("includes extra libs from libraries.txt and ignores comments", () => {
    const libs = "# a comment\nbblanchon/ArduinoJson\n\n  marcoschwartz/LiquidCrystal_I2C  ";
    const ini = generatePlatformioIni("void setup(){}", libs, "uno");
    expect(ini).toContain("bblanchon/ArduinoJson");
    expect(ini).toContain("marcoschwartz/LiquidCrystal_I2C");
    expect(ini).not.toContain("# a comment");
  });

  it("deduplicates a library that appears in both detection and base deps", () => {
    // Servo.h maps to arduino-libraries/Servo which is also a base dep.
    const sketch = `#include <Servo.h>\nvoid setup(){}`;
    const ini = generatePlatformioIni(sketch, "", "uno");
    const occurrences = ini.split("\n").filter((l) => l.includes("arduino-libraries/Servo")).length;
    expect(occurrences).toBe(1);
  });
});
