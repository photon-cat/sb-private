#!/usr/bin/env npx tsx
/**
 * Dump every rendered wire from a live Wokwi project to JSON.
 *
 * Wokwi renders wires as SVG elements inside the simulator canvas. Each
 * wire has a start and end part:pin reference stored in the DOM (either
 * via data attributes or inferrable from the SVG path's start/end points
 * matched against known part positions).
 *
 * This script uses Playwright to open a Wokwi project URL, wait for the
 * canvas to fully render, and then walks the DOM to extract every visible
 * wire as a sequence of (x, y) points in screen pixels.
 *
 * Usage:
 *   npx tsx scripts/dump-wokwi-wires.ts <wokwi-project-url> > wires.json
 */

import { chromium } from "@playwright/test";

interface WokwiWirePoint { x: number; y: number; }
interface WokwiWire {
  index: number;
  pathD?: string;
  points: WokwiWirePoint[];
  color: string | null;
  strokeWidth: string | null;
  /** Nearest part-id within 12px of the first point */
  startPart?: string;
  /** Nearest part-id within 12px of the last point */
  endPart?: string;
  /** Bounding box from getBoundingClientRect */
  bbox: { x: number; y: number; width: number; height: number };
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: dump-wokwi-wires.ts <wokwi-project-url>");
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error(`[wokwi] ${msg.text().slice(0, 200)}`);
    });

    console.error(`[wires] loading ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // Wait for parts AND wires to render
    await page.waitForFunction(
      () => {
        const parts = document.querySelectorAll('[class*="diagram-part_diagramItem"]');
        const lines = document.querySelectorAll("svg polyline, svg line, svg path");
        return parts.length > 0 && lines.length > 5;
      },
      undefined,
      { timeout: 45_000 },
    );
    await page.waitForTimeout(3500);

    // Collect part wrappers for nearest-neighbor matching
    const partCenters = await page.evaluate(() => {
      const out: { id: string; cx: number; cy: number }[] = [];
      for (const el of Array.from(document.querySelectorAll("[id]"))) {
        const id = (el as HTMLElement).id;
        if (!id || id.startsWith("__") || id.length > 30) continue;
        // Only elements that look like parts (inside a diagram container)
        if (!el.closest('[class*="simulation"], [class*="canvas"], [class*="diagram"], main')) continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width < 10 || r.height < 10) continue;
        out.push({ id, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
      }
      return out;
    });

    // Walk the simulator SVG and pull every line/polyline/path that looks
    // like a wire (has a stroke and isn't a ruler tick, grid dot, or UI
    // chrome).
    const wires = await page.evaluate(() => {
      const results: {
        index: number;
        tag: string;
        pathD?: string;
        points: { x: number; y: number }[];
        color: string | null;
        strokeWidth: string | null;
        bbox: { x: number; y: number; width: number; height: number };
      }[] = [];

      // Find the main simulator SVG — the largest SVG inside the canvas area
      const candidates = Array.from(document.querySelectorAll("svg"));
      let best: SVGSVGElement | null = null;
      let bestArea = 0;
      for (const svg of candidates) {
        const r = svg.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea && area > 10000) {
          bestArea = area;
          best = svg as SVGSVGElement;
        }
      }
      if (!best) return results;

      // Iterate every child line/polyline/path inside the biggest SVG
      const elements = Array.from(best.querySelectorAll("line, polyline, path"));
      let idx = 0;
      for (const el of elements) {
        const r = (el as SVGGraphicsElement).getBoundingClientRect();
        // Skip invisible, degenerate, or tiny marks (grid dots, selection handles, ruler ticks)
        if (r.width < 2 && r.height < 2) continue;

        const computed = window.getComputedStyle(el as Element);
        const stroke = computed.stroke || (el as SVGElement).getAttribute("stroke");
        // Skip elements with no stroke (filled shapes = not wires)
        if (!stroke || stroke === "none" || stroke === "transparent") continue;

        const tag = el.tagName.toLowerCase();
        let points: { x: number; y: number }[] = [];
        let pathD: string | undefined;

        if (tag === "line") {
          const line = el as SVGLineElement;
          const p1 = (el as SVGGraphicsElement).ownerSVGElement!.createSVGPoint();
          p1.x = line.x1.baseVal.value; p1.y = line.y1.baseVal.value;
          const p2 = (el as SVGGraphicsElement).ownerSVGElement!.createSVGPoint();
          p2.x = line.x2.baseVal.value; p2.y = line.y2.baseVal.value;
          const ctm = (el as SVGGraphicsElement).getScreenCTM();
          if (!ctm) continue;
          const a = p1.matrixTransform(ctm);
          const b = p2.matrixTransform(ctm);
          points = [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
        } else if (tag === "polyline") {
          const poly = el as SVGPolylineElement;
          const ctm = (el as SVGGraphicsElement).getScreenCTM();
          if (!ctm) continue;
          for (let i = 0; i < poly.points.numberOfItems; i++) {
            const p = poly.points.getItem(i).matrixTransform(ctm);
            points.push({ x: p.x, y: p.y });
          }
        } else if (tag === "path") {
          pathD = (el as SVGPathElement).getAttribute("d") || "";
          // Sample the path endpoints via getPointAtLength for a rough
          // start/end position; exact point set is in pathD.
          const path = el as SVGPathElement;
          const len = path.getTotalLength?.() ?? 0;
          if (len <= 0) continue;
          const ctm = path.getScreenCTM();
          if (!ctm) continue;
          // Collect ~20 evenly-spaced samples so we can reconstruct the
          // wire's rough shape for comparison.
          const samples = Math.min(40, Math.max(3, Math.floor(len / 5)));
          for (let i = 0; i <= samples; i++) {
            const t = (i / samples) * len;
            const p = path.getPointAtLength(t);
            const svgP = (path as unknown as { ownerSVGElement: SVGSVGElement }).ownerSVGElement.createSVGPoint();
            svgP.x = p.x; svgP.y = p.y;
            const tp = svgP.matrixTransform(ctm);
            points.push({ x: tp.x, y: tp.y });
          }
        }

        if (points.length < 2) continue;
        // Skip tiny stubs (e.g. pin indicators)
        const dx = points[points.length - 1].x - points[0].x;
        const dy = points[points.length - 1].y - points[0].y;
        if (Math.abs(dx) < 3 && Math.abs(dy) < 3) continue;

        results.push({
          index: idx++,
          tag,
          pathD,
          points: points.map((p) => ({
            x: Math.round(p.x * 100) / 100,
            y: Math.round(p.y * 100) / 100,
          })),
          color: stroke,
          strokeWidth: computed.strokeWidth || null,
          bbox: {
            x: Math.round(r.left * 100) / 100,
            y: Math.round(r.top * 100) / 100,
            width: Math.round(r.width * 100) / 100,
            height: Math.round(r.height * 100) / 100,
          },
        });
      }
      return results;
    });

    // Match each wire to start/end parts by nearest-center
    const nearest = (x: number, y: number, maxDist = 40): string | undefined => {
      let bestId: string | undefined;
      let bestD = maxDist * maxDist;
      for (const p of partCenters) {
        const d = (p.cx - x) * (p.cx - x) + (p.cy - y) * (p.cy - y);
        if (d < bestD) { bestD = d; bestId = p.id; }
      }
      return bestId;
    };

    const enriched: WokwiWire[] = wires.map((w) => ({
      ...w,
      startPart: nearest(w.points[0].x, w.points[0].y),
      endPart: nearest(w.points[w.points.length - 1].x, w.points[w.points.length - 1].y),
    }));

    console.log(JSON.stringify({ url, extractedAt: new Date().toISOString(), wireCount: enriched.length, wires: enriched }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
