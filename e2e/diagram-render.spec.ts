/**
 * Diagram-to-render regression tests.
 *
 * For each project under `projects/`, this spec:
 *  1. Opens the project in SparkBench's dev UI
 *  2. Waits for the canvas to finish laying out (all elements registered,
 *     all wires computed via `computePinsAndWires`)
 *  3. Screenshots the diagram canvas area
 *  4. Compares against a golden PNG in `e2e/golden/<project>.png`
 *
 * On first run, or when the environment variable `UPDATE_GOLDEN=1` is set,
 * the golden PNG is (re)written instead of compared.
 *
 * This catches editor regressions like "chip element stopped rendering" or
 * "wires suddenly route through a part body" — exactly the class of visual
 * bugs we were finding by eye earlier.
 */

import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "fs";
import { resolve, join } from "path";

const ROOT = resolve(__dirname, "..");
const GOLDEN_DIR = join(__dirname, "golden");

// Projects to snapshot. Keep this list small + deterministic so the
// regression suite stays fast. Each entry can specify a custom viewport
// size or wait condition.
const PROJECTS: { slug: string; waitForText?: string; timeoutMs?: number }[] = [
  { slug: "blink" },
  { slug: "inverter-demo" },
  { slug: "cd4051-mux", timeoutMs: 8000 },
  { slug: "actuator-test" },
  { slug: "lcd-hello" },
];

test.describe("diagram render", () => {
  for (const { slug, timeoutMs = 5000 } of PROJECTS) {
    test(slug, async ({ page }) => {
      // Verify the project directory exists locally before trying to load
      // it. This guards against flaky failures when a project has been
      // renamed or deleted without updating the test list.
      const projDir = join(ROOT, "projects", slug);
      if (!existsSync(projDir)) {
        test.skip(true, `project not found: ${projDir}`);
        return;
      }
      if (!existsSync(join(projDir, "diagram.json"))) {
        test.skip(true, `no diagram.json in ${projDir}`);
        return;
      }

      // Navigate and wait for the canvas to finish first-paint
      await page.goto(`/projects/${slug}`);
      // Wait for at least one part wrapper to appear — we don't care which.
      await page.waitForSelector("[data-part-id]", { timeout: timeoutMs });
      // Give the SVG pin/wire renderer a chance to settle (wires are
      // computed asynchronously via computePinsAndWires with retries).
      await page.waitForTimeout(1500);

      // Locate the diagram viewport container. DiagramCanvas renders a
      // rulered panel — we screenshot that whole element.
      const viewport = page.locator('[data-testid="diagram-viewport"], [class*="DiagramCanvas"], main').first();
      // Fallback: screenshot the whole page if we can't find the viewport.
      const target = (await viewport.count()) > 0 ? viewport : page;

      const goldenPath = join(GOLDEN_DIR, `${slug}.png`);
      const updating = process.env.UPDATE_GOLDEN === "1";

      if (updating || !existsSync(goldenPath)) {
        await target.screenshot({ path: goldenPath });
        console.log(`Wrote golden: ${goldenPath}`);
        return;
      }

      // Compare against golden using Playwright's built-in toHaveScreenshot
      // which already does pixelmatch-style diffing with a tolerance.
      await expect(target).toHaveScreenshot(`${slug}.png`, {
        maxDiffPixelRatio: 0.02, // 2% tolerance for font anti-aliasing
        threshold: 0.2,
      });

      // Also assert the diagram has a non-trivial number of parts rendered
      // (catches "blank canvas" regressions).
      const partCount = await page.locator("[data-part-id]").count();
      expect(partCount).toBeGreaterThan(0);

      // And assert that the diagram.json part count matches the rendered
      // part count (catches "half the parts failed to render" regressions).
      const diagram = JSON.parse(readFileSync(join(projDir, "diagram.json"), "utf-8"));
      expect(partCount).toBe(diagram.parts.length);
    });
  }
});
