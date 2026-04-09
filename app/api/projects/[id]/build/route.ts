import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { writeFile, readFile, mkdir, rm } from "fs/promises";
import path from "path";
import os from "os";
import { nanoid } from "nanoid";
import { isLocalDev, localProjectExists } from "@/lib/local-projects";

const PIO_CMD = process.env.PIO_CMD
  || (isLocalDev() ? findLocalPio() : "/usr/bin/platformio");

function findLocalPio(): string {
  const candidates = [
    path.join(os.homedir(), ".platformio-venv/bin/platformio"),
    path.join(os.homedir(), ".local/bin/platformio"),
    "/opt/homebrew/bin/platformio",
    "/usr/local/bin/platformio",
  ];
  for (const p of candidates) {
    try { require("fs").accessSync(p); return p; } catch { /* next */ }
  }
  return "platformio"; // fall back to PATH
}
const SANDBOX_ENABLED = process.env.SANDBOX_ENABLED === "true";

const AVR_BOARDS = ["uno", "nano", "mega", "atmega328p", "leonardo", "micro", "pro", "promini"];
const ESP32_BOARDS = ["esp32dev", "esp32-s3-devkitc-1", "nodemcu-32s", "esp32-c3-devkitm-1"];
const VALID_BOARDS = [...AVR_BOARDS, ...ESP32_BOARDS];

function getPlatform(board: string): "atmelavr" | "espressif32" {
  return ESP32_BOARDS.includes(board) ? "espressif32" : "atmelavr";
}
const VALID_FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const VALID_LIB_NAME = /^[a-zA-Z0-9_.@\/ -]+$/;

