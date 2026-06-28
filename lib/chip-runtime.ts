// Custom chip WASM runtime — bridges Wokwi Custom Chips C API to avr8js simulation

import { PinState, type TWIEventHandler } from "avr8js";
import type { AVRRunnerLike, PinInfo } from "./pin-mapping";
import { getPort } from "./pin-mapping";
import { normalizeConnection, type Diagram } from "./diagram-parser";
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
  /** String value for string attrs (attr_string_init). */
  stringValue?: string;
}

interface ChipSpiDevice {
  id: number;
  userData: number;
  donePtr: number;
  /** Armed transfer state (set by spi_start, cleared on completion / spi_stop). */
  armed: boolean;
  bufferPtr: number;
  count: number;
  index: number;
  /** The bytes currently in the transfer buffer (MISO out, overwritten with MOSI in). */
  bytes: number[];
}

interface ChipUartDevice {
  id: number;
  userData: number;
  rxDataPtr: number;
  writeDonePtr: number;
  /** True when this UART is bridged to the MCU hardware USART. */
  bridged: boolean;
}

interface ChipFramebuffer {
  id: number;
  width: number;
  height: number;
  /** RGBA pixel data, width*height*4 bytes. */
  pixels: Uint8Array;
}

export interface ChipJsonDef {
  name: string;
  pins: string[];
  controls?: { id: string; label: string; type: string; min: number; max: number; step: number }[];
  /** Display config — framebuffer dimensions for chips that render pixels. */
  display?: { type?: string; width?: number; height?: number };
}

export interface CustomChipConfig {
  chipJson: ChipJsonDef;
  wasmBytes: ArrayBuffer;
}

interface WasmMemorySpec {
  shared: boolean;
  initial: number;
  maximum?: number;
}

/**
 * Parse the imported memory's limits from a WASM module's import section.
 * Needed to detect a SHARED memory import (Verilog/Verilator chips) so we can
 * instantiate a matching `WebAssembly.Memory({ shared: true })`. Returns null
 * if the module imports no memory.
 */
