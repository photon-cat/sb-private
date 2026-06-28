#include "common.h"
I2C_HandleTypeDef h;
int main(void){
  HAL_Init(); SystemClock_Config();
  __HAL_RCC_GPIOB_CLK_ENABLE(); __HAL_RCC_I2C1_CLK_ENABLE();
  GPIO_InitTypeDef g={0}; g.Pin=GPIO_PIN_6|GPIO_PIN_7; g.Mode=GPIO_MODE_AF_OD; g.Speed=GPIO_SPEED_FREQ_HIGH; HAL_GPIO_Init(GPIOB,&g);
  h.Instance=I2C1; h.Init.ClockSpeed=100000; h.Init.DutyCycle=I2C_DUTYCYCLE_2; h.Init.OwnAddress1=0;
  h.Init.AddressingMode=I2C_ADDRESSINGMODE_7BIT; h.Init.DualAddressMode=I2C_DUALADDRESS_DISABLE; h.Init.OwnAddress2=0;
  h.Init.GeneralCallMode=I2C_GENERALCALL_DISABLE; h.Init.NoStretchMode=I2C_NOSTRETCH_DISABLE;
  if(HAL_I2C_Init(&h)!=HAL_OK){while(1){}}
  uint8_t who=0;
  HAL_I2C_Mem_Read(&h, 0x68<<1, 0x75, I2C_MEMADD_SIZE_8BIT, &who, 1, 100);
  for(;;){}
}
