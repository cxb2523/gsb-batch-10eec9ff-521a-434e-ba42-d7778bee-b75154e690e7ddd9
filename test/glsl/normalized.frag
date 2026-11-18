// The same chunk is imported twice using spellings that only differ by
// letter case and "./" / ".." segments. On win32 both imports resolve to
// one normalized file, so the chunk must be inlined once (when
// `removeDuplicatedImports` is enabled) and warned about at most once.
#include utils/normalized;
#include ./Utils/../utils/./normalized;

void main (void) {
  normalizedChunk();
}
