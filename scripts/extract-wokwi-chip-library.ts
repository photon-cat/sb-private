#!/usr/bin/env npx tsx
/**
 * Bulk extractor for Wokwi community chips (chip-*).
 *
 * For each chip in CHIP_LIBRARY, this tool:
 *   1. Opens Wokwi's "new project" editor
 *   2. Edits diagram.json in the Monaco editor to add a single instance
 *      of the target chip
 *   3. Waits for the chip's DOM wrapper to render
 *   4. Dumps its outerHTML (SVG + attributes + style)
 *   5. Parses the inner SVG's body dimensions and pin-hole positions
 *   6. Writes lib/stock-chips/<slug>/chip.svg + chip.json
 *
 * Output layout:
 *   lib/stock-chips/
 *     74hc595.svg        (raw SVG body)
 *     74hc595.json       (wokwi-authoritative dimensions + pin positions)
 *     cd4051b.svg
 *     cd4051b.json
 *     ...
 *
 * Users can reference these when authoring their own SparkBench chip
 * definitions that need to match Wokwi's rendering pixel-for-pixel.
 *
 * Usage:
 *   npx tsx scripts/extract-wokwi-chip-library.ts
 *   npx tsx scripts/extract-wokwi-chip-library.ts --only 74hc595,74hc138
 *   npx tsx scripts/extract-wokwi-chip-library.ts --out /tmp/stock
 *
 * Requires WOKWI_CLI_TOKEN not strictly (only for wokwi-cli, not for the
 * public web editor) — this script uses the anonymous new-project URL.
 */

import { chromium, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import path from "path";

// The list of community chips to extract. Each entry specifies:
//   slug       — local filename
//   chipType   — diagram.json type string (Wokwi community chip)
//   pinCount   — expected number of holes (for verification)
//   projectUrl — a public Wokwi project containing this chip. Finding
//                these URLs is manual since Wokwi has no search API;
//                add more entries here as you discover projects.
//   partId     — the id of the chip instance in that project (usually "ic1")
const CHIP_LIBRARY: {
  slug: string;
  chipType: string;
  pinCount: number;
  projectUrl: string;
  partId: string;
}[] = [
  {
    slug: "cd4051b",
    chipType: "chip-cd4051b",
    pinCount: 16,
    projectUrl: "https://wokwi.com/projects/343522915673702994",
    partId: "ic1",
  },
];

interface ExtractedChip {
  slug: string;
  chipType: string;
  wrapperHtml: string;
  innerSvg: string;
  bodySvgWidth: number;   // in mm (Wokwi uses mm units in the inner SVG)
  bodySvgHeight: number;
  bodyFill: string | null;
  domBoundingBox: { width: number; height: number };
  holes: { cx: number; cy: number; label?: string }[];  // in mm
  wokwiControllerAttr: string | null;
}

async function extractChip(
  page: Page,
  projectUrl: string,
  partId: string,
  chipType: string,
): Promise<ExtractedChip | null> {
  // Navigate to a known public project that contains this chip. Much
  // more reliable than trying to paste a fresh diagram.json into the
  // new-project editor (which hides its editor tabs behind UI chrome
  // that Playwright can't always reach).
  await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4000);

  // Grab the target wrapper
  const raw = await page.evaluate((id: string) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const innerSvg = el.querySelector("svg");
    return {
      outerHTML: el.outerHTML,
      innerSvgOuterHTML: innerSvg?.outerHTML ?? null,
      boundingBox: { width: r.width, height: r.height },
      wokwiController: el.getAttribute("wokwi-controller"),
    };
  }, partId);

  if (!raw || !raw.innerSvgOuterHTML) {
    console.error(`[extract] no #${partId} element found at ${projectUrl}`);
    return null;
  }

  // Parse the inner SVG dimensions and holes using regex + a light parser.
  // Wokwi's chip SVGs follow a consistent pattern:
  //   <svg width="Xmm" height="Ymm" viewBox="0 0 X Y">
  //     <rect fill="#xxxxxx" width="X" height="Y" rx="1"/>
  //     <use href="#hole" x="..." y="..."/>  (repeated)
  //     <text ...>CHIPNAME</text>
  //   </svg>
  const svg = raw.innerSvgOuterHTML;
  const dimMatch = svg.match(/width="([\d.]+)(mm)?"\s+height="([\d.]+)(mm)?"/);
  const bodyMatch = svg.match(/<rect[^>]*fill="(#[0-9a-fA-F]+)"[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"/);
  const bodyFill = bodyMatch?.[1] ?? null;
  const bodyW = parseFloat(dimMatch?.[1] ?? bodyMatch?.[2] ?? "0");
  const bodyH = parseFloat(dimMatch?.[3] ?? bodyMatch?.[3] ?? "0");

  // Holes: <use href="#hole" x="1.27" y="1"/> — or inline <circle> pairs
  const holes: { cx: number; cy: number }[] = [];
  const useRe = /<use\s+[^>]*href="#hole"[^>]*x="([\d.]+)"[^>]*y="([\d.]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(svg)) !== null) {
    holes.push({ cx: parseFloat(m[1]), cy: parseFloat(m[2]) });
  }
  // Alternative: raw <circle> pairs (outer gold + inner white). Count gold only.
  if (holes.length === 0) {
    const circleRe = /<circle[^>]*cx="([\d.]+)"[^>]*cy="([\d.]+)"[^>]*fill="#ffe680"/g;
    while ((m = circleRe.exec(svg)) !== null) {
      holes.push({ cx: parseFloat(m[1]), cy: parseFloat(m[2]) });
    }
  }

  return {
    slug: chipType.replace(/^chip-/, ""),
    chipType,
    wrapperHtml: raw.outerHTML,
    innerSvg: svg,
    bodySvgWidth: bodyW,
    bodySvgHeight: bodyH,
    bodyFill,
    domBoundingBox: raw.boundingBox,
    holes,
    wokwiControllerAttr: raw.wokwiController,
  };
}

