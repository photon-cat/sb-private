#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"

#define BLINK_GPIO 2

void app_main(void)
{
    // Configure GPIO 2 as output (built-in LED on many ESP32 boards)
    gpio_reset_pin(BLINK_GPIO);
    gpio_set_direction(BLINK_GPIO, GPIO_MODE_OUTPUT);

    printf("Hello from ESP32 emulator!\n");

    int count = 0;
    while (1) {
        gpio_set_level(BLINK_GPIO, count % 2);
        printf("Blink %d\n", count);
        count++;
        vTaskDelay(1000 / portTICK_PERIOD_MS);
    }
}
