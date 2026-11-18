"""Automated acceptance tests for the re-layout stability work.

These run the real ``MainWindow`` with Qt's offscreen platform.  libmpv is not
available in CI, so video tiles and the file prober are replaced by fakes that
exercise exactly the scheduling/playlist/layout paths under test:

* a resize drag emits many resize events but must cause a single re-solve for
  the final size, and the resulting wall must equal a fresh solve at that size;
* plans computed against an old playlist/stage size are discarded, never
  applied, when the state changes while the background solve is running;
* rapid queue churn leaves the playing list and the visible tiles in exact
  1:1 correspondence and in the operated order, with no lost or double-started
  video;
* the same guarantees hold end to end with real generated video files feeding
  a fake prober (see the ``polyreel_videofix`` helper).
"""

from __future__ import annotations

import itertools
import os
import threading

import pytest

from PySide6.QtCore import QObject, QSize, QTimer, Signal
from PySide6.QtGui import QResizeEvent
from PySide6.QtWidgets import QApplication

from polyreel import app as appmod
from polyreel import layout as L
from polyreel.app import RESIZE_DEBOUNCE_MS, SCHEDULE_DEBOUNCE_MS, MainWindow
from polyreel.playlist import Item
from polyreel.scheduler import plan

import polyreel_videofix as videofix


# --------------------------------------------------------------------- fakes


class FakeProber(QObject):
    """Stands in for the mpv-based prober without touching any media library."""

    probed = Signal(int, object, object, object)

    def __init__(self, parent=None, aspects: dict[int, float] | None = None) -> None:
        super().__init__(parent)
        self.submitted: list[int] = []
        self._aspects = aspects or {}

    def submit(self, item_id: int, path: str) -> None:
        self.submitted.append(item_id)
        aspect = self._aspects.get(item_id)
        if aspect is None:
            name = os.path.basename(path)
            guess = {"portrait": 9 / 16, "square": 1.0, "tall": 8 / 15,
                     "ultrawide": 2.4}.get(os.path.splitext(name)[0], 16 / 9)
            aspect = guess
        # Queued like the real cross-thread signal, delivered on the GUI thread.
        QTimer.singleShot(0, lambda: self.probed.emit(item_id, aspect, 1.0, None))

    def close(self) -> None:
        pass


class FakeTile(QObject):
    """Records what a real tile would be asked to do; no native window/mpv."""

    double_clicked = Signal(object)
    right_clicked = Signal(object)
    finished = Signal(object)
    failed = Signal(object, str)
    shape_changed = Signal(object, float)
    ready = Signal(object)
    retired = Signal(object)

    _nums = itertools.count(1)

    def __init__(self, parent=None, hwdec: str = "auto-safe") -> None:
        super().__init__(parent)
        self.num = next(self._nums)
        self.item = None
        self.zoom = 1.0
        self.user_muted = False
        self.keep_sound = False
        self.loaded: list[Item] = []
        self.stopped = 0
        self._paused = False
        self._muted = True
        self._rect = None

    # -- loading / lifecycle -------------------------------------------------
    def load(self, item, start: float = 0.0, loop: bool = False, hwdec: str | None = None) -> None:
        self.item = item
        self.loaded.append(item)

    def stop(self) -> None:
        self.item = None
        self.stopped += 1
        self.hide()

    def retire(self) -> None:
        self.hide()

    def shutdown(self, wait: float = 2.0) -> None:
        pass

    def poll(self) -> None:
        pass

    def is_playing(self) -> bool:
        return self.item is not None

    @property
    def is_ready(self) -> bool:
        return True

    @property
    def is_stopped(self) -> bool:
        return True

    @property
    def load_started(self) -> float:
        return 0.0

    @property
    def paused(self) -> bool:
        return self._paused

    # -- widget-ish surface the window uses ---------------------------------
    def set_paused(self, paused: bool) -> None:
        self._paused = paused

    def set_muted(self, muted: bool) -> None:
        self._muted = muted

    def set_zoom(self, zoom: float) -> None:
        self.zoom = zoom

    def set_volume(self, volume: int) -> None:
        pass

    def move_to(self, rect, animate: bool) -> None:
        self._rect = rect
        self.show()

    def geometry(self):
        return self._rect

    def show(self) -> None:
        pass

    def hide(self) -> None:
        pass

    def raise_(self) -> None:
        pass

    def position(self) -> float:
        return 0.0

    def duration(self) -> float:
        return 1.0

    def volume(self) -> int:
        return 100

    def seek(self, seconds: float, exact: bool = True) -> None:
        pass

    def sample(self):
        return None


