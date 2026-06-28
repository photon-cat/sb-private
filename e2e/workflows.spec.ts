import { test, expect } from "@playwright/test";

// Real user-workflow E2E tests. These exercise the full browser stack —
// custom elements, Monaco, the simulation pipeline — which jsdom cannot.
// They target the "blink" project, which ships in the repo.

const PROJECT = "/projects/blink";

test.describe("project workbench", () => {
  test("loads with editor and diagram canvas rendered (no blank panels)", async ({ page }) => {
    await page.goto(PROJECT);

    // Monaco editor mounts (stable library class).
    await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 30_000 });

    // The diagram canvas renders parts — every part wrapper carries data-part-id.
    await expect(page.locator("[data-part-id]").first()).toBeVisible({ timeout: 30_000 });

    // The known parts from blink/diagram.json should be present.
    await expect(page.locator('[data-part-id="uno"]')).toBeVisible();
    await expect(page.locator('[data-part-id="led"]')).toBeVisible();
  });

  test("editor exposes the standard file tabs", async ({ page }) => {
    await page.goto(PROJECT);
    await expect(page.getByRole("button", { name: "sketch.ino" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "diagram.json" })).toBeVisible();
  });

  test("compiles and runs the simulation", async ({ page }) => {
    await page.goto(PROJECT);
    await expect(page.locator("[data-part-id]").first()).toBeVisible({ timeout: 30_000 });

    // Start the simulation (button now has an accessible label).
    const run = page.getByRole("button", { name: "Run simulation" });
    await expect(run).toBeVisible({ timeout: 30_000 });
    await run.click();

    // Compiling can take a while (PlatformIO). Once running, a Stop control
    // appears — that proves the build succeeded and the runner started.
    await expect(page.getByRole("button", { name: "Stop simulation" })).toBeVisible({
      timeout: 120_000,
    });
  });

  test("switches to the PCB tab without a blank canvas", async ({ page }) => {
    await page.goto(PROJECT);
    await expect(page.locator("[data-part-id]").first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "PCB", exact: true }).click();

    // The PCB editor should mount some interactive content (a canvas or toolbar),
    // not leave an empty panel. We assert the page still has substantial content.
    await page.waitForTimeout(2000);
    const canvasOrToolbar = page.locator("canvas, [class*='pcb'], [class*='Pcb'], [class*='kiCanvas']");
    await expect(canvasOrToolbar.first()).toBeVisible({ timeout: 30_000 });
  });
});
