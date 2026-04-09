// Simple analog amplifier chip with two user controls:
//   - gain:   integer 0..5 — multiplier on the input voltage
//   - offset: int -500..500 mV — DC offset added to the output
//
// Output = clamp((IN * gain + offset/1000), 0, 5) volts.
// A periodic 1 kHz tick keeps OUT in sync with changes to IN or the controls.
#include "wokwi-api.h"
#include <stdlib.h>
#include <stdio.h>

typedef struct {
  pin_t in;
  pin_t out;
  uint32_t gain_attr;
  uint32_t offset_attr;
} chip_t;

static void update(chip_t *c) {
  float in_v = pin_adc_read(c->in);
  uint32_t gain = attr_read(c->gain_attr);
  int32_t offset_mv = (int32_t)attr_read(c->offset_attr);
  float out_v = in_v * (float)gain + (float)offset_mv / 1000.0f;
  if (out_v < 0.0f) out_v = 0.0f;
  if (out_v > 5.0f) out_v = 5.0f;
  pin_dac_write(c->out, out_v);
}

static void on_tick(void *user_data) {
  update((chip_t *)user_data);
}

void chip_init(void) {
  chip_t *c = malloc(sizeof(chip_t));
  c->in  = pin_init("IN",  ANALOG);
  c->out = pin_init("OUT", ANALOG);
  c->gain_attr   = attr_init("gain",   1);
  c->offset_attr = attr_init("offset", 0);

  const timer_config_t tcfg = {
    .user_data = c,
    .callback  = on_tick,
  };
  timer_t t = timer_init(&tcfg);
  timer_start(t, 1000, true);

  update(c);
  printf("amplifier ready\n");
}
