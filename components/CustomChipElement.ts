/**
 * Dynamic custom-chip web component.
 *
 * Each registered chip becomes a `<chip-XXX>` HTML element. It exposes
 * `pinInfo` as an instance property (matching @wokwi/elements convention, so
 * DiagramCanvas's wire router can find pin positions), and renders one of two
 * visuals:
 *
 *   1. Generic DIP body + pins — when no breakout art is supplied
 *   2. Breakout PCB — when the project ships a `<name>.chip.svg` file
 *
 * Both use the same pin grid (9.6 px UNIT) so wires land in the same places
 * regardless of which visual is active.
 */

const UNIT = 9.6; // 0.1 inch at 96 DPI — matches UNIT_PX in constants.ts
const PX_PER_MM = 96 / 25.4; // 3.7795275591 — SVGs with mm width render at 96 DPI

// Wokwi's generic breakout template constants (from extract-wokwi-generic-chip-sizes.ts):
//   width is constant 30mm; height is 4.54 + (pinsPerSide-1)*2.54 mm;
//   holes are at x={1.27, 28.73} mm, centers at y=(2.27 + i*2.54) mm,
//   with 2.54mm spacing (=0.1" = UNIT in px). Body fill #087f45, rx=1.
const WOKWI_WIDTH_MM = 30;
const WOKWI_HOLE_X_LEFT_MM = 1.27;
const WOKWI_HOLE_X_RIGHT_MM = 28.73;
const WOKWI_HOLE_Y_FIRST_MM = 2.27; // hole center y for i=0
const WOKWI_PIN_SPACING_MM = 2.54;
const WOKWI_TOP_BOTTOM_MARGIN_MM = 2.27;

interface ElementPinInfo {
  name: string;
  x: number;
  y: number;
  number: number;
  signals: { type: string; signal: string }[];
}

function wokwiHeightMm(pinsPerSide: number): number {
  return WOKWI_TOP_BOTTOM_MARGIN_MM * 2 + (pinsPerSide - 1) * WOKWI_PIN_SPACING_MM;
}

/**
 * Build pin infos for a Wokwi-generic breakout, in PX coordinates relative
 * to the element's own local SVG box. Pin order matches Wokwi: pins[0] =
 * top-left, down the left side, then up the right side (pin N = top-right).
 */
function wokwiPinInfos(pinNames: string[]): {
  pins: ElementPinInfo[];
  chipWidthPx: number;
  chipHeightPx: number;
} {
  const effective = pinNames.filter((p) => p.length > 0);
  const pinsPerSide = Math.max(2, Math.ceil(effective.length / 2));
  const heightMm = wokwiHeightMm(pinsPerSide);
  const chipWidthPx = WOKWI_WIDTH_MM * PX_PER_MM;
  const chipHeightPx = heightMm * PX_PER_MM;
  const xLeftPx = WOKWI_HOLE_X_LEFT_MM * PX_PER_MM;
  const xRightPx = WOKWI_HOLE_X_RIGHT_MM * PX_PER_MM;
  const yPx = (i: number) => (WOKWI_HOLE_Y_FIRST_MM + i * WOKWI_PIN_SPACING_MM) * PX_PER_MM;

  const pins: ElementPinInfo[] = [];
  const leftCount = Math.min(pinsPerSide, effective.length);
  const rightCount = effective.length - leftCount;

  // Left side top-to-bottom: pins 1..leftCount
  for (let i = 0; i < leftCount; i++) {
    const name = effective[i];
    pins.push({
      name,
      x: xLeftPx,
      y: yPx(i),
      number: i + 1,
      signals: isPowerPin(name) ? [{ type: "power", signal: name }] : [],
    });
  }
  // Right side bottom-to-top: pins leftCount+1..N. Right-bottom = pinsPerSide-1.
  for (let i = 0; i < rightCount; i++) {
    const name = effective[leftCount + i];
    pins.push({
      name,
      x: xRightPx,
      y: yPx(pinsPerSide - 1 - i),
      number: leftCount + i + 1,
      signals: isPowerPin(name) ? [{ type: "power", signal: name }] : [],
    });
  }
  return { pins, chipWidthPx, chipHeightPx };
}

/**
 * Render Wokwi's generic custom-chip breakout SVG, verbatim formula.
 * Always 30mm wide; height scales with pinsPerSide.
 */
