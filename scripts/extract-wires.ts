#!/usr/bin/env npx tsx
/**
 * Unified wire extractor for both Wokwi and SparkBench diagrams.
 *
 * Dumps every rendered wire from a live page as a sequence of (x, y)
 * points plus stroke color and nearest start/end part. Works against:
 *
 *   - Wokwi:       https://wokwi.com/projects/<id>
 *   - SparkBench:  http://localhost:3000/projects/<slug>
 *
 * Output format (JSON to stdout):
 *   {
 *     source: "wokwi" | "sparkbench",
 *     url: "...",
 *     wires: [
 *       {
 *         index, color, strokeWidth, points: [{x,y}, ...],
 *         startPart, endPart, bbox
 *       }, ...
 *     ]
 *   }
 *
 * Usage:
 *   npx tsx scripts/extract-wires.ts wokwi https://wokwi.com/projects/343522915673702994
 *   npx tsx scripts/extract-wires.ts sparkbench http://localhost:3000/projects/cd4051-mux
 */

import { chromium, type Page } from "@playwright/test";

interface Wire {
  index: number;
  tag: string;
  color: string;
  strokeWidth: string;
  points: { x: number; y: number }[];
  startPart?: string;
  endPart?: string;
  bbox: { x: number; y: number; w: number; h: number };
}

