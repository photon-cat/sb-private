#!/usr/bin/env npx tsx
/**
 * Dump the raw HTML of a specific Wokwi part wrapper by id so we can see
 * how community chips (chip-*) are actually rendered.
 *
 * Usage:
 *   npx tsx scripts/dump-wokwi-chip.ts <wokwi-project-url> <part-id>
 */

import { chromium } from "@playwright/test";

async function main() {
  const url = process.argv[2];
  const partId = process.argv[3];
  if (!url || !partId) {
    console.error("Usage: dump-wokwi-chip.ts <url> <part-id>");
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(
      () => !!document.querySelector("[class*='simulation'], [class*='canvas']"),
      undefined,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(4000);

    const dump = await page.evaluate((id: string) => {
      const el = document.getElementById(id);
      if (!el) return { error: `no element with id=${id}` };
      return {
        outerHTML: el.outerHTML,
        tagName: el.tagName.toLowerCase(),
        className: el.className,
        boundingBox: (() => {
          const r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, width: r.width, height: r.height };
        })(),
      };
    }, partId);

    console.log(JSON.stringify(dump, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
