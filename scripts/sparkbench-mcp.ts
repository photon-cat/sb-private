#!/usr/bin/env npx tsx
/**
 * SparkBench stdio MCP server.
 *
 * Exposes the SparkBench headless simulator to external MCP clients (Claude
 * Desktop / Code, Cursor, any MCP host) so an AI can compile a project, step
 * the simulation, inspect serial / pins / displays and drive controls — across
 * AVR, STM32 and RP2040, all via the unified {@link SimSession} / HeadlessMcu.
 *
 * Transport is stdio: stdout carries the MCP protocol, so ALL logging goes to
 * stderr. The server is scoped to a single project directory, passed as the
 * positional arg or via SPARKBENCH_PROJECT_DIR (defaults to cwd).
 *
 *   npx tsx scripts/sparkbench-mcp.ts projects/rp2040-i2c
 *
 * Tools are prefixed `sparkbench_`; where wokwi-cli mcp has an analog the
 * semantics match so configs can be swapped.
 */

import path from "path";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SimSession } from "../lib/sim/sim-session";
import { buildFirmware } from "../lib/sim/firmware-builder";
import { loadProject } from "../lib/sim/project-loader";
import { diffScreenshots } from "../lib/png-diff";
import { compileChipSource } from "../lib/sim/chip-compiler";

// stdout is the MCP transport — never write to it directly.
function logErr(msg: string): void {
  process.stderr.write(`[sparkbench-mcp] ${msg}\n`);
}

function resolveProjectDir(): string {
  const arg = process.argv[2];
  const fromEnv = process.env.SPARKBENCH_PROJECT_DIR;
  const dir = path.resolve(arg ?? fromEnv ?? process.cwd());
  if (!existsSync(path.join(dir, "diagram.json")) || !existsSync(path.join(dir, "sketch.ino"))) {
    throw new Error(
      `"${dir}" is not a SparkBench project (need diagram.json + sketch.ino). ` +
        `Pass a project dir as the first arg or set SPARKBENCH_PROJECT_DIR.`,
    );
  }
  return dir;
}

const PROJECT_DIR = resolveProjectDir();
const PROJECTS_ROOT = path.dirname(PROJECT_DIR);

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const errText = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

let session: SimSession | null = null;
let currentDir = PROJECT_DIR;

function requireSession(): SimSession {
  if (!session) {
    throw new Error("No simulation running — call sparkbench_start_simulation first.");
  }
  return session;
}

const server = new McpServer({ name: "sparkbench", version: "1.0.0" });

// ── Project discovery ──────────────────────────────────────────────────────

server.registerTool(
  "sparkbench_list_projects",
  {
    description:
      "List SparkBench projects (directories with diagram.json + sketch.ino) next to the server's project dir.",
    inputSchema: {},
  },
  async () => {
    const entries = readdirSync(PROJECTS_ROOT).filter((name) => {
      const dir = path.join(PROJECTS_ROOT, name);
      try {
        return (
          statSync(dir).isDirectory() &&
          existsSync(path.join(dir, "diagram.json")) &&
          existsSync(path.join(dir, "sketch.ino"))
        );
      } catch {
        return false;
      }
    });
    return json({ projectsRoot: PROJECTS_ROOT, current: currentDir, projects: entries });
  },
);

// ── Simulation lifecycle ────────────────────────────────────────────────────