function renderWokwiBreakoutSvg(pinsPerSide: number, label: string): string {
  const h = wokwiHeightMm(pinsPerSide);
  const midY = h / 2;
  // dy for "Breakout" subtitle: 2.5 for the smallest (4-pin) chip, 4 otherwise.
  const dy = pinsPerSide <= 2 ? 2.5 : 4;
  const safeLabel = escapeXml(label);
  let svg = `<svg width="${WOKWI_WIDTH_MM}mm" height="${h}mm" viewBox="0 0 ${WOKWI_WIDTH_MM} ${h}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<defs><g id="hole"><circle r="0.7" cx="0" cy="1.27" fill="#ffe680"/><circle r="0.45" cx="0" cy="1.27" fill="#fff"/></g></defs>`;
  svg += `<rect fill="#087f45" width="${WOKWI_WIDTH_MM}" height="${h}" rx="1"/>`;
  // Holes: left top-to-bottom, then right bottom-to-top (matches Wokwi's render order).
  for (let i = 0; i < pinsPerSide; i++) {
    const y = 1 + i * WOKWI_PIN_SPACING_MM; // `use y` — circle center is at (y + 1.27)
    svg += `<use href="#hole" x="${WOKWI_HOLE_X_LEFT_MM}" y="${y}"/>`;
  }
  for (let i = pinsPerSide - 1; i >= 0; i--) {
    const y = 1 + i * WOKWI_PIN_SPACING_MM;
    svg += `<use href="#hole" x="${WOKWI_HOLE_X_RIGHT_MM}" y="${y}"/>`;
  }
  svg += `<text data-role="label" y="${midY}" font-size="3" text-anchor="middle" fill="white">`;
  svg += `<tspan x="15">${safeLabel}</tspan>`;
  svg += `<tspan x="15" dy="${dy}">Breakout</tspan>`;
  svg += `</text>`;
  svg += `</svg>`;
  return svg;
}

/** Already-registered (partType, style) keys to avoid double-registering */
const registered = new Set<string>();

/**
 * Register a custom chip as a web component.
 *
 * @param breakoutSvg Optional raw SVG string from `<name>.chip.svg`. When
 *                    provided, this replaces the generic DIP visual.
 * @param pinPositions Optional explicit pin positions (overrides the
 *                    default grid placement). Useful for matching a
 *                    specific external simulator's pin layout so wires
 *                    land at identical coordinates.
 */
export interface PinTemplate {
  template: "numeric-dip" | "alpha-dip";
  defaultPinCount: number;
}

