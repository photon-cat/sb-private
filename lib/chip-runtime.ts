// Custom chip WASM runtime — bridges Wokwi Custom Chips C API to avr8js simulation

import { PinState, type TWIEventHandler } from "avr8js";
import type { AVRRunnerLike, PinInfo } from "./pin-mapping";
import { getPort } from "./pin-mapping";
import type { Diagram } from "./diagram-parser";
import type { I2CBus } from "./i2c-bus";

// Wokwi pin modes (from wokwi-api.h)
// Disable unused warnings — kept for future use and self-documentation.
/* eslint-disable @typescript-eslint/no-unused-vars */
const INPUT = 0;
const OUTPUT = 1;
const INPUT_PULLUP = 2;
const INPUT_PULLDOWN = 3;
const ANALOG = 4;
const OUTPUT_LOW = 16;
const OUTPUT_HIGH = 17;
/* eslint-enable @typescript-eslint/no-unused-vars */

const VCC_VOLTAGE = 5.0;

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

interface ChipAttribute {
  id: number;
  name: string;
  isFloat: boolean;
  /** Current value — float (voltage/coefficient) for float attrs, int otherwise. */
  value: number;
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
  private attrs: ChipAttribute[] = [];
  /** Addresses this chip has registered on the shared I2C bus (for cleanup). */
  private i2cAddresses: number[] = [];
  /** Monotonic ID handed back to the chip from i2c_init. */
  private nextI2cId = 0;
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
    private i2cBus: I2CBus | null = null,
  ) {
    this.memory = new WebAssembly.Memory({ initial: 256 });
    this.partConnections = findPartConnections(diagram, partId);
  }

  /** Set callback for printf output from the chip */
  setConsoleCallback(cb: (text: string) => void) {
    this.onConsoleOutput = cb;
  }

  /** Get current value of a chip attribute by name (host inspection) */
  getAttr(name: string): number | undefined {
    return this.attrs.find((a) => a.name === name)?.value;
  }

  /** Set a chip attribute value by name (e.g., from UI control) */
  setAttr(name: string, value: number): void {
    const a = this.attrs.find((a) => a.name === name);
    if (a) a.value = value;
  }

  /** Instantiate WASM module and call chipInit() */
  async init(): Promise<void> {
    const imports = this.buildImports();
    const { instance } = await WebAssembly.instantiate(
      this.config.wasmBytes,
      imports,
    );
    this.instance = instance;

    // Call chipInit (this registers pins, attrs, timers, i2c devices).
    // attr_init() reads persisted values from part.attrs automatically, so
    // chip_init sees the correct starting state from the first instruction.
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

  /**
   * Read a persisted attribute value for this chip from the diagram's
   * `part.attrs`. Returns `undefined` if the attribute is not set, so the
   * caller can fall back to the C-supplied default.
   */
  private readPersistedAttr(name: string): number | undefined {
    const part = this.diagram.parts.find((p) => p.id === this.partId);
    const raw = part?.attrs?.[name];
    if (raw === undefined) return undefined;
    const num = parseFloat(raw);
    return Number.isNaN(num) ? undefined : num;
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

  /**
   * Read the current voltage on a chip pin by examining what's connected.
   * Supports: potentiometers (via attrs.value), MCU ADC channels, VCC/GND rails.
   * Returns a voltage in 0..5V, or 0 if nothing analog is connected.
   */
  private readChipPinVoltage(chipPinName: string): number {
    const targets = this.partConnections.get(chipPinName);
    if (!targets) return 0;

    for (const ref of targets) {
      const [refPart, refPin] = ref.split(":");

      // Power rails
      if (refPart === this.mcuId) {
        // VCC / GND on the MCU
        if (refPin === "5V" || refPin === "3.3V") return VCC_VOLTAGE;
        if (refPin?.startsWith("GND")) return 0;
        // Analog input pin — read the current ADC channel value
        const pinInfo = this.pinMapper(refPin);
        if (pinInfo?.port === "portC" && pinInfo.pin <= 5) {
          return Number(this.runner.adc.channelValues[pinInfo.pin]) || 0;
        }
        continue;
      }

      // Look up the connected part in the diagram
      const part = this.diagram.parts.find((p) => p.id === refPart);
      if (!part) continue;

      // Potentiometer / slide pot — read attrs.value (0-1023) → voltage
      if (part.type === "wokwi-potentiometer" || part.type === "wokwi-slide-potentiometer") {
        const raw = parseInt(part.attrs?.value ?? "0", 10);
        return (Math.max(0, Math.min(1023, raw)) / 1023) * VCC_VOLTAGE;
      }

      // NTC / temperature sensor — could read attrs.temperature in future
    }

    return 0;
  }

  /**
   * Write a voltage to a chip pin. If the pin is connected to an MCU
   * analog input (portC 0-5), drive the corresponding ADC channel.
   */
  private writeChipPinVoltage(chipPinName: string, voltage: number): void {
    const targets = this.partConnections.get(chipPinName);
    if (!targets) return;
    for (const ref of targets) {
      const [refPart, refPin] = ref.split(":");
      if (refPart !== this.mcuId) continue;
      const pinInfo = this.pinMapper(refPin);
      if (pinInfo?.port === "portC" && pinInfo.pin <= 5) {
        this.runner.adc.channelValues[pinInfo.pin] = Math.max(0, Math.min(VCC_VOLTAGE, voltage));
      }
    }
  }

  /**
   * Build the WASM import object with all Wokwi API bridges.
   * @internal Exposed for tests; do not call from application code.
   */
  buildImportsForTest(): WebAssembly.Imports {
    return this.buildImports();
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

        // --- Analog ---
        pinADCRead(pinId: number): number {
          const pin = self.pins[pinId];
          if (!pin) return 0;
          return self.readChipPinVoltage(pin.name);
        },

        pinDACWrite(pinId: number, voltage: number): void {
          const pin = self.pins[pinId];
          if (!pin) return;
          self.writeChipPinVoltage(pin.name, voltage);
        },

        // --- Attributes ---
        //
        // attr_init(name, default) is called from inside chip_init(). The
        // C default is used only when there's no persisted value in the
        // diagram's part.attrs. When a value IS persisted (e.g. from the
        // slider UI or a hand-edited diagram.json), we return that instead
        // so chip_init sees the correct starting value — matching Wokwi's
        // behaviour.
        attrInit(namePtr: number, defaultValue: number): number {
          const name = self.readCString(namePtr);
          const id = self.attrs.length;
          const persisted = self.readPersistedAttr(name);
          const value = persisted !== undefined ? persisted : defaultValue;
          self.attrs.push({ id, name, isFloat: false, value });
          return id;
        },

        attrInitFloat(namePtr: number, defaultValue: number): number {
          const name = self.readCString(namePtr);
          const id = self.attrs.length;
          const persisted = self.readPersistedAttr(name);
          const value = persisted !== undefined ? persisted : defaultValue;
          self.attrs.push({ id, name, isFloat: true, value });
          return id;
        },

        attrRead(attrId: number): number {
          const a = self.attrs[attrId];
          return a ? a.value : 0;
        },

        attrReadFloat(attrId: number): number {
          const a = self.attrs[attrId];
          return a ? a.value : 0;
        },

        attrStringInit: stub,
        stringGetLength: stub,
        stringRead: stub,

        // --- I2C ---
        // Reads the i2c_config_t struct from WASM memory, builds a
        // TWIEventHandler wrapper that forwards events to the chip's WASM
        // callbacks, and registers it on the shared I2CBus so the MCU's
        // Wire library sees the chip as a standard I2C peripheral.
        i2cInit(configPtr: number): number {
          if (!self.i2cBus) return 0;

          const view = new DataView(self.memory.buffer);
          // i2c_config_t layout (wasm32, 4-byte aligned):
          //   0:  void *user_data
          //   4:  uint32_t address
          //   8:  pin_t scl
          //  12:  pin_t sda
          //  16:  bool (*connect)(user_data, address, read)
          //  20:  uint8_t (*read)(user_data)
          //  24:  bool (*write)(user_data, data)
          //  28:  void (*disconnect)(user_data)
          const userData = view.getUint32(configPtr + 0, true);
          const address = view.getUint32(configPtr + 4, true);
          const connectPtr = view.getUint32(configPtr + 16, true);
          const readPtr = view.getUint32(configPtr + 20, true);
          const writePtr = view.getUint32(configPtr + 24, true);
          const disconnectPtr = view.getUint32(configPtr + 28, true);

          const twi = self.runner.twi;

          const callTable = (ptr: number): ((...args: number[]) => unknown) | null => {
            if (!ptr) return null;
            const table = self.table;
            if (!table) return null;
            const fn = table.get(ptr) as ((...args: number[]) => unknown) | null;
            return fn ?? null;
          };

          let connected = false;

          const handler: TWIEventHandler = {
            start: () => {
              twi.completeStart();
            },
            stop: () => {
              if (connected) {
                const cb = callTable(disconnectPtr);
                cb?.(userData);
                connected = false;
              }
              twi.completeStop();
            },
            connectToSlave: (addr: number, write: boolean) => {
              const cb = callTable(connectPtr);
              // C signature: bool connect(user_data, address, read)
              // When the master writes, read=0; when the master reads, read=1.
              const accepted = cb ? !!cb(userData, addr, write ? 0 : 1) : true;
              connected = accepted;
              twi.completeConnect(accepted);
            },
            writeByte: (value: number) => {
              const cb = callTable(writePtr);
              // C signature: bool write(user_data, data) — return value is ACK
              const ack = cb ? !!cb(userData, value) : true;
              twi.completeWrite(ack);
            },
            readByte: () => {
              const cb = callTable(readPtr);
              // C signature: uint8_t read(user_data)
              const value = cb ? (Number(cb(userData)) & 0xff) : 0xff;
              twi.completeRead(value);
            },
          };

          self.i2cBus.addDevice(address, handler);
          self.i2cAddresses.push(address);
          return ++self.nextI2cId;
        },
        i2cConfig: stub,   // advanced config (rarely used)
        i2cStatus: stub,   // read bus status

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
        fd_fdstat_get: stub,
        fd_fdstat_set_flags: stub,
        fd_prestat_get: () => 8, // BADF — no preopens
        fd_prestat_dir_name: stub,
        fd_read: stub,
        fd_filestat_get: stub,
        fd_sync: stub,
        path_open: stub,
        random_get: (bufPtr: number, len: number): number => {
          const buf = new Uint8Array(self.memory.buffer, bufPtr, len);
          for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 256);
          return 0;
        },
        clock_time_get: (clockId: number, _precision: bigint, ptr: number): number => {
          const view = new DataView(self.memory.buffer);
          // Return current time in nanoseconds
          const nanos = BigInt(Date.now()) * 1_000_000n;
          view.setBigUint64(ptr, nanos, true);
          return 0;
        },
        proc_exit: stub,
        args_get: stub,
        args_sizes_get(countPtr: number, sizePtr: number): number {
          const view = new DataView(self.memory.buffer);
          view.setUint32(countPtr, 0, true);
          view.setUint32(sizePtr, 0, true);
          return 0;
        },
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
  i2cBus: I2CBus | null = null,
): Promise<Map<string, CustomChipRuntime>> {
  const runtimes = new Map<string, CustomChipRuntime>();

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
      i2cBus,
    );

    await runtime.init();
    runtimes.set(part.id, runtime);

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
