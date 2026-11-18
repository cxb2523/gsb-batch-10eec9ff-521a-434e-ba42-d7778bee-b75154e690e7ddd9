"""Tests for media switching convergence in ZidooCoordinator.

These tests drive the coordinator with locally constructed playing-info
dictionaries and a scriptable fake player; no real device or network access
is involved.

Scenarios covered:
    * switching movies (metadata/tracks/zoom/position converge immediately)
    * a failed playing-info request right after a switch (grace period and
      expiry to IDLE, never assigning old track lists to the new media)
    * same-path reload (pause then resume keeps progress and does not clear)
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from custom_components.zidoo.coordinator import ZidooCoordinator
from custom_components.zidoo.zidooaio import (
    ZCONTENT_VIDEO,
    ZSTATE_PAUSED,
    ZSTATE_PLAYING,
)

try:  # real Home Assistant when available, otherwise the conftest stubs
    from homeassistant.components.media_player import MediaPlayerState, MediaType
except ImportError:  # pragma: no cover - exercised in the stub-only environment
    MediaPlayerState = SimpleNamespace(
        OFF="off",
        ON="on",
        PLAYING="playing",
        PAUSED="paused",
        IDLE="idle",
    )
    MediaType = SimpleNamespace(
        APP="app",
        MUSIC="music",
        MOVIE="movie",
        TVSHOW="tvshow",
    )

pytestmark = pytest.mark.asyncio


def video_info(
    uri,
    media_id,
    *,
    status=ZSTATE_PLAYING,
    position=60000,
    duration=6000000,
    title=None,
    **extra,
):
    """Build a playing-info dictionary as produced by ZidooRC.get_playing_info."""
    info = {
        "source": "video",
        "status": status,
        "uri": uri,
        "id": media_id,
        "title": title or uri.rsplit("/", 1)[-1],
        "duration": duration,
        "position": position,
    }
    info.update(extra)
    return info


class FakePlayer:
    """Scriptable replacement for ZidooRC."""

    def __init__(self):
        self._connected = True
        self._keep_stale = False
        self.playing_info_responses = []
        self.audio_responses = []
        self.subtitle_responses = []
        self.zoom_responses = []
        self.audio_calls = 0
        self.subtitle_calls = 0
        self.zoom_calls = 0
        self.audio_output = 0

    def is_connected(self):
        return self._connected

    async def connect(self):
        self._connected = True

    async def load_audio_output_list(self):
        return {}

    async def get_audio_output(self):
        return self.audio_output

    async def load_source_list(self):
        return {}

    async def get_source(self):
        return ZCONTENT_VIDEO

    async def get_playing_info(self):
        if not self.playing_info_responses:
            raise AssertionError("no playing-info response queued")
        response = self.playing_info_responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def _should_keep_stale_media(self):
        return self._keep_stale

    async def get_audio_list(self, log_errors=True):
        self.audio_calls += 1
        return self.audio_responses.pop(0) if self.audio_responses else []

    async def get_subtitle_list(self, log_errors=True):
        self.subtitle_calls += 1
        return self.subtitle_responses.pop(0) if self.subtitle_responses else []

    async def get_zoom_list(self):
        self.zoom_calls += 1
        return self.zoom_responses.pop(0) if self.zoom_responses else {}


def make_coordinator(player):
    config_entry = SimpleNamespace(
        title="Zidoo", entry_id="test-entry", options={}
    )
    return ZidooCoordinator(hass=SimpleNamespace(), player=player, config_entry=config_entry)


async def poll(coordinator):
    await coordinator._async_update_data()


# ---------------------------------------------------------------------------
# Scenario 1: switching movies
# ---------------------------------------------------------------------------


async def test_switching_movie_clears_previous_media_immediately():
    player = FakePlayer()
    coordinator = make_coordinator(player)

    old_info = video_info(
        "/media/movies/old.mkv",
        101,
        position=120000,
        movie_name="Old Movie",
        tag="old tagline",
        type="movie",
    )
    player.playing_info_responses = [old_info]
    player.audio_responses = [[{"index": 0, "title": "old-audio"}]]
    player.subtitle_responses = [[{"index": 0, "title": "old-sub"}]]
    player.zoom_responses = [{0: "Original"}]

    await poll(coordinator)

    assert coordinator.state == MediaPlayerState.PLAYING
    assert coordinator.media_info["movie_name"] == "Old Movie"
    assert coordinator.audio_tracks == [{"index": 0, "title": "old-audio"}]
    assert coordinator.subtitle_tracks == [{"index": 0, "title": "old-sub"}]
    assert coordinator.zoom_modes == {0: "Original"}
    assert coordinator.media_info["position"] == 120000
    old_updated_at = coordinator.last_updated
    assert old_updated_at is not None

    # Switch: the new media's poster lookup has not completed yet, so its id is
    # still 0 and only the fresh player payload (uri/title/position) exists.
    new_info = video_info(
        "/media/movies/new.mkv",
        0,
        position=3000,
        movie_name="Old Movie",  # stale field that must be scrubbed
        tag="old tagline",
        type="movie",
    )
    player.playing_info_responses = [new_info]
    # Track lists fail to load on the first poll for the new media.
    player.audio_responses = [[]]
    player.subtitle_responses = [[]]
    player.zoom_responses = [{}]

    await poll(coordinator)

    # The old media's identity and metadata are gone at once.
    assert coordinator.media_info.get("uri") == "/media/movies/new.mkv"
    assert coordinator.media_info.get("movie_name") is None
    assert coordinator.media_info.get("tag") is None
    assert coordinator.media_info.get("type") is None
    assert coordinator.media_info.get("id") == 0

    # Old tracks/zoom must never be presented for the new media.
    assert coordinator.audio_tracks == []
    assert coordinator.subtitle_tracks == []
    assert coordinator.zoom_modes == {}
    assert player.audio_calls == 2 and player.subtitle_calls == 2 and player.zoom_calls == 2

    # The timestamp is freshly derived from the new media's own position, not
    # inherited from the old media's timestamp.
    assert coordinator.last_updated is not None
    assert coordinator.last_updated >= old_updated_at
    assert coordinator.media_info["position"] == 3000

    # Next poll: poster enrichment and track lists arrive for the new media.
    enriched_info = video_info(
        "/media/movies/new.mkv",
        202,
        position=8000,
        movie_name="New Movie",
        type="movie",
    )
    player.playing_info_responses = [enriched_info]
    player.audio_responses = [[{"index": 0, "title": "new-audio"}]]
    player.subtitle_responses = [[{"index": 0, "title": "new-sub"}]]
    player.zoom_responses = [{0: "Original", 1: "Full"}]

    await poll(coordinator)

    assert coordinator.media_info.get("id") == 202
    assert coordinator.media_info.get("movie_name") == "New Movie"
    assert coordinator.audio_tracks == [{"index": 0, "title": "new-audio"}]
    assert coordinator.subtitle_tracks == [{"index": 0, "title": "new-sub"}]
    assert coordinator.zoom_modes == {0: "Original", 1: "Full"}
    assert coordinator.last_updated is not None
    assert coordinator.last_updated >= old_updated_at

    # Once the lists are loaded they are not refetched on every poll.
    calls_after_load = (player.audio_calls, player.subtitle_calls, player.zoom_calls)
    player.playing_info_responses = [
        video_info("/media/movies/new.mkv", 202, position=12000)
    ]
    await poll(coordinator)
    assert (
        player.audio_calls,
        player.subtitle_calls,
        player.zoom_calls,
    ) == calls_after_load
    assert coordinator.media_info["position"] == 12000


async def test_switching_tv_episode_uses_path_identity():
    player = FakePlayer()
    coordinator = make_coordinator(player)

    player.playing_info_responses = [
        video_info("/media/tv/show/S01E01.mkv", 1, type="tv", episode=1)
    ]
    player.audio_responses = [[{"index": 0, "title": "a1"}]]
    player.subtitle_responses = [[{"index": 0, "title": "s1"}]]
    player.zoom_responses = [{0: "Original"}]
    await poll(coordinator)
    assert coordinator.media_type == MediaType.TVSHOW
    assert coordinator.media_info["episode"] == 1

    # Same id space, different path: a new episode must still be detected.
    player.playing_info_responses = [
        video_info("/media/tv/show/S01E02.mkv", 1, type="tv", episode=2)
    ]
    player.audio_responses = [[]]
    player.subtitle_responses = [[]]
    player.zoom_responses = [{}]
    await poll(coordinator)

    assert coordinator.media_info.get("uri") == "/media/tv/show/S01E02.mkv"
    assert coordinator.media_info.get("episode") is None
    assert coordinator.audio_tracks == []
    assert coordinator.subtitle_tracks == []
    assert coordinator.zoom_modes == {}


# ---------------------------------------------------------------------------
# Scenario 2: failed request after a media switch
# ---------------------------------------------------------------------------


async def test_failed_request_within_grace_keeps_state_but_not_old_tracks_for_new_media():
    player = FakePlayer()
    coordinator = make_coordinator(player)

    player.playing_info_responses = [
        video_info("/media/movies/old.mkv", 101, position=100000)
    ]
    player.audio_responses = [[{"index": 0, "title": "old-audio"}]]
    player.subtitle_responses = [[{"index": 0, "title": "old-sub"}]]
    player.zoom_responses = [{0: "Original"}]
    await poll(coordinator)

    # The player switches to a new video but the playing-info request fails.
    player.playing_info_responses = [{}]
    player._keep_stale = True
    await poll(coordinator)

    # Within the grace period the last known state/media are retained...
    assert coordinator.state == MediaPlayerState.PLAYING
    assert coordinator.media_info.get("uri") == "/media/movies/old.mkv"
    # ...and no track fetch happens, so nothing gets reassigned.
    assert player.audio_calls == 1
    assert coordinator.audio_tracks == [{"index": 0, "title": "old-audio"}]
    # The old timestamp must not be refreshed by the failed poll.
    updated_after_failure = coordinator.last_updated

    # When the new media finally reports, the old tracks are dropped at once.
    player._keep_stale = False
    player.playing_info_responses = [
        video_info("/media/movies/new.mkv", 202, position=5000)
    ]
    player.audio_responses = [[]]
    player.subtitle_responses = [[]]
    player.zoom_responses = [{}]
    await poll(coordinator)

    assert coordinator.media_info.get("uri") == "/media/movies/new.mkv"
    assert coordinator.audio_tracks == []
    assert coordinator.subtitle_tracks == []
    assert coordinator.zoom_modes == {}
    # The failed poll never touched the timestamp.
    assert coordinator.last_updated == updated_after_failure


async def test_failed_request_after_grace_expiry_resets_to_idle():
    player = FakePlayer()
    coordinator = make_coordinator(player)

    player.playing_info_responses = [
        video_info("/media/movies/old.mkv", 101, position=100000)
    ]
    player.audio_responses = [[{"index": 0, "title": "old-audio"}]]
    player.subtitle_responses = [[{"index": 0, "title": "old-sub"}]]
    player.zoom_responses = [{0: "Original"}]
    await poll(coordinator)

    # Persistent failure beyond MEDIA_STATUS_GRACE.
    player._keep_stale = False
    player.playing_info_responses = [None]
    await poll(coordinator)

    assert coordinator.state == MediaPlayerState.IDLE
    assert coordinator.media_info == {}
    assert coordinator.audio_tracks == []
    assert coordinator.subtitle_tracks == []
    assert coordinator.zoom_modes == {}
    assert coordinator.last_updated is None
    assert coordinator.media_type == MediaType.APP
    assert coordinator.source is None

    # Recovery starts clean: a fresh media repopulates everything.
    player.playing_info_responses = [
        video_info("/media/movies/new.mkv", 202, position=2000)
    ]
    player.audio_responses = [[{"index": 0, "title": "new-audio"}]]
    player.subtitle_responses = [[{"index": 0, "title": "new-sub"}]]
    player.zoom_responses = [{0: "Original"}]
    await poll(coordinator)

    assert coordinator.state == MediaPlayerState.PLAYING
    assert coordinator.media_info.get("uri") == "/media/movies/new.mkv"
    assert coordinator.audio_tracks == [{"index": 0, "title": "new-audio"}]
    assert coordinator.last_updated is not None


# ---------------------------------------------------------------------------
# Scenario 3: same path reload (pause then resume)
# ---------------------------------------------------------------------------


async def test_same_path_resume_keeps_progress_and_does_not_clear():
    player = FakePlayer()
    coordinator = make_coordinator(player)

    uri = "/media/movies/same.mkv"
    player.playing_info_responses = [
        video_info(
            uri,
            303,
            status=ZSTATE_PAUSED,
            position=45000,
            movie_name="Same Movie",
        )
    ]
    player.audio_responses = [[{"index": 0, "title": "audio"}]]
    player.subtitle_responses = [[{"index": 0, "title": "sub"}]]
    player.zoom_responses = [{0: "Original"}]
    await poll(coordinator)

    assert coordinator.state == MediaPlayerState.PAUSED
    assert coordinator.media_info["position"] == 45000
    tracks_before = (
        list(coordinator.audio_tracks),
        list(coordinator.subtitle_tracks),
        dict(coordinator.zoom_modes),
    )
    updated_before = coordinator.last_updated

    # Pause then resume the same file: same path and id, no clearing/refetch.
    player.playing_info_responses = [
        video_info(
            uri,
            303,
            status=ZSTATE_PLAYING,
            position=46000,
            movie_name="Same Movie",
        )
    ]
    await poll(coordinator)

    assert coordinator.state == MediaPlayerState.PLAYING
    assert coordinator.media_info.get("uri") == uri
    assert coordinator.media_info.get("id") == 303
    assert coordinator.media_info.get("movie_name") == "Same Movie"
    assert coordinator.audio_tracks == tracks_before[0]
    assert coordinator.subtitle_tracks == tracks_before[1]
    assert coordinator.zoom_modes == tracks_before[2]
    assert player.audio_calls == 1
    assert player.subtitle_calls == 1
    assert player.zoom_calls == 1
    # Position continues from the saved progress and the timestamp advances.
    assert coordinator.media_info["position"] == 46000
    assert coordinator.last_updated is not None
    assert coordinator.last_updated >= updated_before


async def test_position_updated_at_is_none_until_new_media_reports_position():
    player = FakePlayer()
    coordinator = make_coordinator(player)

    player.playing_info_responses = [
        video_info("/media/movies/old.mkv", 101, position=90000)
    ]
    player.audio_responses = [[{"index": 0}]]
    player.subtitle_responses = [[{"index": 0}]]
    player.zoom_responses = [{0: "Original"}]
    await poll(coordinator)
    assert coordinator.last_updated is not None

    # New media without a position yet (e.g. mid-switch payload).
    player.playing_info_responses = [
        video_info("/media/movies/new.mkv", 0, position=None)
    ]
    player.audio_responses = [[]]
    player.subtitle_responses = [[]]
    player.zoom_responses = [{}]
    await poll(coordinator)

    assert coordinator.media_info.get("position") is None
    assert coordinator.last_updated is None

    # And when the first position arrives, reporting resumes.
    player.playing_info_responses = [
        video_info("/media/movies/new.mkv", 202, position=4000)
    ]
    player.audio_responses = [[{"index": 0, "title": "new-audio"}]]
    player.subtitle_responses = [[{"index": 0}]]
    player.zoom_responses = [{0: "Original"}]
    await poll(coordinator)
    assert coordinator.media_info["position"] == 4000
    assert isinstance(coordinator.last_updated, datetime)
    assert coordinator.last_updated.tzinfo == timezone.utc


async def test_media_change_detection_helpers():
    player = FakePlayer()
    coordinator = make_coordinator(player)
    coordinator._last_media_uri = "/media/a.mkv"
    coordinator._last_media_id = 1

    assert coordinator._media_changed({"uri": "/media/b.mkv", "id": 1}) is True
    assert coordinator._media_changed({"uri": "/media/a.mkv", "id": 9}) is False
    coordinator._last_media_uri = None
    assert coordinator._media_changed({"uri": None, "id": 9}) is True
    assert coordinator._media_changed({"uri": None, "id": 1}) is False

    scrubbed = coordinator._clear_old_media_metadata(
        {
            "uri": "/x",
            "title": "x",
            "position": 1,
            "movie_name": "stale",
            "episode_name": "stale ep",
            "date": datetime(2020, 1, 1),
        }
    )
    assert "movie_name" not in scrubbed and "episode_name" not in scrubbed
    assert "date" not in scrubbed
    assert scrubbed["uri"] == "/x" and scrubbed["position"] == 1
