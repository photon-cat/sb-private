// ESP32 ROM Function Stubs
// The ESP32 boot ROM contains utility functions that firmware calls.
// We stub these at their known addresses so the CPU can "call" them
// and get meaningful behavior without a real ROM binary.

import { ESP32CPU, SR_PS } from "../cpu/cpu.js";
import { MemoryBus } from "../memory/memory-bus.js";

const PS_CALLINC_SHIFT = 16;
const PS_CALLINC_MASK = 0x3 << PS_CALLINC_SHIFT;

// Known ROM function addresses (from ESP32 linker scripts / ROM map)
// These are the addresses where ESP-IDF firmware expects to find these functions.
const ROM_FUNCTIONS: Record<number, string> = {
  // ets_printf — primary ROM print function
  0x40007d54: "ets_printf",
  // ets_delay_us
  0x40008534: "ets_delay_us",
  // ets_install_putc1
  0x40007d18: "ets_install_putc1",
  // ets_update_cpu_frequency
  0x40008588: "ets_update_cpu_frequency",
  // ets_get_cpu_frequency
  0x4000858c: "ets_get_cpu_frequency",
  // Cache_Read_Enable
  0x40009a84: "Cache_Read_Enable",
  // Cache_Read_Disable
  0x40009ab8: "Cache_Read_Disable",
  // Cache_Flush
  0x40009a14: "Cache_Flush",
  // ets_set_appcpu_boot_addr
  0x4000689c: "ets_set_appcpu_boot_addr",
  // ets_efuse_get_spiconfig
  0x40008658: "ets_efuse_get_spiconfig",
  // ets_isr_attach
  0x400084e8: "ets_isr_attach",
  // ets_isr_unmask
  0x400084fc: "ets_isr_unmask",
  // ets_isr_mask
  0x40008500: "ets_isr_mask",
  // gpio_output_set
  0x40009b24: "gpio_output_set",
  // Software reset
  0x4000050c: "software_reset",
  // memcpy
  0x4000c2c8: "memcpy",
  // memset
  0x4000c44c: "memset",
  // memcmp
  0x4000c260: "memcmp",
  // strlen
  0x4000c398: "strlen",
  // bzero
  0x4000c1f0: "bzero",
  // __popcountsi2 — count set bits
  0x40002ed0: "__popcountsi2",
  // _xtos_set_intlevel — set interrupt level, returns old level
  0x4000bfdc: "_xtos_set_intlevel",
  // 64-bit math functions (used by RTC calibration, etc.)
  0x4000cff8: "__udivdi3",
  0x4000d010: "__umoddi3",
  0x4000c8e0: "__divdi3",
  0x4000c8f8: "__moddi3",
  0x4000bfd8: "__umulsidi3",
  // qsort — used by heap init to sort reserved regions
  0x40056424: "qsort",
  // strcat — used by abort() to build error message
  0x4000c518: "strcat",
  // strcmp
  0x4000c34c: "strcmp",
  // strcpy
  0x4000c3e8: "strcpy",
  // strlen — also mapped at this address by ESP-IDF linker
  0x400014c0: "strlen",
  // __swrite — newlib FILE write callback (stdout->_write)
  0x40001150: "__swrite",
  // __sread — newlib FILE read callback
  0x40001118: "__sread",
  // __sseek — newlib FILE seek callback
  0x40001184: "__sseek",
  // __sclose — newlib FILE close callback
  0x400011b8: "__sclose",
  // __sinit — newlib stdio initialization (sets up stdin/stdout/stderr)
  0x40001e38: "__sinit",
  // __sinit lock/unlock
  0x40001e20: "__sinit_lock_acquire",
  0x40001e2c: "__sinit_lock_release",
};

export interface RomCallbacks {
  onPrint?: (char: number) => void;
  onPrintf?: (text: string) => void;
}

// Install RETW.N at all ROM addresses so any call returns after handleRomCall
// performs the window rotation and stub logic.
export function installRomStubs(memory: MemoryBus): void {
  // Fill ROM with RETW.N (0x1d, 0xf0) every 2 bytes.
  // ROM range: 0x40000000 – 0x40070000 (448KB)
  const romSize = 0x70000;
  const romFill = new Uint8Array(romSize);
  for (let i = 0; i < romSize; i += 2) {
    romFill[i] = 0x1d;     // RETW.N byte 0
    romFill[i + 1] = 0xf0; // RETW.N byte 1
  }
  memory.writeRom(0, romFill);
}

