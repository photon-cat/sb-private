#!/usr/bin/env npx tsx
/**
 * Compare the wire rendering of a SparkBench project against the matching
 * Wokwi project. Pairs each wire by (startPart, endPart, color) and
 * reports whether every SparkBench wire has a matching Wokwi wire.
 *
 * Because the two simulators have different absolute coordinate systems
 * (different zoom levels, different origin offsets, different element
 * scales), we normalize each wire to part-relative coordinates before
 * comparing shape: the wire's points are expressed as offsets from its
 * startPart center. This gives us a shape fingerprint that's invariant
 * to where the two simulators put their viewports.
 *
 * Output: per-wire match report, plus overall stats. Exit code 0 if every
 * SparkBench wire matches a Wokwi wire.
 *
 * Usage:
 *   npx tsx scripts/compare-wires.ts cd4051-mux
 *   (assumes matching Wokwi URL from projects/<slug>/.wokwi-url or
 *    passed via --wokwi-url)
 */

import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import os from "os";

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

interface Dump {
  source: string;
  url: string;
  wireCount: number;
  wires: Wire[];
}

// Classify a color into a coarse bucket so Wokwi's "#dd0000" and
// SparkBench's "#ee0000" are treated as the same wire.
function colorBucket(rgb: string): string {
  const m = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return rgb;
  const r = parseInt(m[1], 10);
  const g = parseInt(m[2], 10);
  const b = parseInt(m[3], 10);

  const dominant = (primary: number, a: number, b_: number) =>
    primary > 100 && primary > a * 2 && primary > b_ * 2;

  // Grayscale
  if (Math.abs(r - g) < 20 && Math.abs(g - b) < 20) {
    if (r < 30) return "black";
    if (r < 180) return "gray";
    return "white";
  }
  // Red (pure or orange-red)
  if (dominant(r, g, b)) return "red";
  // Green — Wokwi uses rgb(0,128,0), SparkBench uses rgb(0,204,0)
  if (dominant(g, r, b)) return "green";
  // Gold / yellow — high red AND green, low blue
  if (r > 180 && g > 130 && b < 80) return "gold";
  // Violet / purple / magenta — high red AND blue, variable green
  if (r > 100 && b > 100 && (r > g + 30 || b > g + 30)) return "violet";
  return `${r},${g},${b}`;
}

// Make a key from a wire's part endpoints that's direction-independent
// (pot1→pot2 matches pot2→pot1 because both simulators may render them
// in either direction).
function partKey(a?: string, b?: string): string {
  const as = a || "?";
  const bs = b || "?";
  return [as, bs].sort().join("|");
}

/**
 * Build a topological shape fingerprint: the sequence of bend directions
 * (horizontal/vertical axis + sign) the wire takes from start to end.
 *
 * This normalizes across the two simulators' rendering differences:
 *   - Wokwi samples paths at ~5 px intervals → many redundant colinear points
 *   - SparkBench uses polylines with 2 or 3 points per L-bend
 * Collapsing redundant colinear moves gives us a simulator-independent
 * sequence like "E|S|E" for a wire that goes east, south, east.
 */
function shapeFingerprint(w: Wire): string {
  if (w.points.length < 2) return "";
  // Compute per-segment directions, collapsing colinear runs.
  const dirs: string[] = [];
  for (let i = 1; i < w.points.length; i++) {
    const dx = w.points[i].x - w.points[i - 1].x;
    const dy = w.points[i].y - w.points[i - 1].y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    let dir: string;
    if (Math.abs(dx) > Math.abs(dy)) {
      dir = dx > 0 ? "E" : "W";
    } else {
      dir = dy > 0 ? "S" : "N";
    }
    // Collapse consecutive identical directions (colinear runs)
    if (dirs.length > 0 && dirs[dirs.length - 1] === dir) continue;
    dirs.push(dir);
  }
  const forward = dirs.join("");
  // Reverse with direction flip for direction-independence
  const flip: Record<string, string> = { N: "S", S: "N", E: "W", W: "E" };
  const backward = dirs.slice().reverse().map((d) => flip[d]).join("");
  return forward < backward ? forward : backward;
}

