// espwebemu — ESP32 Browser Emulator
// Public API

import { ESP32CPU, SR_CCOUNT, SR_PS } from "./cpu/cpu.js";
import { executeInstruction } from "./cpu/xtensa-execute.js";
import { InterruptController } from "./cpu/interrupt.js";
import { MemoryBus } from "./memory/memory-bus.js";
import { loadESP32Bin } from "./memory/flash.js";
import * as regions from "./memory/regions.js";
import { ESP32UART } from "./peripherals/uart.js";
import { ESP32GPIO } from "./peripherals/gpio.js";
import { ESP32TimerGroup } from "./peripherals/timer.js";
import { ESP32DPORT, ESP32RTC, ESP32IOMUX } from "./peripherals/system.js";
import { ESP32I2C } from "./peripherals/i2c.js";
import { installRomStubs, handleRomCall, type RomCallbacks } from "./stubs/rom-functions.js";
import { FreeRTOSShim } from "./stubs/freertos-shim.js";

export { ESP32CPU } from "./cpu/cpu.js";
export { ESP32UART } from "./peripherals/uart.js";
export { ESP32GPIO } from "./peripherals/gpio.js";
export { ESP32TimerGroup } from "./peripherals/timer.js";
export { MemoryBus } from "./memory/memory-bus.js";

export class ESP32Runner {
  readonly cpu: ESP32CPU;
  readonly memory: MemoryBus;
  readonly gpio: ESP32GPIO;
  readonly uart0: ESP32UART;
  readonly uart1: ESP32UART;
  readonly timerGroup0: ESP32TimerGroup;
  readonly timerGroup1: ESP32TimerGroup;
  readonly dport: ESP32DPORT;
  readonly rtc: ESP32RTC;
  readonly ioMux: ESP32IOMUX;
  readonly i2c0: ESP32I2C;
  readonly i2c1: ESP32I2C;
  readonly interrupts: InterruptController;
  readonly freertos: FreeRTOSShim;

  readonly speed = 240e6; // 240 MHz
  readonly workUnitCycles = 5_000_000;

  private stopped = false;
  private wallStartMs = 0;
  private simStartCycles = 0;
  private scheduledId: number | null = null;
  private romCallbacks: RomCallbacks = {};
  // Firmware address intercepts: PC → handler
  private firmwareIntercepts = new Map<number, () => void>();
  // app_main address (detected from firmware)
  appMainAddr: number = 0;
  // printf address (detected from firmware map)
  printfAddr: number = 0;
  // puts address
  putsAddr: number = 0;
  // vTaskDelay address
  vTaskDelayAddr: number = 0;

  // Serial output handler (convenience wrapper around uart0.onByteTransmit)
  set onSerialOutput(handler: ((char: number) => void) | undefined) {
    this.uart0.onByteTransmit = handler;
  }

  constructor(binData?: Uint8Array) {
    this.memory = new MemoryBus();
    this.cpu = new ESP32CPU(this.memory);
    this.interrupts = new InterruptController();
    this.freertos = new FreeRTOSShim();

    // Create peripherals
    this.uart0 = new ESP32UART();
    this.uart1 = new ESP32UART();
    this.gpio = new ESP32GPIO();
    this.timerGroup0 = new ESP32TimerGroup(this.speed);
    this.timerGroup1 = new ESP32TimerGroup(this.speed);
    this.dport = new ESP32DPORT();
    this.rtc = new ESP32RTC();
    this.ioMux = new ESP32IOMUX();
    this.i2c0 = new ESP32I2C();
    this.i2c1 = new ESP32I2C();

    // Map peripherals to memory bus
    this.memory.mapPeripheral(regions.UART0_BASE, 0x1000, this.uart0);
    this.memory.mapPeripheral(regions.UART1_BASE, 0x1000, this.uart1);
    this.memory.mapPeripheral(regions.GPIO_BASE, 0x1000, this.gpio);
    this.memory.mapPeripheral(regions.TIMG0_BASE, 0x1000, this.timerGroup0);
    this.memory.mapPeripheral(regions.TIMG1_BASE, 0x1000, this.timerGroup1);
    this.memory.mapPeripheral(regions.DPORT_BASE, 0x1000, this.dport);
    this.memory.mapPeripheral(regions.RTC_CNTL_BASE, 0x400, this.rtc);
    this.memory.mapPeripheral(regions.IO_MUX_BASE, 0x100, this.ioMux);
    this.memory.mapPeripheral(regions.I2C0_BASE, 0x1000, this.i2c0);
    this.memory.mapPeripheral(regions.I2C1_BASE, 0x1000, this.i2c1);

    // Install ROM function stubs
    installRomStubs(this.memory);
    this.freertos.installStubs(this.memory);

    // Set up ROM callbacks
    this.romCallbacks = {
      onPrintf: (text: string) => {
        // Route ets_printf output to UART0
        for (let i = 0; i < text.length; i++) {
          if (this.uart0.onByteTransmit) {
            this.uart0.onByteTransmit(text.charCodeAt(i));
          }
        }
      },
    };

    // Load firmware if provided
    if (binData) {
      this.loadFirmware(binData);
    }
  }

