#include "common.h"
int main(void){
  HAL_Init(); SystemClock_Config();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  GPIO_InitTypeDef g={0}; g.Pin=GPIO_PIN_13; g.Mode=GPIO_MODE_OUTPUT_PP; g.Speed=GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOC,&g);
  for(;;){ HAL_GPIO_TogglePin(GPIOC,GPIO_PIN_13); for(volatile int i=0;i<2000;i++){} }
}
