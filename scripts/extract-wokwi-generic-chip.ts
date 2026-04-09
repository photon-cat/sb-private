#!/usr/bin/env npx tsx
/**
 * Extract Wokwi's GENERIC custom-chip breakout template.
 *
 * Wokwi uses a single breakout shape for every user-created custom chip
 * (chip.c + chip.json), parameterized only by the number of pins and the
 * chip name. This script:
 *
 *   1. Navigates to /projects/new/blank
 *   2. Opens the Add Part menu
 *   3. Selects "Custom chip"
 *   4. Fills in a name + picks C
 *   5. Clicks Create Chip
 *   6. Waits for the chip part to render in the canvas
 *   7. Dumps its outerHTML so we can see the exact SVG template Wokwi uses
 *
 * Also takes screenshots at each step so we can debug selectors if the
 * UI changes. Writes all artifacts to /tmp/wokwi-generic-chip/.
 *
 * Usage:
 *   npx tsx scripts/extract-wokwi-generic-chip.ts [--pins N] [--name X]
 */

import { chromium, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";

const OUT_DIR = "/tmp/wokwi-generic-chip";
mkdirSync(OUT_DIR, { recursive: true });

async function snap(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: false });
  console.error(`[snap] ${name}.png`);
}

async function main() {
  const args = process.argv.slice(2);
  let chipName = "inspect-me";
  let pinCount = 4;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name") chipName = args[++i];
    else if (args[i] === "--pins") pinCount = parseInt(args[++i], 10);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error(`[wokwi] ${msg.text().slice(0, 200)}`);
    });

    console.error("[1] Navigate to new blank project");
    await page.goto("https://wokwi.com/projects/new/blank", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(4000);
    await snap(page, "01-blank-loaded");

    // Dump a summary of what's on the page
    const pageSummary = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button")).slice(0, 40).map((b) => ({
        text: (b.textContent || "").trim().slice(0, 60),
        aria: b.getAttribute("aria-label") || "",
        title: b.getAttribute("title") || "",
        testId: b.getAttribute("data-testid") || "",
      }));
      const iconButtons = Array.from(document.querySelectorAll('[role="button"], .MuiIconButton-root')).slice(0, 20).map((b) => ({
        text: (b.textContent || "").trim().slice(0, 60),
        aria: (b as HTMLElement).getAttribute("aria-label") || "",
        title: (b as HTMLElement).getAttribute("title") || "",
      }));
      const hasMonaco = !!document.querySelector(".monaco-editor");
      const hasSimBoard = document.querySelectorAll('[class*="simulation"], [class*="canvas"], [class*="diagram"]').length;
      return { buttonCount: buttons.length, buttons, iconButtons, hasMonaco, hasSimBoard };
    });
    writeFileSync(path.join(OUT_DIR, "01-page-summary.json"), JSON.stringify(pageSummary, null, 2));
    console.error(`[1] Found ${pageSummary.buttonCount} buttons, monaco=${pageSummary.hasMonaco}, sim=${pageSummary.hasSimBoard}`);

    // --- Step 2: Add Part menu ---
    console.error("[2] Looking for Add Part button");
    // Try a bunch of likely selectors
    const candidates = [
      'button[aria-label*="Add" i]',
      'button[aria-label*="part" i]',
      'button[title*="Add" i]',
      'button[data-testid*="add-part"]',
      '[role="button"][aria-label*="Add" i]',
      'button:has-text("Add part")',
      'button:has-text("+")',
    ];
    let addBtn = null;
    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0) {
        addBtn = loc;
        console.error(`  matched: ${sel}`);
        break;
      }
    }
    if (!addBtn) {
      console.error("[2] No Add Part button found via common selectors");
      // Dump all button aria-labels for manual inspection
      const allButtons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("button, [role='button']"))
          .map((b) => ({
            tag: b.tagName.toLowerCase(),
            text: (b.textContent || "").trim().slice(0, 80),
            aria: (b as HTMLElement).getAttribute("aria-label") || "",
            title: (b as HTMLElement).getAttribute("title") || "",
            class: (b as HTMLElement).className?.toString().slice(0, 80) || "",
          }))
          .filter((b) => b.text || b.aria || b.title);
      });
      writeFileSync(path.join(OUT_DIR, "02-all-buttons.json"), JSON.stringify(allButtons, null, 2));
      console.error(`  wrote full button list to ${OUT_DIR}/02-all-buttons.json`);
      await snap(page, "02-no-add-button");
      return;
    }

    await addBtn.click();
    await page.waitForTimeout(1500);
    await snap(page, "03-after-add-clicked");

    // --- Step 3: Find "Custom chip" in the parts picker ---
    console.error("[3] Looking for Custom chip option");
    const customChipSelectors = [
      'text="Custom chip"',
      'text=/custom.chip/i',
      '[role="menuitem"]:has-text("Custom")',
      'button:has-text("Custom chip")',
    ];
    let customBtn = null;
    for (const sel of customChipSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0) {
        customBtn = loc;
        console.error(`  matched: ${sel}`);
        break;
      }
    }
    if (!customBtn) {
      console.error("[3] No Custom chip menu item found");
      await snap(page, "03-no-custom-chip-option");
      return;
    }
    await customBtn.click();
    await page.waitForTimeout(1500);
    await snap(page, "04-create-chip-dialog");

    // --- Step 4: Fill in the dialog ---
    console.error(`[4] Filling name="${chipName}"`);
    const nameInput = page.locator('input[type="text"]').first();
    await nameInput.fill(chipName);

    const createBtn = page.locator('button:has-text("Create Chip"), button:has-text("CREATE CHIP")').first();
    if (await createBtn.count() === 0) {
      console.error("[4] No Create Chip button");
      await snap(page, "04-no-create-button");
      return;
    }
    await createBtn.click();
    await page.waitForTimeout(4000);
    await snap(page, "05-after-create");

    // --- Step 5: Find the chip element in the canvas ---
    console.error("[5] Looking for chip-* element in canvas");
    const chipInfo = await page.evaluate(() => {
      // Find any element whose wokwi-controller starts with "chip-" OR whose
      // id is prefixed with "chip" and is inside the canvas area.
      const all = Array.from(document.querySelectorAll("[wokwi-controller], [id^='chip']"));
      const results: {
        id: string;
        controller: string;
        outerHTML: string;
        innerSvg: string | null;
        bbox: { w: number; h: number };
      }[] = [];
      for (const el of all) {
        const controller = el.getAttribute("wokwi-controller") || "";
        if (!controller.startsWith("chip-") && !(el.id && el.id.startsWith("chip"))) continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width < 10) continue;
        const svg = el.querySelector("svg");
        results.push({
          id: (el as HTMLElement).id,
          controller,
          outerHTML: el.outerHTML,
          innerSvg: svg?.outerHTML ?? null,
          bbox: { w: r.width, h: r.height },
        });
      }
      return results;
    });

    if (chipInfo.length === 0) {
      console.error("[5] No chip element found in DOM");
      await snap(page, "05-no-chip");
      return;
    }

    console.error(`[5] Found ${chipInfo.length} chip element(s):`);
    for (const c of chipInfo) {
      console.error(`  id=${c.id}  controller=${c.controller}  bbox=${c.bbox.w}x${c.bbox.h}`);
    }
    writeFileSync(path.join(OUT_DIR, "05-chip-elements.json"), JSON.stringify(chipInfo, null, 2));

    // Also screenshot just the chip
    await snap(page, "06-final");

    console.error(`\n✓ All artifacts in ${OUT_DIR}/`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
