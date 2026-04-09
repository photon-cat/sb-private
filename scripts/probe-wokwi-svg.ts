#!/usr/bin/env npx tsx
/**
 * Diagnostic tool: dump every SVG line/polyline/path in a Wokwi project
 * plus its container hierarchy so we can figure out where wires live.
 */
import { chromium } from "@playwright/test";

async function main() {
  const url = process.argv[2];
  if (!url) { console.error("Usage: probe-wokwi-svg.ts <url>"); process.exit(2); }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(6000);

    const info = await page.evaluate(() => {
      const summary: Record<string, number> = {};
      const samples: unknown[] = [];

      // Count by tag and parent SVG size
      const all = Array.from(document.querySelectorAll("svg"));
      const svgSummary: { w: number; h: number; children: number; classList: string }[] = [];
      for (const svg of all) {
        const r = svg.getBoundingClientRect();
        svgSummary.push({
          w: Math.round(r.width),
          h: Math.round(r.height),
          children: svg.children.length,
          classList: (svg as Element).className.toString().slice(0, 100),
        });
      }

      // Also count all lines/paths/polylines with strokes
      const shapes = Array.from(document.querySelectorAll("line, polyline, path"));
      for (const el of shapes) {
        const tag = el.tagName.toLowerCase();
        const cs = window.getComputedStyle(el as Element);
        const stroke = cs.stroke;
        const key = `${tag}[stroke=${stroke}]`;
        summary[key] = (summary[key] || 0) + 1;
      }

      // Take ~10 sample non-trivial strokes (not grid, not ruler)
      const picked: { tag: string; stroke: string; strokeWidth: string; parent: string; bbox: { x: number; y: number; w: number; h: number } }[] = [];
      for (const el of shapes) {
        const cs = window.getComputedStyle(el as Element);
        if (!cs.stroke || cs.stroke === "none") continue;
        const r = (el as SVGGraphicsElement).getBoundingClientRect();
        if (r.width < 5 && r.height < 5) continue;
        // Walk up to find a recognizable container
        let parent = (el.parentElement?.className || "").toString();
        if (!parent) parent = (el.parentElement?.tagName || "").toString();
        picked.push({
          tag: el.tagName.toLowerCase(),
          stroke: cs.stroke,
          strokeWidth: cs.strokeWidth,
          parent: String(parent).slice(0, 120),
          bbox: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        });
        if (picked.length >= 15) break;
      }

      return { svgCount: all.length, svgSummary, summary, picked };
    });

    console.log(JSON.stringify(info, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
