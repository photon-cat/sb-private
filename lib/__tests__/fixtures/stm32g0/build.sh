#!/usr/bin/env bash
# Build the bare-metal STM32G0 firmware into a raw flash image (firmware.bin).
# The .bin is committed so CI runs the Phase-3 test without an ARM toolchain.
#
# Toolchain: PlatformIO's arm-none-eabi-gcc (installed via `pio platform install
# ststm32`). Override with GCC_DIR if yours lives elsewhere.
set -euo pipefail
cd "$(dirname "$0")"

GCC_DIR="${GCC_DIR:-$HOME/.platformio/packages/toolchain-gccarmnoneeabi/bin}"
CC="$GCC_DIR/arm-none-eabi-gcc"
OBJCOPY="$GCC_DIR/arm-none-eabi-objcopy"

CFLAGS="-mcpu=cortex-m0plus -mthumb -Os -ffreestanding -nostdlib -Wall -Wextra -fno-common"

"$CC" $CFLAGS -T link.ld -o firmware.elf firmware.c
"$OBJCOPY" -O binary firmware.elf firmware.bin
echo "built firmware.bin ($(wc -c < firmware.bin) bytes)"
