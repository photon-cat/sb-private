#!/usr/bin/env npx tsx
/**
 * extract-wokwi-dimensions.ts
 *
 * Headless Playwright tool that visits the Wokwi public web editor, loads a
 * given `diagram.json` content, waits for the canvas to render, and dumps
 * each part's bounding box + pinInfo positions to JSON.
 *
 * The output is useful for:
 *   - Authoring breakout SVGs that match Wokwi's actual element dimensions
 *     (e.g., the chip-cd4051b body size & pin positions)
 *   - Cross-simulator visual regression tests
 *   - Catching divergences like the wokwi-ssd1306 pin-name mismatch
 *
 * Usage:
 *   npx tsx scripts/extract-wokwi-dimensions.ts projects/cd4051-mux > cd4051-mux.wokwi.json
 *
 * Notes / limits:
 *   - Wokwi's web editor may require authentication for private projects;
 *     this tool only supports public projects or authenticated sessions via
 *     an existing browser profile.
 *   - Wokwi's DOM is subject to change; the selectors below are best-effort
 *     and may need updating when Wokwi ships a new editor version.
 */

import { chromium, type Browser, type Page } from "@playwright/test";
import { readFileSync, existsSync } from "fs";
import path from "path";

interface PartDimension {
  id: string;
  type: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  pinInfo: { name: string; x: number; y: number }[];
}

interface WokwiDump {
  project: string;
  extractedAt: string;
  parts: PartDimension[];
}

async function extract(opts: { url?: string; projDir?: string; headful?: boolean; screenshot?: string }): Promise<WokwiDump> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: !opts.headful });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1200 },
      deviceScaleFactor: 1,
    });
    const page: Page = await context.newPage();

    // Log console errors for debugging
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error(`[wokwi console] ${msg.text().slice(0, 200)}`);
    });

    let slug: string;
    if (opts.url) {
      slug = opts.url.split("/").pop() || "wokwi";
      console.error(`[extract] navigating to ${opts.url}`);
      await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } else if (opts.projDir) {
      slug = path.basename(opts.projDir);
      if (!existsSync(path.join(opts.projDir, "diagram.json"))) {
        throw new Error(`No diagram.json at ${opts.projDir}`);
      }
      const diagramJson = readFileSync(path.join(opts.projDir, "diagram.json"), "utf-8");
      await page.goto("https://wokwi.com/projects/new/arduino-uno", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      // Paste diagram.json into the editor
      const diagramTab = page.getByRole("tab", { name: /diagram\.json/i });
      if (await diagramTab.count() > 0) {
        await diagramTab.first().click();
        await page.locator(".monaco-editor").first().click();
        await page.keyboard.press("Meta+A");
        await page.keyboard.press("Delete");
        await page.keyboard.insertText(diagramJson);
        await page.waitForTimeout(2500);
      }
    } else {
      throw new Error("Provide --url or --project");
    }

    // Wait for Wokwi to render. The element tags are wokwi-* and chip-*.
    console.error("[extract] waiting for custom elements to mount...");
    await page.waitForFunction(
      () => {
        const els = Array.from(document.querySelectorAll("*"));
        return els.some((el) => {
          const t = el.tagName.toLowerCase();
          return t.startsWith("wokwi-") || t.startsWith("chip-");
        });
      },
      undefined,
      { timeout: 45_000 },
    );
    await page.waitForTimeout(3500);

    if (opts.screenshot) {
      await page.screenshot({ path: opts.screenshot, fullPage: false });
      console.error(`[extract] page screenshot -> ${opts.screenshot}`);
    }

    // Walk the DOM. Built-in Wokwi elements use `wokwi-*` tags, but
    // community chips (`chip-*` in diagram.json) get rendered via a
    // generic Wokwi wrapper. To find them we also look at every element
    // with an `id` whose parent container is the simulator canvas.
    const parts = await page.evaluate(() => {
      const results: Array<{
        id: string;
        type: string;
        boundingBox: { x: number; y: number; width: number; height: number };
        pinInfo: { name: string; x: number; y: number }[];
      }> = [];
      const seen = new Set<string>();

      // Pass 1: wokwi-*/chip-* custom elements
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const t = el.tagName.toLowerCase();
        if (!t.startsWith("wokwi-") && !t.startsWith("chip-")) continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const wrapper = (el.closest("[id]") as HTMLElement | null) ?? (el.parentElement as HTMLElement | null);
        const id = wrapper?.id || el.id || `(anon-${results.length})`;
        if (seen.has(id)) continue;
        seen.add(id);
        const pinInfo = (el as unknown as { pinInfo?: { name: string; x: number; y: number }[] }).pinInfo;
        results.push({
          id,
          type: t,
          boundingBox: {
            x: Math.round(r.left * 100) / 100,
            y: Math.round(r.top * 100) / 100,
            width: Math.round(r.width * 100) / 100,
            height: Math.round(r.height * 100) / 100,
          },
          pinInfo: Array.isArray(pinInfo)
            ? pinInfo.map((p) => ({
                name: p.name,
                x: Math.round(p.x * 100) / 100,
                y: Math.round(p.y * 100) / 100,
              }))
            : [],
        });
      }

      // Pass 2: any element with an id that's inside the simulator canvas
      // container AND isn't already in results. This picks up chip-*
      // elements rendered as plain SVG/div wrappers.
      const canvasRoots = Array.from(document.querySelectorAll('[class*="simulation"], [class*="canvas"], [class*="diagram"], main'));
      for (const root of canvasRoots) {
        for (const el of Array.from(root.querySelectorAll("[id]"))) {
          const id = (el as HTMLElement).id;
          if (!id || seen.has(id)) continue;
          // Filter out obvious non-parts: elements without a bounding box,
          // too small to be a part, or whose id looks like a React/webview
          // internal (starts with __).
          if (id.startsWith("__") || id.length > 30) continue;
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width < 10 || r.height < 10) continue;
          seen.add(id);
          results.push({
            id,
            type: el.tagName.toLowerCase() + ` (wrapper, classes=${(el as HTMLElement).className.toString().slice(0, 80)})`,
            boundingBox: {
              x: Math.round(r.left * 100) / 100,
              y: Math.round(r.top * 100) / 100,
              width: Math.round(r.width * 100) / 100,
              height: Math.round(r.height * 100) / 100,
            },
            pinInfo: [],
          });
        }
      }

      return results;
    });

    await browser.close();
    browser = null;

    return {
      project: slug,
      extractedAt: new Date().toISOString(),
      parts,
    };
  } finally {
    if (browser) await browser.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  let url: string | undefined;
  let projDir: string | undefined;
  let headful = false;
  let screenshot: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url") url = args[++i];
    else if (args[i] === "--project") projDir = args[++i];
    else if (args[i] === "--headful") headful = true;
    else if (args[i] === "--screenshot") screenshot = args[++i];
    else if (!args[i].startsWith("--") && !projDir && !url) projDir = args[i];
  }
  if (!url && !projDir) {
    console.error("Usage:");
    console.error("  extract-wokwi-dimensions.ts --url https://wokwi.com/projects/<id>");
    console.error("  extract-wokwi-dimensions.ts --project projects/<slug>");
    console.error("  Optional: --headful  --screenshot <path>");
    process.exit(2);
  }
  const dump = await extract({
    url,
    projDir: projDir ? path.resolve(projDir) : undefined,
    headful,
    screenshot,
  });
  process.stdout.write(JSON.stringify(dump, null, 2) + "\n");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