async function extractFromPage(page: Page, source: "wokwi" | "sparkbench"): Promise<Wire[]> {
  // Wait differently per source.
  if (source === "wokwi") {
    await page.waitForFunction(
      () => document.querySelectorAll('[class*="diagram-part_diagramItem"]').length > 0,
      undefined,
      { timeout: 45_000 },
    );
  } else {
    await page.waitForSelector("[data-part-id]", { timeout: 30_000 });
  }
  await page.waitForTimeout(3500);

  // Pass the extraction body as a plain function string so Playwright can
  // serialize it without tsx wrapping it in a `__name` helper (which is
  // not defined in the browser context).
  const raw = await page.evaluate(`
    (function extract(source) {
      // Find the simulator canvas SVG. Prefer SVGs with the most
      // stroked line/polyline/path children (the wire layer), using
      // area as a secondary filter so we skip tiny icon SVGs.
      var allSvgs = Array.from(document.querySelectorAll("svg"));
      var best = null;
      var bestScore = 0;
      for (var i = 0; i < allSvgs.length; i++) {
        var svg = allSvgs[i];
        var r = svg.getBoundingClientRect();
        var area = r.width * r.height;
        if (area < 10000) continue;
        // Score by distinct stroke colors — the wire layer uses ~6 colors
        // (red, black, green, gold, violet, gray) while the ruler layer
        // uses just 2 (major/minor ticks).
        var seenColors = {};
        var kids = svg.querySelectorAll("line, polyline, path");
        for (var ki = 0; ki < kids.length; ki++) {
          var kcs = window.getComputedStyle(kids[ki]);
          var stk = kcs.stroke;
          if (!stk || stk === "none" || stk === "rgba(0, 0, 0, 0)") continue;
          if (parseFloat(kcs.strokeWidth || "0") < 0.5) continue;
          seenColors[stk] = true;
        }
        var distinct = Object.keys(seenColors).length;
        if (distinct > bestScore) {
          bestScore = distinct;
          best = svg;
        }
      }
      if (!best) return [];

      // Collect part wrappers with full bounding boxes, not just centers.
      // Matching "endpoint is near part" uses the nearest EDGE of a part's
      // bbox, which is more accurate for wires that terminate at a pin on
      // the part boundary rather than at the part center.
      var partBoxes = [];
      var wrapperSelector = source === "wokwi"
        ? '[class*="diagram-part_diagramItem"][id]'
        : '[data-part-id]';
      var wrappers = document.querySelectorAll(wrapperSelector);
      for (var j = 0; j < wrappers.length; j++) {
        var w = wrappers[j];
        var wr = w.getBoundingClientRect();
        var id = w.id || w.dataset.partId || "";
        if (!id || wr.width < 10 || wr.height < 10) continue;
        partBoxes.push({
          id: id,
          cx: wr.left + wr.width / 2,
          cy: wr.top + wr.height / 2,
          l: wr.left,
          t: wr.top,
          r: wr.right,
          b: wr.bottom,
        });
      }

      function nearest(x, y) {
        // Use distance to the nearest point on the part's bounding box
        // (not just the center) and expand to 120 px so we can reach
        // wires terminating a little outside the part.
        var best = undefined;
        var bestD = 120 * 120;
        for (var k = 0; k < partBoxes.length; k++) {
          var p = partBoxes[k];
          var dx = Math.max(p.l - x, 0, x - p.r);
          var dy = Math.max(p.t - y, 0, y - p.b);
          var d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = p.id; }
        }
        return best;
      }

      var results = [];
      var shapes = best.querySelectorAll("line, polyline, path");
      var idx = 0;
      for (var m = 0; m < shapes.length; m++) {
        var el = shapes[m];
        var cs = window.getComputedStyle(el);
        var stroke = cs.stroke;
        if (!stroke || stroke === "none" || stroke === "rgba(0, 0, 0, 0)") continue;
        var sw = parseFloat(cs.strokeWidth || "0");
        if (sw < 0.5) continue;

        var elRect = el.getBoundingClientRect();
        if (elRect.width < 4 && elRect.height < 4) continue;

        var tag = el.tagName.toLowerCase();
        var points = [];
        var ctm = el.getScreenCTM();
        if (!ctm) continue;
        var ownerSvg = el.ownerSVGElement;

        if (tag === "line") {
          var p1 = ownerSvg.createSVGPoint();
          p1.x = el.x1.baseVal.value; p1.y = el.y1.baseVal.value;
          var p2 = ownerSvg.createSVGPoint();
          p2.x = el.x2.baseVal.value; p2.y = el.y2.baseVal.value;
          var a = p1.matrixTransform(ctm);
          var b = p2.matrixTransform(ctm);
          points.push({ x: a.x, y: a.y });
          points.push({ x: b.x, y: b.y });
        } else if (tag === "polyline") {
          for (var pi = 0; pi < el.points.numberOfItems; pi++) {
            var pp = el.points.getItem(pi).matrixTransform(ctm);
            points.push({ x: pp.x, y: pp.y });
          }
        } else if (tag === "path") {
          var len = el.getTotalLength ? el.getTotalLength() : 0;
          if (len <= 0) continue;
          var samples = Math.min(25, Math.max(2, Math.floor(len / 5)));
          for (var si = 0; si <= samples; si++) {
            var t = (si / samples) * len;
            var point = el.getPointAtLength(t);
            var svgP = ownerSvg.createSVGPoint();
            svgP.x = point.x; svgP.y = point.y;
            var tp = svgP.matrixTransform(ctm);
            points.push({ x: tp.x, y: tp.y });
          }
        }

        if (points.length < 2) continue;
        var dx = points[points.length - 1].x - points[0].x;
        var dy = points[points.length - 1].y - points[0].y;
        if (Math.hypot(dx, dy) < 6) continue;

        var rounded = [];
        for (var ri = 0; ri < points.length; ri++) {
          rounded.push({
            x: Math.round(points[ri].x * 100) / 100,
            y: Math.round(points[ri].y * 100) / 100,
          });
        }

        results.push({
          index: idx++,
          tag: tag,
          color: stroke,
          strokeWidth: cs.strokeWidth || "0",
          points: rounded,
          startPart: nearest(points[0].x, points[0].y),
          endPart: nearest(points[points.length - 1].x, points[points.length - 1].y),
          bbox: {
            x: Math.round(elRect.left * 100) / 100,
            y: Math.round(elRect.top * 100) / 100,
            w: Math.round(elRect.width * 100) / 100,
            h: Math.round(elRect.height * 100) / 100,
          },
        });
      }
      return results;
    })(${JSON.stringify(source)});
  `);
  return raw as Wire[];
}

async function main() {
  const source = process.argv[2] as "wokwi" | "sparkbench";
  const url = process.argv[3];
  if (!source || !url || (source !== "wokwi" && source !== "sparkbench")) {
    console.error("Usage: extract-wires.ts (wokwi|sparkbench) <url>");
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error(`[${source}] ${msg.text().slice(0, 200)}`);
    });
    console.error(`[${source}] loading ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const wires = await extractFromPage(page, source);
    const out = { source, url, wireCount: wires.length, wires };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
