#include <string.h>
#include "common.h"
UART_HandleTypeDef h;
int main(void){
  HAL_Init(); SystemClock_Config();
  __HAL_RCC_GPIOA_CLK_ENABLE(); __HAL_RCC_USART1_CLK_ENABLE();
  GPIO_InitTypeDef gt={0}; gt.Pin=GPIO_PIN_9; gt.Mode=GPIO_MODE_AF_PP; gt.Speed=GPIO_SPEED_FREQ_HIGH; HAL_GPIO_Init(GPIOA,&gt);
  GPIO_InitTypeDef gr={0}; gr.Pin=GPIO_PIN_10; gr.Mode=GPIO_MODE_INPUT; gr.Pull=GPIO_NOPULL; HAL_GPIO_Init(GPIOA,&gr);
  h.Instance=USART1; h.Init.BaudRate=115200; h.Init.WordLength=UART_WORDLENGTH_8B; h.Init.StopBits=UART_STOPBITS_1;
  h.Init.Parity=UART_PARITY_NONE; h.Init.Mode=UART_MODE_TX_RX; h.Init.HwFlowCtl=UART_HWCONTROL_NONE; h.Init.OverSampling=UART_OVERSAMPLING_16;
  if(HAL_UART_Init(&h)!=HAL_OK){while(1){}}
  const char *msg="UART-OK\n";
  HAL_UART_Transmit(&h,(uint8_t*)msg,strlen(msg),100);
  for(;;){}
}
