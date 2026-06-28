#include "common.h"
TIM_HandleTypeDef h;
int main(void){
  HAL_Init(); SystemClock_Config();
  __HAL_RCC_TIM3_CLK_ENABLE();
  h.Instance=TIM3; h.Init.Prescaler=63; h.Init.CounterMode=TIM_COUNTERMODE_UP; h.Init.Period=999;
  h.Init.ClockDivision=TIM_CLOCKDIVISION_DIV1; h.Init.AutoReloadPreload=TIM_AUTORELOAD_PRELOAD_ENABLE;
  if(HAL_TIM_PWM_Init(&h)!=HAL_OK){while(1){}}
  TIM_OC_InitTypeDef oc={0}; oc.OCMode=TIM_OCMODE_PWM1; oc.Pulse=500; oc.OCPolarity=TIM_OCPOLARITY_HIGH; oc.OCFastMode=TIM_OCFAST_DISABLE;
  HAL_TIM_PWM_ConfigChannel(&h,&oc,TIM_CHANNEL_1);
  HAL_TIM_PWM_Start(&h,TIM_CHANNEL_1);
  for(;;){}
}
