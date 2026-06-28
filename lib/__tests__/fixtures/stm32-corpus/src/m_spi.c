#include "common.h"
SPI_HandleTypeDef h;
int main(void){
  HAL_Init(); SystemClock_Config();
  __HAL_RCC_GPIOA_CLK_ENABLE(); __HAL_RCC_SPI1_CLK_ENABLE();
  GPIO_InitTypeDef g={0}; g.Pin=GPIO_PIN_5|GPIO_PIN_7; g.Mode=GPIO_MODE_AF_PP; g.Alternate=GPIO_AF0_SPI1; g.Speed=GPIO_SPEED_FREQ_HIGH;
  HAL_GPIO_Init(GPIOA,&g);
  h.Instance=SPI1; h.Init.Mode=SPI_MODE_MASTER; h.Init.Direction=SPI_DIRECTION_2LINES; h.Init.DataSize=SPI_DATASIZE_8BIT;
  h.Init.CLKPolarity=SPI_POLARITY_LOW; h.Init.CLKPhase=SPI_PHASE_1EDGE; h.Init.NSS=SPI_NSS_SOFT;
  h.Init.BaudRatePrescaler=SPI_BAUDRATEPRESCALER_8; h.Init.FirstBit=SPI_FIRSTBIT_MSB; h.Init.TIMode=SPI_TIMODE_DISABLE; h.Init.CRCCalculation=SPI_CRCCALCULATION_DISABLE;
  if(HAL_SPI_Init(&h)!=HAL_OK){while(1){}}
  uint8_t cmd[4]={0xAE,0xA8,0x3F,0xAF}; // SSD1306-ish init bytes
  HAL_SPI_Transmit(&h,cmd,4,100);
  for(;;){}
}