// Handle a ROM function call. Called when PC matches a known ROM address.
// Returns true if handled (PC is in ROM range).
export function handleRomCall(
  cpu: ESP32CPU,
  pc: number,
  callbacks: RomCallbacks
): boolean {
  // Only handle ROM addresses (0x40000000 – 0x4006FFFF)
  if (pc < 0x40000000 || pc >= 0x40070000) return false;

  // Simulate ENTRY: rotate the window by PS.CALLINC (set by the preceding CALLn).
  // This is needed because CALLn only sets CALLINC, and ENTRY does the rotation.
  // ROM stubs don't have a real ENTRY instruction, so we do it here.
  // After rotation, the CPU will execute RETW.N at the ROM address to return.
  const callinc = (cpu.specialRegisters[SR_PS] & PS_CALLINC_MASK) >> PS_CALLINC_SHIFT;
  if (callinc > 0) {
    // Read SP from caller's window before rotation
    const oldSP = cpu.getAR(1);
    cpu.rotateWindowUp(callinc);
    cpu.setAR(1, oldSP); // Preserve SP in new window (ENTRY would do SP - imm, but we use 0)
    // Set a0 = return address (already in the right physical register from CALLn)
  }

  const name = ROM_FUNCTIONS[pc];
  if (!name) return true; // Unknown ROM function — just return (RETW.N will handle it)

  // After rotation, callee registers are now directly accessible

  switch (name) {
    case "ets_printf": {
      const fmtAddr = cpu.getAR(2) >>> 0;
      const fmt = readCString(cpu.memory, fmtAddr, 256);
      // Read variadic args from AR[3-7] (after ENTRY rotation)
      const args: number[] = [];
      for (let i = 3; i <= 7; i++) args.push(cpu.getAR(i));
      const text = formatString(cpu.memory, fmt, args);
      if (callbacks.onPrintf) callbacks.onPrintf(text);
      cpu.setAR(2, text.length);
      break;
    }

    case "ets_delay_us": {
      const us = cpu.getAR(2) >>> 0;
      cpu.cycles += Math.min(us * 240, 24000); // Cap at 100µs to prevent boot slowdown
      // Single-core emulation: set APP CPU flags so dual-core waits don't hang
      if (cpu.memory.read8(0x3ffb2381) === 0) {
        cpu.memory.write8(0x3ffb2381, 1); // s_cpu_up[1]
      }
      if (cpu.memory.read8(0x3ffb237d) === 0) {
        cpu.memory.write8(0x3ffb237d, 1); // s_cpu_inited[1]
      }
      break;
    }

    case "ets_install_putc1":
      break;

    case "ets_update_cpu_frequency":
      break;

    case "ets_get_cpu_frequency": {
      cpu.setAR(2, 240);
      break;
    }

    case "Cache_Read_Enable":
    case "Cache_Read_Disable":
    case "Cache_Flush":
      break;

    case "ets_set_appcpu_boot_addr":
      break;

    case "ets_efuse_get_spiconfig":
      cpu.setAR(2, 0);
      break;

    case "ets_isr_attach":
    case "ets_isr_unmask":
    case "ets_isr_mask":
      break;

    case "memcpy": {
      const dst = cpu.getAR(2) >>> 0;
      const src = cpu.getAR(3) >>> 0;
      const n = cpu.getAR(4) >>> 0;
      for (let i = 0; i < n; i++) {
        cpu.memory.write8(dst + i, cpu.memory.read8(src + i));
      }
      break;
    }

    case "memset": {
      const dst = cpu.getAR(2) >>> 0;
      const val = cpu.getAR(3) & 0xff;
      const n = cpu.getAR(4) >>> 0;
      for (let i = 0; i < n; i++) {
        cpu.memory.write8(dst + i, val);
      }
      break;
    }

    case "memcmp": {
      const s1 = cpu.getAR(2) >>> 0;
      const s2 = cpu.getAR(3) >>> 0;
      const n = cpu.getAR(4) >>> 0;
      let result = 0;
      for (let i = 0; i < n; i++) {
        const diff = cpu.memory.read8(s1 + i) - cpu.memory.read8(s2 + i);
        if (diff !== 0) { result = diff; break; }
      }
      cpu.setAR(2, result);
      break;
    }

    case "strlen": {
      const s = cpu.getAR(2) >>> 0;
      let len = 0;
      while (cpu.memory.read8(s + len) !== 0 && len < 65536) len++;
      cpu.setAR(2, len);
      break;
    }

    case "bzero": {
      const dst = cpu.getAR(2) >>> 0;
      const n = cpu.getAR(3) >>> 0;
      for (let i = 0; i < n; i++) {
        cpu.memory.write8(dst + i, 0);
      }
      break;
    }

    case "software_reset":
      cpu.reset();
      break;

    case "gpio_output_set":
      break;

    case "__popcountsi2": {
      let val = cpu.getAR(2) >>> 0;
      let count = 0;
      while (val) { count += val & 1; val >>>= 1; }
      cpu.setAR(2, count);
      break;
    }

    case "_xtos_set_intlevel": {
      const ps = cpu.specialRegisters[0xe6] || 0;
      cpu.setAR(2, ps & 0xf);
      break;
    }

    // 64-bit division: __udivdi3(uint64 a, uint64 b) -> uint64
    // Xtensa windowed ABI: a=AR2:AR3 (lo:hi), b=AR4:AR5, result in AR2:AR3
    case "__udivdi3": {
      const aLo = cpu.getAR(2) >>> 0;
      const aHi = cpu.getAR(3) >>> 0;
      const bLo = cpu.getAR(4) >>> 0;
      const bHi = cpu.getAR(5) >>> 0;
      const a = BigInt(aLo) | (BigInt(aHi) << 32n);
      const b = BigInt(bLo) | (BigInt(bHi) << 32n);
      const result = b !== 0n ? a / b : 0n;
      cpu.setAR(2, Number(result & 0xffffffffn));
      cpu.setAR(3, Number((result >> 32n) & 0xffffffffn));
      break;
    }

    case "__umoddi3": {
      const aLo = cpu.getAR(2) >>> 0;
      const aHi = cpu.getAR(3) >>> 0;
      const bLo = cpu.getAR(4) >>> 0;
      const bHi = cpu.getAR(5) >>> 0;
      const a = BigInt(aLo) | (BigInt(aHi) << 32n);
      const b = BigInt(bLo) | (BigInt(bHi) << 32n);
      const result = b !== 0n ? a % b : 0n;
      cpu.setAR(2, Number(result & 0xffffffffn));
      cpu.setAR(3, Number((result >> 32n) & 0xffffffffn));
      break;
    }

    case "__divdi3": {
      const aLo = cpu.getAR(2) >>> 0;
      const aHi = cpu.getAR(3) | 0;
      const bLo = cpu.getAR(4) >>> 0;
      const bHi = cpu.getAR(5) | 0;
      const a = BigInt(aLo) | (BigInt(aHi) << 32n);
      const b = BigInt(bLo) | (BigInt(bHi) << 32n);
      const result = b !== 0n ? a / b : 0n;
      cpu.setAR(2, Number(BigInt.asUintN(32, result)));
      cpu.setAR(3, Number(BigInt.asUintN(32, result >> 32n)));
      break;
    }

    case "__moddi3": {
      const aLo = cpu.getAR(2) >>> 0;
      const aHi = cpu.getAR(3) | 0;
      const bLo = cpu.getAR(4) >>> 0;
      const bHi = cpu.getAR(5) | 0;
      const a = BigInt(aLo) | (BigInt(aHi) << 32n);
      const b = BigInt(bLo) | (BigInt(bHi) << 32n);
      const result = b !== 0n ? a % b : 0n;
      cpu.setAR(2, Number(BigInt.asUintN(32, result)));
      cpu.setAR(3, Number(BigInt.asUintN(32, result >> 32n)));
      break;
    }

    case "__umulsidi3": {
      const a = cpu.getAR(2) >>> 0;
      const b = cpu.getAR(3) >>> 0;
      const result = BigInt(a) * BigInt(b);
      cpu.setAR(2, Number(result & 0xffffffffn));
      cpu.setAR(3, Number((result >> 32n) & 0xffffffffn));
      break;
    }

    case "qsort": {
      // qsort(void *base, size_t nmemb, size_t size, int (*compar)(const void *, const void *))
      const base = cpu.getAR(2) >>> 0;
      const nmemb = cpu.getAR(3) >>> 0;
      const size = cpu.getAR(4) >>> 0;
      const comparAddr = cpu.getAR(5) >>> 0;
      // Simple insertion sort in-place (good enough for small arrays)
      const tmp = new Uint8Array(size);
      for (let i = 1; i < nmemb; i++) {
        const iAddr = base + i * size;
        // Save element i
        for (let b = 0; b < size; b++) tmp[b] = cpu.memory.read8(iAddr + b);
        let j = i - 1;
        while (j >= 0) {
          const jAddr = base + j * size;
          // Compare element j with tmp using the comparator
          // We can't call the comparator via CPU, so we compare the first 4 bytes as uint32
          const jVal = cpu.memory.read32(jAddr);
          const tmpVal = (tmp[0] | (tmp[1] << 8) | (tmp[2] << 16) | (tmp[3] << 24)) >>> 0;
          if (jVal <= tmpVal) break;
          // Move element j to j+1
          const destAddr = base + (j + 1) * size;
          for (let b = 0; b < size; b++) cpu.memory.write8(destAddr + b, cpu.memory.read8(jAddr + b));
          j--;
        }
        // Insert tmp at j+1
        const insertAddr = base + (j + 1) * size;
        for (let b = 0; b < size; b++) cpu.memory.write8(insertAddr + b, tmp[b]);
      }
      break;
    }

    case "strcat": {
      // strcat(char *dest, const char *src) -> dest
      const dst = cpu.getAR(2) >>> 0;
      const src = cpu.getAR(3) >>> 0;
      // Find end of dest
      let dstEnd = dst;
      while (cpu.memory.read8(dstEnd) !== 0 && dstEnd < dst + 65536) dstEnd++;
      // Copy src
      let si = 0;
      while (si < 65536) {
        const ch = cpu.memory.read8(src + si);
        cpu.memory.write8(dstEnd + si, ch);
        if (ch === 0) break;
        si++;
      }
      // Return dest (already in a2)
      break;
    }

    case "strcmp": {
      const s1 = cpu.getAR(2) >>> 0;
      const s2 = cpu.getAR(3) >>> 0;
      let result = 0;
      for (let i = 0; i < 65536; i++) {
        const c1 = cpu.memory.read8(s1 + i);
        const c2 = cpu.memory.read8(s2 + i);
        if (c1 !== c2) { result = c1 - c2; break; }
        if (c1 === 0) break;
      }
      cpu.setAR(2, result);
      break;
    }

    case "strcpy": {
      const dst = cpu.getAR(2) >>> 0;
      const src = cpu.getAR(3) >>> 0;
      let i = 0;
      while (i < 65536) {
        const ch = cpu.memory.read8(src + i);
        cpu.memory.write8(dst + i, ch);
        if (ch === 0) break;
        i++;
      }
      // Return dst (already in a2)
      break;
    }

    case "__swrite": {
      // __swrite(struct _reent *ptr, void *cookie, const char *buf, int n)
      // cookie is FILE*, buf is data, n is length
      // Read fd from FILE struct's _file field (offset 12 in newlib FILE)
      const cookie = cpu.getAR(3) >>> 0;
      const buf = cpu.getAR(4) >>> 0;
      const n = cpu.getAR(5) | 0;
      const fd = cookie ? cpu.memory.read16(cookie + 12) : 1;
      // For stdout (fd 1) and stderr (fd 2), output via printf callback
      if ((fd === 1 || fd === 2 || fd === 0) && n > 0 && callbacks.onPrintf) {
        let text = "";
        for (let i = 0; i < n; i++) {
          text += String.fromCharCode(cpu.memory.read8(buf + i));
        }
        callbacks.onPrintf(text);
      }
      // Return n (bytes written)
      cpu.setAR(2, n);
      break;
    }

    case "__sinit": {
      // __sinit(struct _reent *s) — initialize stdio FILE structs
      const reent = cpu.getAR(2) >>> 0;
      if (reent === 0) break;

      // __sf array at 0x3ffb2ae0 (BSS), FILE struct size = 104 bytes
      const sfBase = 0x3ffb2ae0;
      const fileSize = 104;
      const stdinF  = sfBase;
      const stdoutF = sfBase + fileSize;
      const stderrF = sfBase + fileSize * 2;

      // ROM function pointers for FILE callbacks
      const SREAD  = 0x40001118;
      const SWRITE = 0x40001150;
      const SSEEK  = 0x40001184;
      const SCLOSE = 0x400011b8;

      // newlib flags
      const SRD  = 0x0004; // readable
      const SWR  = 0x0008; // writable
      const SNBF = 0x0002; // unbuffered

      // Set reent->_stdin, _stdout, _stderr (offsets 4, 8, 12)
      cpu.memory.write32(reent + 4, stdinF);
      cpu.memory.write32(reent + 8, stdoutF);
      cpu.memory.write32(reent + 12, stderrF);

      // Helper to initialize a FILE struct
      const initFile = (addr: number, flags: number, fd: number) => {
        // Clear the struct
        for (let i = 0; i < fileSize; i += 4) cpu.memory.write32(addr + i, 0);
        cpu.memory.write16(addr + 12, flags);   // _flags
        cpu.memory.write16(addr + 14, fd);      // _file
        cpu.memory.write32(addr + 28, addr);    // _cookie = self
        cpu.memory.write32(addr + 32, SREAD);   // _read
        cpu.memory.write32(addr + 36, SWRITE);  // _write
        cpu.memory.write32(addr + 40, SSEEK);   // _seek
        cpu.memory.write32(addr + 44, SCLOSE);  // _close
      };

      initFile(stdinF,  SRD | SNBF, 0);  // stdin: read, unbuffered
      initFile(stdoutF, SWR | SNBF, 1);  // stdout: write, unbuffered
      initFile(stderrF, SWR | SNBF, 2);  // stderr: write, unbuffered

      // Set __sdidinit flag in reent (try common offsets)
      // In ESP-IDF newlib, __sdidinit is typically at offset 48
      cpu.memory.write32(reent + 48, 1);
      break;
    }

    case "__sinit_lock_acquire":
    case "__sinit_lock_release":
      break;

    case "__sread":
    case "__sseek":
    case "__sclose":
      cpu.setAR(2, 0);
      break;

    default:
      return false;
  }

  return true;
}