# ------------------------------------------------------------------ fixtures


@pytest.fixture
def qapp():
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture
def window(qapp, monkeypatch):
    # No media library in the test environment.
    monkeypatch.setattr(appmod, "Prober", FakeProber)
    monkeypatch.setattr(appmod, "VideoTile", FakeTile)
    monkeypatch.setattr(appmod, "take_retiring", lambda: [])
    monkeypatch.setattr(L, "SEARCH_BUDGET", None)
    monkeypatch.setattr(L, "QUICK_BUDGET", None)
    from polyreel import scheduler
    monkeypatch.setattr(scheduler, "FILL_BUDGET", None)

    win = MainWindow([])
    win.settings.benchmark_asked = True     # skip the first-run benchmark
    win.settings.max_streams = 8
    win.settings.min_area_pct = 1.0
    win.settings.lookahead = 1
    win.settings.tray_icon = False
    win.show()
    qapp.processEvents()
    yield win
    win.close()
    qapp.processEvents()


# ------------------------------------------------------------------- helpers


def pump(app, ms: int) -> None:
    """Let Qt process queued signals/timers for roughly ``ms`` milliseconds."""
    deadline = ms
    step = 10
    while deadline > 0:
        QTimer.singleShot(step, app.quit)
        app.exec()
        deadline -= step


def wait_until(app, predicate, timeout_ms: int = 10000) -> bool:
    deadline = timeout_ms
    while deadline > 0:
        if predicate():
            return True
        pump(app, 10)
        deadline -= 10
    return predicate()


def settle(app, win, quiet_ms: int = 250) -> None:
    """Run events until no plan is in flight and no re-solve is scheduled,
    and stay quiet for ``quiet_ms`` so chained re-solves have time to fire."""
    ok = wait_until(app, lambda: not win._planning and not win._schedule_timer.isActive())
    assert ok, "planner did not settle"
    pump(app, quiet_ms)
    assert not win._planning and not win._schedule_timer.isActive(), "a late re-solve appeared"


def add_items(win, aspects: list[float]) -> list[Item]:
    items = win.pl.add([f"/v/{i}.mp4" for i in range(len(win.pl), len(win.pl) + len(aspects))])
    for it, aspect in zip(items, aspects):
        it.aspect, it.probed = aspect, True
    win.schedule_soon()
    return items


def drag_resize(win, width: int, height: int) -> None:
    """Simulate one frame of a window drag.

    Qt's offscreen platform does not deliver ``resizeEvent`` to widgets it
    has hidden, so the event is posted explicitly.  It reaches the real
    ``Stage.resizeEvent`` -> ``MainWindow.stage_resized`` production path and
    keeps the widget's reported size in sync."""
    old = win.stage.size()
    win.stage.resize(width, height)
    win.stage.resizeEvent(QResizeEvent(QSize(width, height), old))


# --------------------------------------------------------------------- tests


def test_resize_drag_solves_once_for_final_size(window, qapp, monkeypatch):
    win = window
    add_items(win, [16 / 9, 9 / 16, 4 / 3, 1.0, 21 / 9, 16 / 9])
    settle(qapp, win)
    assert len(win.tiles) == 6

    calls: list[tuple[int, int]] = []
    real_plan = appmod.plan

    def counting_plan(playing, queued, width, height, *a, **k):
        calls.append((width, height))
        return real_plan(playing, queued, width, height, *a, **k)

    monkeypatch.setattr(appmod, "plan", counting_plan)
    # A rapid stream of resize events, as a drag produces.  The events are
    # delivered synchronously inside the debounce window, so the timer cannot
    # fire between frames.
    sizes = [(1000 + 20 * i, 700 + 8 * i) for i in range(1, 16)] + [(1300, 820)]
    for w, h in sizes:
        drag_resize(win, w, h)
        # The wall is stretched immediately; no solve may start mid-drag:
        # the debounce timer must stay pending and keep being pushed out.
        assert win._schedule_timer.isActive()
        assert win._schedule_timer.interval() == RESIZE_DEBOUNCE_MS
    assert win._schedule_timer.interval() == RESIZE_DEBOUNCE_MS

    settle(qapp, win)

    # Exactly one solve for the whole drag, at the final stage size.
    final_w, final_h = win.stage_size()
    assert len(calls) == 1, calls
    assert calls[0] == (final_w, final_h)


