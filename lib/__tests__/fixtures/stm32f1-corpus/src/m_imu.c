#include <string.h>
#include "common.h"
UART_HandleTypeDef hu;
I2C_HandleTypeDef hi;
static void uputs(const char*s){ HAL_UART_Transmit(&hu,(uint8_t*)s,strlen(s),100); }
int main(void){
  HAL_Init(); SystemClock_Config();
  __HAL_RCC_GPIOA_CLK_ENABLE(); __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_AFIO_CLK_ENABLE();
  __HAL_RCC_USART1_CLK_ENABLE(); __HAL_RCC_I2C1_CLK_ENABLE();
  /* USART1 TX=PA9 AF push-pull, RX=PA10 input */
  GPIO_InitTypeDef gt={0}; gt.Pin=GPIO_PIN_9; gt.Mode=GPIO_MODE_AF_PP; gt.Speed=GPIO_SPEED_FREQ_HIGH; HAL_GPIO_Init(GPIOA,&gt);
  GPIO_InitTypeDef gr={0}; gr.Pin=GPIO_PIN_10; gr.Mode=GPIO_MODE_INPUT; gr.Pull=GPIO_NOPULL; HAL_GPIO_Init(GPIOA,&gr);
  /* I2C1 SCL=PB6, SDA=PB7 AF open-drain */
  GPIO_InitTypeDef gi={0}; gi.Pin=GPIO_PIN_6|GPIO_PIN_7; gi.Mode=GPIO_MODE_AF_OD; gi.Speed=GPIO_SPEED_FREQ_HIGH; HAL_GPIO_Init(GPIOB,&gi);
  hu.Instance=USART1; hu.Init.BaudRate=115200; hu.Init.WordLength=UART_WORDLENGTH_8B; hu.Init.StopBits=UART_STOPBITS_1;
  hu.Init.Parity=UART_PARITY_NONE; hu.Init.Mode=UART_MODE_TX_RX; hu.Init.HwFlowCtl=UART_HWCONTROL_NONE; hu.Init.OverSampling=UART_OVERSAMPLING_16;
  HAL_UART_Init(&hu);
  hi.Instance=I2C1; hi.Init.ClockSpeed=100000; hi.Init.DutyCycle=I2C_DUTYCYCLE_2; hi.Init.OwnAddress1=0;
  hi.Init.AddressingMode=I2C_ADDRESSINGMODE_7BIT; hi.Init.DualAddressMode=I2C_DUALADDRESS_DISABLE; hi.Init.OwnAddress2=0;
  hi.Init.GeneralCallMode=I2C_GENERALCALL_DISABLE; hi.Init.NoStretchMode=I2C_NOSTRETCH_DISABLE;
  HAL_I2C_Init(&hi);
  uint8_t who=0;
  HAL_StatusTypeDef st=HAL_I2C_Mem_Read(&hi, 0x68<<1, 0x75, I2C_MEMADD_SIZE_8BIT, &who, 1, 100);
  char buf[24]; const char*hex="0123456789ABCDEF";
  if(st==HAL_OK){ buf[0]='W';buf[1]='=';buf[2]='0';buf[3]='x';buf[4]=hex[(who>>4)&0xf];buf[5]=hex[who&0xf];buf[6]='\n';buf[7]=0; }
  else { buf[0]='E';buf[1]='R';buf[2]='R';buf[3]='\n';buf[4]=0; }
  uputs(buf);
  for(;;){}
}
