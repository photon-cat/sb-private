// Custom chip WASM runtime — bridges Wokwi Custom Chips C API to avr8js simulation

import { PinState } from "avr8js";
import type { AVRRunnerLike, PinInfo } from "./pin-mapping";
import { getPort } from "./pin-mapping";
import type { Diagram } from "./diagram-parser";

// Wokwi pin modes (from wokwi-api.h)
const INPUT = 0;
const OUTPUT = 1;
const INPUT_PULLUP = 2;
// const INPUT_PULLDOWN = 3;
// const ANALOG = 4;
const OUTPUT_LOW = 16;
const OUTPUT_HIGH = 17;

// Wokwi edge constants
const EDGE_RISING = 1;
const EDGE_FALLING = 2;
const EDGE_BOTH = 3;

interface ChipPin {
  id: number;
  name: string;
  pinInfo: PinInfo | null;
  mode: number;
  lastValue: boolean;
  watchCallbackPtr: number;
  watchUserData: number;
  watchEdge: number;
  removeListener?: () => void;
}

interface ChipTimer {
  id: number;
  callbackPtr: number;
  userDataPtr: number;
  active: boolean;
}

export interface ChipJsonDef {
  name: string;
  pins: string[];
  controls?: { id: string; label: string; type: string; min: number; max: number; step: number }[];
}

export interface CustomChipConfig {
  chipJson: ChipJsonDef;
  wasmBytes: ArrayBuffer;
}

/**
 * Find all connections for a specific part in the diagram.
 * Returns a map of pinName -> array of "otherPartId:otherPinName" refs.
 */
function findPartConnections(
  diagram: Diagram,
  partId: string,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const prefix = `${partId}:`;
  for (const conn of diagram.connections) {
    const [a, b] = conn;
    if (a.startsWith(prefix)) {
      const pinName = a.slice(prefix.length);
      const list = map.get(pinName) || [];
      list.push(b);
      map.set(pinName, list);
    } else if (b.startsWith(prefix)) {
      const pinName = b.slice(prefix.length);
      const list = map.get(pinName) || [];
      list.push(a);
      map.set(pinName, list);
    }
  }
  return map;
}

/**
 * CustomChipRuntime — instantiates a compiled WASM custom chip and bridges
 * the Wokwi Custom Chips C API to avr8js GPIO ports and clock events.
 */
export class CustomChipRuntime {
  private instance: WebAssembly.Instance | null = null;
  private memory: WebAssembly.Memory;
  private pins: ChipPin[] = [];
  private timers: ChipTimer[] = [];
  private partConnections: Map<string, string[]>;
  private consoleBuffer = "";
  private onConsoleOutput?: (text: string) => void;

  constructor(
    private runner: AVRRunnerLike,
    private diagram: Diagram,
    private partId: string,
    private mcuId: string,
    private config: CustomChipConfig,
    private pinMapper: (name: string) => PinInfo | null,
  ) {
    this.memory = new WebAssembly.Memory({ initial: 256 });
    this.partConnections = findPartConnections(diagram, partId);
  }

  /** Set callback for printf output from the chip */
  setConsoleCallback(cb: (text: string) => void) {
    this.onConsoleOutput = cb;
  }

  /** Instantiate WASM module and call chipInit() */
  async init(): Promise<void> {
    const imports = this.buildImports();
    const { instance } = await WebAssembly.instantiate(
      this.config.wasmBytes,
      imports,
    );
    this.instance = instance;

    // Call chipInit
    const chipInit = instance.exports.chipInit as (() => void) | undefined;
    if (chipInit) {
      chipInit();
    }
  }

  /** Clean up all port listeners and pending timers */
  dispose(): void {
    for (const pin of this.pins) {
      pin.removeListener?.();
    }
    this.pins = [];
    this.timers = [];
    this.instance = null;
  }

  private get table(): WebAssembly.Table | null {
    return (this.instance?.exports.__indirect_function_table as WebAssembly.Table) ?? null;
  }

  /** Read a null-terminated C string from WASM memory */
  private readCString(ptr: number): string {
    const mem = this.memory;
    const buf = new Uint8Array(mem.buffer);
    let end = ptr;
    while (end < buf.length && buf[end] !== 0) end++;
    return new TextDecoder().decode(buf.subarray(ptr, end));
  }

  /** Resolve a custom chip pin name to the MCU pin it's connected to */
  private resolveMcuPin(chipPinName: string): PinInfo | null {
    const targets = this.partConnections.get(chipPinName);
    if (!targets) return null;
    for (const ref of targets) {
      const [refPart, refPin] = ref.split(":");
      if (refPart === this.mcuId) {
        return this.pinMapper(refPin);
      }
    }
    return null;
  }