  loadFirmware(binData: Uint8Array): void {
    const result = loadESP32Bin(binData, this.memory);
    this.cpu.pc = result.entryPoint;

    // Set up initial stack pointer (top of DRAM)
    this.cpu.setAR(1, 0x3fffffff); // Stack grows downward from top of DRAM

    // Initialize g_ticks_per_us (240 for 240MHz) — needed by esp_log_early_timestamp
    const ticksPerUs = 240;
    this.memory.write32(0x3ffe01e0, ticksPerUs); // g_ticks_per_us_pro
    this.memory.write32(0x3ffe40f0, ticksPerUs); // g_ticks_per_us_app

    // Note: s_cpu_up[1] (APP CPU) is set in the ets_delay_us ROM stub
    // to prevent start_other_core from waiting forever in single-core emulation

    // Pre-initialize newlib locks to prevent assert on first use
    // __sinit_lock at 0x3ffae0a8, __sfp_lock at 0x3ffae0ac
    this.memory.write32(0x3ffae0a8, 1); // __sinit_lock
    this.memory.write32(0x3ffae0ac, 1); // __sfp_lock

    // Patch check_lock_nonzero (0x400826b8) to always return (skip NULL assert)
    // This avoids crashes from uninitialized newlib locks during early boot
    // Original: entry a1,32 / bnez a2,+0xe / ... / assert
    // Patch: entry a1,32 / retw.n (always return)
    this.memory.write8(0x400826bb, 0x1d); // RETW.N byte 0
    this.memory.write8(0x400826bc, 0xf0); // RETW.N byte 1

    // Patch _esp_error_check_failed (0x40085568) to return instead of aborting.
    // Many init functions use ESP_ERROR_CHECK which calls this on failure.
    // Without full VFS/driver subsystem support, some init functions return errors
    // that are non-fatal for basic emulation. Patch: entry a1,48 / retw.n
    this.memory.write8(0x4008556b, 0x1d); // RETW.N byte 0
    this.memory.write8(0x4008556c, 0xf0); // RETW.N byte 1

    // Patch do_system_init_fn error check at 0x400d1add: change BEQZ a10,+30
    // to J +30 (unconditional). Allows boot past init functions that fail due
    // to unimplemented subsystems (VFS, etc.).
    // J encoding: op0=6, n=0, offset18=30. byte0=0x86, byte1=0x07, byte2=0x00
    this.memory.write8(0x400d1add, 0x86);
    this.memory.write8(0x400d1ade, 0x07);
    this.memory.write8(0x400d1adf, 0x00);

    // Patch __assert_func (0x4008b32c) to return immediately.
    // Flash init and other subsystems assert on failure. Since we don't emulate
    // SPI flash, these asserts are non-fatal. Returning from __assert_func
    // unwinds the call stack cleanly via RETW.
    this.memory.write8(0x4008b32f, 0x1d); // RETW.N
    this.memory.write8(0x4008b330, 0xf0);

    // Patch start_cpu0 APP CPU wait loop at 0x400d1b81.
    // The BEQZ loops waiting for APP CPU to signal readiness, which never
    // happens in single-core emulation. Replace with NOP (or a0,a0,a0).
    this.memory.write8(0x400d1b81, 0x00); // OR a0,a0,a0 (NOP)
    this.memory.write8(0x400d1b82, 0x00);
    this.memory.write8(0x400d1b83, 0x20);

    // Intercept esp_startup_start_app (0x400e407c) to call app_main directly.
    // The real function creates a FreeRTOS task and starts the scheduler,
    // which needs timer interrupts for context switching. We skip that and
    // jump straight to app_main.
    if (this.appMainAddr) {
      const mainAddr = this.appMainAddr;
      this.firmwareIntercepts.set(0x400e407c, () => {
        this.cpu.pc = mainAddr;
      });
    }

    // Intercept printf to bypass broken newlib stdio (VFS not initialized).
    // printf is called via CALL8. At intercept: CALLINC=2, args in AR[10-15].
    if (this.printfAddr) {
      this.firmwareIntercepts.set(this.printfAddr, () => {
        this.handlePrintfIntercept();
      });
    }
    if (this.putsAddr) {
      this.firmwareIntercepts.set(this.putsAddr, () => {
        this.handlePutsIntercept();
      });
    }

    // Intercept vTaskDelay to avoid FreeRTOS scheduler dependency.
    // Just advance cycle count and return.
    if (this.vTaskDelayAddr) {
      this.firmwareIntercepts.set(this.vTaskDelayAddr, () => {
        const retAddrRaw = this.cpu.getAR(8);
        const retAddr = ((this.cpu.pc & 0xC0000000) | (retAddrRaw & 0x3FFFFFFF)) >>> 0;
        const ticks = this.cpu.getAR(10) >>> 0;
        // Advance cycles: ticks * 1ms * 240MHz = ticks * 240K cycles
        // (portTICK_PERIOD_MS=10 in firmware, so 100 ticks = 100ms simulated)
        this.cpu.cycles += Math.min(ticks * 240_000, 24_000_000);
        this.cpu.specialRegisters[SR_PS] &= ~(0x3 << 16);
        this.cpu.pc = retAddr;
      });
    }
  }

