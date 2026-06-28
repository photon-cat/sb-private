# simavr golden-trace oracle

`tracer.c` is a minimal [simavr](https://github.com/buserror/simavr) front-end that
loads a raw ATmega328 flash image and prints a per-instruction architectural-state
trace (PC R0..R31 SREG SP, all hex). It is the **reference oracle** for differential
testing avr8js (see `docs/differential-testing.md`).

simavr is a *dev-time* tool used to (re)generate committed golden-trace fixtures —
CI diffs avr8js against the committed trace and needs no simavr build.

## Regenerate a golden trace

```bash
# 1. build the tracer (clone simavr first)
git clone --depth 1 https://github.com/buserror/simavr /tmp/simavr
bash lib/verify/simavr/build.sh /tmp/simavr   # → /tmp/simavr_tracer

# 2. firmware → raw flash bin, then trace
#    (use lib/intelhex loadHex to convert hex → 32KB bin)
/tmp/simavr_tracer flash.bin 4000 > lib/__tests__/fixtures/<name>.simavr-trace.txt
```