def test_final_layout_equals_fresh_solve_at_final_size(window, qapp):
    win = window
    items = add_items(win, [16 / 9, 9 / 16, 4 / 3, 1.0, 21 / 9, 16 / 9, 3 / 4])
    settle(qapp, win)
    prev = win.layout_

    drag_resize(win, 1180, 760)
    settle(qapp, win)
    final_w, final_h = win.stage_size()

    # What a direct solve for the final size would have produced.
    direct = plan(list(win.pl.playing), list(win.pl.queued), final_w, final_h,
                  win.settings.max_streams, win.settings.min_area,
                  win.settings.lookahead, prev=prev, crop=win.settings.crop)
    assert set(win.layout_.rects) == set(direct.layout.rects)
    for key, rect in win.layout_.rects.items():
        other = direct.layout.rects[key]
        assert abs(rect.x - other.x) < 1e-6 and abs(rect.y - other.y) < 1e-6
        assert abs(rect.w - other.w) < 1e-6 and abs(rect.h - other.h) < 1e-6

    # Geometric acceptance: no overlap, nothing outside the stage.
    rects = win.layout_.rects
    for (ka, a), (kb, b) in itertools.combinations(rects.items(), 2):
        ox = min(a.x + a.w, b.x + b.w) - max(a.x, b.x)
        oy = min(a.y + a.h, b.y + b.h) - max(a.y, b.y)
        assert ox <= 1e-6 or oy <= 1e-6, (ka, kb)
    for r in rects.values():
        assert r.x >= -1e-6 and r.y >= -1e-6
        assert r.x + r.w <= final_w + 1e-6 and r.y + r.h <= final_h + 1e-6
    # Tiles on screen correspond one to one with the playing list.
    assert sorted(win.tiles) == sorted(it.id for it in win.pl.playing)
    assert len(win.pl.playing) == len(items)


def test_queue_change_during_solve_discards_stale_plan(window, qapp, monkeypatch):
    win = window
    add_items(win, [16 / 9] * 4)
    settle(qapp, win)
    started = {it.id for it in win.pl.playing}
    assert len(started) == 4

    entered = threading.Event()
    release = threading.Event()

    def blocking_plan(playing, queued, *a, **k):
        entered.set()
        release.wait(5.0)
        return plan(playing, queued, *a, **k)

    monkeypatch.setattr(appmod, "plan", blocking_plan)
    win.schedule_soon()
    assert wait_until(qapp, entered.is_set)

    # While the background solve runs, remove a playing video and add a new one.
    victim = win.pl.playing[1]
    tile = win.tiles[victim.id]
    win._tile_finished(tile)
    extra = add_items(win, [9 / 16])
    qapp.processEvents()
    release.set()

    settle(qapp, win)
    monkeypatch.undo()
    settle(qapp, win)

    # The finished video is in Played, the newcomer is playing exactly once.
    assert victim in win.pl.played
    assert extra[0] in win.pl.playing
    loaded_ids = [it.id for t in win.tiles.values() for it in t.loaded]
    assert loaded_ids.count(extra[0].id) == 1
    assert sorted(win.tiles) == sorted(it.id for it in win.pl.playing)
    # No tile was asked to load the removed video after it left the wall.
    assert all(victim.id != it.id for t in win.tiles.values() for it in t.loaded
               if it is not victim)


def test_rapid_queue_churn_ends_consistent_and_in_order(window, qapp):
    win = window
    items = add_items(win, [16 / 9, 9 / 16, 4 / 3, 1.0, 21 / 9, 3 / 4, 16 / 10, 1.3])
    settle(qapp, win)
    assert len(win.pl.playing) == 8

    # A burst of different operations before anything can settle.
    first, second = items[0], items[1]
    win._tile_finished(win.tiles[first.id])           # skip
    added = add_items(win, [1.1, 0.9, 1.8])            # add three
    win.pl.remove(added[1])                             # remove one of them again
    win._tile_finished(win.tiles[second.id])           # skip another
    # Reverse whatever is queued (a real drag-reorder), capturing the order.
    queued_before = [it.id for it in win.pl.queued]
    win.pl.move_queued(list(reversed(queued_before)))
    qapp.processEvents()
    settle(qapp, win)

    # 1:1 correspondence, no duplicate/missing tile.
    assert sorted(win.tiles) == sorted(it.id for it in win.pl.playing)
    all_loaded = [it.id for t in win.tiles.values() for it in t.loaded]
    assert len(all_loaded) == len(set(all_loaded))
    # The drag order is preserved for the items still queued.
    surviving = [i for i in reversed(queued_before) if i in {it.id for it in win.pl.queued}]
    assert [it.id for it in win.pl.queued] == surviving
    # The removed item is gone everywhere.
    assert added[1] not in win.pl.queued and added[1] not in win.pl.playing
    # Nothing else got lost: every remaining item is in exactly one list.
    accounted = [it.id for lst in (win.pl.played, win.pl.playing, win.pl.queued) for it in lst]
    assert len(accounted) == len(set(accounted))
    for it in items + [added[0], added[2]]:
        assert it.id in accounted


