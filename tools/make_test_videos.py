"""Command-line wrapper for the acceptance-test video generator.

Usage:
    python tools/make_test_videos.py [output_directory]

Writes a handful of small silent clips with different aspect ratios
(16:9, 9:16, 1:1, 2.4:1, 8:15) so the wall can be exercised with purely
local files -- no network and no real camera needed.  Defaults to a
``wall_videos`` folder next to the repository root.
"""

from __future__ import annotations

import os
import sys

# Allow running both as ``python tools/make_test_videos.py`` and as a module.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from polyreel_videofix import SHAPES, av_available, make_wall_videos, read_shape  # noqa: E402

def main(argv: list[str]) -> int:
    if not av_available():
        print("PyAV is required to generate test videos (pip install av).", file=sys.stderr)
        return 2
    out = argv[1] if len(argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "wall_videos")
    paths = make_wall_videos(out)
    for path in paths:
        w, h = read_shape(path)
        print(f"{path}  {w}x{h}  aspect={w / h:.3f}")
    print(f"\n{len(SHAPES)} clips written to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
