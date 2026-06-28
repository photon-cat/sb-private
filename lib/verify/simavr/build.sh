#!/usr/bin/env bash
# Build the simavr golden-trace tracer. Arg: path to a simavr checkout.
set -euo pipefail
SRC="${1:?usage: build.sh <simavr-checkout>}"
SIM="$SRC/simavr/sim"; CORES="$SRC/simavr/cores"; HERE="$(dirname "$0")"
# Minimal generated config headers (mega328 only; avoids libelf/avr-gcc Makefile reqs)
printf '#define CONFIG_MEGA328 1\n' > "$SRC/simavr/sim_core_config.h"
cat > "$SRC/simavr/sim_core_decl.h" <<'H'
#ifndef __SIM_CORE_DECL_H__
#define __SIM_CORE_DECL_H__
#include "sim_core_config.h"
#if CONFIG_MEGA328
extern avr_kind_t mega328;
#endif
extern avr_kind_t * avr_kind[];
#ifdef AVR_KIND_DECL
avr_kind_t * avr_kind[] = {
#if CONFIG_MEGA328
  &mega328,
#endif
  NULL };
#endif
#endif
H
cat > /tmp/_sa_stub.c <<'C'
struct avr_vcd_t;
void avr_vcd_close(struct avr_vcd_t*v){(void)v;}
int avr_vcd_start(struct avr_vcd_t*v){(void)v;return 0;}
int avr_vcd_stop(struct avr_vcd_t*v){(void)v;return 0;}
int elf_read_firmware(const char*f,void*w){(void)f;(void)w;return -1;}
void sim_default_mcu(void*p,const char*n){(void)p;(void)n;}
C
cc -O2 -w -I"$SIM" -I"$CORES" -I"$SRC/simavr" \
  "$HERE/tracer.c" /tmp/_sa_stub.c \
  "$SIM"/sim_avr.c "$SIM"/sim_core.c "$SIM"/sim_io.c "$SIM"/sim_interrupts.c \
  "$SIM"/sim_cycle_timers.c "$SIM"/sim_irq.c "$SIM"/sim_utils.c "$SIM"/sim_cmds.c \
  "$SIM"/sim_gdb.c "$SIM"/sim_hex.c "$CORES"/sim_mega328.c "$CORES"/sim_megax8.c \
  "$SIM"/avr_acomp.c "$SIM"/avr_adc.c "$SIM"/avr_eeprom.c "$SIM"/avr_extint.c \
  "$SIM"/avr_flash.c "$SIM"/avr_ioport.c "$SIM"/avr_spi.c "$SIM"/avr_timer.c \
  "$SIM"/avr_twi.c "$SIM"/avr_uart.c "$SIM"/avr_watchdog.c "$SIM"/avr_lin.c "$SIM"/avr_usi.c \
  -o /tmp/simavr_tracer
echo "built /tmp/simavr_tracer"
