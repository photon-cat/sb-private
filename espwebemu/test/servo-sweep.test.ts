import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { ESP32Runner } from "../src/index.js";
import { SR_PS } from "../src/cpu/cpu.js";
import { executeInstruction } from "../src/cpu/xtensa-execute.js";
import { handleRomCall } from "../src/stubs/rom-functions.js";

const FIRMWARE_PATH = resolve(__dirname, "/tmp/esp32-servo-build/.pio/build/esp32/firmware.bin");

// Addresses from nm:
const ADDR = {
  call_start_cpu0:      0x40082a90,
  start_cpu0:           0x400db040,
  esp_startup_start_app:0x400f2b14,
  app_main:             0x400d3410,
  loopTask:             0x400d33e4,
  setup:                0x400d148c,
  loop:                 0x400d15cc,
  initArduino:          0x400d264c,
  printf:               0x400e4bc4,
  puts:                 0x400e4ca4,
  vTaskDelay:           0x4008a270,
  delay:                0x400d2640,
  millis:               0x400d2628,
  uart_write_bytes:     0x400d6d80,
  uart_write:           0x400dd2e0,
  HW_Serial_write_buf:  0x400d1c9c, // HardwareSerial::write(const uint8_t*, size_t)
  HW_Serial_write_byte: 0x400d1c88, // HardwareSerial::write(uint8_t)
  HW_Serial_begin:      0x400d1da0,
  HW_Serial_flush:      0x400d1c7c,
  HW_Serial_available:  0x400d1c08,
  HW_Serial_readBytesU: 0x400d1c60,
  HW_Serial_peek:       0x400d1c20,
  HW_Serial_read:       0x400d1c40,
  HW_Serial_availWrite: 0x400d1c14,
  xTaskCreatePinnedToCore: 0, // will find
};