export function registerCustomChipElement(
  partType: string,
  pinNames: string[],
  label: string,
  breakoutSvg?: string,
  pinPositions?: Record<string, { x: number; y: number }>,
  bodySize?: { width: number; height: number },
  pinTemplate?: PinTemplate,
): void {
  const styleKey = breakoutSvg ? "breakout" : "dip";
  const key = `${partType}:${styleKey}`;
  if (registered.has(key)) return;
  if (typeof customElements === "undefined") return;

  // Filter out empty pin names (spacers in chip.json)
  const effectivePins = pinNames.filter((p) => p.length > 0);
  const pinsPerSide = Math.max(2, Math.ceil(effectivePins.length / 2));

  // Compute chip dimensions and pin positions. Priority:
  //   1. Explicit bodySize override + pinPositions (stock chips like CD4051B)
  //   2. External breakoutSvg supplied by the project
  //   3. Wokwi-generic breakout template (default for user custom chips)
  let chipW: number;
  let chipH: number;
  let pinInfos: ElementPinInfo[];

  if (pinPositions || bodySize) {
    // Legacy / stock-chip path: explicit positions take precedence. Keep
    // the previous coordinate convention (bottom row L→R, top row R→L).
    const rowSpacing = 3 * UNIT;
    chipW = (pinsPerSide - 1) * UNIT;
    chipH = rowSpacing;
    if (bodySize) {
      chipW = bodySize.width;
      chipH = bodySize.height;
    } else if (pinPositions) {
      let maxX = 0;
      let maxY = 0;
      for (const name of effectivePins) {
        const pos = pinPositions[name];
        if (!pos) continue;
        if (pos.x > maxX) maxX = pos.x;
        if (pos.y > maxY) maxY = pos.y;
      }
      if (maxX > 0) chipW = maxX;
      if (maxY > 0) chipH = maxY;
    }
    pinInfos = [];
    const bottomCount = Math.min(pinsPerSide, effectivePins.length);
    const topCount = effectivePins.length - bottomCount;
    const placeOrOverride = (name: string, defaultX: number, defaultY: number, number: number) => {
      const pos = pinPositions?.[name];
      pinInfos.push({
        name,
        x: pos ? pos.x : defaultX,
        y: pos ? pos.y : defaultY,
        number,
        signals: isPowerPin(name) ? [{ type: "power", signal: name }] : [],
      });
    };
    for (let i = 0; i < bottomCount; i++) {
      placeOrOverride(effectivePins[i], i * UNIT, chipH, i + 1);
    }
    for (let i = 0; i < topCount; i++) {
      placeOrOverride(effectivePins[bottomCount + i], (pinsPerSide - 1 - i) * UNIT, 0, bottomCount + i + 1);
    }
  } else {
    // Default path: Wokwi's generic custom-chip breakout template.
    const out = wokwiPinInfos(effectivePins);
    chipW = out.chipWidthPx;
    chipH = out.chipHeightPx;
    pinInfos = out.pins;
  }

  const svg = breakoutSvg
    ? wrapBreakoutSvg(breakoutSvg, chipW, chipH)
    : pinPositions || bodySize
      ? renderDipSvg(chipW, chipH, pinsPerSide, label)
      : renderWokwiBreakoutSvg(pinsPerSide, label);

  // Skip the actual customElements.define if a previous call already
  // registered this partType with a different style — the browser won't let
  // us redefine an existing element name. The first-registered style wins.
  if (customElements.get(partType)) {
    registered.add(key);
    return;
  }

  class CustomChipEl extends HTMLElement {
    // Instance properties so (el as any).pinInfo / .chipWidth / .chipHeight
    // work — matches the @wokwi/elements convention used by DiagramCanvas.
    // These defaults come from chip.json's static `pins` array; they may
    // be overridden per-instance from the diagram.json `attrs.pins`
    // value via the `pins` attribute on this element.
    pinInfo: ElementPinInfo[] = pinInfos;
    chipWidth = chipW;
    chipHeight = chipH;
    // SVG-internal viewBox units used for label rotation. For the legacy
    // DIP renderer the viewBox is in px (matches chipWidth/Height). For the
    // Wokwi breakout, it's in mm (width=30, height=heightMm).
    private labelCenter: { x: number; y: number } = pinPositions || bodySize
      ? { x: chipW / 2, y: chipH / 2 }
      : { x: WOKWI_WIDTH_MM / 2, y: wokwiHeightMm(pinsPerSide) / 2 };

    static get observedAttributes() {
      return ["pins"];
    }

    attributeChangedCallback(name: string, _old: string | null, value: string | null) {
      if (name !== "pins") return;
      if (!pinTemplate) return;
      const count = Math.max(2, parseInt(value ?? "", 10) || pinTemplate.defaultPinCount);
      this.rebuildPinGrid(count);
    }

    /**
     * Rebuild pinInfo for a specific pin count using the declared
     * template. Only called when chip.json set a `pinTemplate` — static
     * chips keep their default pinInfo.
     */
    private rebuildPinGrid(count: number) {
      if (!pinTemplate) return;
      const newNames: string[] =
        pinTemplate.template === "numeric-dip"
          ? Array.from({ length: count }, (_, i) => String(i + 1))
          : (() => {
              const half = Math.ceil(count / 2);
              return [
                ...Array.from({ length: half }, (_, i) => `A${i + 1}`),
                ...Array.from({ length: count - half }, (_, i) => `B${i + 1}`),
              ];
            })();
      const pps = Math.max(2, Math.ceil(newNames.length / 2));
      const out = wokwiPinInfos(newNames);
      this.pinInfo = out.pins;
      this.chipWidth = out.chipWidthPx;
      this.chipHeight = out.chipHeightPx;
      this.labelCenter = { x: WOKWI_WIDTH_MM / 2, y: wokwiHeightMm(pps) / 2 };
      this.innerHTML = renderWokwiBreakoutSvg(pps, label);
      this.fixLabelOrientation();
    }

    connectedCallback() {
      // If the element was created with a `pins` attribute, rebuild
      // the grid before emitting the default SVG.
      if (pinTemplate && this.hasAttribute("pins")) {
        const count = parseInt(this.getAttribute("pins") || "", 10) || pinTemplate.defaultPinCount;
        this.rebuildPinGrid(count);
      } else {
        this.innerHTML = svg;
      }
      // Counter-rotate label so it's readable regardless of wrapper rotation.
      this.fixLabelOrientation();
      const wrapper = this.closest("[data-part-id]") as HTMLElement | null;
      if (wrapper && typeof MutationObserver !== "undefined") {
        const obs = new MutationObserver(() => this.fixLabelOrientation());
        obs.observe(wrapper, { attributes: true, attributeFilter: ["style"] });
      }
    }

    private fixLabelOrientation() {
      const wrapper = this.closest("[data-part-id]") as HTMLElement | null;
      const text = this.querySelector("text[data-role='label']") as SVGGraphicsElement | null;
      if (!text) return;
      let rot = 0;
      if (wrapper) {
        const m = wrapper.style.transform.match(/rotate\((-?\d+(?:\.\d+)?)deg\)/);
        if (m) rot = parseFloat(m[1]) % 360;
      }
      if (rot < 0) rot += 360;
      text.setAttribute(
        "transform",
        `rotate(${-rot} ${this.labelCenter.x} ${this.labelCenter.y})`,
      );
    }
  }

  customElements.define(partType, CustomChipEl);
  registered.add(key);
}

