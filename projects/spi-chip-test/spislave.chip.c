// SPI slave custom chip. MISO starts at 0x42; after each exchanged byte the
// next MISO value becomes (received MOSI) XOR 0xFF. Proves bidirectional SPI.
#include "wokwi-api.h"
#include <stdio.h>
#include <stdlib.h>

typedef struct {
  pin_t cs;
  spi_dev_t spi;
  uint8_t buf[1];
} chip_t;

static void on_spi_done(void *user_data, uint8_t *buffer, uint32_t count) {
  chip_t *c = (chip_t *)user_data;
  c->buf[0] = buffer[0] ^ 0xFF;   // transform received MOSI for next MISO
  spi_start(c->spi, c->buf, 1);   // re-arm for the next byte
}

static void on_cs(void *user_data, pin_t pin, uint32_t value) {
  chip_t *c = (chip_t *)user_data;
  if (value == LOW) {
    c->buf[0] = 0x42;             // initial MISO byte
    spi_start(c->spi, c->buf, 1);
  } else {
    spi_stop(c->spi);
  }
}

void chip_init(void) {
  chip_t *c = (chip_t *)malloc(sizeof(chip_t));
  c->cs = pin_init("CS", INPUT_PULLUP);
  const spi_config_t cfg = {
    .user_data = c,
    .sck = pin_init("SCK", INPUT),
    .mosi = pin_init("MOSI", INPUT),
    .miso = pin_init("MISO", OUTPUT),
    .mode = 0,
    .done = on_spi_done,
  };
  c->spi = spi_init(&cfg);
  const pin_watch_config_t w = { .edge = BOTH, .pin_change = on_cs, .user_data = c };
  pin_watch(c->cs, &w);
  printf("SPI chip ready\n");
}
