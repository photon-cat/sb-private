// simavr golden-trace producer for SparkBench differential testing.
//
// Loads a raw flash binary into an ATmega328, runs N instructions, and prints
// one trace line per instruction: PC R0..R31 SREG SP (all hex). The TS oracle
// adapter (simavr-oracle.ts) spawns this and parses the output.
//
// Firmware is passed as a raw flash image (not hex/ELF) so we avoid libelf.
//
//   usage: tracer <flash.bin> <maxSteps>

#include <stdio.h>
#include <stdlib.h>
#include "sim_avr.h"

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: tracer <flash.bin> <maxSteps>\n"); return 2; }
  const char *path = argv[1];
  long maxSteps = strtol(argv[2], NULL, 10);

  avr_t *avr = avr_make_mcu_by_name("atmega328");
  if (!avr) { fprintf(stderr, "unknown mcu\n"); return 1; }
  avr_init(avr);

  FILE *f = fopen(path, "rb");
  if (!f) { fprintf(stderr, "cannot open %s\n", path); return 1; }
  size_t n = fread(avr->flash, 1, avr->flashend + 1, f);
  fclose(f);
  avr->codeend = (uint32_t)(n & ~1); // even byte boundary
  avr->pc = 0;

  for (long i = 0; i < maxSteps; i++) {
    int state = avr_run(avr);

    unsigned sreg = 0;
    for (int b = 0; b < 8; b++) sreg |= (avr->sreg[b] ? 1u : 0u) << b;
    unsigned sp = avr->data[R_SPL] | (avr->data[R_SPH] << 8);

    printf("%x", avr->pc);
    for (int r = 0; r < 32; r++) printf(" %x", avr->data[r]);
    printf(" %x %x\n", sreg, sp);

    if (state == cpu_Crashed || state == cpu_Done) break;
  }
  return 0;
}
