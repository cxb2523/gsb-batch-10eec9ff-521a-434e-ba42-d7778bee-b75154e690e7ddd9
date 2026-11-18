// Recursion fixture: imports "CycleA.frag" (letter-case variant of
// "cycleA.frag") to close the cycle started in "cycleA.frag".
#include CycleA.frag;

float cycleBFn () {
  return 1.0;
}
