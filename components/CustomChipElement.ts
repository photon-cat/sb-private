/**
 * Dynamic DIP IC chip web component for custom chips.
 * Renders an SVG DIP package with pin positions matching the @wokwi/elements grid.
 */

const UNIT = 9.6; // 0.1 inch at 96 DPI — matches UNIT_PX in constants.ts

interface ElementPinInfo {
  name: string;
  x: number;
  y: number;
  number: number;
  signals: { type: string; signal: string }[];
}

function pinX(i: number): number {
  return i * UNIT;
}

/** Already-registered custom element names to avoid double-registering */
const registered = new Set<string>();

/**
 * Register a custom chip as a web component with DIP package rendering.
 * Call this before creating DOM elements for the chip.
 */
export function registerCustomChipElement(
  partType: string,
  pinNames: string[],
  label: string,
): void {
  if (registered.has(partType)) return;
  if (typeof customElements === "undefined") return;
  if (customElements.get(partType)) {
    registered.add(partType);
    return;
  }

  // Filter out empty pin names (spacers in chip.json)
  const effectivePins = pinNames.filter((p) => p.length > 0);
  const pinsPerSide = Math.max(2, Math.ceil(effectivePins.length / 2));
  const rowSpacing = 3 * UNIT; // 0.3in between rows
  const chipW = (pinsPerSide - 1) * UNIT;
  const chipH = rowSpacing;

  // Build pin info array: bottom row left→right (pins 1..N/2), top row right→left (pins N/2+1..N)
  const pinInfos: ElementPinInfo[] = [];
  const bottomCount = Math.min(pinsPerSide, effectivePins.length);
  const topCount = effectivePins.length - bottomCount;

  for (let i = 0; i < bottomCount; i++) {
    const name = effectivePins[i];
    pinInfos.push({
      name,
      x: pinX(i),
      y: chipH,
      number: i + 1,
      signals: isPowerPin(name) ? [{ type: "power", signal: name }] : [],
    });
  }
  for (let i = 0; i < topCount; i++) {
    const name = effectivePins[bottomCount + i];
    pinInfos.push({
      name,
      x: pinX(pinsPerSide - 1 - i),
      y: 0,
      number: bottomCount + i + 1,
      signals: isPowerPin(name) ? [{ type: "power", signal: name }] : [],
    });
  }

  const svg = renderDipSvg(chipW, chipH, pinsPerSide, label);

  class CustomChipEl extends HTMLElement {
    static get pinInfo() {
      return pinInfos;
    }
    connectedCallback() {
      this.innerHTML = svg;
    }
  }

  customElements.define(partType, CustomChipEl);
  registered.add(partType);
}

function isPowerPin(name: string): boolean {
  const n = name.toUpperCase();
  return n === "VCC" || n === "GND" || n === "VDD" || n === "VSS" || n === "V+" || n === "V-";
}

function renderDipSvg(chipW: number, chipH: number, pinsPerSide: number, label: string): string {
  const pinStub = 2;
  const pinW = 2.4;
  const bodyPad = 3;
  const bodyX = -bodyPad;
  const bodyW = chipW + bodyPad * 2;
  const bodyY = pinStub;
  const bodyH = chipH - pinStub * 2;
  const bodyR = 2;

  let svg = `<svg width="${chipW}" height="${chipH}" style="overflow:visible" xmlns="http://www.w3.org/2000/svg">`;

  // Body — teal tint to distinguish from standard ICs
  svg += `<rect x="${bodyX}" y="${bodyY}" width="${bodyW}" height="${bodyH}" rx="${bodyR}" fill="#2d4a4a"/>`;

  // Notch (pin 1 indicator)
  const notchY = chipH / 2;
  svg += `<path d="M ${bodyX} ${notchY - 3} A 3 3 0 0 1 ${bodyX} ${notchY + 3}" fill="#1d3333"/>`;

  // Dot markers
  svg += `<circle cx="${bodyX + 6}" cy="${chipH / 2}" r="1.8" fill="#1d3333"/>`;

  // Label — truncate if needed
  const displayLabel = label.length > 12 ? label.slice(0, 11) + "…" : label;
  const fontSize = label.length > 8 ? 4 : 5.5;
  svg += `<text x="${chipW / 2}" y="${chipH / 2}" text-anchor="middle" dominant-baseline="middle" fill="#8cc" font-size="${fontSize}" font-family="monospace" font-weight="600">${escapeXml(displayLabel)}</text>`;

  // Bottom pins
  for (let i = 0; i < pinsPerSide; i++) {
    const x = pinX(i);
    svg += `<rect x="${x - pinW / 2}" y="${bodyY + bodyH}" width="${pinW}" height="${pinStub}" fill="#c0c0c0" rx="0.3"/>`;
  }

  // Top pins
  for (let i = 0; i < pinsPerSide; i++) {
    const x = pinX(i);
    svg += `<rect x="${x - pinW / 2}" y="0" width="${pinW}" height="${pinStub}" fill="#c0c0c0" rx="0.3"/>`;
  }

  svg += "</svg>";
  return svg;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