export function parseWasmMemoryImport(bytes: ArrayBuffer): WasmMemorySpec | null {
  const buf = new Uint8Array(bytes);
  let p = 0;
  const u32 = () => (buf[p++] | (buf[p++] << 8) | (buf[p++] << 16) | (buf[p++] << 24)) >>> 0;
  if (buf.length < 8 || u32() !== 0x6d736100) return null; // "\0asm"
  u32(); // version

  const leb = (): number => {
    let result = 0, shift = 0, b: number;
    do {
      b = buf[p++];
      result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return result >>> 0;
  };
  const skipName = () => {
    const len = leb();
    p += len;
  };

  while (p < buf.length) {
    const id = buf[p++];
    const size = leb();
    const end = p + size;
    if (id === 2) {
      // Import section
      const count = leb();
      for (let i = 0; i < count; i++) {
        skipName(); // module
        skipName(); // field
        const kind = buf[p++];
        if (kind === 0x00) {
          leb(); // function: typeidx
        } else if (kind === 0x01) {
          // table: elemtype + limits
          p++; // elemtype
          const flags = buf[p++];
          leb();
          if (flags & 0x01) leb();
        } else if (kind === 0x02) {
          // memory: limits flags + min (+ max)
          const flags = buf[p++];
          const initial = leb();
          const maximum = flags & 0x01 ? leb() : undefined;
          return { shared: (flags & 0x02) !== 0, initial, maximum };
        } else if (kind === 0x03) {
          p++; // global: valtype
          p++; // mutability
        }
      }
      return null; // import section had no memory
    }
    p = end;
  }
  return null;
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
  for (const rawConn of diagram.connections) {
    const conn = normalizeConnection(rawConn);
    if (conn.from.startsWith(prefix)) {
      const pinName = conn.from.slice(prefix.length);
      const list = map.get(pinName) || [];
      list.push(conn.to);
      map.set(pinName, list);
    } else if (conn.to.startsWith(prefix)) {
      const pinName = conn.to.slice(prefix.length);
      const list = map.get(pinName) || [];
      list.push(conn.from);
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
  private spiDevices: ChipSpiDevice[] = [];
  private uartDevices: ChipUartDevice[] = [];
  private framebuffers: ChipFramebuffer[] = [];
  /** Restores runner.spi.onByte / usart.onByteTransmit on dispose. */
  private cleanupBridges: (() => void)[] = [];
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
    // Verilog/Verilator-derived chips link the threaded Verilator runtime and
    // import a SHARED memory. Match the module's memory import (shared + bounds)
    // so it instantiates; on our single thread the mutexes never contend and
    // wasi thread-spawn is never invoked.
    const memSpec = parseWasmMemoryImport(this.config.wasmBytes);
    if (memSpec?.shared) {
      this.memory = new WebAssembly.Memory({
        initial: memSpec.initial,
        maximum: memSpec.maximum ?? memSpec.initial,
        shared: true,
      });
    }

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
    for (const restore of this.cleanupBridges) restore();
    this.cleanupBridges = [];
    this.pins = [];
    this.timers = [];
    this.spiDevices = [];
    this.uartDevices = [];
    this.framebuffers = [];
    this.instance = null;
  }

  /** Read the latest framebuffer (for display rendering / tests). */
  getFramebuffer(id = 0): ChipFramebuffer | undefined {
    return this.framebuffers[id];
  }

  private get table(): WebAssembly.Table | null {
    return (this.instance?.exports.__indirect_function_table as WebAssembly.Table) ?? null;
  }

  /** Invoke a function pointer from the WASM indirect function table. */
  private callTableFn(ptr: number, ...args: number[]): unknown {
    if (!ptr) return undefined;
    const table = this.table;
    if (!table) return undefined;
    const fn = table.get(ptr) as ((...a: number[]) => unknown) | null;
    return fn ? fn(...args) : undefined;
  }

  /** Read a null-terminated C string from WASM memory */
  private readCString(ptr: number): string {
    const buf = new Uint8Array(this.memory.buffer);
    let end = ptr;
    while (end < buf.length && buf[end] !== 0) end++;
    // .slice() copies out of a (possibly shared) buffer — TextDecoder rejects
    // views backed by SharedArrayBuffer, which Verilog chips use.
    return new TextDecoder().decode(buf.slice(ptr, end));
  }

  /**
   * Read a persisted attribute value for this chip from the diagram's
   * `part.attrs`. Returns `undefined` if the attribute is not set, so the
   * caller can fall back to the C-supplied default.
   */
  private readPersistedAttr(name: string): number | undefined {
    const raw = this.readPersistedAttrRaw(name);
    if (raw === undefined) return undefined;
    const num = parseFloat(raw);
    return Number.isNaN(num) ? undefined : num;
  }

  /** Raw (unparsed) persisted attribute string from the diagram's part.attrs. */
  private readPersistedAttrRaw(name: string): string | undefined {
    const part = this.diagram.parts.find((p) => p.id === this.partId);
    return part?.attrs?.[name];
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

        pinDACWrite(pinId: number, voltage: number): number {
          const pin = self.pins[pinId];
          if (!pin) return 0;
          self.writeChipPinVoltage(pin.name, voltage);
          return voltage; // ABI: float pin_dac_write(pin, float)
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

        // String attributes — attr_string_init(name) returns a string_t handle
        // (we reuse the attr id). string_get_length / string_read operate on it.
        attrStringInit(namePtr: number): number {
          const name = self.readCString(namePtr);
          const id = self.attrs.length;
          const value = self.readPersistedAttrRaw(name) ?? "";
          self.attrs.push({ id, name, isFloat: false, value: 0, stringValue: value });
          return id;
        },

        stringGetLength(stringId: number): number {
          const a = self.attrs[stringId];
          if (!a?.stringValue) return 0;
          return new TextEncoder().encode(a.stringValue).length;
        },

        stringRead(stringId: number, bufPtr: number, bufferSize: number): number {
          const a = self.attrs[stringId];
          if (!a?.stringValue) return 0;
          const bytes = new TextEncoder().encode(a.stringValue);
          const n = Math.min(bytes.length, Math.max(0, bufferSize));
          const mem = new Uint8Array(self.memory.buffer);
          for (let i = 0; i < n; i++) mem[bufPtr + i] = bytes[i];
          return n;
        },

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

        // --- SPI ---
        // spi_config_t layout (wasm32): user_data@0, sck@4, mosi@8, miso@12,
        //   mode@16, done(user_data, buffer, count)@20, reserved[8]@24.
        // The chip is an SPI slave; the AVR is master. When the master clocks a
        // byte (runner.spi.onByte), the armed chip returns its buffer byte as
        // MISO and records the received MOSI byte. After `count` bytes the chip's
        // `done` callback fires with the buffer now holding received data.
        spiInit(configPtr: number): number {
          const view = new DataView(self.memory.buffer);
          const userData = view.getUint32(configPtr + 0, true);
          const donePtr = view.getUint32(configPtr + 20, true);
          const id = self.spiDevices.length;
          const dev: ChipSpiDevice = {
            id,
            userData,
            donePtr,
            armed: false,
            bufferPtr: 0,
            count: 0,
            index: 0,
            bytes: [],
          };
          self.spiDevices.push(dev);

          // Chain onto the existing SPI byte handler so multiple SPI chips can
          // coexist: the armed device responds, otherwise we delegate down the
          // chain (ultimately to avr8js's default which idles MISO high).
          const prev = self.runner.spi.onByte;
          const handler = (mosi: number) => {
            if (dev.armed) {
              const miso = dev.bytes[dev.index] ?? 0;
              self.runner.spi.completeTransfer(miso);
              dev.bytes[dev.index] = mosi & 0xff; // record received MOSI
              dev.index++;
              if (dev.index >= dev.count) {
                // Write received bytes back into WASM memory, then call done().
                const mem = new Uint8Array(self.memory.buffer);
                for (let i = 0; i < dev.count; i++) {
                  mem[dev.bufferPtr + i] = dev.bytes[i] & 0xff;
                }
                dev.armed = false;
                self.callTableFn(dev.donePtr, dev.userData, dev.bufferPtr, dev.count);
              }
            } else {
              prev(mosi);
            }
          };
          self.runner.spi.onByte = handler;
          self.cleanupBridges.push(() => {
            // Best-effort restore (only valid if no later chip re-chained).
            if (self.runner.spi.onByte === handler) self.runner.spi.onByte = prev;
          });
          return id;
        },

        spiStart(spiId: number, bufferPtr: number, count: number): void {
          const dev = self.spiDevices[spiId];
          if (!dev) return;
          const mem = new Uint8Array(self.memory.buffer);
          dev.bufferPtr = bufferPtr;
          dev.count = count;
          dev.index = 0;
          dev.bytes = [];
          for (let i = 0; i < count; i++) dev.bytes.push(mem[bufferPtr + i]);
          dev.armed = true;
        },

        spiStop(spiId: number): void {
          const dev = self.spiDevices[spiId];
          if (dev) dev.armed = false;
        },

        // --- UART ---
        // uart_config_t layout: user_data@0, rx@4, tx@8, baud_rate@12,
        //   rx_data(user_data, byte)@16, write_done(user_data)@20, reserved[8]@24.
        // Bridged to the MCU hardware USART when the chip's rx/tx pins connect to
        // the MCU serial pins: MCU TX -> chip rx_data; chip uart_write -> MCU RX.
        uartInit(configPtr: number): number {
          const view = new DataView(self.memory.buffer);
          const userData = view.getUint32(configPtr + 0, true);
          const rxPinId = view.getInt32(configPtr + 4, true);
          const txPinId = view.getInt32(configPtr + 8, true);
          const rxDataPtr = view.getUint32(configPtr + 16, true);
          const writeDonePtr = view.getUint32(configPtr + 20, true);
          const id = self.uartDevices.length;

          // Only bridge to the MCU hardware USART when the chip's UART pins are
          // wired to the MCU serial pins (D0=RX/PD0, D1=TX/PD1). The chip's rx
          // receives the MCU's transmissions (so it should connect to MCU TX/PD1);
          // the chip's tx feeds the MCU's receiver (MCU RX/PD0). Otherwise the
          // device is registered but inert (software-serial bridging is future work).
          const rxPin = self.pins[rxPinId]?.pinInfo;
          const txPin = self.pins[txPinId]?.pinInfo;
          const onMcuTx = (p?: PinInfo | null) => p?.port === "portD" && p.pin === 1;
          const onMcuRx = (p?: PinInfo | null) => p?.port === "portD" && p.pin === 0;
          const bridged = onMcuTx(rxPin) || onMcuRx(txPin);

          const dev: ChipUartDevice = { id, userData, rxDataPtr, writeDonePtr, bridged };
          self.uartDevices.push(dev);
          if (!bridged) return id;

          // Bridge MCU USART transmit -> this chip's rx_data callback, chaining
          // the existing onByteTransmit so serial capture keeps working.
          const prev = self.runner.usart.onByteTransmit;
          const handler = (byte: number) => {
            prev?.(byte);
            self.callTableFn(dev.rxDataPtr, dev.userData, byte & 0xff);
          };
          self.runner.usart.onByteTransmit = handler;
          self.cleanupBridges.push(() => {
            if (self.runner.usart.onByteTransmit === handler) {
              self.runner.usart.onByteTransmit = prev;
            }
          });
          return id;
        },

        uartWrite(uartId: number, bufferPtr: number, count: number): number {
          const dev = self.uartDevices[uartId];
          if (!dev || !dev.bridged) return 0;
          const mem = new Uint8Array(self.memory.buffer);
          for (let i = 0; i < count; i++) {
            self.runner.usart.writeByte(mem[bufferPtr + i]);
          }
          // Signal write completion back to the chip.
          self.callTableFn(dev.writeDonePtr, dev.userData);
          return 1; // success
        },

        // --- Framebuffer ---
        // framebuffer_init(uint32_t *pixel_width, uint32_t *pixel_height) — per
        // the Wokwi ABI the SIMULATOR fills the dimensions (from the chip.json
        // `display` config) into the pointers and returns an RGBA buffer of
        // width*height*4 bytes. If chip.json omits the size we fall back to any
        // value the chip pre-wrote into the pointers.
        framebufferInit(widthPtr: number, heightPtr: number): number {
          const view = new DataView(self.memory.buffer);
          const disp = self.config.chipJson.display;
          const width = disp?.width ?? view.getUint32(widthPtr, true) ?? 0;
          const height = disp?.height ?? view.getUint32(heightPtr, true) ?? 0;
          // Provide the dimensions back to the chip.
          view.setUint32(widthPtr, width, true);
          view.setUint32(heightPtr, height, true);
          const id = self.framebuffers.length;
          self.framebuffers.push({
            id,
            width,
            height,
            pixels: new Uint8Array(Math.max(0, width * height * 4)),
          });
          return id;
        },

        bufferRead(bufferId: number, offset: number, dataPtr: number, dataLen: number): void {
          const fb = self.framebuffers[bufferId];
          if (!fb) return;
          const mem = new Uint8Array(self.memory.buffer);
          for (let i = 0; i < dataLen; i++) {
            mem[dataPtr + i] = fb.pixels[offset + i] ?? 0;
          }
        },

        bufferWrite(bufferId: number, offset: number, dataPtr: number, dataLen: number): void {
          const fb = self.framebuffers[bufferId];
          if (!fb) return;
          const mem = new Uint8Array(self.memory.buffer);
          for (let i = 0; i < dataLen; i++) {
            if (offset + i < fb.pixels.length) fb.pixels[offset + i] = mem[dataPtr + i];
          }
        },

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
            const text = new TextDecoder().decode(buf.slice(ptr, ptr + len));
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
          const nanos = BigInt(Date.now()) * BigInt(1_000_000);
          (view as any).setBigUint64(ptr, nanos, true);
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
        // Threaded Verilator runtime cooperatively yields; we're single-threaded.
        sched_yield: () => 0,
      },

      // Threaded (Verilog/Verilator) chips link wasi thread-spawn. We never
      // spawn — Verilator runs single-threaded here — so this is a stub that
      // reports failure; it is never actually invoked at runtime.
      wasi: {
        "thread-spawn": () => -1,
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
    wc.chipRuntime = runtime;
    const prevCleanup = wc.cleanup;
    wc.cleanup = () => {
      prevCleanup?.();
      runtime.dispose();
    };
    wired.set(part.id, wc);
  }

  return runtimes;
}
