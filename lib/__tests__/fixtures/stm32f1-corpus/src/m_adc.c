#include <string.h>
#include "common.h"
ADC_HandleTypeDef ha; UART_HandleTypeDef hu;
static void uputs(const char*s){ HAL_UART_Transmit(&hu,(uint8_t*)s,strlen(s),100); }
int main(void){
  HAL_Init(); SystemClock_Config();
  __HAL_RCC_GPIOA_CLK_ENABLE(); __HAL_RCC_USART1_CLK_ENABLE(); __HAL_RCC_ADC1_CLK_ENABLE();
  GPIO_InitTypeDef gt={0}; gt.Pin=GPIO_PIN_9; gt.Mode=GPIO_MODE_AF_PP; gt.Speed=GPIO_SPEED_FREQ_HIGH; HAL_GPIO_Init(GPIOA,&gt);
  GPIO_InitTypeDef ga={0}; ga.Pin=GPIO_PIN_0; ga.Mode=GPIO_MODE_ANALOG; HAL_GPIO_Init(GPIOA,&ga);
  hu.Instance=USART1; hu.Init.BaudRate=115200; hu.Init.WordLength=UART_WORDLENGTH_8B; hu.Init.StopBits=UART_STOPBITS_1;
  hu.Init.Parity=UART_PARITY_NONE; hu.Init.Mode=UART_MODE_TX_RX; hu.Init.HwFlowCtl=UART_HWCONTROL_NONE; hu.Init.OverSampling=UART_OVERSAMPLING_16;
  HAL_UART_Init(&hu);
  ha.Instance=ADC1; ha.Init.ScanConvMode=ADC_SCAN_DISABLE; ha.Init.ContinuousConvMode=DISABLE;
  ha.Init.DiscontinuousConvMode=DISABLE; ha.Init.ExternalTrigConv=ADC_SOFTWARE_START;
  ha.Init.DataAlign=ADC_DATAALIGN_RIGHT; ha.Init.NbrOfConversion=1;
  HAL_ADC_Init(&ha);
  ADC_ChannelConfTypeDef ch={0}; ch.Channel=ADC_CHANNEL_0; ch.Rank=ADC_REGULAR_RANK_1; ch.SamplingTime=ADC_SAMPLETIME_55CYCLES_5;
  HAL_ADC_ConfigChannel(&ha,&ch);
  HAL_ADC_Start(&ha);
  uint32_t v=0;
  if(HAL_ADC_PollForConversion(&ha,100)==HAL_OK) v=HAL_ADC_GetValue(&ha)&0xFFF;
  const char*hex="0123456789ABCDEF"; char buf[8];
  buf[0]='A';buf[1]='=';buf[2]=hex[(v>>8)&0xf];buf[3]=hex[(v>>4)&0xf];buf[4]=hex[v&0xf];buf[5]='\n';buf[6]=0;
  uputs(buf);
  for(;;){}
}
