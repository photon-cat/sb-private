// Magic-8 I2C demo chip.
//
// A tiny I2C peripheral at address 0x42. The master writes a 1-byte
// "register index" then reads 1 byte back. There are three registers:
//   0x00 — static magic number 0x42
//   0x01 — incrementing counter (read returns current value, then increments)
//   0x02 — echo of the last byte written to register 0x03 (default 0xA5)
//   0x03 — write-only: stash a byte to be echoed from 0x02
//
// Exercises: connect/read/write/disconnect callbacks of the Wokwi I2C API.
#include "wokwi-api.h"
#include <stdlib.h>
#include <stdio.h>

typedef struct {
  uint8_t counter;
  uint8_t echo;
  int32_t reg;        // currently selected register, or -1
  bool first_byte;    // true while waiting for register index
} chip_t;

static bool on_connect(void *ud, uint32_t addr, bool read) {
  chip_t *c = (chip_t *)ud;
  c->first_byte = true;
  return true;
}

static bool on_write(void *ud, uint8_t data) {
  chip_t *c = (chip_t *)ud;
  if (c->first_byte) {
    c->reg = data;
    c->first_byte = false;
    return true;
  }
  if (c->reg == 0x03) {
    c->echo = data;
  }
  return true;
}

static uint8_t on_read(void *ud) {
  chip_t *c = (chip_t *)ud;
  switch (c->reg) {
    case 0x00: return 0x42;
    case 0x01: return c->counter++;
    case 0x02: return c->echo;
    default:   return 0xff;
  }
}

static void on_disconnect(void *ud) {
  chip_t *c = (chip_t *)ud;
  c->first_byte = true;
}

void chip_init(void) {
  chip_t *chip = malloc(sizeof(chip_t));
  chip->counter = 0;
  chip->echo = 0xA5;
  chip->reg = -1;
  chip->first_byte = true;

  pin_init("SDA", INPUT);
  pin_init("SCL", INPUT);

  const i2c_config_t i2c_config = {
    .user_data  = chip,
    .address    = 0x42,
    .scl        = pin_init("SCL", INPUT),
    .sda        = pin_init("SDA", INPUT),
    .connect    = on_connect,
    .read       = on_read,
    .write      = on_write,
    .disconnect = on_disconnect,
  };
  i2c_init(&i2c_config);

  printf("Magic8 chip ready at 0x42\n");
}