function loadDump(src: "wokwi" | "sparkbench", url: string): Dump {
  console.error(`[compare] extracting ${src} wires from ${url}`);
  const out = execFileSync("npx", ["tsx", path.join(__dirname, "extract-wires.ts"), src, url], {
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function main() {
  const args = process.argv.slice(2);
  const slug = args[0];
  if (!slug) {
    console.error("Usage: compare-wires.ts <project-slug> [--wokwi-url <url>]");
    process.exit(2);
  }
  let wokwiUrl: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--wokwi-url") wokwiUrl = args[++i];
  }
  // Well-known URL per slug — extend as more projects get oracle URLs.
  const defaultUrls: Record<string, string> = {
    "cd4051-mux": "https://wokwi.com/projects/343522915673702994",
  };
  if (!wokwiUrl) wokwiUrl = defaultUrls[slug];
  if (!wokwiUrl) {
    console.error(`No --wokwi-url provided and no default for slug "${slug}"`);
    process.exit(2);
  }

  const sbUrl = `http://localhost:3000/projects/${slug}`;
  const wokwi = loadDump("wokwi", wokwiUrl);
  const sb = loadDump("sparkbench", sbUrl);

  // Stash raw dumps for inspection
  const outDir = path.join(os.tmpdir(), `wire-compare-${slug}-${Date.now()}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "wokwi.json"), JSON.stringify(wokwi, null, 2));
  writeFileSync(path.join(outDir, "sparkbench.json"), JSON.stringify(sb, null, 2));
  console.error(`[compare] raw dumps in ${outDir}`);

  // Group wires by (partKey, colorBucket). Both should produce the same
  // number of wires per group if the two diagrams are topologically equal.
  const groupOf = (w: Wire) => `${partKey(w.startPart, w.endPart)}#${colorBucket(w.color)}`;
  const wokwiGroups = new Map<string, Wire[]>();
  const sbGroups = new Map<string, Wire[]>();
  for (const w of wokwi.wires) {
    const g = groupOf(w);
    if (!wokwiGroups.has(g)) wokwiGroups.set(g, []);
    wokwiGroups.get(g)!.push(w);
  }
  for (const w of sb.wires) {
    const g = groupOf(w);
    if (!sbGroups.has(g)) sbGroups.set(g, []);
    sbGroups.get(g)!.push(w);
  }

  const allKeys = new Set([...wokwiGroups.keys(), ...sbGroups.keys()]);

  const byColor = {
    red: { wokwi: 0, sb: 0 },
    black: { wokwi: 0, sb: 0 },
    green: { wokwi: 0, sb: 0 },
    gold: { wokwi: 0, sb: 0 },
    violet: { wokwi: 0, sb: 0 },
    gray: { wokwi: 0, sb: 0 },
    other: { wokwi: 0, sb: 0 },
  } as Record<string, { wokwi: number; sb: number }>;
  for (const w of wokwi.wires) {
    const b = colorBucket(w.color);
    (byColor[b] ?? byColor.other).wokwi++;
  }
  for (const w of sb.wires) {
    const b = colorBucket(w.color);
    (byColor[b] ?? byColor.other).sb++;
  }

  // Report
  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log(`║ Wire comparison: ${slug.padEnd(48)}║`);
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  console.log(`Total wires: wokwi=${wokwi.wireCount}  sparkbench=${sb.wireCount}\n`);

  console.log("Wires by color:");
  console.log(`  ${"color".padEnd(10)} ${"wokwi".padStart(6)}  ${"sb".padStart(6)}  diff`);
  for (const [color, counts] of Object.entries(byColor)) {
    if (counts.wokwi === 0 && counts.sb === 0) continue;
    const diff = counts.sb - counts.wokwi;
    const flag = diff === 0 ? "✓" : diff > 0 ? `+${diff}` : `${diff}`;
    console.log(`  ${color.padEnd(10)} ${String(counts.wokwi).padStart(6)}  ${String(counts.sb).padStart(6)}  ${flag}`);
  }

  console.log("\nPer-endpoint match:");
  const unmatched: string[] = [];
  let matched = 0;
  let mismatched = 0;
  for (const key of Array.from(allKeys).sort()) {
    const w = wokwiGroups.get(key) ?? [];
    const s = sbGroups.get(key) ?? [];
    if (w.length === s.length && w.length > 0) {
      matched += w.length;
    } else {
      mismatched += Math.max(w.length, s.length);
      unmatched.push(`  ${key.padEnd(40)}  wokwi=${w.length}  sb=${s.length}`);
    }
  }
  if (unmatched.length === 0) {
    console.log("  ✓ every (endpoint, color) group has matching counts in both simulators");
  } else {
    console.log(`  ✗ ${unmatched.length} endpoint groups differ:`);
    for (const u of unmatched.slice(0, 20)) console.log(u);
    if (unmatched.length > 20) console.log(`  ... ${unmatched.length - 20} more`);
  }

  // Topology fingerprint comparison for matched groups.
  // Two wires are topologically equivalent if they take the same
  // sequence of direction changes (e.g. both go "east then south then
  // east"), regardless of the absolute pixel coordinates.
  let shapeMatches = 0;
  let shapeDiffers = 0;
  const shapeDetail: { key: string; i: number; wokwi: string; sb: string; match: boolean }[] = [];
  for (const key of allKeys) {
    const w = wokwiGroups.get(key) ?? [];
    const s = sbGroups.get(key) ?? [];
    if (w.length !== s.length || w.length === 0) continue;
    for (let i = 0; i < w.length; i++) {
      const wFp = shapeFingerprint(w[i]);
      const sFp = shapeFingerprint(s[i]);
      const match = wFp === sFp;
      if (match) shapeMatches++;
      else shapeDiffers++;
      shapeDetail.push({ key, i, wokwi: wFp, sb: sFp, match });
    }
  }
  console.log(`\nTopology comparison: ${shapeMatches} matched, ${shapeDiffers} differed`);
  if (shapeDiffers > 0 && shapeDiffers <= 10) {
    console.log("\nWires with divergent topology:");
    for (const d of shapeDetail.filter((x) => !x.match)) {
      console.log(`  ${d.key.padEnd(40)}  wokwi=[${d.wokwi}]  sb=[${d.sb}]`);
    }
  }
  console.log(`\nOverall: ${matched}/${wokwi.wireCount + sb.wireCount} wires in matched groups, ${mismatched} unmatched`);

  // Final verdict summary
  const totalMatched = matched === (wokwi.wireCount + sb.wireCount);
  if (totalMatched && shapeDiffers === 0) {
    console.log("\n\x1b[32m✓ WIRE PARITY\x1b[0m — every SparkBench wire has a matching Wokwi wire with identical topology.");
  } else {
    console.log("\n\x1b[33m⚠ Partial parity\x1b[0m — see unmatched groups and topology diffs above.");
  }

  process.exit(unmatched.length === 0 ? 0 : 1);
}

main();
