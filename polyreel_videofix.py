"""Generate small local video files of several aspect ratios for acceptance
testing, without any network or real camera.

Used by ``tests/test_replan_acceptance.py`` and by ``tools/make_test_videos.py``.
Encoding goes through PyAV (bundled ffmpeg); when PyAV is unavailable the
helpers return nothing so tests can skip instead of failing.

Each file is a short, silent H.264 clip with a distinctive solid colour and a
moving vertical stripe, so a wall of them shows clearly different shapes.
The files are written into a fresh directory that the caller owns.
"""

from __future__ import annotations

import os

# (file name, width, height): landscape, portrait, square and ultrawide.
SHAPES: tuple[tuple[str, int, int], ...] = (
    ("landscape.mp4", 320, 180),    # 16:9
    ("portrait.mp4", 180, 320),     # 9:16
    ("square.mp4", 240, 240),       # 1:1
    ("ultrawide.mp4", 360, 150),    # 2.4:1
    ("tall.mp4", 160, 300),         # 8:15
)

FRAMES = 30
FPS = 30


def av_available() -> bool:
    try:
        import importlib

        importlib.import_module("av")
    except Exception:
        return False
    return True


def make_video(path: str, width: int, height: int, frames: int = FRAMES,
               fps: int = FPS, colour: tuple[int, int, int] = (40, 90, 200)) -> None:
    """Write one silent H.264 clip with a moving stripe to ``path``."""
    import numpy as np

    import av

    container = av.open(path, "w")
    stream = container.add_stream("libx264", rate=fps)
    stream.width, stream.height = width, height
    stream.pix_fmt = "yuv420p"
    stream.options = {"crf": "30", "preset": "ultrafast"}
    stripe_w = max(2, width // 12)
    for i in range(frames):
        img = np.zeros((height, width, 3), dtype=np.uint8)
        img[:, :, 0], img[:, :, 1], img[:, :, 2] = colour
        x = int((i / max(1, frames - 1)) * (width - stripe_w))
        img[:, x:x + stripe_w, :] = (255, 255, 255)
        frame = av.VideoFrame.from_ndarray(img, format="rgb24")
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)
    container.close()


def make_wall_videos(directory: str) -> list[str]:
    """Create one clip per entry of :data:`SHAPES` in ``directory`` (which is
    created if needed).  Returns the paths in aspect-ratio order."""
    os.makedirs(directory, exist_ok=True)
    palette = ((200, 70, 60), (60, 170, 90), (90, 90, 220),
               (210, 160, 50), (160, 80, 200))
    paths: list[str] = []
    for (name, w, h), colour in zip(SHAPES, palette):
        path = os.path.join(directory, name)
        make_video(path, w, h, colour=colour)
        paths.append(path)
    return paths


def read_shape(path: str) -> tuple[int, int]:
    """Read a clip's coded width and height back (for assertions)."""
    import av

    container = av.open(path)
    stream = container.streams.video[0]
    w, h = stream.codec_context.width, stream.codec_context.height
    container.close()
    return w, h
