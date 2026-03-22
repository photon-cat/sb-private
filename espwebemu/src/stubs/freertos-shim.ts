// FreeRTOS Shim for ESP32 Emulator
//
// Arduino ESP32 firmware runs on FreeRTOS. The boot sequence:
// 1. Boot ROM → 2nd stage bootloader → app_main()
// 2. app_main() calls xTaskCreatePinnedToCore() to create the "loopTask"
// 3. loopTask runs setup() once, then loop() forever
//
// We shim the FreeRTOS functions so firmware can boot without a full RTOS.

import { ESP32CPU } from "../cpu/cpu.js";
import { MemoryBus } from "../memory/memory-bus.js";

interface Task {
  name: string;
  entryPoint: number;
  stackPointer: number;
  priority: number;
  core: number;
}

export class FreeRTOSShim {
  private tasks: Task[] = [];
  private currentTaskIdx = 0;
  private tickCount = 0;

  // Known FreeRTOS function addresses (from ESP-IDF linker map)
  // These vary by ESP-IDF version; we'll use pattern matching instead.
  private interceptAddresses = new Map<number, string>();

  // Callback when a new task is created
  onTaskCreate?: (name: string, entry: number) => void;

  // Install FreeRTOS function stubs at specific addresses in memory
  installStubs(memory: MemoryBus): void {
    // We don't know exact addresses until we have the firmware's symbol table.
    // Instead, we'll use the ROM call interception pattern:
    // The firmware will CALL these functions; we intercept at known symbol addresses.
    // For now, this is a placeholder — the main interception happens via
    // symbol table analysis or known address patterns.
  }

  // Handle a potential FreeRTOS call. Returns true if handled.
  handleCall(cpu: ESP32CPU, funcName: string): boolean {
    switch (funcName) {
      case "vTaskDelay": {
        // a2 = ticks to delay (1 tick = 1ms typically)
        const ticks = cpu.getAR(2) >>> 0;
        // Advance cycle counter: ticks * (CPU_FREQ / configTICK_RATE_HZ)
        // At 240MHz with 1000Hz tick rate: 240000 cycles per tick
        cpu.cycles += ticks * 240000;
        this.tickCount += ticks;
        break;
      }

      case "vTaskDelayUntil": {
        const ticks = cpu.getAR(3) >>> 0;
        cpu.cycles += ticks * 240000;
        this.tickCount += ticks;
        break;
      }

      case "xTaskCreatePinnedToCore": {
        // a2=func, a3=name_ptr, a4=stack_size, a5=params, a6=priority, a7=handle_out
        // stack param after that = core_id
        const entry = cpu.getAR(2) >>> 0;
        const nameAddr = cpu.getAR(3) >>> 0;
        const priority = cpu.getAR(6);

        let name = "";
        for (let i = 0; i < 32; i++) {
          const ch = cpu.memory.read8(nameAddr + i);
          if (ch === 0) break;
          name += String.fromCharCode(ch);
        }

        this.tasks.push({ name, entryPoint: entry, stackPointer: 0, priority, core: 0 });
        if (this.onTaskCreate) this.onTaskCreate(name, entry);

        // Return pdPASS (1) in a2
        cpu.setAR(2, 1);
        break;
      }

      case "xTaskCreate": {
        // Same as above but no core pinning
        const entry = cpu.getAR(2) >>> 0;
        const nameAddr = cpu.getAR(3) >>> 0;
        let name = "";
        for (let i = 0; i < 32; i++) {
          const ch = cpu.memory.read8(nameAddr + i);
          if (ch === 0) break;
          name += String.fromCharCode(ch);
        }
        this.tasks.push({ name, entryPoint: entry, stackPointer: 0, priority: 0, core: 0 });
        cpu.setAR(2, 1);
        break;
      }

      case "xSemaphoreCreateMutex":
      case "xSemaphoreCreateBinary":
      case "xSemaphoreCreateCounting": {
        // Return a non-null handle (fake pointer)
        cpu.setAR(2, 0x3ffb0100 + this.tasks.length * 4);
        break;
      }

      case "xSemaphoreTake":
      case "xSemaphoreGive": {
        // Always succeed
        cpu.setAR(2, 1); // pdTRUE
        break;
      }

      case "xQueueCreate": {
        cpu.setAR(2, 0x3ffb0200 + this.tasks.length * 4);
        break;
      }

      case "xQueueSend":
      case "xQueueReceive": {
        cpu.setAR(2, 1);
        break;
      }

      case "vTaskStartScheduler": {
        // In real FreeRTOS this never returns.
        // In our shim, we let it return and the main loop continues.
        break;
      }

      case "xTaskGetTickCount": {
        cpu.setAR(2, this.tickCount);
        break;
      }

      case "esp_get_free_heap_size": {
        cpu.setAR(2, 200000); // ~200KB free
        break;
      }

      case "esp_log_timestamp": {
        cpu.setAR(2, this.tickCount);
        break;
      }

      case "portENTER_CRITICAL":
      case "portEXIT_CRITICAL":
      case "vPortEnterCritical":
      case "vPortExitCritical":
        // No-ops in single-threaded emulation
        break;

      default:
        return false;
    }

    return true;
  }

  getTickCount(): number {
    return this.tickCount;
  }

  getTasks(): readonly Task[] {
    return this.tasks;
  }
}
