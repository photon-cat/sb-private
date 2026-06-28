#!/usr/bin/env bash
# Rebuild the STM32F103 HAL corpus. Each src/m_*.c is a real STM32Cube HAL program
# (F1 clock tree + one driver subsystem) compiled for bluepill_f103c8. The .bin
# files are committed so the F1 stress/integration tests run without a toolchain.
# Regenerate with:
#   pio platform install ststm32   # one-time (pulls HAL-F1 + arm-none-eabi-gcc)
#   ./build.sh
# Programs are HAL_Delay-free: the unicorn ARMv7-M core has no NVIC exception
# entry, so SysTick-IRQ-driven HAL_Delay would busy-wait. Polling drivers run.
set -euo pipefail
cd "$(dirname "$0")"
PROJ=$(mktemp -d)
cat > "$PROJ/platformio.ini" <<INI
[env:bluepill_f103c8]
platform = ststm32
board = bluepill_f103c8
framework = stm32cube
INI
mkdir -p "$PROJ/src"; cp src/common.h "$PROJ/src/"
for f in src/m_*.c; do
  v=$(basename "$f" .c | sed 's/^m_//')
  cp "$f" "$PROJ/src/main.c"
  ( cd "$PROJ" && pio run >/dev/null )
  cp "$PROJ/.pio/build/bluepill_f103c8/firmware.bin" "$v.bin"
  echo "built $v.bin"
done
rm -rf "$PROJ"
