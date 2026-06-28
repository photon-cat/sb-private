#include "common.h"
UART_HandleTypeDef h;
int main(void){
  HAL_Init(); SystemClock_Config();
  __HAL_RCC_GPIOA_CLK_ENABLE(); __HAL_RCC_USART2_CLK_ENABLE();
  GPIO_InitTypeDef g={0}; g.Pin=GPIO_PIN_2|GPIO_PIN_3; g.Mode=GPIO_MODE_AF_PP; g.Alternate=GPIO_AF1_USART2; g.Speed=GPIO_SPEED_FREQ_HIGH;
  HAL_GPIO_Init(GPIOA,&g);
  h.Instance=USART2; h.Init.BaudRate=115200; h.Init.WordLength=UART_WORDLENGTH_8B; h.Init.StopBits=UART_STOPBITS_1;
  h.Init.Parity=UART_PARITY_NONE; h.Init.Mode=UART_MODE_TX_RX; h.Init.HwFlowCtl=UART_HWCONTROL_NONE; h.Init.OverSampling=UART_OVERSAMPLING_16;
  if(HAL_UART_Init(&h)!=HAL_OK){while(1){}}
  const char *msg="UART-OK\n";
  HAL_UART_Transmit(&h,(uint8_t*)msg,8,100);
  for(;;){}
}
