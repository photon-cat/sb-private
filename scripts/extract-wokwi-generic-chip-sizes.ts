#!/usr/bin/env npx tsx
/**
 * Extract Wokwi's generic custom-chip breakout template at MULTIPLE pin counts
 * by editing chip.json in Monaco after the chip is created.
 *
 * For each pin count in PIN_COUNTS, we:
 *   1. Navigate to /projects/new/blank
 *   2. Create a custom chip (default: 4 pins VCC/GND/IN/OUT)
 *   3. Open chip.json in the Monaco editor
 *   4. Replace the "pins" array with N entries ["1","2",...,"N"]
 *   5. Wait for the canvas to re-render
 *   6. Dump the chip element's outerHTML
 *
 * This reveals the formulas Wokwi uses for width, height, and hole positions
 * as a function of pin count.
 */
import { chromium, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";

const OUT_DIR = "/tmp/wokwi-generic-chip";
mkdirSync(OUT_DIR, { recursive: true });
const PIN_COUNTS = [4, 6, 8, 12, 16, 20];

async function createAndDump(page: Page, pinCount: number) {
  console.error(`\n=== ${pinCount} pins ===`);
  await page.goto("https://wokwi.com/projects/new/blank", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(3500);

  // Add Part → Custom chip
  await page.locator('button[aria-label*="Add" i]').first().click();
  await page.waitForTimeout(800);
  await page.locator('text=/custom.chip/i').first().click();
  await page.waitForTimeout(800);
  await page.locator('input[type="text"]').first().fill(`t${pinCount}`);
  await page.locator('button:has-text("Create Chip"), button:has-text("CREATE CHIP")').first().click();
  await page.waitForTimeout(2500);

  // Click the chip.json tab in Monaco's tab bar
  const jsonTab = page.locator('[role="tab"]:has-text(".chip.json"), button:has-text(".chip.json")').first();
  if (await jsonTab.count() > 0) {
    await jsonTab.click();
    await page.waitForTimeout(800);
  } else {
    console.error("  chip.json tab not found, trying file-tree");
    await page.locator('text=.chip.json').first().click();
    await page.waitForTimeout(800);
  }

  // Replace Monaco content via its model API
  const pinNames = Array.from({ length: pinCount }, (_, i) => String(i + 1));
  const newJson = JSON.stringify(
    { name: `t${pinCount}`, author: "x", pins: pinNames, controls: [] },
    null,
    2,
  );
  const replaced = await page.evaluate((text) => {
    const w = window as unknown as {
      monaco?: {
        editor?: {
          getModels: () => Array<{
            uri: { path: string };
            setValue: (v: string) => void;
          }>;
        };
      };
    };
    const models = w.monaco?.editor?.getModels() ?? [];
    for (const m of models) {
      if (m.uri.path.endsWith("chip.json")) {
        m.setValue(text);
        return true;
      }
    }
    return false;
  }, newJson);
  console.error(`  monaco chip.json replaced: ${replaced}`);
  await page.waitForTimeout(1500);

  // Trigger save (Wokwi auto-saves on change but sometimes needs focus change)
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2000);

  const info = await page.evaluate(() => {
    const el = document.querySelector('[wokwi-controller^="chip-"]');
    if (!el) return null;
    const svg = el.querySelector("svg");
    const svgAttrs = svg
      ? { width: svg.getAttribute("width"), height: svg.getAttribute("height"), viewBox: svg.getAttribute("viewBox") }
      : null;
    const holes = svg
      ? Array.from(svg.querySelectorAll("use")).map((u) => ({
          x: u.getAttribute("x"),
          y: u.getAttribute("y"),
        }))
      : [];
    const rect = svg?.querySelector("rect");
    return {
      outerHTML: el.outerHTML,
      svgAttrs,
      holes,
      rect: rect
        ? {
            w: rect.getAttribute("width"),
            h: rect.getAttribute("height"),
            fill: rect.getAttribute("fill"),
            rx: rect.getAttribute("rx"),
          }
        : null,
    };
  });
  return info;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const results: Record<string, unknown> = {};
    for (const n of PIN_COUNTS) {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
      try {
        const info = await createAndDump(page, n);
        results[`n${n}`] = info;
        if (info) {
          console.error(`  svg=${info.svgAttrs?.width}x${info.svgAttrs?.height} rect=${info.rect?.w}x${info.rect?.h} holes=${info.holes.length}`);
        } else {
          console.error("  NO chip element found");
        }
      } finally {
        await page.close();
      }
    }
    writeFileSync(path.join(OUT_DIR, "sizes.json"), JSON.stringify(results, null, 2));
    console.error(`\n✓ Wrote ${OUT_DIR}/sizes.json`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