  // Run with real-time throttling (for browser use)
  execute(callback: (cpu: ESP32CPU) => void): void {
    if (this.stopped) return;

    if (this.wallStartMs === 0) {
      this.wallStartMs = performance.now();
      this.simStartCycles = this.cpu.cycles;
    }

    const cyclesToRun = this.cpu.cycles + this.workUnitCycles;
    while (this.cpu.cycles < cyclesToRun && !this.stopped) {
      // Check firmware address intercepts
      const intercept = this.firmwareIntercepts.get(this.cpu.pc);
      if (intercept) { intercept(); continue; }

      // Check for ROM function interception
      if (handleRomCall(this.cpu, this.cpu.pc, this.romCallbacks)) {
        // ROM call was handled; the function stub at the address is RETW.N
        // so the CPU will execute that and return.
      }

      if (!executeInstruction(this.cpu)) {
        // CPU halted (WAITI or unhandled exception)
        // Check for interrupts that might wake it
        if (!this.interrupts.checkInterrupts(this.cpu)) {
          break; // Still halted
        }
      }

      // Check for zero-overhead loop (handled in execute) and interrupts
      this.interrupts.checkInterrupts(this.cpu);
    }

    // Tick timers
    this.timerGroup0.tick(this.workUnitCycles);
    this.timerGroup1.tick(this.workUnitCycles);

    callback(this.cpu);

    // Throttle to real-time
    const simElapsedMs = ((this.cpu.cycles - this.simStartCycles) / this.speed) * 1000;
    const wallElapsedMs = performance.now() - this.wallStartMs;
    const aheadMs = simElapsedMs - wallElapsedMs;

    if (aheadMs > 2) {
      this.scheduledId = setTimeout(() => this.execute(callback), aheadMs) as unknown as number;
    } else {
      // Use MessageChannel for zero-delay scheduling (same as MicroTaskScheduler)
      const channel = new MessageChannel();
      channel.port2.onmessage = () => this.execute(callback);
      channel.port1.postMessage(null);
    }
  }

