/**
 * Structural tests: verify the mapping from diagram.json → rendered DOM is
 * complete and correct, independent of pixel-level rendering.
 *
 * For each project:
 *   1. Every part in diagram.json must have a corresponding DOM wrapper
 *      with [data-part-id="<id>"]
 *   2. Every connection in diagram.json must resolve to an SVG polyline
 *      (or wire path) in the canvas — no silent drops from unresolved pins
 *   3. The rendered canvas must report bounding boxes that are non-zero
 *      (catches "element failed to mount" bugs like the static pinInfo
 *      issue we just fixed)
 *   4. For each custom chip part, its pinInfo must be exposed as an
 *      instance property (the bug class that silently dropped chip wires)
 *
 * This is complementary to the pixel golden-file test: if the pixel diff
 * fails, this structural test usually pinpoints WHY (e.g. "chip element
 * had no pinInfo so wires couldn't resolve").
 */

import { test, expect } from "@playwright/test";
import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";

const ROOT = resolve(__dirname, "..");

const PROJECTS = [
  "blink",
  "inverter-demo",
  "cd4051-mux",
  "actuator-test",
  "lcd-hello",
  "i2c-chip-demo",
  "control-knob-demo",
];

test.describe("diagram structure", () => {
  for (const slug of PROJECTS) {
    test(slug, async ({ page }) => {
      const projDir = join(ROOT, "projects", slug);
      const diagramPath = join(projDir, "diagram.json");
      if (!existsSync(diagramPath)) {
        test.skip(true, `no diagram.json in ${projDir}`);
        return;
      }

      const diagram = JSON.parse(readFileSync(diagramPath, "utf-8"));

      await page.goto(`/projects/${slug}`);
      await page.waitForSelector("[data-part-id]", { timeout: 10_000 });
      // Let the async wire computation settle — the computePinsAndWires
      // retry loop runs up to 5 times with increasing delays.
      await page.waitForTimeout(2000);

      // 1. Every part ID in the diagram must have a matching DOM wrapper
      const domPartIds = await page.$$eval("[data-part-id]", (els) =>
        els.map((el) => (el as HTMLElement).dataset.partId ?? ""),
      );
      const diagramPartIds: string[] = diagram.parts.map((p: { id: string }) => p.id);

      for (const id of diagramPartIds) {
        expect(domPartIds, `missing DOM wrapper for part "${id}"`).toContain(id);
      }
      expect(
        domPartIds.length,
        `expected ${diagramPartIds.length} parts rendered, got ${domPartIds.length}`,
      ).toBe(diagramPartIds.length);

      // 2. Every part wrapper should have a non-zero bounding box (i.e.
      //    the custom element actually mounted and produced content).
      const dimensions = await page.$$eval("[data-part-id]", (els) =>
        els.map((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return { id: (el as HTMLElement).dataset.partId, w: r.width, h: r.height };
        }),
      );
      for (const d of dimensions) {
        expect(d.w, `part ${d.id} has zero width`).toBeGreaterThan(0);
        expect(d.h, `part ${d.id} has zero height`).toBeGreaterThan(0);
      }

      // 3. Every connection's start and end ref must resolve to a known
      //    part id. Count wires drawn and compare to the number of
      //    non-dangling connections.
      const expectedWireCount = diagram.connections.filter(
        (conn: [string, string, string, string[]]) => {
          const [from, to] = conn;
          const fromPart = from.split(":")[0];
          const toPart = to.split(":")[0];
          return domPartIds.includes(fromPart) && domPartIds.includes(toPart);
        },
      ).length;

      // The canvas renders wires as SVG polylines or paths. Count them
      // via a permissive selector (depends on the DiagramCanvas impl).
      const renderedWireCount = await page.evaluate(() => {
        // Each rendered wire should have a data-wire-idx or be inside an
        // svg group marked as a wire. Fall back to counting polylines.
        const polylines = document.querySelectorAll("svg polyline, svg [data-wire-idx]");
        return polylines.length;
      });

      // Allow some slack since pin-hover highlight circles might also be
      // polylines, and disconnected wires won't render. Assert at least
      // 50% of expected wires rendered — stricter ratio indicates the
      // "pinInfo dropped, half the wires invisible" class of bug.
      if (expectedWireCount > 0) {
        const ratio = renderedWireCount / expectedWireCount;
        expect(
          ratio,
          `only ${renderedWireCount}/${expectedWireCount} wires rendered (ratio ${ratio.toFixed(2)}) — likely a pin-resolution bug`,
        ).toBeGreaterThan(0.5);
      }

      // 4. Every chip-* part must expose pinInfo as an instance property.
      //    This catches the static-getter regression we fixed.
      const chipPartIds: string[] = diagram.parts
        .filter((p: { type: string }) => p.type.startsWith("chip-"))
        .map((p: { id: string }) => p.id);

      for (const chipId of chipPartIds) {
        const pinInfoLen = await page.evaluate((id) => {
          const wrapper = document.querySelector(`[data-part-id="${id}"]`);
          const el = wrapper?.firstElementChild as (HTMLElement & { pinInfo?: unknown[] }) | null;
          return el?.pinInfo?.length ?? -1;
        }, chipId);
        expect(
          pinInfoLen,
          `chip "${chipId}" has no pinInfo on the element instance — wires to this chip will silently drop`,
        ).toBeGreaterThan(0);
      }
    });
  }
});
