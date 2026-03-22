// ESP32 Memory Map — from ESP32 Technical Reference Manual

// Internal ROM (boot ROM)
export const ROM_START = 0x40000000;
export const ROM_END = 0x40070000; // 448KB

// Internal SRAM 0 (instruction bus)
export const IRAM_START = 0x40080000;
export const IRAM_END = 0x400a0000; // 128KB

// Internal SRAM 1 (data bus alias of upper IRAM)
export const DRAM_START = 0x3ffae000;
export const DRAM_END = 0x40000000; // ~320KB

// Flash-mapped instruction region (via cache/MMU)
export const IROM_START = 0x400d0000;
export const IROM_END = 0x40400000; // up to ~3.25MB

// Flash-mapped data region (read-only)
export const DROM_START = 0x3f400000;
export const DROM_END = 0x3f800000; // up to 4MB

// External SRAM (PSRAM) data bus
export const PSRAM_START = 0x3f800000;
export const PSRAM_END = 0x3fc00000; // 4MB

// Peripheral registers
export const PERIPH_START = 0x3ff00000;
export const PERIPH_END = 0x3ff80000;

// Peripheral base addresses
export const DPORT_BASE = 0x3ff00000;
export const UART0_BASE = 0x3ff40000;
export const SPI1_BASE = 0x3ff42000;
export const SPI0_BASE = 0x3ff43000;
export const GPIO_BASE = 0x3ff44000;
export const RTC_CNTL_BASE = 0x3ff48000;
export const IO_MUX_BASE = 0x3ff49000;
export const RTCIO_BASE = 0x3ff48400;
export const UART1_BASE = 0x3ff50000;
export const I2C0_BASE = 0x3ff53000;
export const UHCI0_BASE = 0x3ff54000;
export const RMT_BASE = 0x3ff56000;
export const LEDC_BASE = 0x3ff59000;
export const TIMG0_BASE = 0x3ff5f000;
export const TIMG1_BASE = 0x3ff60000;
export const SPI2_BASE = 0x3ff64000;
export const SPI3_BASE = 0x3ff65000;
export const I2C1_BASE = 0x3ff67000;
export const UART2_BASE = 0x3ff6e000;

// RTC memory
export const RTC_SLOW_MEM_START = 0x50000000;
export const RTC_SLOW_MEM_END = 0x50002000; // 8KB
export const RTC_FAST_MEM_START = 0x3ff80000;
export const RTC_FAST_MEM_END = 0x3ff82000; // 8KB