  // Run synchronously for a number of cycles (for tests / headless use)
  runCycles(count: number): void {
    const target = this.cpu.cycles + count;
    while (this.cpu.cycles < target) {
      const intercept = this.firmwareIntercepts.get(this.cpu.pc);
      if (intercept) { intercept(); continue; }
      if (handleRomCall(this.cpu, this.cpu.pc, this.romCallbacks)) {
        // handled
      }
      if (!executeInstruction(this.cpu)) {
        if (!this.interrupts.checkInterrupts(this.cpu)) break;
      }
      this.interrupts.checkInterrupts(this.cpu);
    }
    this.timerGroup0.tick(count);
    this.timerGroup1.tick(count);
  }

  // Run for a given number of milliseconds worth of CPU cycles
  runMs(ms: number): void {
    this.runCycles(Math.round((ms / 1000) * this.speed));
  }

  stop(): void {
    this.stopped = true;
    if (this.scheduledId !== null) {
      clearTimeout(this.scheduledId);
      this.scheduledId = null;
    }
    this.wallStartMs = 0;
    this.simStartCycles = 0;
  }

  resume(): void {
    this.stopped = false;
  }

  reset(): void {
    this.stop();
    this.cpu.reset();
  }

  // Get simulation speed as percentage of real-time
  getSpeedPercent(): number {
    if (this.wallStartMs === 0) return 0;
    const simElapsedMs = ((this.cpu.cycles - this.simStartCycles) / this.speed) * 1000;
    const wallElapsedMs = performance.now() - this.wallStartMs;
    if (wallElapsedMs === 0) return 100;
    return (simElapsedMs / wallElapsedMs) * 100;
  }

  // Get elapsed simulation time in milliseconds
  getElapsedMs(): number {
    return (this.cpu.cycles / this.speed) * 1000;
  }

  // Handle printf firmware intercept
  private handlePrintfIntercept(): void {
    // CALL8 already set: AR[8] = returnPC | (2<<30), PS.CALLINC = 2
    // Args in caller's AR[10-15]: a10=fmt, a11=arg1, a12=arg2, ...
    const retAddrRaw = this.cpu.getAR(8);
    // RETW reconstructs PC: (currentPC & 0xC0000000) | (a0 & 0x3FFFFFFF)
    const retAddr = ((this.cpu.pc & 0xC0000000) | (retAddrRaw & 0x3FFFFFFF)) >>> 0;
    const fmtAddr = this.cpu.getAR(10) >>> 0;

    // Read format string
    const fmt = this.readCString(fmtAddr, 512);

    // Read variadic args from AR[11-15] (up to 5 args)
    const args: number[] = [];
    for (let i = 11; i <= 15; i++) {
      args.push(this.cpu.getAR(i));
    }

    // Format the string
    const output = this.formatString(fmt, args);

    // Output via serial
    if (this.uart0.onByteTransmit) {
      for (let i = 0; i < output.length; i++) {
        this.uart0.onByteTransmit(output.charCodeAt(i));
      }
    }

    // Clear CALLINC and return to caller
    this.cpu.specialRegisters[SR_PS] &= ~(0x3 << 16);
    // Set return value in AR[10] (caller's perspective)
    this.cpu.setAR(10, output.length);
    this.cpu.pc = retAddr;
  }

