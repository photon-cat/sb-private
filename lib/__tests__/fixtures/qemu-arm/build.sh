#!/usr/bin/env bash
# Build the Cortex-M4 (Thumb-2) firmware for the QEMU ARM backend/oracle test.
# Thumb-2 (mla/udiv) is NOT in ARMv6-M, so the M0+ core can't run it — this is
# what motivates the QEMU path for M3–M7. Committed .elf so CI needs no toolchain.
set -euo pipefail
cd "$(dirname "$0")"
GCC_DIR="${GCC_DIR:-$HOME/.platformio/packages/toolchain-gccarmnoneeabi/bin}"
"$GCC_DIR/arm-none-eabi-gcc" -mcpu=cortex-m4 -mthumb -Os -ffreestanding -nostdlib \
  -T link.ld -o firmware.elf firmware.c
echo "built firmware.elf"
