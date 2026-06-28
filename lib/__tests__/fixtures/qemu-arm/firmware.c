#include <stdint.h>
/* Cortex-M4 bare metal using ARM semihosting for output (board-agnostic). */
static void sh_write0(const char *s){
  register int op asm("r0") = 0x04;      /* SYS_WRITE0 */
  register const char *p asm("r1") = s;
  asm volatile("bkpt 0xAB" : : "r"(op), "r"(p) : "memory");
}
static void sh_exit(void){
  register int op asm("r0") = 0x18;       /* SYS_EXIT */
  register int code asm("r1") = 0x20026;  /* ADP_Stopped_ApplicationExit */
  asm volatile("bkpt 0xAB" : : "r"(op), "r"(code) : "memory");
}
void Reset_Handler(void){
  /* Thumb-2-only ops: 32-bit multiply-accumulate + udiv (NOT in ARMv6-M/M0). */
  volatile uint32_t a = 7, b = 6, c = 5;
  uint32_t mac = a * b + c;        /* mla -> Thumb-2 */
  uint32_t q = mac / a;            /* udiv -> Thumb-2 (no divide on M0) */
  char buf[8]; buf[0]='M';buf[1]='4';buf[2]='=';
  buf[3]='0'+(mac/10)%10; buf[4]='0'+mac%10;   /* mac=47 */
  buf[5]='/'; buf[6]='0'+q%10; buf[7]=0;        /* q=6 */
  sh_write0(buf);
  sh_write0("\n");
  sh_exit();
  for(;;){}
}
extern uint32_t _estack;
__attribute__((section(".isr_vector"),used)) void (*const v[])(void) = {
  (void(*)(void))&_estack, Reset_Handler,
};