describe("Servo sweep", () => {
  it("should boot and print startup message", () => {
    const binData = new Uint8Array(readFileSync(FIRMWARE_PATH));
    const runner = new ESP32Runner();
    runner.appMainAddr = ADDR.app_main;
    runner.printfAddr = ADDR.printf;
    runner.putsAddr = ADDR.puts;
    runner.loadFirmware(binData);
    const cpu = runner.cpu;
    const mem = cpu.memory;

    let serialOutput = "";
    runner.onSerialOutput = (ch: number) => {
      serialOutput += String.fromCharCode(ch);
    };

    function returnFromCall(retVal?: number) {
      const retAddrRaw = cpu.getAR(8);
      const retAddr = ((cpu.pc & 0xC0000000) | (retAddrRaw & 0x3FFFFFFF)) >>> 0;
      cpu.specialRegisters[SR_PS] &= ~(0x3 << 16);
      if (retVal !== undefined) cpu.setAR(10, retVal);
      cpu.pc = retAddr;
    }

    const MAX_STEPS = 10_000_000;
    let stuckPC = 0;
    let stuckCount = 0;
    let loopCount = 0;
    const pcHits = new Map<number, number>();

    for (let i = 0; i < MAX_STEPS; i++) {
      const pc = cpu.pc;

      if (pc === stuckPC) {
        stuckCount++;
        if (stuckCount > 50_000) {
          console.log(`  Stuck at PC=0x${pc.toString(16)} after ${i} steps, loops=${loopCount}`);
          break;
        }
      } else {
        stuckPC = pc;
        stuckCount = 0;
      }

      // Skip all boot → jump straight to loopTask (calls setup + loop)
      if (pc === ADDR.call_start_cpu0 || pc === ADDR.start_cpu0 ||
          pc === ADDR.esp_startup_start_app || pc === ADDR.app_main) {
        // Zero BSS (0x3ffc1c10 - 0x3ffc3018)
        for (let addr = 0x3ffc1c10; addr < 0x3ffc3018; addr += 4) {
          mem.write32(addr, 0);
        }
        cpu.pc = ADDR.loopTask;
        continue;
      }

      // Intercept esp_task_wdt_reset — noop
      if (pc === 0x400da700) {
        returnFromCall(0);
        continue;
      }

      // Intercept serialEventRun — noop
      if (pc === 0x400d1cac) {
        returnFromCall(0);
        continue;
      }

      // Intercept printf
      if (pc === ADDR.printf) {
        (runner as any).handlePrintfIntercept();
        continue;
      }
      // Intercept puts
      if (pc === ADDR.puts) {
        (runner as any).handlePutsIntercept();
        continue;
      }

      // Intercept Print::write(const char*) — base for println
      if (pc === 0x400d203c) {
        const strAddr = cpu.getAR(11) >>> 0;
        let text = "";
        for (let j = 0; j < 1024; j++) {
          const ch = mem.read8(strAddr + j);
          if (ch === 0) break;
          text += String.fromCharCode(ch);
        }
        serialOutput += text;
        returnFromCall(text.length);
        continue;
      }

      // Intercept Print::println(const char*)
      if (pc === 0x400d2070) {
        const strAddr = cpu.getAR(11) >>> 0;
        let text = "";
        for (let j = 0; j < 1024; j++) {
          const ch = mem.read8(strAddr + j);
          if (ch === 0) break;
          text += String.fromCharCode(ch);
        }
        serialOutput += text + "\n";
        returnFromCall(text.length + 2);
        continue;
      }

      // Intercept Print::println() — just newline
      if (pc === 0x400d205c) {
        serialOutput += "\n";
        returnFromCall(2);
        continue;
      }

      // Intercept HardwareSerial::write(buf, size) — this is how Serial.println works
      if (pc === ADDR.HW_Serial_write_buf) {
        const buf = cpu.getAR(11) >>> 0;
        const size = cpu.getAR(12) >>> 0;
        for (let j = 0; j < size; j++) {
          const ch = mem.read8(buf + j);
          serialOutput += String.fromCharCode(ch);
          if (runner.onSerialOutput) (runner as any).uart0.onByteTransmit?.(ch);
        }
        returnFromCall(size);
        continue;
      }

      // Intercept HardwareSerial::write(byte)
      if (pc === ADDR.HW_Serial_write_byte) {
        const byte = cpu.getAR(10) & 0xff;
        serialOutput += String.fromCharCode(byte);
        if (runner.onSerialOutput) (runner as any).uart0.onByteTransmit?.(byte);
        returnFromCall(1);
        continue;
      }

      // Intercept HardwareSerial::begin — just return (UART already "ready")
      if (pc === ADDR.HW_Serial_begin) {
        returnFromCall(0);
        continue;
      }

      // Intercept Servo::attach(pin, min, max) — just return channel 0
      if (pc === 0x400d1a24) {
        returnFromCall(0);
        continue;
      }

      // Intercept Servo::write(angle) — log it, return
      if (pc === 0x400d1b48) {
        // a10 = this, a11 = angle (for CALL8, args shifted)
        returnFromCall(0);
        continue;
      }

      // Intercept Servo::writeMicroseconds — return
      if (pc === 0x400d1b30) {
        returnFromCall(0);
        continue;
      }

      // Intercept Servo::writeTicks — return
      if (pc === 0x400d1b04) {
        returnFromCall(0);
        continue;
      }

      // Intercept ledcSetup, ledcWrite, ledcAttachPin — return
      if (pc === 0x400d252c || pc === 0x400d2550 || pc === 0x400d2590) {
        returnFromCall(0);
        continue;
      }

      // Intercept pinMode — use our GPIO peripheral
      if (pc === ADDR.HW_Serial_begin + 1000000) { // placeholder — handled below
      }

      // Intercept gpio_set_direction, gpio_set_level — use our GPIO
      if (pc === 0x400d3e98) { // gpio_set_direction
        // a10 = pin, a11 = mode
        const pin = cpu.getAR(10) & 0x3f;
        const mode = cpu.getAR(11);
        // mode 2 = OUTPUT. Enable in GPIO peripheral
        if (mode === 2 || mode === 3) {
          const enableReg = runner.gpio.read32(0x20);
          runner.gpio.write32(0x24, 1 << pin); // W1TS enable
        }
        returnFromCall(0);
        continue;
      }
      if (pc === 0x400d3d28) { // gpio_set_level
        const pin = cpu.getAR(10) & 0x3f;
        const level = cpu.getAR(11) & 1;
        if (level) {
          runner.gpio.write32(0x08, 1 << pin); // W1TS
        } else {
          runner.gpio.write32(0x0c, 1 << pin); // W1TC
        }
        returnFromCall(0);
        continue;
      }

      // Intercept __pinMode, __digitalWrite — Arduino wrappers
      if (pc === 0x400d246c) { // __pinMode
        const pin = cpu.getAR(10) & 0x3f;
        const mode = cpu.getAR(11);
        if (mode === 2 || mode === 3) { // OUTPUT
          runner.gpio.write32(0x24, 1 << pin);
        }
        returnFromCall(0);
        continue;
      }
      if (pc === 0x400d24e8) { // __digitalWrite
        const pin = cpu.getAR(10) & 0x3f;
        const level = cpu.getAR(11) & 1;
        if (level) {
          runner.gpio.write32(0x08, 1 << pin);
        } else {
          runner.gpio.write32(0x0c, 1 << pin);
        }
        returnFromCall(0);
        continue;
      }

      // Intercept HardwareSerial::flush — noop
      if (pc === ADDR.HW_Serial_flush) {
        returnFromCall(0);
        continue;
      }

      // Intercept HardwareSerial::available — return 0 (no input)
      if (pc === ADDR.HW_Serial_available || pc === ADDR.HW_Serial_availWrite) {
        returnFromCall(0);
        continue;
      }

      // Intercept HardwareSerial::peek/read — return -1
      if (pc === ADDR.HW_Serial_peek || pc === ADDR.HW_Serial_read || pc === ADDR.HW_Serial_readBytesU) {
        returnFromCall(-1);
        continue;
      }

      // Intercept Stream::readStringUntil — return empty String
      if (pc === 0x400d20f4) {
        // Returns a String object. a10 = return pointer (String), a11 = this, a12 = delimiter
        // Arduino String is: char* buffer, uint16_t len, uint16_t capacity
        // Write an empty string object to the return pointer
        const retPtr = cpu.getAR(10) >>> 0;
        mem.write32(retPtr, 0);      // buffer = NULL
        mem.write16(retPtr + 4, 0);  // len = 0
        mem.write16(retPtr + 6, 0);  // capacity = 0
        returnFromCall(retPtr);
        continue;
      }

      // Intercept delay
      if (pc === ADDR.delay || pc === ADDR.vTaskDelay) {
        const ms = cpu.getAR(10) >>> 0;
        cpu.cycles += ms * 240_000;
        returnFromCall(0);
        continue;
      }

      // Intercept millis
      if (pc === ADDR.millis) {
        const ms = Math.floor(cpu.cycles / 240_000);
        returnFromCall(ms);
        continue;
      }

      handleRomCall(cpu, pc, {
        onPrintf: (text: string) => { serialOutput += text; },
      });

      const ok = executeInstruction(cpu);
      if (!ok) {
        cpu.halted = false;
        cpu.pc += 3;
      }

      // Track if we reach loop() and delay()
      if (pc === ADDR.loop) {
        loopCount++;
        if (loopCount > 200) break;
      }
      if (pc === ADDR.delay) {
        // delay(15) means servo step completed
      }
    }

    const simMs = cpu.cycles / 240_000;
    console.log(`  Serial output: "${serialOutput.trim()}"`);
    console.log(`  Final PC: 0x${cpu.pc.toString(16)}`);
    console.log(`  Simulated: ${(simMs / 1000).toFixed(1)}s, loop() called: ${loopCount}x`);
    console.log(`  GPIO 33 (LED): ${runner.gpio.getOutputPin(33) ? "HIGH" : "LOW"}`);
    console.log(`  GPIO 18 (Servo): ${runner.gpio.getOutputPin(18) ? "HIGH" : "LOW"}`);

    expect(serialOutput).toContain("Commands:");
  });
});