def test_items_queued_during_solve_are_not_lost_or_double_started(window, qapp, monkeypatch):
    win = window
    add_items(win, [16 / 9, 4 / 3])
    settle(qapp, win)

    entered = threading.Event()
    release = threading.Event()

    def blocking_plan(playing, queued, *a, **k):
        entered.set()
        release.wait(5.0)
        return plan(playing, queued, *a, **k)

    monkeypatch.setattr(appmod, "plan", blocking_plan)
    win.schedule_soon()
    assert wait_until(qapp, entered.is_set)

    # New videos keep arriving while the solver is busy.
    late = add_items(win, [9 / 16, 1.0, 21 / 9, 3 / 4])
    qapp.processEvents()
    release.set()
    settle(qapp, win)
    monkeypatch.undo()
    settle(qapp, win)

    loaded = [it.id for t in win.tiles.values() for it in t.loaded]
    assert len(loaded) == len(set(loaded))
    for it in late:
        assert it in win.pl.playing or it in win.pl.queued
    assert sorted(win.tiles) == sorted(it.id for it in win.pl.playing)


def test_settings_change_invalidates_inflight_plan(window, qapp, monkeypatch):
    win = window
    add_items(win, [16 / 9] * 6)
    settle(qapp, win)

    entered = threading.Event()
    release = threading.Event()
    seen_limits: list[int] = []

    def blocking_plan(playing, queued, width, height, max_streams, min_area, *a, **k):
        seen_limits.append(max_streams)
        entered.set()
        release.wait(5.0)
        return plan(playing, queued, width, height, max_streams, min_area, *a, **k)

    monkeypatch.setattr(appmod, "plan", blocking_plan)
    win.schedule_soon()
    assert wait_until(qapp, entered.is_set)
    win.settings.max_streams = 3            # changes the plan inputs
    win.schedule_soon()
    release.set()
    settle(qapp, win)
    monkeypatch.undo()
    settle(qapp, win)

    assert len(win.pl.playing) <= 3
    assert sorted(win.tiles) == sorted(it.id for it in win.pl.playing)


def test_plan_inputs_change_on_every_playlist_mutation(window, qapp):
    win = window
    # More items than fit, so some stay queued and a reorder is meaningful.
    items = add_items(win, [16 / 9] * 8 + [9 / 16, 1.0])
    settle(qapp, win)
    assert len(win.pl.queued) >= 2
    assert win._state_version > 0
    baseline = win._plan_inputs()
    win.pl.touch()                        # metadata-only change
    assert win._plan_inputs() != baseline
    before = win._state_version
    win.pl.remove(items[-1])
    assert win._state_version == before + 1
    before = win._state_version
    queued = [it.id for it in win.pl.queued]
    win.pl.move_queued(list(reversed(queued)))
    assert win._state_version == before + 1
    assert [it.id for it in win.pl.queued] == list(reversed(queued))


def test_resize_while_solving_never_applies_intermediate_size(window, qapp, monkeypatch):
    win = window
    add_items(win, [16 / 9, 9 / 16, 4 / 3, 1.0])
    settle(qapp, win)

    entered = threading.Event()
    release = threading.Event()
    sizes_seen: list[tuple[int, int]] = []

    def blocking_plan(playing, queued, width, height, *a, **k):
        sizes_seen.append((width, height))
        entered.set()
        release.wait(5.0)
        return plan(playing, queued, width, height, *a, **k)

    monkeypatch.setattr(appmod, "plan", blocking_plan)
    win.schedule_soon()
    assert wait_until(qapp, entered.is_set)

    # Resize to a throwaway size, then keep going to the real final size.
    drag_resize(win, 900, 600)
    drag_resize(win, 1400, 850)
    release.set()
    settle(qapp, win)
    monkeypatch.undo()
    settle(qapp, win)

    final_w, final_h = win.stage_size()
    # The wall that remains is the one solved for the final size.
    assert win.layout_.width == final_w and win.layout_.height == final_h
    for rect in win.layout_.rects.values():
        assert rect.x + rect.w <= final_w + 1e-6 and rect.y + rect.h <= final_h + 1e-6
    # The blocked solve used the old size and was discarded; no solve was run
    # for the throwaway intermediate size (the debounce swallowed it), and the
    # only re-solve afterwards is for the final size.
    assert (900, 600) not in sizes_seen
    assert sizes_seen[-1] == (final_w, final_h)
    assert all((w, h) != (900, 600) for w, h in sizes_seen)


