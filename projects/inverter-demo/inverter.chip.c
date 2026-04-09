// Simple digital inverter custom chip.
// OUT = NOT IN. Demonstrates pin watch + pin write.
#include "wokwi-api.h"
#include <stdio.h>
#include <stdlib.h>

typedef struct {
  pin_t pin_in;
  pin_t pin_out;
} chip_state_t;

static void on_in_change(void *user_data, pin_t pin, uint32_t value) {
  chip_state_t *chip = (chip_state_t *)user_data;
  pin_write(chip->pin_out, value ? LOW : HIGH);
}

void chip_init(void) {
  chip_state_t *chip = malloc(sizeof(chip_state_t));
  chip->pin_in  = pin_init("IN",  INPUT);
  chip->pin_out = pin_init("OUT", OUTPUT);

  // Set initial output
  pin_write(chip->pin_out, pin_read(chip->pin_in) ? LOW : HIGH);

  const pin_watch_config_t watch_config = {
    .edge      = BOTH,
    .pin_change = on_in_change,
    .user_data = chip,
  };
  pin_watch(chip->pin_in, &watch_config);

  printf("Inverter initialized\n");
}
