// ESP32 Memory Bus — routes reads/writes to correct backing store
import * as R from "./regions.js";

export interface PeripheralHandler {
  read32(offset: number): number;
  write32(offset: number, value: number): void;
  read16?(offset: number): number;
  write16?(offset: number, value: number): void;
  read8?(offset: number): number;
  write8?(offset: number, value: number): void;
}

interface MappedPeripheral {
  base: number;
  size: number;
  handler: PeripheralHandler;
}

export class MemoryBus {
  // Internal SRAM — unified backing store
  // DRAM (0x3FFAE000–0x3FFFFFFF) and IRAM (0x40080000–0x4009FFFF) share physical SRAM
  // DRAM size: 0x52000 (335872 bytes), IRAM size: 0x20000 (131072 bytes)
  // Total: ~456KB. We allocate a flat buffer and map both regions into it.
  private readonly sram = new ArrayBuffer(0x52000 + 0x20000);
  private readonly sramView = new DataView(this.sram);
  private readonly sramU8 = new Uint8Array(this.sram);

  // Flash content — loaded from .bin firmware
  // Mapped to both IROM (instruction) and DROM (data) regions
  private flashData: Uint8Array = new Uint8Array(0);
  private flashView: DataView = new DataView(this.flashData.buffer);

  // ROM — boot ROM stubs
  private readonly rom = new ArrayBuffer(448 * 1024);
  private readonly romView = new DataView(this.rom);
  private readonly romU8 = new Uint8Array(this.rom);

  // RTC slow memory (8KB)
  private readonly rtcSlowMem = new ArrayBuffer(8 * 1024);
  private readonly rtcSlowView = new DataView(this.rtcSlowMem);

  // Peripheral register handlers
  private peripherals: MappedPeripheral[] = [];