// Map header files to PlatformIO library names/specs for auto-detection
const HEADER_TO_LIB: Record<string, string> = {
  // Arduino Core / Standard
  "ArduinoJson.h": "bblanchon/ArduinoJson",
  "EEPROM.h": "",  // built-in
  "FixedPoints.h": "Pharap/FixedPoints",
  "Geometry.h": "tomstewart89/Geometry",
  "Key.h": "",  // part of Keypad
  "Keypad.h": "chris--a/Keypad",
  "PID_v1.h": "br3ttb/Arduino-PID-Library",
  "SPI.h": "",  // built-in
  "SD.h": "arduino-libraries/SD",
  "SdFat.h": "greiman/SdFat",
  "SoftwareSerial.h": "",  // built-in
  "Stepper.h": "",  // built-in
  "TimeLib.h": "paulstoffregen/Time",
  "TimerOne.h": "paulstoffregen/TimerOne",
  "Ultrasonic.h": "ericsimon/Ultrasonic",
  "Wire.h": "",  // built-in

  // Adafruit
  "Adafruit_GFX.h": "adafruit/Adafruit GFX Library",
  "Adafruit_ILI9341.h": "adafruit/Adafruit ILI9341",
  "Adafruit_INA219.h": "adafruit/Adafruit INA219",
  "Adafruit_LEDBackpack.h": "adafruit/Adafruit LED Backpack Library",
  "Adafruit_MPU6050.h": "adafruit/Adafruit MPU6050",
  "Adafruit_NeoMatrix.h": "adafruit/Adafruit NeoMatrix",
  "Adafruit_NeoPixel.h": "adafruit/Adafruit NeoPixel",
  "Adafruit_SSD1306.h": "adafruit/Adafruit SSD1306",
  "Adafruit_BMP085.h": "adafruit/Adafruit BMP085 Library",
  "Adafruit_Sensor.h": "adafruit/Adafruit Unified Sensor",
  "Adafruit_SoftServo.h": "adafruit/Adafruit SoftServo",
  "Adafruit_ST7735.h": "adafruit/Adafruit ST7735 and ST7789 Library",
  "Adafruit_ST7789.h": "adafruit/Adafruit ST7735 and ST7789 Library",

  // Displays / Graphics
  "lcdgfx.h": "lexus2k/lcdgfx",
  "LiquidCrystal.h": "arduino-libraries/LiquidCrystal",
  "LiquidCrystal_I2C.h": "marcoschwartz/LiquidCrystal_I2C",
  "MD_MAX72xx.h": "majicdesigns/MD_MAX72XX",
  "MD_Parola.h": "majicdesigns/MD_Parola",
  "Segment.h": "pedrogoliveira/Segment",
  "SevSeg.h": "DeanIsMe/SevSeg",
  "ShiftDisplay.h": "MiguelPynto/ShiftDisplay",
  "SSD1306Ascii.h": "greiman/SSD1306Ascii",
  "SSD1306AsciiWire.h": "greiman/SSD1306Ascii",
  "ssd1306.h": "lexus2k/ssd1306",
  "SSD1306init.h": "greiman/SSD1306Ascii",
  "TM1637TinyDisplay.h": "jasonacox/TM1637TinyDisplay",
  "Tiny4kOLED.h": "datacute/Tiny4kOLED",
  "U8g2lib.h": "olikraus/U8g2",
  "U8glib.h": "olikraus/U8glib",
  "U8x8lib.h": "olikraus/U8g2",

  // LEDs
  "FastLED.h": "fastled/FastLED",
  "FastLED_NeoMatrix.h": "marcmerlin/FastLED NeoMatrix",
  "LedControl.h": "wayoda/LedControl",
  "blinker.h": "blinker",

  // Sensors
  "AccelStepper.h": "waspinator/AccelStepper",
  "basicMPU6050.h": "RCmags/basicMPU6050",
  "DallasTemperature.h": "milesburton/DallasTemperature",
  "DHT.h": "adafruit/DHT sensor library",
  "dht.h": "adafruit/DHT sensor library",
  "DHT_U.h": "adafruit/DHT sensor library",
  "DHTesp.h": "beegee-tokyo/DHTesp",
  "DS3231.h": "andrew-henry/DS3231",
  "I2Cdev.h": "jrowberg/I2Cdevlib-Core",
  "MPU6050.h": "electroniccats/MPU6050",
  "OneWire.h": "paulstoffregen/OneWire",
  "SimpleDHT.h": "winlinvip/SimpleDHT",

  // Input / Control
  "Bounce2.h": "thomasfredericks/Bounce2",
  "Button.h": "madleech/Button",
  "Encoder.h": "paulstoffregen/Encoder",
  "mechButton.h": "jim-lee/mechButton",
  "OneButton.h": "mathertel/OneButton",
  "Servo.h": "arduino-libraries/Servo",
  "ServoEasing.h": "arminjo/ServoEasing",
  "VarSpeedServo.h": "netlabtoolkit/VarSpeedServo",

  // Timing / Scheduling / Utilities
  "TaskScheduler.h": "arkhipenko/TaskScheduler",
  "SimpleTimer.h": "kiryanenko/SimpleTimer",
  "runningAvg.h": "robtillaart/RunningAverage",
  "TinyDebug.h": "jdolinay/avr-debugger",
  "TinyWireM.h": "adafruit/TinyWireM",
  "timeObj.h": "jim-lee/LC_baseTools",

  // Audio / Misc
  "Talkie.h": "going-digital/Talkie",
  "pitches.h": "",  // local file
  "PlayRtttl.h": "arminjo/PlayRtttl",
  "Midier.h": "razhaleva/Midier",
  "qrcode.h": "ricmoo/QRCode",
  "pt.h": "benhoyt/protothreads",
  "protothreads.h": "benhoyt/protothreads",

  // Networking / Platform
  "WiFiNINA.h": "arduino-libraries/WiFiNINA",
  "RTClib.h": "adafruit/RTClib",
  "idlers.h": "jim-lee/LC_baseTools",
  "IRremote.h": "Arduino-IRremote/Arduino-IRremote",
  "IRremoteInt.h": "Arduino-IRremote/Arduino-IRremote",

  // ESP32-specific (built-in to ESP32 Arduino core)
  "WiFi.h": "",  // built-in for ESP32, not available on AVR
  "WiFiClient.h": "",
  "WiFiServer.h": "",
  "WiFiUdp.h": "",
  "WebServer.h": "",
  "ESPmDNS.h": "",
  "BLEDevice.h": "",
  "BLEUtils.h": "",
  "BLEServer.h": "",
  "BluetoothSerial.h": "",
  "esp_wifi.h": "",
  "esp_system.h": "",
  "esp_sleep.h": "",
  "driver/ledc.h": "",
  "driver/adc.h": "",
  "HTTPClient.h": "",
  "AsyncTCP.h": "me-no-dev/AsyncTCP",
  "ESPAsyncWebServer.h": "me-no-dev/ESPAsyncWebServer",
  "PubSubClient.h": "knolleary/PubSubClient",
  "ArduinoOTA.h": "",
  "Update.h": "",
  "Preferences.h": "",
  "SPIFFS.h": "",
  "FS.h": "",
};

