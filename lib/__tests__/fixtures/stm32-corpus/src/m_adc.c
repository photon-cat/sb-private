#include "common.h"
ADC_HandleTypeDef h;
int main(void){
  HAL_Init(); SystemClock_Config();
  __HAL_RCC_ADC_CLK_ENABLE();
  h.Instance=ADC1; h.Init.ClockPrescaler=ADC_CLOCK_SYNC_PCLK_DIV2; h.Init.Resolution=ADC_RESOLUTION_12B;
  h.Init.DataAlign=ADC_DATAALIGN_RIGHT; h.Init.ScanConvMode=ADC_SCAN_DISABLE; h.Init.EOCSelection=ADC_EOC_SINGLE_CONV;
  h.Init.LowPowerAutoWait=DISABLE; h.Init.ContinuousConvMode=DISABLE; h.Init.DiscontinuousConvMode=DISABLE;
  h.Init.ExternalTrigConv=ADC_SOFTWARE_START; h.Init.DMAContinuousRequests=DISABLE; h.Init.Overrun=ADC_OVR_DATA_PRESERVED;
  if(HAL_ADC_Init(&h)!=HAL_OK){while(1){}}
  HAL_ADC_Start(&h); HAL_ADC_PollForConversion(&h,100);
  volatile uint32_t v=HAL_ADC_GetValue(&h); (void)v;
  for(;;){}
}
