// UART echo chip: every byte received from the MCU is echoed back as byte+1.
#include "wokwi-api.h"
#include <stdlib.h>

typedef struct { uart_dev_t uart; } chip_t;

static void on_rx(void *user_data, uint8_t byte) {
  chip_t *c = (chip_t *)user_data;
  uint8_t out = byte + 1;
  uart_write(c->uart, &out, 1);
}

void chip_init(void) {
  chip_t *c = (chip_t *)malloc(sizeof(chip_t));
  const uart_config_t cfg = {
    .user_data = c,
    .rx = pin_init("RX", INPUT),
    .tx = pin_init("TX", OUTPUT),
    .baud_rate = 9600,
    .rx_data = on_rx,
  };
  c->uart = uart_init(&cfg);
}
