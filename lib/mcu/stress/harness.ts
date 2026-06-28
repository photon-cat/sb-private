// STM32 M0+ stress harness — runs real firmware on STM32Runner and characterizes
// where it breaks. The diagnostic signal: when firmware hits an *unmodeled*
// peripheral it spins polling a status bit that never sets, so the unmapped-access
// log sorted by hit-count pinpoints the culprit IP block. Also tracks serial,
// instruction throughput, and whether execution settled (idle loop) or stalled.

import { STM32Runner } from "../../stm32-runner";
import type { UnmappedAccess } from "../cortex-m0-host";
import { peripheralAt } from "./peripheral-map";

export interface PeripheralHits {
  base: number;
  name: string;
  reads: number;
  writes: number;
}

export interface StressResult {
  name: string;
  instrExecuted: number;
  /** Distinct PCs visited in the final window (<= a few ⇒ tight spin/idle loop). */
  finalLoopSize: number;
  finalPc: number;
  serial: string;
  /** Unmodeled peripherals touched, busiest first. */
  unmapped: PeripheralHits[];
  /** Wall-clock ms spent executing (for the throughput benchmark). */
  elapsedMs: number;
  /** Instructions per second and the effective core MHz that implies. */
  ips: number;
}

export interface StressOptions {
  maxInstr?: number;
  /** Size of the trailing PC window used to detect a settled loop. */
  loopWindow?: number;
}

/** Run one firmware image and return a breakage/throughput characterization. */
export function runStress(
  name: string,
  firmware: Uint8Array,
  svdXml: string,
  now: () => number,
  opts: StressOptions = {},
): StressResult {
  const maxInstr = opts.maxInstr ?? 2_000_000;
  const loopWindow = opts.loopWindow ?? 64;

  const hits = new Map<number, PeripheralHits>();
  const record = (ev: UnmappedAccess): void => {
    const { base, name: pname } = peripheralAt(ev.addr);
    let h = hits.get(base);
    if (!h) {
      h = { base, name: pname, reads: 0, writes: 0 };
      hits.set(base, h);
    }
    if (ev.write) h.writes++;
    else h.reads++;
  };

  let serial = "";
  const runner = new STM32Runner(firmware, svdXml, { onUnmapped: record });
  runner.onSerialByte = (b) => (serial += String.fromCharCode(b));

  const host = runner.host;
  const recent: number[] = [];
  let executed = 0;
  const start = now();
  for (let i = 0; i < maxInstr; i++) {
    host.step();
    executed++;
    recent.push(host.pc >>> 0);
    if (recent.length > loopWindow) recent.shift();
  }
  const elapsedMs = now() - start;

  const finalLoopSize = new Set(recent).size;
  const ips = elapsedMs > 0 ? Math.round((executed / elapsedMs) * 1000) : 0;

  const unmapped = [...hits.values()].sort((a, b) => b.reads + b.writes - (a.reads + a.writes));

  return {
    name,
    instrExecuted: executed,
    finalLoopSize,
    finalPc: host.pc >>> 0,
    serial,
    unmapped,
    elapsedMs,
    ips,
  };
}
