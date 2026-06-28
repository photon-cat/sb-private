// SimSession lifecycle — the long-lived simulation wrapper behind the MCP server.
//
// Uses the prebuilt-firmware path (the pico_blink.uf2 fixture) against real
// project directories so the build/PlatformIO step is skipped: these tests
// exercise the session mechanics (wiring, stepping, pin/serial/display/control
// access), not firmware compilation.

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { SimSession } from "../sim/sim-session";

const PROJECTS = path.resolve(__dirname, "../../projects");
const UF2 = new Uint8Array(readFileSync(path.join(__dirname, "fixtures", "pico_blink.uf2")));
const prebuilt = { simCore: "rp2040" as const, bin: UF2 };

let session: SimSession | null = null;
afterEach(() => {
  session?.dispose();
  session = null;
});

describe("SimSession", () => {
  it("loads a project and reports status", async () => {
    session = await SimSession.load({ slug: "rp2040-blink", projectsRoot: PROJECTS, prebuilt, quiet: true });
    const s = session.status();
    expect(s.status).toBe("running");
    expect(s.simCore).toBe("rp2040");
    expect(s.parts.map((p) => p.id)).toContain("led1");
    expect(s.clockHz).toBeGreaterThan(0);
  }, 60_000);

  it("advances time and tracks cycles via runMs", async () => {
    session = await SimSession.load({ slug: "rp2040-blink", projectsRoot: PROJECTS, prebuilt, quiet: true });
    const before = session.status().cycles;
    const r = session.runMs(50);
    expect(r.cyclesRun).toBeGreaterThan(0);
    expect(session.status().cycles).toBe(before + r.cyclesRun);
    expect(session.status().timeMs).toBeGreaterThan(0);
  }, 60_000);

  it("rejects non-positive runMs and run-after-stop", async () => {
    session = await SimSession.load({ slug: "rp2040-blink", projectsRoot: PROJECTS, prebuilt, quiet: true });
    expect(() => session!.runMs(0)).toThrow(/positive/);
    session.stop();
    expect(session.status().status).toBe("stopped");
    expect(() => session!.runMs(10)).toThrow(/stopped/);
  }, 60_000);

  it("restarts back to a running state", async () => {
    session = await SimSession.load({ slug: "rp2040-blink", projectsRoot: PROJECTS, prebuilt, quiet: true });
    session.runMs(20);
    session.stop();
    await session.restart();
    expect(session.status().status).toBe("running");
    expect(session.status().cycles).toBe(0);
    expect(() => session!.runMs(5)).not.toThrow();
  }, 60_000);

  it("reads a board-native pin", async () => {
    session = await SimSession.load({ slug: "rp2040-blink", projectsRoot: PROJECTS, prebuilt, quiet: true });
    const pin = session.readPin("GP25");
    expect(typeof pin.high).toBe("boolean");
    expect(pin.state === 0 || pin.state === 1).toBe(true);
    expect(pin.mcuPin).toBe("GP25");
    expect(() => session!.readPin("ZZZ")).toThrow();
  }, 60_000);

  it("resolves a part's pin to the connected MCU GPIO (Wokwi parity)", async () => {
    session = await SimSession.load({ slug: "rp2040-blink", projectsRoot: PROJECTS, prebuilt, quiet: true });
    // led1:A is wired to pico:GP15 in the diagram.
    const viaPart = session.readPin("A", "led1");
    expect(viaPart.mcuPin).toBe("GP15");
    expect(typeof viaPart.high).toBe("boolean");
    // MCU partId reads the board-native pin directly.
    expect(session.readPin("GP15", "pico").mcuPin).toBe("GP15");
    // Unknown part pin throws.
    expect(() => session!.readPin("ZZ", "led1")).toThrow(/no pin/);
  }, 60_000);

  it("applies and rejects controls (potentiometer)", async () => {
    session = await SimSession.load({ slug: "rp2040-adc", projectsRoot: PROJECTS, prebuilt, quiet: true });
    expect(session.setControl("pot1", "position", 0.5)).toEqual({ ok: true });
    const bad = session.setControl("pot1", "nonsense", 1);
    expect(bad.ok).toBe(false);
    const missing = session.setControl("ghost", "position", 0.5);
    expect(missing.ok).toBe(false);
  }, 60_000);

  it("reads an SSD1306 display buffer and renders a PNG", async () => {
    session = await SimSession.load({ slug: "rp2040-i2c", projectsRoot: PROJECTS, prebuilt, quiet: true });
    expect(session.listDisplayParts().map((p) => p.id)).toContain("oled1");

    const buf = session.readDisplayBuffer("oled1");
    expect(buf?.type).toBe("ssd1306");
    if (buf?.type === "ssd1306") {
      expect(buf.gddram.length).toBe(1024);
      expect(buf.width).toBe(128);
      expect(buf.height).toBe(64);
    }

    const png = session.takeScreenshot("oled1");
    // PNG magic bytes.
    expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);

    expect(session.readDisplayBuffer("led1")).toBeNull();
    expect(() => session!.takeScreenshot("led1")).toThrow(/no renderable display/);
  }, 60_000);
});
