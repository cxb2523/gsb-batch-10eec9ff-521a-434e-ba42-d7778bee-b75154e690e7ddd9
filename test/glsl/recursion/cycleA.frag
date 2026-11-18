// Recursion fixture: cycleA -> ./cycleB -> CycleA (case + "./" variants).
// The two spellings of this file must still resolve to one normalized
// chunk key and produce a recursion error containing the real paths.
#include ./cycleB.frag;

float cycleAFn () {
  return 1.0;
}
