// STM32F103C8 memory map (subset — just the regions the emulator actually services)
//
// Reference: RM0008 "STM32F10xxx reference manual", section 3.1 "Memory organization"
//
// Note: the CPU services any 32-bit address; we only model the windows we need.

export const FLASH_BASE = 0x0800_0000;
export const FLASH_SIZE = 64 * 1024; // STM32F103C8 = 64 KiB flash
export const FLASH_END = FLASH_BASE + FLASH_SIZE;

// Cortex-M devices alias flash to 0x0000_0000 at reset so the vector table
// can be fetched from address 0. We model this as a read-only mirror.
export const FLASH_ALIAS_BASE = 0x0000_0000;

export const SRAM_BASE = 0x2000_0000;
export const SRAM_SIZE = 20 * 1024; // STM32F103C8 = 20 KiB SRAM
export const SRAM_END = SRAM_BASE + SRAM_SIZE;

// Peripheral buses
export const PERIPH_BASE = 0x4000_0000;
export const APB1_BASE = 0x4000_0000;
export const APB2_BASE = 0x4001_0000;
export const AHB_BASE = 0x4001_8000;

// Specific peripherals used by blinky-class firmware
export const RCC_BASE = 0x4002_1000;
export const GPIOA_BASE = 0x4001_0800;
export const GPIOB_BASE = 0x4001_0C00;
export const GPIOC_BASE = 0x4001_1000;
export const GPIOD_BASE = 0x4001_1400;
export const USART1_BASE = 0x4001_3800;
export const USART2_BASE = 0x4000_4400;

// Cortex-M3 System Control Space (SysTick, NVIC, SCB)
export const SCS_BASE = 0xE000_E000;
export const SYSTICK_BASE = 0xE000_E010;
export const NVIC_BASE = 0xE000_E100;
export const SCB_BASE = 0xE000_ED00;

export function inFlash(addr: number): boolean {
  return (addr >>> 0) >= FLASH_BASE && (addr >>> 0) < FLASH_END;
}

export function inSram(addr: number): boolean {
  return (addr >>> 0) >= SRAM_BASE && (addr >>> 0) < SRAM_END;
}
