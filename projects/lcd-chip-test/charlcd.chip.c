// Custom-chip 16x2 character LCD. The MCU streams bytes over SPI:
//   0xFF = clear + home; any other non-null byte = light the next cell.
// Each character is a 6x8 cell rendered into an RGBA framebuffer (96x16).
#include "wokwi-api.h"
#include <stdlib.h>

#define W 96
#define H 16
#define CELL_W 6
#define CELL_H 8
#define COLS 16

typedef struct {
  buffer_t fb;
  spi_dev_t spi;
  uint8_t in[1];
  uint32_t cursor;
} chip_t;

static void fill_cell(chip_t *c, uint32_t col, uint32_t row, uint8_t on) {
  uint8_t rowbuf[CELL_W * 4];
  for (int i = 0; i < CELL_W; i++) {
    rowbuf[i * 4 + 0] = on ? 0xFF : 0x00;
    rowbuf[i * 4 + 1] = on ? 0xFF : 0x00;
    rowbuf[i * 4 + 2] = on ? 0xFF : 0x00;
    rowbuf[i * 4 + 3] = 0xFF;
  }
  uint32_t x0 = col * CELL_W, y0 = row * CELL_H;
  for (int ry = 0; ry < CELL_H; ry++) {
    uint32_t off = ((y0 + ry) * W + x0) * 4;
    buffer_write(c->fb, off, rowbuf, CELL_W * 4);
  }
}

static void on_spi_done(void *user_data, uint8_t *buffer, uint32_t count) {
  chip_t *c = (chip_t *)user_data;
  uint8_t b = buffer[0];
  if (b == 0xFF) {
    for (uint32_t col = 0; col < COLS; col++) { fill_cell(c, col, 0, 0); fill_cell(c, col, 1, 0); }
    c->cursor = 0;
  } else if (b != 0x00) {
    uint32_t col = c->cursor % COLS;
    uint32_t row = (c->cursor / COLS) % 2;
    fill_cell(c, col, row, 1);
    c->cursor++;
  }
  c->in[0] = 0x00;
  spi_start(c->spi, c->in, 1);
}

static void on_cs(void *user_data, pin_t pin, uint32_t value) {
  chip_t *c = (chip_t *)user_data;
  if (value == LOW) { c->in[0] = 0x00; spi_start(c->spi, c->in, 1); }
  else spi_stop(c->spi);
}

void chip_init(void) {
  chip_t *c = (chip_t *)calloc(1, sizeof(chip_t));
  uint32_t w = W, h = H;
  c->fb = framebuffer_init(&w, &h);
  pin_t cs = pin_init("CS", INPUT_PULLUP);
  const spi_config_t cfg = {
    .user_data = c, .sck = pin_init("SCK", INPUT), .mosi = pin_init("MOSI", INPUT),
    .miso = pin_init("MISO", OUTPUT), .mode = 0, .done = on_spi_done,
  };
  c->spi = spi_init(&cfg);
  const pin_watch_config_t wc = { .edge = BOTH, .pin_change = on_cs, .user_data = c };
  pin_watch(cs, &wc);
}
