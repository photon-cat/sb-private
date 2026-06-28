import { test, expect } from "@playwright/test";

// Live, end-to-end proof that a server-compiled STM32F103 sketch runs on the
// in-browser unicorn.js (asm.js ARMv7-M) core and drives a real component: the
// PC13 LED in the `stm32-blink` project must visibly toggle in the canvas.
//
// This exercises the WHOLE path the headless unit tests can't: Next bundling of
// the 2.3 MB asm.js core, the static-asset fetch+eval loader, the build API
// returning simCore=unicorn-arm, createStm32Runner, wireComponentsStm32, and the
// React render of <wokwi-led>.
//
// Requires the PlatformIO ststm32 *Arduino* framework (a one-time network
// download). If the build fails because the toolchain isn't present, the test
// skips rather than failing — keep it out of the default CI gate unless the
// framework is provisioned.
test.describe("STM32 in-browser simulation (unicorn.js)", () => {
  test("PC13 LED blinks from real F103 firmware", async ({ page }) => {
    test.setTimeout(180_000);

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    let buildOk: boolean | null = null;
    let simCore: string | undefined;
    page.on("response", async (resp) => {
      if (!resp.url().includes("/build")) return;
      try {
        const j = await resp.json();
        buildOk = j.success;
        simCore = j.simCore;
        if (!j.success) console.log("STM32 build failed (skipping):", j.error?.slice?.(0, 200));
      } catch {
        /* not json */
      }
    });

    await page.goto("/projects/stm32-blink", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});

    const run = page.getByRole("button", { name: /^\s*(Run|Start)/i }).first();
    await expect(run).toBeVisible({ timeout: 30_000 });
    await run.click();

    // Poll the LED's `value` for up to ~2 min; pass when both states are seen.
    const seen = new Set<boolean>();
    let toggled = false;
    for (let i = 0; i < 600; i++) {
      const v = await page.evaluate(() => {
        const el = document.querySelector("wokwi-led") as (Element & { value?: boolean }) | null;
        return el ? !!el.value : null;
      });
      if (v !== null) {
        seen.add(v);
        if (seen.has(true) && seen.has(false)) { toggled = true; break; }
      }
      if (buildOk === false) break; // build failed → skip below
      await page.waitForTimeout(200);
    }

    if (buildOk === false) {
      test.skip(true, "STM32 ststm32/arduino framework not available in this environment");
      return;
    }

    expect(simCore, "build should select the unicorn-arm core").toBe("unicorn-arm");
    expect(errors, "no uncaught page errors").toEqual([]);
    expect(toggled, "PC13 LED should toggle on/off").toBe(true);
  });
});
