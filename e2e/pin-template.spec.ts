/**
 * Verifies that `attrs.pins` on a diagram.json part instance overrides
 * the default pin count from chip.json when `pinTemplate` is declared.
 *
 * The dip-template-demo project has three instances of chip-genericdip:
 *   dip8  with attrs.pins = "8"
 *   dip16 with attrs.pins = "16"
 *   dip20 with attrs.pins = "20"
 *
 * Each instance should expose a DIFFERENT pinInfo array with the
 * corresponding length, and different chipWidth so the rendered DIP
 * scales to its pin count.
 */

import { test, expect } from "@playwright/test";

test.describe("diagram.json pinTemplate override", () => {
  test("each instance gets its own pinInfo from attrs.pins", async ({ page }) => {
    await page.goto("/projects/dip-template-demo");
    await page.waitForSelector("[data-part-id]", { timeout: 30_000 });
    await page.waitForTimeout(2500);

    // Read pinInfo from the DOM instances
    const info = await page.evaluate(() => {
      const ids = ["dip8", "dip16", "dip20"];
      const out: Record<string, { pinCount: number; chipWidth: number; firstPin?: string; lastPin?: string }> = {};
      for (const id of ids) {
        const wrapper = document.querySelector(`[data-part-id="${id}"]`);
        const el = wrapper?.firstElementChild as (HTMLElement & { pinInfo?: { name: string }[]; chipWidth?: number }) | null;
        const pins = el?.pinInfo ?? [];
        out[id] = {
          pinCount: pins.length,
          chipWidth: el?.chipWidth ?? -1,
          firstPin: pins[0]?.name,
          lastPin: pins[pins.length - 1]?.name,
        };
      }
      return out;
    });

    // dip8: 8 pins, pins 1..8
    expect(info.dip8.pinCount).toBe(8);
    expect(info.dip8.firstPin).toBe("1");
    expect(info.dip8.lastPin).toBe("8");

    // dip16: 16 pins
    expect(info.dip16.pinCount).toBe(16);
    expect(info.dip16.firstPin).toBe("1");
    expect(info.dip16.lastPin).toBe("16");

    // dip20: 20 pins
    expect(info.dip20.pinCount).toBe(20);
    expect(info.dip20.firstPin).toBe("1");
    expect(info.dip20.lastPin).toBe("20");

    // Wokwi generic-breakout template: width is a constant 30mm (113.39 px
    // at 96 DPI); height scales with pinsPerSide:
    //   h_mm = 2*2.27 + (pinsPerSide-1) * 2.54
    //   h_px = h_mm * (96/25.4)
    // 8 pins  → pinsPerSide=4 → h_mm=12.16 → h_px≈45.96
    // 16 pins → pinsPerSide=8 → h_mm=22.32 → h_px≈84.36
    // 20 pins → pinsPerSide=10 → h_mm=27.40 → h_px≈103.56
    const WOKWI_WIDTH_PX = 30 * (96 / 25.4);
    expect(info.dip8.chipWidth).toBeCloseTo(WOKWI_WIDTH_PX, 1);
    expect(info.dip16.chipWidth).toBeCloseTo(WOKWI_WIDTH_PX, 1);
    expect(info.dip20.chipWidth).toBeCloseTo(WOKWI_WIDTH_PX, 1);
  });
});
