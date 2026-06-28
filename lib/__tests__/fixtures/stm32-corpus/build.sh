#!/usr/bin/env bash
# Rebuild the STM32G0 HAL stress corpus. Each src/m_*.c is a real STM32Cube HAL
# program (clock tree + a driver subsystem) compiled for nucleo_g071rb. The .bin
# files are committed so the stress test runs without a toolchain; regenerate with:
#   pio platform install ststm32   # one-time (pulls HAL + arm-none-eabi-gcc)
#   ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
PROJ=$(mktemp -d)
cat > "$PROJ/platformio.ini" <<INI
[env:nucleo_g071rb]
platform = ststm32
board = nucleo_g071rb
framework = stm32cube
INI
mkdir -p "$PROJ/src"; cp src/common.h "$PROJ/src/"
for f in src/m_*.c; do
  v=$(basename "$f" .c | sed 's/^m_//')
  cp "$f" "$PROJ/src/main.c"
  ( cd "$PROJ" && pio run >/dev/null )
  cp "$PROJ/.pio/build/nucleo_g071rb/firmware.bin" "$v.bin"
  echo "built $v.bin"
done
rm -rf "$PROJ"
