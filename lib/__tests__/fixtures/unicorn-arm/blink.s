.syntax unified
.cpu cortex-m3
.thumb
.section .vectors,"a"
.word 0x20005000          @ initial SP
.word reset+1             @ reset vector
.text
.thumb_func
.global reset
reset:
  ldr  r0, =0x40011010    @ GPIOC BSRR
  movw r1, #0x2000        @ set   PC13  (1<<13)
  movt r1, #0x0000
  movw r2, #0x0000        @ reset PC13  ((1<<13)<<16 = 0x20000000)
  movt r2, #0x2000
loop:
  str  r1, [r0]           @ PC13 = high  (BSRR set)
  bl   delay
  str  r2, [r0]           @ PC13 = low   (BSRR reset)
  bl   delay
  b    loop
.thumb_func
delay:
  movw r3, #2000
delay_l:
  subs r3, r3, #1
  bne  delay_l
  bx   lr