function writeChipFiles(extracted: ExtractedChip, outDir: string): void {
  const slug = extracted.slug;
  mkdirSync(outDir, { recursive: true });

  // Convert holes from mm to SparkBench px (3.78 px / mm)
  const MM_TO_PX = 96 / 25.4;
  const pxHoles = extracted.holes.map((h) => ({
    x: Math.round(h.cx * MM_TO_PX * 100) / 100,
    y: Math.round(h.cy * MM_TO_PX * 100) / 100,
  }));

  // Dump the inner SVG verbatim (trimmed to its contents) as .svg for
  // reuse as a .chip.svg breakout source.
  writeFileSync(path.join(outDir, `${slug}.svg`), extracted.innerSvg + "\n");

  // Dump authoritative metadata so SparkBench authors can reference it
  // when creating cd4051b-wokwi-style breakout projects.
  const meta = {
    slug,
    chipType: extracted.chipType,
    wokwiController: extracted.wokwiControllerAttr,
    bodySizeMm: {
      width: extracted.bodySvgWidth,
      height: extracted.bodySvgHeight,
    },
    bodySizePx: {
      width: Math.round(extracted.bodySvgWidth * MM_TO_PX * 100) / 100,
      height: Math.round(extracted.bodySvgHeight * MM_TO_PX * 100) / 100,
    },
    bodyFill: extracted.bodyFill,
    domBoundingBoxPx: extracted.domBoundingBox,
    holeCount: extracted.holes.length,
    holesMm: extracted.holes,
    holesPx: pxHoles,
    extractedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(outDir, `${slug}.json`), JSON.stringify(meta, null, 2) + "\n");
}

async function main() {
  const args = process.argv.slice(2);
  let onlySlugs: Set<string> | null = null;
  let outDir = path.resolve(__dirname, "..", "lib", "stock-chips");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--only") {
      onlySlugs = new Set(args[++i].split(","));
    } else if (args[i] === "--out") {
      outDir = path.resolve(args[++i]);
    }
  }

  const targets = onlySlugs
    ? CHIP_LIBRARY.filter((c) => onlySlugs!.has(c.slug))
    : CHIP_LIBRARY;

  if (targets.length === 0) {
    console.error("No chips selected.");
    process.exit(2);
  }

  console.error(`[extract] writing to ${outDir}`);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error(`[wokwi] ${msg.text().slice(0, 180)}`);
    });

    const results: { slug: string; ok: boolean; reason?: string }[] = [];
    for (const c of targets) {
      console.error(`\n[extract] ${c.chipType} from ${c.projectUrl} (#${c.partId}, expecting ${c.pinCount} pins)...`);
      try {
        const ex = await extractChip(page, c.projectUrl, c.partId, c.chipType);
        if (!ex) {
          results.push({ slug: c.slug, ok: false, reason: `no #${c.partId} in project` });
          continue;
        }
        const holeCount = ex.holes.length;
        const pinMatch = holeCount === c.pinCount;
        console.error(
          `  body ${ex.bodySvgWidth}x${ex.bodySvgHeight}mm  fill=${ex.bodyFill}  holes=${holeCount}` +
          (pinMatch ? " ✓" : ` (expected ${c.pinCount})`),
        );
        writeChipFiles(ex, outDir);
        results.push({ slug: c.slug, ok: true });
      } catch (err) {
        console.error(`  error: ${err instanceof Error ? err.message : String(err)}`);
        results.push({ slug: c.slug, ok: false, reason: String(err).slice(0, 80) });
      }
    }

    console.error("\n=== Extraction summary ===");
    for (const r of results) {
      console.error(`  ${r.ok ? "✓" : "✗"} ${r.slug}${r.reason ? " — " + r.reason : ""}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