/**
 * Wrap a raw `<name>.chip.svg` string in a fresh <svg> viewBox sized to the
 * chip's pin grid plus generous padding. Breakout boards typically extend
 * ~30-50 px beyond the naked pin footprint (IC cavity + silk + mounting
 * holes). We use 40 px padding on each axis to accommodate that, and the
 * pin grid stays centered so wires still land on their expected positions.
 *
 * If the author supplied a full `<svg>` document, strip their outer tag and
 * keep only its contents so our viewBox wins.
 */
function wrapBreakoutSvg(inner: string, chipW: number, chipH: number): string {
  const padX = 40;
  const padY = 40;
  const viewX = -padX;
  const viewY = -padY;
  const viewW = chipW + padX * 2;
  const viewH = chipH + padY * 2;
  let body = inner.trim();
  const svgMatch = body.match(/<svg[^>]*>([\s\S]*)<\/svg>/i);
  if (svgMatch) body = svgMatch[1];
  return `<svg width="${viewW}" height="${viewH}" viewBox="${viewX} ${viewY} ${viewW} ${viewH}" style="overflow:visible" xmlns="http://www.w3.org/2000/svg" data-role="breakout">${body}</svg>`;
}

function isPowerPin(name: string): boolean {
  const n = name.toUpperCase();
  return n === "VCC" || n === "GND" || n === "VDD" || n === "VSS" || n === "V+" || n === "V-";
}

function renderDipSvg(chipW: number, chipH: number, pinsPerSide: number, label: string): string {
  // Pin grid stays on the 9.6 px UNIT. The body is drawn with extra padding
  // for visual weight.
  const pinStub = 3;
  const pinW = 3.0;
  const bodyPadX = 6;
  const bodyX = -bodyPadX;
  const bodyW = chipW + bodyPadX * 2;
  const bodyY = pinStub;
  const bodyH = chipH - pinStub * 2;
  const bodyR = 3;

  let svg = `<svg width="${bodyW}" height="${chipH}" viewBox="${bodyX} 0 ${bodyW} ${chipH}" style="overflow:visible" xmlns="http://www.w3.org/2000/svg">`;

  // Shadow
  svg += `<rect x="${bodyX + 0.5}" y="${bodyY + 0.5}" width="${bodyW}" height="${bodyH}" rx="${bodyR}" fill="#000" opacity="0.35"/>`;
  // Body
  svg += `<rect x="${bodyX}" y="${bodyY}" width="${bodyW}" height="${bodyH}" rx="${bodyR}" fill="#2a4a4a" stroke="#1a2e2e" stroke-width="0.4"/>`;
  // Top highlight
  svg += `<rect x="${bodyX + 1}" y="${bodyY + 1}" width="${bodyW - 2}" height="${Math.max(1, bodyH * 0.15)}" rx="1.5" fill="#3a6666" opacity="0.6"/>`;
  // Notch (pin 1 indicator)
  const notchY = bodyY + bodyH / 2;
  svg += `<path d="M ${bodyX} ${notchY - 3.5} A 3.5 3.5 0 0 1 ${bodyX} ${notchY + 3.5}" fill="#1a2e2e"/>`;
  // Pin-1 dot
  svg += `<circle cx="${bodyX + 4}" cy="${bodyY + bodyH - 3.5}" r="1.2" fill="#bbb" opacity="0.9"/>`;
  // Label
  const displayLabel = label.length > 14 ? label.slice(0, 13) + "…" : label;
  const fontSize = label.length > 8 ? 5.5 : 7;
  svg += `<text data-role="label" x="${chipW / 2}" y="${chipH / 2}" text-anchor="middle" dominant-baseline="middle" fill="#9cdcdc" font-size="${fontSize}" font-family="-apple-system, monospace" font-weight="700" letter-spacing="0.3">${escapeXml(displayLabel)}</text>`;
  // Bottom pins
  for (let i = 0; i < pinsPerSide; i++) {
    const x = i * UNIT;
    svg += `<rect x="${x - pinW / 2}" y="${bodyY + bodyH}" width="${pinW}" height="${pinStub}" fill="#d0d0d0" stroke="#888" stroke-width="0.2" rx="0.4"/>`;
  }
  // Top pins
  for (let i = 0; i < pinsPerSide; i++) {
    const x = i * UNIT;
    svg += `<rect x="${x - pinW / 2}" y="0" width="${pinW}" height="${pinStub}" fill="#d0d0d0" stroke="#888" stroke-width="0.2" rx="0.4"/>`;
  }

  svg += "</svg>";
  return svg;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