  // Handle puts firmware intercept
  private handlePutsIntercept(): void {
    const retAddrRaw = this.cpu.getAR(8);
    const retAddr = ((this.cpu.pc & 0xC0000000) | (retAddrRaw & 0x3FFFFFFF)) >>> 0;
    const strAddr = this.cpu.getAR(10) >>> 0;

    const str = this.readCString(strAddr, 512);

    if (this.uart0.onByteTransmit) {
      for (let i = 0; i < str.length; i++) {
        this.uart0.onByteTransmit(str.charCodeAt(i));
      }
      this.uart0.onByteTransmit(10); // newline
    }

    this.cpu.specialRegisters[SR_PS] &= ~(0x3 << 16);
    this.cpu.setAR(10, 0); // puts returns non-negative on success
    this.cpu.pc = retAddr;
  }

  private readCString(addr: number, maxLen: number): string {
    let result = "";
    for (let i = 0; i < maxLen; i++) {
      const byte = this.memory.read8(addr + i);
      if (byte === 0) break;
      result += String.fromCharCode(byte);
    }
    return result;
  }

  private formatString(fmt: string, args: number[]): string {
    let result = "";
    let argIdx = 0;
    let i = 0;
    while (i < fmt.length) {
      if (fmt[i] !== '%') {
        result += fmt[i++];
        continue;
      }
      i++; // skip '%'
      if (i >= fmt.length) break;

      // Parse flags
      let leftAlign = false, zeroPad = false, showSign = false;
      while (i < fmt.length && "-0+ ".includes(fmt[i])) {
        if (fmt[i] === '-') leftAlign = true;
        if (fmt[i] === '0') zeroPad = true;
        if (fmt[i] === '+') showSign = true;
        i++;
      }

      // Parse width
      let width = 0;
      while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') {
        width = width * 10 + (fmt[i].charCodeAt(0) - 48);
        i++;
      }

      // Parse precision
      let precision = -1;
      if (i < fmt.length && fmt[i] === '.') {
        i++;
        precision = 0;
        while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') {
          precision = precision * 10 + (fmt[i].charCodeAt(0) - 48);
          i++;
        }
      }

      // Parse length modifier
      let isLong = false;
      if (i < fmt.length && fmt[i] === 'l') { isLong = true; i++; }
      if (i < fmt.length && fmt[i] === 'l') { i++; } // ll (treat same as l for 32-bit)

      if (i >= fmt.length) break;
      const spec = fmt[i++];
      const arg = argIdx < args.length ? args[argIdx] : 0;

      let formatted = "";
      switch (spec) {
        case '%': formatted = "%"; break;
        case 'd': case 'i': {
          argIdx++;
          formatted = (arg | 0).toString();
          if (showSign && arg >= 0) formatted = "+" + formatted;
          break;
        }
        case 'u': {
          argIdx++;
          formatted = (arg >>> 0).toString();
          break;
        }
        case 'x': {
          argIdx++;
          formatted = (arg >>> 0).toString(16);
          break;
        }
        case 'X': {
          argIdx++;
          formatted = (arg >>> 0).toString(16).toUpperCase();
          break;
        }
        case 'p': {
          argIdx++;
          formatted = "0x" + (arg >>> 0).toString(16);
          break;
        }
        case 'o': {
          argIdx++;
          formatted = (arg >>> 0).toString(8);
          break;
        }
        case 'c': {
          argIdx++;
          formatted = String.fromCharCode(arg & 0xff);
          break;
        }
        case 's': {
          argIdx++;
          const sAddr = arg >>> 0;
          formatted = sAddr ? this.readCString(sAddr, precision >= 0 ? precision : 256) : "(null)";
          break;
        }
        case 'f': case 'F': case 'e': case 'E': case 'g': case 'G': {
          argIdx++;
          // Floats are passed differently in Xtensa ABI, just output placeholder
          formatted = "<float>";
          break;
        }
        default:
          formatted = "%" + spec;
          break;
      }

      // Apply width padding
      if (width > 0 && formatted.length < width) {
        const padChar = zeroPad && !leftAlign ? '0' : ' ';
        const padding = padChar.repeat(width - formatted.length);
        formatted = leftAlign ? formatted + padding : padding + formatted;
      }

      result += formatted;
    }
    return result;
  }
}