/** Extract #include headers from source code and return PlatformIO lib deps. */
function detectLibsFromSource(source: string): string[] {
  const includes = source.matchAll(/#include\s*[<"]([^>"]+)[>"]/g);
  const libs = new Set<string>();
  for (const m of includes) {
    const header = m[1];
    const lib = HEADER_TO_LIB[header];
    if (lib) libs.add(lib);
  }
  return Array.from(libs);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return NextResponse.json(
        { success: false, error: "Invalid project ID" },
        { status: 400 },
      );
    }

    let projectId = id;

    if (isLocalDev()) {
      if (!(await localProjectExists(id))) {
        return NextResponse.json({ success: false, error: "Project not found" }, { status: 404 });
      }
    } else {
      const { getServerSession } = await import("@/lib/auth-middleware");
      const { authorizeProjectRead } = await import("@/lib/auth-middleware");

      const session = await getServerSession();
      if (!session?.user) {
        return NextResponse.json(
          { success: false, error: "Sign in to build projects" },
          { status: 401 },
        );
      }

      const readResult = await authorizeProjectRead(id);
      if (readResult.error) return readResult.error;
      projectId = readResult.project.id;
    }

    const buildStart = Date.now();

    // Per-build temp directory for concurrency safety
    const BUILD_DIR = path.join(os.tmpdir(), `sparkbench-build-${nanoid(8)}`);
    await mkdir(BUILD_DIR, { recursive: true });

    try {

    const data = await request.json();
    const board = data.board || "uno";
    if (!VALID_BOARDS.includes(board)) {
      return NextResponse.json(
        { success: false, error: `Invalid board type. Valid boards: ${VALID_BOARDS.join(", ")}` },
        { status: 400 },
      );
    }
    const files: { name: string; content: string }[] = data.files || [];
    const librariesTxt: string = data.librariesTxt || "";

    // Parse libraries.txt into library names (validate to prevent INI injection)
    const extraLibs = librariesTxt
      .split("\n")
      .map((l: string) => l.trim())
      .filter((l: string) => l && !l.startsWith("#") && VALID_LIB_NAME.test(l));

    // Auto-detect libraries from #include directives in sketch + extra files
    const allSources = [data.sketch || "", ...files.map((f: { content: string }) => f.content || "")].join("\n");
    const detectedLibs = detectLibsFromSource(allSources);

    // Build platformio.ini with library dependencies
    const baseLibDeps = [
      "arduino-libraries/Servo@^1.2.1",
      "adafruit/DHT sensor library@^1.4.6",
      "adafruit/Adafruit Unified Sensor@^1.1.14",
    ];
    const seen = new Set(baseLibDeps.map((l) => l.toLowerCase()));
    const allLibDeps = [...baseLibDeps];
    for (const lib of [...detectedLibs, ...extraLibs]) {
      const key = lib.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        allLibDeps.push(lib);
      }
    }
    const libDepsStr = allLibDeps.map((l) => `  ${l}`).join("\n");

    // In sandboxed mode, libs are pre-installed globally in the Docker image.
    // Skip lib_deps (which triggers network downloads) and use lib_extra_dirs instead.
    const libSection = SANDBOX_ENABLED
      ? `lib_extra_dirs = /home/sandbox/.platformio/lib`
      : `lib_deps =\n${libDepsStr}`;

    const platform = getPlatform(board);

    // Generate platformio.ini environments for all supported boards
    const avrEnvs = AVR_BOARDS.map((b) => {
      const pioBoard = b === "atmega328p" ? "uno" : b;
      return `[env:${b}]\nplatform = atmelavr\nboard = ${pioBoard}\nframework = arduino\n${libSection}\n`;
    }).join("\n");

    const esp32Envs = ESP32_BOARDS.map((b) => {
      return `[env:${b}]\nplatform = espressif32\nboard = ${b}\nframework = arduino\nmonitor_speed = 115200\n${libSection}\n`;
    }).join("\n");

    const pioIni = `${avrEnvs}\n${esp32Envs}`;
    await writeFile(path.join(BUILD_DIR, "platformio.ini"), pioIni);

    // Ensure build directories exist
    const srcDir = path.join(BUILD_DIR, "src");
    const includeDir = path.join(BUILD_DIR, "include");
    await mkdir(srcDir, { recursive: true });
    await mkdir(includeDir, { recursive: true });

    // Clean previous build source files
    await rm(srcDir, { recursive: true, force: true });
    await rm(includeDir, { recursive: true, force: true });
    await mkdir(srcDir, { recursive: true });
    await mkdir(includeDir, { recursive: true });

    // Write extra files (headers, etc.) — validate names to prevent path traversal.
    // Skip .chip.c / .chip.json files: those are Wokwi custom chip sources
    // compiled separately by `wokwi-cli chip compile`, not by avr-gcc.
    for (const f of files) {
      if (!f.name || !f.content) continue;
      if (f.name.endsWith(".chip.c") || f.name.endsWith(".chip.json")) continue;
      const safeName = path.basename(f.name);
      if (!VALID_FILENAME.test(safeName)) continue;
      const targetDir = safeName.endsWith(".h") ? includeDir : srcDir;
      const dest = path.join(targetDir, safeName);
      const resolved = path.resolve(dest);
      if (!resolved.startsWith(BUILD_DIR)) continue;
      await writeFile(dest, f.content);
    }

    // Get main sketch code
    let sketch = data.sketch || "";
    if (!sketch) {
      return NextResponse.json(
        { success: false, error: "No source code provided" },
        { status: 400 },
      );
    }

    // Auto-add Arduino.h for .ino-style sketches compiled as .cpp
    if (
      !sketch.includes('#include <Arduino.h>') &&
      !sketch.includes('#include "Arduino.h"')
    ) {
      sketch = '#include <Arduino.h>\n' + sketch;
    }

    // Write main source
    await writeFile(path.join(srcDir, "main.cpp"), sketch);

    // Create build record
    const buildId = nanoid(10);

    // Compile with PlatformIO (sandboxed or direct)
    let result: { code: number; stdout: string; stderr: string };
    let sandboxArtifacts: Map<string, Buffer> | undefined;

    const firmwareExt = platform === "espressif32" ? "bin" : "hex";
    const firmwareFile = `firmware.${firmwareExt}`;

    if (SANDBOX_ENABLED) {
      const { runProjectBuild } = await import("@/lib/sandbox");
      const sbResult = await runProjectBuild(projectId, {
        projectDir: BUILD_DIR,
        command: ["platformio", "run", "-e", board],
        timeout: 120_000,
        artifactPaths: [
          `.pio/build/${board}/${firmwareFile}`,
          `.pio/build/${board}/firmware.elf`,
        ],
      });
      result = {
        code: sbResult.exitCode,
        stdout: sbResult.stdout,
        stderr: sbResult.stderr,
      };
      sandboxArtifacts = sbResult.artifacts;
    } else {
      result = await new Promise<{
        code: number;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        execFile(
          PIO_CMD,
          ["run", "-e", board],
          { cwd: BUILD_DIR, timeout: 120_000 },
          (error, stdout, stderr) => {
            resolve({
              code:
                typeof error?.code === "number" ? error.code : error ? 1 : 0,
              stdout: stdout || "",
              stderr: stderr || "",
            });
          },
        );
      });
    }

    if (result.code !== 0) {
      // Record failed build (production only)
      if (!isLocalDev()) {
        const { db } = await import("@/lib/db");
        const { builds } = await import("@/lib/db/schema");
        const { logActivity } = await import("@/lib/logger");

        await db.insert(builds).values({
          id: buildId,
          projectId,
          status: "error",
          board,
          stdout: result.stdout,
          stderr: result.stderr,
        });

        logActivity("build.error", {
          projectId,
          metadata: { board, buildId },
          durationMs: Date.now() - buildStart,
        });
      }

      return NextResponse.json({
        success: false,
        error: result.stderr || "Compilation failed",
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }

    // Read firmware file (from sandbox artifacts or local filesystem)
    const firmwareArtifactKey = `.pio/build/${board}/${firmwareFile}`;
    let hex: string;
    let bin: string | undefined;

    if (platform === "espressif32") {
      // ESP32: read .bin as base64
      let binBuffer: Buffer;
      if (sandboxArtifacts?.has(firmwareArtifactKey)) {
        binBuffer = sandboxArtifacts.get(firmwareArtifactKey)!;
      } else {
        const binPath = path.join(BUILD_DIR, ".pio", "build", board, firmwareFile);
        binBuffer = await readFile(binPath);
      }
      bin = binBuffer.toString("base64");
      hex = ""; // no hex for ESP32
    } else {
      // AVR: read .hex as text
      if (sandboxArtifacts?.has(firmwareArtifactKey)) {
        hex = sandboxArtifacts.get(firmwareArtifactKey)!.toString("utf-8");
      } else {
        const hexPath = path.join(BUILD_DIR, ".pio", "build", board, firmwareFile);
        hex = await readFile(hexPath, "utf-8");
      }
    }

    // Extract source map for debug mode (AVR only — needs avr-objdump)
    let sourceMap: { file: string; line: number; address: number }[] | undefined;
    if (data.debug && platform === "atmelavr") {
      try {
        // When sandboxed, write the ELF artifact to disk for objdump
        const elfPath = path.join(BUILD_DIR, ".pio", "build", board, "firmware.elf");
        const elfArtifactKey = `.pio/build/${board}/firmware.elf`;
        if (sandboxArtifacts?.has(elfArtifactKey)) {
          const elfDir = path.dirname(elfPath);
          await mkdir(elfDir, { recursive: true });
          await writeFile(elfPath, sandboxArtifacts.get(elfArtifactKey)!);
        }

        const pioDir = process.env.PLATFORMIO_CORE_DIR || path.join(os.homedir(), ".platformio");
        const objdumpPath = path.join(
          pioDir,
          "packages/toolchain-atmelavr/bin/avr-objdump",
        );
        const dwarfResult = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
          execFile(
            objdumpPath,
            ["--dwarf=decodedline", elfPath],
            { timeout: 30_000 },
            (_error, stdout, stderr) => {
              resolve({ stdout: stdout || "", stderr: stderr || "" });
            },
          );
        });
        sourceMap = parseDwarfLineInfo(dwarfResult.stdout);
      } catch {
        // Source map extraction is best-effort; continue without it
      }
    }

    // Record build in production (DB + MinIO)
    if (!isLocalDev()) {
      const { db } = await import("@/lib/db");
      const { builds } = await import("@/lib/db/schema");
      const { uploadFile } = await import("@/lib/storage");
      const { logActivity } = await import("@/lib/logger");

      const hexKey = `builds/${buildId}/${firmwareFile}`;
      const uploadContent = platform === "espressif32" ? bin! : hex;
      await uploadFile(projectId, hexKey, uploadContent);

      await db.insert(builds).values({
        id: buildId,
        projectId,
        status: "success",
        board,
        hexKey,
        stdout: result.stdout,
        stderr: result.stderr,
      });

      logActivity("build.success", {
        projectId,
        metadata: { board, buildId, platform },
        durationMs: Date.now() - buildStart,
      });
    }

    return NextResponse.json({
      success: true,
      firmware: firmwareFile,
      hex,
      ...(bin ? { bin } : {}),
      platform,
      simulatable: platform === "atmelavr",
      stdout: result.stdout,
      stderr: result.stderr,
      ...(sourceMap ? { sourceMap } : {}),
    });

    } finally {
      // Clean up per-build temp directory
      rm(BUILD_DIR, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    console.error("Build error:", err);
    return NextResponse.json(
      { success: false, error: "Internal build error" },
      { status: 500 },
    );
  }
}

/**
 * Parse avr-objdump --dwarf=decodedline output into source map entries.
 * Output format:
 *   File name   Line number    Starting address    View    Stmt
 *   main.cpp             10          0x00000080               x
 */
function parseDwarfLineInfo(
  output: string,
): { file: string; line: number; address: number }[] {
  const entries: { file: string; line: number; address: number }[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    // Match lines like: main.cpp             10          0x00000080               x
    const match = line.match(
      /^(\S+)\s+(\d+)\s+0x([0-9a-fA-F]+)/,
    );
    if (!match) continue;
    const [, file, lineStr, addrHex] = match;
    const byteAddr = parseInt(addrHex, 16);
    entries.push({
      file,
      line: parseInt(lineStr, 10),
      address: byteAddr >> 1, // convert byte address to word address
    });
  }
  return entries;
}
