// CMSIS-SVD loader.
//
// ST publishes a CMSIS-SVD for every STM32 describing the full memory map,
// peripheral instances + base addresses, interrupt numbers, and register/field
// layout. Parsing it turns "support a new MCU" into "drop in a data file" — the
// behavioral IP models (lib/mcu/peripherals) are reused by IP-block name.

import { XMLParser } from "fast-xml-parser";

export interface SvdField {
  name: string;
  bitOffset: number;
  bitWidth: number;
}

export interface SvdRegister {
  name: string;
  addressOffset: number;
  resetValue: number;
  fields: SvdField[];
}

export interface SvdInterrupt {
  name: string;
  value: number;
}

export interface SvdPeripheral {
  name: string;
  /** IP-block group (groupName / derivedFrom base), e.g. "USART", "GPIO". */
  group: string;
  baseAddress: number;
  /** Register-window size in bytes (from addressBlock, default 0x400). */
  size: number;
  interrupts: SvdInterrupt[];
  registers: SvdRegister[];
}

export interface SvdDevice {
  name: string;
  peripherals: SvdPeripheral[];
  /** Convenience: peripheral name → instance. */
  byName: Map<string, SvdPeripheral>;
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseInt(v, v.trim().startsWith("0x") ? 16 : 10);
  return 0;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

function parseFields(reg: Record<string, unknown>): SvdField[] {
  const fields = (reg.fields as Record<string, unknown>) ?? {};
  return asArray(fields.field as Record<string, unknown>[]).map((f) => ({
    name: String(f.name ?? ""),
    bitOffset: num(f.bitOffset),
    bitWidth: num(f.bitWidth ?? 1),
  }));
}

function parseRegisters(p: Record<string, unknown>): SvdRegister[] {
  const registers = (p.registers as Record<string, unknown>) ?? {};
  return asArray(registers.register as Record<string, unknown>[]).map((r) => ({
    name: String(r.name ?? ""),
    addressOffset: num(r.addressOffset),
    resetValue: num(r.resetValue ?? 0),
    fields: parseFields(r),
  }));
}

/** Parse a CMSIS-SVD XML string into a typed device description. */
export function parseSvd(xml: string): SvdDevice {
  const root = parser.parse(xml) as Record<string, unknown>;
  const device = root.device as Record<string, unknown>;
  const peripheralsNode = device.peripherals as Record<string, unknown>;
  const rawPeripherals = asArray(peripheralsNode.peripheral as Record<string, unknown>[]);

  // First pass: index raw nodes by name for derivedFrom resolution.
  const rawByName = new Map<string, Record<string, unknown>>();
  for (const rp of rawPeripherals) rawByName.set(String(rp.name), rp);

  const peripherals: SvdPeripheral[] = [];
  for (const rp of rawPeripherals) {
    const derivedFrom = rp["@_derivedFrom"] as string | undefined;
    const baseNode = derivedFrom ? rawByName.get(derivedFrom) : undefined;

    // addressBlock may be a single object or an array of blocks; take the first.
    const blocks = asArray(
      (rp.addressBlock ?? baseNode?.addressBlock) as Record<string, unknown> | Record<string, unknown>[] | undefined,
    );
    const size = blocks.length ? num(blocks[0].size) : 0x400;

    const interrupts = asArray(
      (rp.interrupt ?? baseNode?.interrupt) as Record<string, unknown>[],
    ).map((it) => ({ name: String(it.name ?? ""), value: num(it.value) }));

    const registers = rp.registers ? parseRegisters(rp) : baseNode ? parseRegisters(baseNode) : [];

    const group = String(rp.groupName ?? baseNode?.groupName ?? derivedFrom ?? rp.name);

    peripherals.push({
      name: String(rp.name),
      group,
      baseAddress: num(rp.baseAddress),
      size: size || 0x400,
      interrupts,
      registers,
    });
  }

  const byName = new Map(peripherals.map((p) => [p.name, p]));
  return { name: String(device.name ?? ""), peripherals, byName };
}