  /** Build the WASM import object with all Wokwi API stubs */
  private buildImports(): WebAssembly.Imports {
    const self = this;

    // Stub for unimplemented imports — returns 0 silently
    const stub = () => 0;

    return {
      env: {
        memory: this.memory,

        // --- GPIO ---
        pinInit(namePtr: number, mode: number): number {
          const name = self.readCString(namePtr);
          const pinInfo = self.resolveMcuPin(name);
          const id = self.pins.length;
          const pin: ChipPin = {
            id,
            name,
            pinInfo,
            mode,
            lastValue: false,
            watchCallbackPtr: 0,
            watchUserData: 0,
            watchEdge: 0,
          };
          self.pins.push(pin);

          // Apply initial mode
          if (pinInfo) {
            const port = getPort(self.runner, pinInfo.port);
            if (mode === OUTPUT_HIGH) {
              port.setPin(pinInfo.pin, true);
            } else if (mode === OUTPUT_LOW || mode === OUTPUT) {
              port.setPin(pinInfo.pin, false);
            } else if (mode === INPUT_PULLUP) {
              // Pull-up: default HIGH
              pin.lastValue = true;
            }
            // Read initial value
            pin.lastValue = port.pinState(pinInfo.pin) === PinState.High;
          }

          return id;
        },

        pinRead(pinId: number): number {
          const pin = self.pins[pinId];
          if (!pin?.pinInfo) return 0;
          const port = getPort(self.runner, pin.pinInfo.port);
          return port.pinState(pin.pinInfo.pin) === PinState.High ? 1 : 0;
        },

        pinWrite(pinId: number, value: number): void {
          const pin = self.pins[pinId];
          if (!pin?.pinInfo) return;
          const port = getPort(self.runner, pin.pinInfo.port);
          port.setPin(pin.pinInfo.pin, !!value);
        },

        pinMode(pinId: number, mode: number): void {
          const pin = self.pins[pinId];
          if (pin) pin.mode = mode;
        },

        pinWatch(pinId: number, configPtr: number): number {
          const pin = self.pins[pinId];
          if (!pin?.pinInfo) return 0;

          const view = new DataView(self.memory.buffer);
          const userData = view.getUint32(configPtr, true);
          const edge = view.getUint32(configPtr + 4, true);
          const callbackPtr = view.getUint32(configPtr + 8, true);

          pin.watchUserData = userData;
          pin.watchEdge = edge;
          pin.watchCallbackPtr = callbackPtr;

          // Remove existing listener
          pin.removeListener?.();

          const port = getPort(self.runner, pin.pinInfo.port);
          const pinNum = pin.pinInfo.pin;

          const listener = () => {
            const newHigh = port.pinState(pinNum) === PinState.High;
            const oldHigh = pin.lastValue;
            pin.lastValue = newHigh;

            if (newHigh === oldHigh) return;

            const rising = !oldHigh && newHigh;
            const matchEdge = pin.watchEdge;
            if (
              matchEdge === EDGE_BOTH ||
              (rising && matchEdge === EDGE_RISING) ||
              (!rising && matchEdge === EDGE_FALLING)
            ) {
              const table = self.table;
              if (table && pin.watchCallbackPtr) {
                const cb = table.get(pin.watchCallbackPtr);
                if (cb) {
                  cb(pin.watchUserData, pin.id, newHigh ? 1 : 0);
                }
              }
            }
          };

          port.addListener(listener);
          pin.removeListener = () => port.removeListener(listener);

          return 1; // success
        },

        pinWatchStop(pinId: number): void {
          const pin = self.pins[pinId];
          if (!pin) return;
          pin.removeListener?.();
          pin.removeListener = undefined;
          pin.watchCallbackPtr = 0;
        },

        // --- Timers ---
        timerInit(configPtr: number): number {
          const view = new DataView(self.memory.buffer);
          const userDataPtr = view.getUint32(configPtr, true);
          const callbackPtr = view.getUint32(configPtr + 4, true);
          const id = self.timers.length;
          self.timers.push({ id, callbackPtr, userDataPtr, active: false });
          return id;
        },

        timerStart(timerId: number, micros: number, repeat: number): void {
          const timer = self.timers[timerId];
          if (!timer) return;
          timer.active = true;

          const cycles = Math.round(micros * (self.runner.speed / 1_000_000));
          const schedule = () => {
            if (!timer.active) return;
            self.runner.cpu.addClockEvent(() => {
              if (!timer.active) return;
              const table = self.table;
              if (table && timer.callbackPtr) {
                const cb = table.get(timer.callbackPtr);
                if (cb) cb(timer.userDataPtr);
              }
              if (repeat && timer.active) schedule();
            }, cycles);
          };
          schedule();
        },

        timerStartNanos(timerId: number, nanos: number, repeat: number): void {
          // nanos comes as f64, convert to micros and delegate
          const micros = nanos / 1000;
          const timer = self.timers[timerId];
          if (!timer) return;
          timer.active = true;

          const cycles = Math.max(1, Math.round((nanos / 1e9) * self.runner.speed));
          const schedule = () => {
            if (!timer.active) return;
            self.runner.cpu.addClockEvent(() => {
              if (!timer.active) return;
              const table = self.table;
              if (table && timer.callbackPtr) {
                const cb = table.get(timer.callbackPtr);
                if (cb) cb(timer.userDataPtr);
              }
              if (repeat && timer.active) schedule();
            }, cycles);
          };
          schedule();
        },

        timerStop(timerId: number): void {
          const timer = self.timers[timerId];
          if (timer) timer.active = false;
        },

        getSimNanos(): number {
          return (self.runner.cpu.cycles / self.runner.speed) * 1e9;
        },

        // --- Analog (stubs for Phase 1) ---
        pinADCRead: stub,
        pinDACWrite: stub,

        // --- Attributes (stubs for Phase 1) ---
        attrInit: stub,
        attrInitFloat: stub,
        attrRead: stub,
        attrReadFloat: stub,
        attrStringInit: stub,
        stringGetLength: stub,
        stringRead: stub,

        // --- I2C (stub for Phase 1) ---
        i2cInit: stub,

        // --- SPI (stubs for Phase 1) ---
        spiInit: stub,
        spiStart: stub,
        spiStop: stub,

        // --- UART (stubs for Phase 1) ---
        uartInit: stub,
        uartWrite: stub,

        // --- Framebuffer (stubs for Phase 1) ---
        framebufferInit: stub,
        bufferRead: stub,
        bufferWrite: stub,

        // --- Experimental MCU access (stubs) ---
        _symbolResolve: stub,
        _mcuReadMemory: stub,
        _mcuReadUint32: stub,
        _mcuReadPC: stub,
        _mcuReadSP: stub,
        _mcuMonitorSP: stub,
      },

      // WASI stubs for printf support
      wasi_snapshot_preview1: {
        fd_write(fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
          const view = new DataView(self.memory.buffer);
          const buf = new Uint8Array(self.memory.buffer);
          let totalWritten = 0;
          for (let i = 0; i < iovsLen; i++) {
            const ptr = view.getUint32(iovsPtr + i * 8, true);
            const len = view.getUint32(iovsPtr + i * 8 + 4, true);
            const text = new TextDecoder().decode(buf.subarray(ptr, ptr + len));
            self.consoleBuffer += text;
            totalWritten += len;
          }
          // Flush on newlines
          while (self.consoleBuffer.includes("\n")) {
            const idx = self.consoleBuffer.indexOf("\n");
            const line = self.consoleBuffer.slice(0, idx);
            self.consoleBuffer = self.consoleBuffer.slice(idx + 1);
            self.onConsoleOutput?.(line + "\n");
          }
          view.setUint32(nwrittenPtr, totalWritten, true);
          return 0; // success
        },
        fd_seek: stub,
        fd_close: stub,
        proc_exit: stub,
        environ_get: stub,
        environ_sizes_get(countPtr: number, sizePtr: number): number {
          const view = new DataView(self.memory.buffer);
          view.setUint32(countPtr, 0, true);
          view.setUint32(sizePtr, 0, true);
          return 0;
        },
      },
    };
  }
}

/**
 * Wire all custom chip parts in a diagram.
 * Call this after wireComponents() — it's async because WASM instantiation is async.
 */
export async function wireCustomChipsAsync(
  runner: AVRRunnerLike,
  diagram: Diagram,
  mcuId: string,
  pinMapper: (name: string) => PinInfo | null,
  wired: Map<string, import("./wire-components").WiredComponent>,
  chipConfigs: Map<string, CustomChipConfig>,
): Promise<CustomChipRuntime[]> {
  const runtimes: CustomChipRuntime[] = [];

  for (const part of diagram.parts) {
    const config = chipConfigs.get(part.id);
    if (!config) continue;

    const runtime = new CustomChipRuntime(
      runner,
      diagram,
      part.id,
      mcuId,
      config,
      pinMapper,
    );

    await runtime.init();
    runtimes.push(runtime);

    const wc = wired.get(part.id) || { part };
    const prevCleanup = wc.cleanup;
    wc.cleanup = () => {
      prevCleanup?.();
      runtime.dispose();
    };
    wired.set(part.id, wc);
  }

  return runtimes;
}
