#include "stm32g0xx_hal.h"
int main(void){HAL_Init();__HAL_RCC_GPIOA_CLK_ENABLE();GPIO_InitTypeDef g={0};g.Pin=GPIO_PIN_5;g.Mode=GPIO_MODE_OUTPUT_PP;HAL_GPIO_Init(GPIOA,&g);for(;;){HAL_GPIO_TogglePin(GPIOA,GPIO_PIN_5);HAL_Delay(500);}}
void SysTick_Handler(void){HAL_IncTick();}