  setFlash(data: Uint8Array) {
    this.flashData = data;
    this.flashView = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  writeRom(offset: number, data: Uint8Array) {
    this.romU8.set(data, offset);
  }

  mapPeripheral(base: number, size: number, handler: PeripheralHandler) {
    this.peripherals.push({ base, size, handler });
  }

  // Write a block of data at the given address
  writeBlock(addr: number, data: Uint8Array) {
    const u32Addr = addr >>> 0;

    // IRAM region
    if (u32Addr >= R.IRAM_START && u32Addr < R.IRAM_END) {
      const offset = u32Addr - R.IRAM_START;
      // IRAM maps to upper portion of SRAM (after DRAM's 320KB)
      const sramOffset = 0x52000 + offset;
      this.sramU8.set(data, sramOffset);
      return;
    }

    // DRAM region
    if (u32Addr >= R.DRAM_START && u32Addr < R.DRAM_END) {
      const offset = u32Addr - R.DRAM_START;
      this.sramU8.set(data, offset);
      return;
    }

    // IROM region — write to flash buffer
    if (u32Addr >= R.IROM_START && u32Addr < R.IROM_END) {
      this.ensureFlashSize(u32Addr - R.IROM_START + data.length);
      const dest = new Uint8Array(this.flashData.buffer, this.flashData.byteOffset);
      // IROM and DROM share flash; IROM offset = addr - IROM_START mapped after DROM section
      // For simplicity, we use a single flash buffer with DROM at offset 0 and IROM at offset based on segment load
      dest.set(data, u32Addr - R.IROM_START + 0x100000); // IROM maps after DROM in flash image
      return;
    }

    // DROM region
    if (u32Addr >= R.DROM_START && u32Addr < R.DROM_END) {
      this.ensureFlashSize(u32Addr - R.DROM_START + data.length);
      const dest = new Uint8Array(this.flashData.buffer, this.flashData.byteOffset);
      dest.set(data, u32Addr - R.DROM_START);
      return;
    }

    // ROM region
    if (u32Addr >= R.ROM_START && u32Addr < R.ROM_END) {
      const offset = u32Addr - R.ROM_START;
      this.romU8.set(data, offset);
      return;
    }

    // Fall through — just write to whatever region matches
    for (let i = 0; i < data.length; i++) {
      this.write8(u32Addr + i, data[i]);
    }
  }

  private ensureFlashSize(minSize: number) {
    if (this.flashData.length >= minSize) return;
    const newSize = Math.max(minSize, this.flashData.length * 2, 4 * 1024 * 1024);
    const newFlash = new Uint8Array(newSize);
    newFlash.set(this.flashData);
    this.flashData = newFlash;
    this.flashView = new DataView(newFlash.buffer);
  }

  // --- Read operations ---

  read32(addr: number): number {
    const u = addr >>> 0;
    const region = this.resolveRegion(u);
    if (region) return region.view.getUint32(region.offset, true);
    const periph = this.findPeripheral(u);
    if (periph) return periph.handler.read32(u - periph.base);
    return 0; // unmapped — return 0
  }

  read16(addr: number): number {
    const u = addr >>> 0;
    const region = this.resolveRegion(u);
    if (region) return region.view.getUint16(region.offset, true);
    const periph = this.findPeripheral(u);
    if (periph && periph.handler.read16) return periph.handler.read16(u - periph.base);
    // Fall back to 32-bit read
    if (periph) {
      const aligned = u & ~3;
      const shift = (u & 2) * 8;
      return (periph.handler.read32(aligned - periph.base) >>> shift) & 0xffff;
    }
    return 0;
  }

  read8(addr: number): number {
    const u = addr >>> 0;
    const region = this.resolveRegion(u);
    if (region) return region.u8[region.offset];
    const periph = this.findPeripheral(u);
    if (periph && periph.handler.read8) return periph.handler.read8(u - periph.base);
    if (periph) {
      const aligned = u & ~3;
      const shift = (u & 3) * 8;
      return (periph.handler.read32(aligned - periph.base) >>> shift) & 0xff;
    }
    return 0;
  }

  // --- Write operations ---

  write32(addr: number, value: number): void {
    const u = addr >>> 0;
    const region = this.resolveRegion(u);
    if (region) { region.view.setUint32(region.offset, value, true); return; }
    const periph = this.findPeripheral(u);
    if (periph) { periph.handler.write32(u - periph.base, value); return; }
  }

  write16(addr: number, value: number): void {
    const u = addr >>> 0;
    const region = this.resolveRegion(u);
    if (region) { region.view.setUint16(region.offset, value, true); return; }
    const periph = this.findPeripheral(u);
    if (periph && periph.handler.write16) { periph.handler.write16(u - periph.base, value); return; }
  }

  write8(addr: number, value: number): void {
    const u = addr >>> 0;
    const region = this.resolveRegion(u);
    if (region) { region.u8[region.offset] = value; return; }
    const periph = this.findPeripheral(u);
    if (periph && periph.handler.write8) { periph.handler.write8(u - periph.base, value); return; }
  }

  // --- Region resolution ---

  private resolveRegion(addr: number): { view: DataView; u8: Uint8Array; offset: number } | null {
    // DRAM: 0x3FFB0000 – 0x3FFFFFFF
    if (addr >= R.DRAM_START && addr < R.DRAM_END) {
      return { view: this.sramView, u8: this.sramU8, offset: addr - R.DRAM_START };
    }

    // IRAM: 0x40080000 – 0x4009FFFF → maps to sram[320K..]
    if (addr >= R.IRAM_START && addr < R.IRAM_END) {
      return { view: this.sramView, u8: this.sramU8, offset: 0x52000 + (addr - R.IRAM_START) };
    }

    // IROM (flash-mapped code): 0x400D0000 – 0x40400000
    if (addr >= R.IROM_START && addr < R.IROM_END) {
      const offset = (addr - R.IROM_START) + 0x100000;
      if (offset < this.flashData.length) {
        return { view: this.flashView, u8: this.flashData, offset };
      }
      return null;
    }

    // DROM (flash-mapped data): 0x3F400000 – 0x3F800000
    if (addr >= R.DROM_START && addr < R.DROM_END) {
      const offset = addr - R.DROM_START;
      if (offset < this.flashData.length) {
        return { view: this.flashView, u8: this.flashData, offset };
      }
      return null;
    }

    // ROM: 0x40000000 – 0x40070000
    if (addr >= R.ROM_START && addr < R.ROM_END) {
      return { view: this.romView, u8: this.romU8, offset: addr - R.ROM_START };
    }

    // RTC Slow Memory: 0x50000000 – 0x50002000
    if (addr >= R.RTC_SLOW_MEM_START && addr < R.RTC_SLOW_MEM_END) {
      return {
        view: this.rtcSlowView,
        u8: new Uint8Array(this.rtcSlowMem),
        offset: addr - R.RTC_SLOW_MEM_START,
      };
    }

    return null;
  }

  private findPeripheral(addr: number): MappedPeripheral | null {
    for (const p of this.peripherals) {
      if (addr >= p.base && addr < p.base + p.size) return p;
    }
    return null;
  }
}
