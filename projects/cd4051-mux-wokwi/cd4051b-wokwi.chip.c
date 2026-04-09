// CD4051B — 8-channel analog multiplexer/demultiplexer.
//
// 3 select lines (A=LSB, B, C=MSB) pick one of 8 channels (CIO0..CIO7).
// The selected channel's analog voltage is mirrored onto COMIO.
// INH high disables the chip (COMIO floats to 0V in this model).
//
// We re-evaluate on every state change: any select line toggles, INH toggles,
// or a 1ms periodic timer tick (so changes in pot values are picked up live).

#include "wokwi-api.h"
#include <stdlib.h>
#include <stdio.h>

typedef struct {
  pin_t a;
  pin_t b;
  pin_t c;
  pin_t inh;
  pin_t comio;
  pin_t channels[8];
} chip_t;

static void update(chip_t *chip) {
  if (pin_read(chip->inh)) {
    pin_dac_write(chip->comio, 0.0f);
    return;
  }
  uint32_t sel =
      (pin_read(chip->a) ? 1 : 0) |
      (pin_read(chip->b) ? 2 : 0) |
      (pin_read(chip->c) ? 4 : 0);
  float v = pin_adc_read(chip->channels[sel]);
  pin_dac_write(chip->comio, v);
}

static void on_change(void *user_data, pin_t pin, uint32_t value) {
  update((chip_t *)user_data);
}

static void on_tick(void *user_data) {
  update((chip_t *)user_data);
}

void chip_init(void) {
  chip_t *chip = malloc(sizeof(chip_t));

  chip->a   = pin_init("A",   INPUT);
  chip->b   = pin_init("B",   INPUT);
  chip->c   = pin_init("C",   INPUT);
  chip->inh = pin_init("INH", INPUT);

  chip->comio = pin_init("COMIO", ANALOG);

  static const char *names[8] = {
      "CIO0", "CIO1", "CIO2", "CIO3", "CIO4", "CIO5", "CIO6", "CIO7",
  };
  for (int i = 0; i < 8; i++) {
    chip->channels[i] = pin_init(names[i], ANALOG);
  }

  // Watch select + inhibit pins for changes
  const pin_watch_config_t watch = {
      .edge       = BOTH,
      .pin_change = on_change,
      .user_data  = chip,
  };
  pin_watch(chip->a,   &watch);
  pin_watch(chip->b,   &watch);
  pin_watch(chip->c,   &watch);
  pin_watch(chip->inh, &watch);

  // 1 kHz timer to track live changes in input voltages.
  const timer_config_t tcfg = {
      .user_data = chip,
      .callback  = on_tick,
  };
  timer_t t = timer_init(&tcfg);
  timer_start(t, 1000, true);

  // Initial sample
  update(chip);

  printf("CD4051B initialized\n");
}