function readCString(memory: MemoryBus, addr: number, maxLen: number): string {
  let result = "";
  for (let i = 0; i < maxLen; i++) {
    const byte = memory.read8(addr + i);
    if (byte === 0) break;
    result += String.fromCharCode(byte);
  }
  return result;
}

function formatString(memory: MemoryBus, fmt: string, args: number[]): string {
  let result = "";
  let argIdx = 0;
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] !== '%') { result += fmt[i++]; continue; }
    i++;
    if (i >= fmt.length) break;
    // Skip flags
    while (i < fmt.length && "-0+ #".includes(fmt[i])) i++;
    // Skip width
    let width = 0;
    while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') {
      width = width * 10 + (fmt[i].charCodeAt(0) - 48); i++;
    }
    // Skip precision
    if (i < fmt.length && fmt[i] === '.') {
      i++;
      while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') i++;
    }
    // Length modifiers
    if (i < fmt.length && fmt[i] === 'l') { i++; if (i < fmt.length && fmt[i] === 'l') i++; }
    if (i < fmt.length && fmt[i] === 'h') { i++; if (i < fmt.length && fmt[i] === 'h') i++; }
    if (i >= fmt.length) break;
    const spec = fmt[i++];
    const arg = argIdx < args.length ? args[argIdx] : 0;
    let f = "";
    switch (spec) {
      case '%': f = "%"; break;
      case 'd': case 'i': argIdx++; f = (arg | 0).toString(); break;
      case 'u': argIdx++; f = (arg >>> 0).toString(); break;
      case 'x': argIdx++; f = (arg >>> 0).toString(16); break;
      case 'X': argIdx++; f = (arg >>> 0).toString(16).toUpperCase(); break;
      case 'p': argIdx++; f = "0x" + (arg >>> 0).toString(16); break;
      case 'o': argIdx++; f = (arg >>> 0).toString(8); break;
      case 'c': argIdx++; f = String.fromCharCode(arg & 0xff); break;
      case 's': {
        argIdx++;
        const sAddr = arg >>> 0;
        f = sAddr ? readCString(memory, sAddr, 256) : "(null)";
        break;
      }
      default: f = "%" + spec; break;
    }
    if (width > 0 && f.length < width) f = " ".repeat(width - f.length) + f;
    result += f;
  }
  return result;
}
