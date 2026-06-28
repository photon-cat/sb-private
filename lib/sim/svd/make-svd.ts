// Compact CMSIS-SVD generator for the in-browser STM32 runners. The behavioral
// models use fixed register offsets, so the SVD only needs each peripheral's
// name / groupName / baseAddress / window size / interrupt — not full register
// trees. This keeps client-shipped SVDs tiny.

export interface SvdPeriphSpec {
  /** Instance name, e.g. "GPIOC", "USART1". */
  name: string;
  /** IP group the model registry is keyed by, e.g. "GPIO", "USART", "TIM". */
  group: string;
  /** Peripheral base address. */
  base: number;
  /** NVIC interrupt number, if any. */
  irq?: number;
  /** Register-window size (default 0x400). */
  size?: number;
}

const hex = (n: number) => "0x" + n.toString(16).toUpperCase();

/** Build a minimal but valid CMSIS-SVD XML string from a peripheral table. */
export function makeSvd(deviceName: string, periphs: SvdPeriphSpec[]): string {
  const body = periphs
    .map((p) => {
      const irq =
        p.irq != null
          ? `\n      <interrupt><name>${p.name}</name><value>${p.irq}</value></interrupt>`
          : "";
      return `    <peripheral>
      <name>${p.name}</name>
      <groupName>${p.group}</groupName>
      <baseAddress>${hex(p.base)}</baseAddress>
      <addressBlock><offset>0x0</offset><size>${hex(p.size ?? 0x400)}</size><usage>registers</usage></addressBlock>${irq}
    </peripheral>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<device schemaVersion="1.1">
  <name>${deviceName}</name>
  <peripherals>
${body}
  </peripherals>
</device>`;
}