def test_plan_finishing_during_resize_drag_is_not_applied(window, qapp, monkeypatch):
    """A solve that returns while a drag is still in flight must be held back
    even if its stage size happens to match the current one: the
    ``_resizing`` gate guarantees no stale result is shown for one frame."""
    win = window
    add_items(win, [16 / 9, 9 / 16, 4 / 3, 1.0])
    settle(qapp, win)
    layout_before = win.layout_

    entered = threading.Event()
    release = threading.Event()

    def blocking_plan(playing, queued, *a, **k):
        entered.set()
        release.wait(5.0)
        return plan(playing, queued, *a, **k)

    monkeypatch.setattr(appmod, "plan", blocking_plan)
    win.schedule_soon()
    assert wait_until(qapp, entered.is_set)

    # One resize starts (and keeps) the debounce window open.
    drag_resize(win, 1200, 780)
    assert win._resizing and win._schedule_timer.isActive()

    # The in-flight solve now finishes; it must not be applied while resizing.
    release.set()
    assert wait_until(qapp, lambda: not win._planning)
    assert win._resizing
    assert win.layout_ is layout_before          # nothing was applied

    settle(qapp, win)
    assert not win._resizing
    final_w, final_h = win.stage_size()
    assert win.layout_.width == final_w and win.layout_.height == final_h
    assert sorted(win.tiles) == sorted(it.id for it in win.pl.playing)


def test_schedule_soon_uses_short_debounce(window):
    win = window
    win.schedule_soon()
    assert win._schedule_timer.isActive()
    assert win._schedule_timer.interval() == SCHEDULE_DEBOUNCE_MS
    win.schedule_after_resize()
    assert win._schedule_timer.interval() == RESIZE_DEBOUNCE_MS


# ------------------------------------------------------- real generated files


@pytest.mark.skipif(not videofix.av_available(), reason="PyAV not installed")
def test_end_to_end_with_generated_video_files(window, qapp, monkeypatch, tmp_path):
    win = window
    paths = videofix.make_wall_videos(str(tmp_path / "clips"))
    duration = videofix.FRAMES / videofix.FPS

    # A prober that really reads each generated file's coded shape.
    class FileProber(FakeProber):
        def submit(self, item_id: int, path: str) -> None:
            self.submitted.append(item_id)
            w, h = videofix.read_shape(path)
            QTimer.singleShot(0, lambda: self.probed.emit(item_id, w / h, duration, None))

    win.prober = FileProber()
    win.prober.probed.connect(win._probed)

    win.add_paths(paths)
    settle(qapp, win, quiet_ms=400)

    # Every generated file was probed with its true aspect and accounted for.
    assert len(win.prober.submitted) == len(paths)
    visible = list(win.pl.playing)
    assert visible and all(it.probed and it.aspect for it in visible)
    assert sorted(win.tiles) == sorted(it.id for it in visible)

    # The measured aspects match the files on disk.
    for it in visible:
        w, h = videofix.read_shape(it.path)
        assert abs(it.aspect - w / h) < 1e-9

    # Resize drag: one solve for the final size, wall stays within the stage.
    calls = []
    real_plan = appmod.plan

    def counting_plan(playing, queued, width, height, *a, **k):
        calls.append((width, height))
        return real_plan(playing, queued, width, height, *a, **k)

    monkeypatch.setattr(appmod, "plan", counting_plan)
    for i in range(1, 12):
        drag_resize(win, 900 + 30 * i, 600 + 12 * i)
    assert win._schedule_timer.isActive()
    settle(qapp, win)

    final_w, final_h = win.stage_size()
    assert len(calls) == 1 and calls[0] == (final_w, final_h)
    for r in win.layout_.rects.values():
        assert r.x >= -1e-6 and r.y >= -1e-6
        assert r.x + r.w <= final_w + 1e-6 and r.y + r.h <= final_h + 1e-6