server.registerTool(
  "sparkbench_start_simulation",
  {
    description:
      "Compile the project's firmware (PlatformIO) and start a headless simulation. " +
      "Optionally switch to a different project by path or slug. Returns sim status.",
    inputSchema: {
      projectPath: z
        .string()
        .optional()
        .describe("Absolute/relative project dir or a slug under the projects root. Defaults to the server's project."),
    },
  },
  async ({ projectPath }) => {
    try {
      const dir = projectPath
        ? path.isAbsolute(projectPath) || projectPath.includes(path.sep)
          ? path.resolve(projectPath)
          : path.join(PROJECTS_ROOT, projectPath)
        : currentDir;
      if (session) {
        session.dispose();
        session = null;
      }
      logErr(`start_simulation: building ${dir} …`);
      session = await SimSession.load({ projectDir: dir, quiet: true });
      currentDir = dir;
      logErr(`start_simulation: running (${session.simCore})`);
      return json({ started: true, ...session.status() });
    } catch (e) {
      return errText(`start_simulation failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

server.registerTool(
  "sparkbench_stop_simulation",
  { description: "Stop the running simulation (keeps it loaded; restart to resume).", inputSchema: {} },
  async () => {
    try {
      requireSession().stop();
      return json({ stopped: true, ...session!.status() });
    } catch (e) {
      return errText(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  "sparkbench_restart_simulation",
  { description: "Reset the simulation to power-on state (re-wires from the already-built firmware).", inputSchema: {} },
  async () => {
    try {
      await requireSession().restart();
      return json({ restarted: true, ...session!.status() });
    } catch (e) {
      return errText(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  "sparkbench_run_ms",
  {
    description: "Advance the simulation by N simulated milliseconds. Returns cycles run and any new serial output.",
    inputSchema: { ms: z.number().positive().describe("Simulated milliseconds to advance.") },
  },
  async ({ ms }) => {
    try {
      return json(requireSession().runMs(ms));
    } catch (e) {
      return errText(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  "sparkbench_get_status",
  { description: "Current simulation status: core, board, clock, cycles, simulated time, parts.", inputSchema: {} },
  async () => {
    if (!session) return json({ status: "idle", note: "No simulation started yet." });
    return json(session.status());
  },
);

// ── Serial ──────────────────────────────────────────────────────────────────

server.registerTool(
  "sparkbench_read_serial",
  {
    description: "Read accumulated serial (USART/UART) output. Set clear=true to drain the buffer.",
    inputSchema: { clear: z.boolean().optional().describe("Clear the buffer after reading.") },
  },
  async ({ clear }) => {
    try {
      return text(requireSession().readSerial({ clear }));
    } catch (e) {
      return errText(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  "sparkbench_write_serial",
  {
    description: "Send text to the MCU's serial RX. Not supported on the STM32 core (no RX feed).",
    inputSchema: { text: z.string().describe("Bytes to inject into the serial receive line.") },
  },
  async ({ text: payload }) => {
    try {
      requireSession().writeSerial(payload);
      return json({ sent: payload.length });
    } catch (e) {
      return errText(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Pins & controls ───────────────────────────────────────────────────────

server.registerTool(
  "sparkbench_read_pin",
  {
    description:
      "Read a pin's logic level. Either give a board-native pin ('13'/'A0'/'PB5' AVR, 'PC13' STM32, 'GP15' RP2040), " +
      "or a part's pin via partId (resolved through the diagram to the connected MCU GPIO).",
    inputSchema: {
      pin: z.string().describe("Pin name or number (board-native, or a part's pin when partId is set)."),
      partId: z
        .string()
        .optional()
        .describe("Part id whose pin to read. Omit (or pass the MCU id) to read a board-native pin directly."),
    },
  },
  async ({ pin, partId }) => {
    try {
      return json(requireSession().readPin(pin, partId));
    } catch (e) {
      return errText(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  "sparkbench_set_control",
  {
    description:
      "Drive a component control. Controls: state (switch on/off), pressed (button/encoder), " +
      "position (pot 0.0-1.0), temperature, humidity, pressure, accel ('x,y,z'), gyro ('x,y,z'), " +
      "rotate-cw, rotate-ccw (detent count).",
    inputSchema: {
      partId: z.string().describe("Diagram part id."),
      control: z.string().describe("Control name."),
      value: z.union([z.number(), z.boolean(), z.string()]).describe("Control value."),
    },
  },
  async ({ partId, control, value }) => {
    try {
      const result = requireSession().setControl(partId, control, value);
      return result.ok ? json({ ok: true }) : errText(result.error);
    } catch (e) {
      return errText(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Parts & displays ─────────────────────────────────────────────────────

server.registerTool(
  "sparkbench_list_parts",
  { description: "List all parts in the diagram, plus which ones expose a readable display.", inputSchema: {} },
  async () => {
    try {
      const s = requireSession();
      return json({ parts: s.listParts(), displays: s.listDisplayParts() });
    } catch (e) {
      return errText(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  "sparkbench_read_display_buffer",
  {
    description:
      "Read a display part's raw buffer. SSD1306: 1024-byte GDDRAM (base64). LCD1602: char codes + decoded text. " +
      "ILI9341/chip: RGBA framebuffer (base64).",
    inputSchema: { partId: z.string().describe("Display part id (see sparkbench_list_parts).") },
  },
  async ({ partId }) => {
    try {
      const buf = requireSession().readDisplayBuffer(partId);
      if (!buf) return errText(`Part "${partId}" has no readable display.`);
      if (buf.type === "ssd1306") {
        return json({
          type: buf.type,
          width: buf.width,
          height: buf.height,
          gddramBase64: Buffer.from(buf.gddram).toString("base64"),
        });
      }
      if (buf.type === "lcd1602") {
        const decode = (row: number) =>
          Array.from(buf.characters.slice(row * buf.cols, (row + 1) * buf.cols))
            .map((c) => String.fromCharCode(c))
            .join("")
            .replace(/\s+$/, "");
        return json({
          type: buf.type,
          cols: buf.cols,
          rows: buf.rows,
          backlight: buf.backlight,
          lines: Array.from({ length: buf.rows }, (_, r) => decode(r)),
          charactersBase64: Buffer.from(buf.characters).toString("base64"),
        });
      }
      return json({
        type: buf.type,
        source: buf.source,
        width: buf.width,
        height: buf.height,
        pixelsBase64: Buffer.from(buf.pixels).toString("base64"),
      });
    } catch (e) {
      return errText(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  "sparkbench_take_screenshot",
  {
    description:
      "Render a display part to a PNG image (full base64, not truncated). Works for SSD1306, LCD1602, ILI9341 and chip framebuffers.",
    inputSchema: { partId: z.string().describe("Display part id (see sparkbench_list_parts).") },
  },
  async ({ partId }) => {
    try {
      const png = requireSession().takeScreenshot(partId);
      return {
        content: [
          { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
        ],
      };
    } catch (e) {
      return errText(e instanceof Error ? e.message : String(e));
    }
  },
);

// ── Build (compile-only, no run) ─────────────────────────────────────────

server.registerTool(
  "sparkbench_build_firmware",
  {
    description:
      "Compile a project's firmware via PlatformIO without starting a simulation. Returns target board, sim core and artifact size.",
    inputSchema: {
      projectPath: z.string().optional().describe("Project dir or slug. Defaults to the current project."),
    },
  },
  async ({ projectPath }) => {
    try {
      const dir = projectPath
        ? path.isAbsolute(projectPath) || projectPath.includes(path.sep)
          ? path.resolve(projectPath)
          : path.join(PROJECTS_ROOT, projectPath)
        : currentDir;
      const project = loadProject({ projectDir: dir });
      if (!project.target) return errText(`No simulatable MCU in ${dir}.`);
      const board = project.target.boardId;
      logErr(`build_firmware: compiling ${dir} (${board}) …`);
      const result = buildFirmware(project.sketch, project.librariesTxt, {
        board,
        quiet: true,
        projectDir: project.root,
      });
      return json({
        board,
        simCore: result.simCore,
        hexBytes: result.hex.length,
        binBytes: result.bin?.byteLength ?? 0,
        durationMs: result.durationMs,
      });
    } catch (e) {
      return errText(`build_firmware failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

// ── Visual diff (two PNGs → match + diff image) ─────────────────────────────

server.registerTool(
  "sparkbench_diff_screenshots",
  {
    description:
      "Compare two PNG screenshots pixel-by-pixel (e.g. two take_screenshot outputs, or SparkBench vs Wokwi). " +
      "Returns match/diffPixels/diffRatio and, by default, a diff image highlighting changed pixels in red.",
    inputSchema: {
      pngA: z.string().describe("First screenshot as base64 PNG."),
      pngB: z.string().describe("Second screenshot as base64 PNG."),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Match sensitivity 0..1 (default 0.1; smaller = stricter)."),
      includeDiffImage: z.boolean().optional().describe("Return the diff PNG (default true)."),
    },
  },
  async ({ pngA, pngB, threshold, includeDiffImage }) => {
    try {
      const a = Buffer.from(pngA, "base64");
      const b = Buffer.from(pngB, "base64");
      const includeImage = includeDiffImage ?? true;
      const result = diffScreenshots(a, b, { threshold, includeImage });
      const summary = {
        match: result.match,
        diffPixels: result.diffPixels,
        totalPixels: result.totalPixels,
        diffRatio: Number(result.diffRatio.toFixed(6)),
        width: result.width,
        height: result.height,
      };
      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [{ type: "text", text: JSON.stringify(summary, null, 2) }];
      if (includeImage && result.diffPng) {
        content.push({ type: "image", data: result.diffPng.toString("base64"), mimeType: "image/png" });
      }
      return { content };
    } catch (e) {
      return errText(`diff_screenshots failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

// ── Compile a custom chip (C or Verilog) ────────────────────────────────────

server.registerTool(
  "sparkbench_compile_chip",
  {
    description:
      "Compile a custom-chip source (C via wokwi-cli, or Verilog/SystemVerilog via Verilator) to a WASM module. " +
      "Language is auto-detected unless given. Returns the wasm as base64.",
    inputSchema: {
      name: z.string().describe("Chip name (used for the temp source file)."),
      source: z.string().describe("Chip source code (C or Verilog)."),
      language: z.enum(["c", "verilog"]).optional().describe("Override the auto-detected language."),
    },
  },
  async ({ name, source, language }) => {
    try {
      const result = compileChipSource({ name, source, language });
      return json({
        name,
        language: result.language,
        size: result.size,
        wasmBase64: Buffer.from(result.wasm).toString("base64"),
      });
    } catch (e) {
      return errText(`compile_chip failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

// ── Oracle cross-sim comparison (SparkBench avr8js vs official Wokwi) ────────

server.registerTool(
  "sparkbench_oracle_compare",
  {
    description:
      "Run a project through BOTH SparkBench (avr8js) and the official Wokwi cloud simulator and diff their " +
      "serial output — the cross-validation wokwi-cli mcp can't do. AVR projects only. Requires wokwi-cli + " +
      "WOKWI_CLI_TOKEN in the environment.",
    inputSchema: {
      projectPath: z.string().optional().describe("Project dir or slug. Defaults to the current project."),
      timeoutMs: z.number().positive().optional().describe("Serial capture window in ms (default 5000)."),
    },
  },
  async ({ projectPath, timeoutMs }) => {
    try {
      const dir = projectPath
        ? path.isAbsolute(projectPath) || projectPath.includes(path.sep)
          ? path.resolve(projectPath)
          : path.join(PROJECTS_ROOT, projectPath)
        : currentDir;
      const slug = path.basename(dir);
      if (path.dirname(dir) !== PROJECTS_ROOT) {
        return errText(`oracle_compare needs a project under ${PROJECTS_ROOT} (got ${dir}).`);
      }
      const timeout = timeoutMs ?? 5000;
      logErr(`oracle_compare: ${slug} (${timeout}ms) …`);
      const proc = spawnSync(
        "npx",
        ["tsx", path.join(__dirname, "oracle-test.ts"), slug, "--timeout", String(timeout)],
        { cwd: path.resolve(__dirname, ".."), encoding: "utf-8", timeout: timeout + 180_000 },
      );
      const out = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
      const match = /✓ ORACLE MATCH/.test(out);
      const mismatch = /✗ ORACLE MISMATCH/.test(out);
      if (!match && !mismatch) {
        const reason = /WOKWI_CLI_TOKEN|wokwi-cli not found/.test(out)
          ? "wokwi-cli or WOKWI_CLI_TOKEN not configured"
          : "oracle did not run to completion";
        return errText(`oracle_compare could not complete (${reason}).\n\n${out.slice(-1500)}`);
      }
      return json({ slug, match, mismatch, timeoutMs: timeout, output: out.slice(-4000) });
    } catch (e) {
      return errText(`oracle_compare failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

// ── Resources: project files (sandboxed to the project dir) ─────────────────

function registerFileResource(name: string, file: string, mimeType: string): void {
  const full = path.join(currentDir, file);
  if (!existsSync(full)) return;
  server.registerResource(
    name,
    `sparkbench://project/${file}`,
    { description: `Project ${file}`, mimeType },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType, text: readFileSync(path.join(currentDir, file), "utf-8") }],
    }),
  );
}

registerFileResource("diagram", "diagram.json", "application/json");
registerFileResource("sketch", "sketch.ino", "text/x-arduino");
registerFileResource("libraries", "libraries.txt", "text/plain");
registerFileResource("scenario", "test.scenario.yaml", "application/yaml");

// ── Prompt: orientation walkthrough ─────────────────────────────────────────

server.registerPrompt(
  "sparkbench_explore",
  { description: "Walk through inspecting and running the loaded SparkBench project." },
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            "You are driving a SparkBench hardware simulation over MCP. Do this:\n" +
            "1. Call sparkbench_list_parts to see the circuit.\n" +
            "2. Read the sparkbench://project/sketch.ino resource to understand the firmware.\n" +
            "3. Call sparkbench_start_simulation.\n" +
            "4. Call sparkbench_run_ms with ms=1000.\n" +
            "5. Call sparkbench_read_serial to see output.\n" +
            "6. If any display is listed, call sparkbench_take_screenshot on it.\n" +
            "Summarize what the project does and whether it is behaving correctly.",
        },
      },
    ],
  }),
);

// ── Connect ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logErr(`project: ${PROJECT_DIR}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logErr("ready (stdio)");
}

main().catch((e) => {
  logErr(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
