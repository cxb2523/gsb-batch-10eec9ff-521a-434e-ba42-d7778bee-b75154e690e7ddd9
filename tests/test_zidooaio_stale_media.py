"""Tests for the stale-media handling in ZidooRC (zidooaio).

The client is driven entirely through a monkeypatched ``_req_json`` transport
with locally built response dictionaries, so no HTTP traffic or real device
is needed.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from custom_components.zidoo.zidooaio import (
    MEDIA_STATUS_GRACE,
    ZCONTENT_NONE,
    ZCONTENT_VIDEO,
    ZidooEndpoints,
    ZidooRC,
)

pytestmark = pytest.mark.asyncio


def make_client():
    client = ZidooRC("127.0.0.1")
    # Pretend the player is reachable without a real connection.
    client._cookies = {"session": "stub"}
    return client


def play_status_response(uri, *, playing=True, position=60000, duration=6_000_000):
    """Raw getPlayStatus payload as returned by the Zidoo firmware."""
    return {
        "status": 200,
        "video": {
            "status": 1 if playing else 2,
            "title": uri.rsplit("/", 1)[-1],
            "path": uri,
            "duration": duration,
            "currentPosition": position,
        },
    }


def poster_response(movie_id, name, *, media_type="movie"):
    """Raw getAggregationOfFile payload."""
    return {
        "type": media_type,
        "movie": {
            "id": movie_id,
            "name": name,
            "aggregation": {"tagLine": f"{name} tag"},
        },
    }


def install_transport(client, play_status=None, poster=None):
    """Route _req_json calls to scripted endpoint responses."""

    async def fake_req_json(url, params=None, log_errors=True, timeout=5, max_retries=0):
        if ZidooEndpoints.VIDEO_PLAY_STATUS in url:
            value = play_status.pop(0) if play_status else None
            return value
        if ZidooEndpoints.POSTER_AGGREGATION_FILE in url:
            value = poster.pop(0) if poster else None
            return value
        return None

    client._req_json = fake_req_json


async def test_transient_failure_returns_empty_within_grace_and_expires_after():
    client = make_client()
    now = datetime.now(timezone.utc)

    install_transport(
        client,
        play_status=[
            play_status_response("/media/movies/old.mkv", position=90000),
            None,  # timeout / empty while switching
            None,
        ],
        poster=[None, None],
    )
    client._get_music_playing_info = _async_return(None)
    client._get_music_playing_info_v2 = _async_return(None)

    # First poll: media is playing.
    info = await client.get_playing_info()
    assert info["uri"] == "/media/movies/old.mkv"
    assert client._current_source == ZCONTENT_VIDEO

    # Failure inside the grace window: empty result instead of the stale media,
    # while the coordinator retains state via _should_keep_stale_media().
    client._last_update = datetime.now(timezone.utc)
    info = await client.get_playing_info()
    assert info == {}
    assert client._current_source == ZCONTENT_NONE
    assert client._should_keep_stale_media() is True

    # After the grace period the stale media must no longer be retained.
    client._last_update = datetime.now(timezone.utc) - timedelta(
        seconds=MEDIA_STATUS_GRACE + 1
    )
    info = await client.get_playing_info()
    assert info == {}
    assert client._should_keep_stale_media() is False
    assert client._last_media_info == {}


async def test_old_movie_info_is_not_merged_onto_new_path():
    client = make_client()

    install_transport(
        client,
        play_status=[
            play_status_response("/media/movies/old.mkv"),
            play_status_response("/media/movies/new.mkv", position=2000),
        ],
        poster=[
            poster_response(101, "Old Movie"),
            None,  # new media's poster lookup has not completed yet
        ],
    )
    client._get_music_playing_info = _async_return(None)
    client._get_music_playing_info_v2 = _async_return(None)

    info = await client.get_playing_info()
    assert info["id"] == 101
    assert info["movie_name"] == "Old Movie"
    assert client._movie_info_uri == "/media/movies/old.mkv"

    # New path: its own lookup returned nothing, so the previous media's
    # cached metadata must not be attached to the new payload.
    info = await client.get_playing_info()
    assert info["uri"] == "/media/movies/new.mkv"
    assert info["id"] == 0
    assert "movie_name" not in info
    assert "tag" not in info
    # The lookup target is tracked but no metadata is cached for it yet.
    assert client._movie_info_uri == "/media/movies/new.mkv"
    assert client._movie_info == {}


async def test_same_path_resume_merges_its_own_metadata_and_keeps_progress():
    client = make_client()
    uri = "/media/movies/same.mkv"

    install_transport(
        client,
        play_status=[
            play_status_response(uri, playing=False, position=45000),
            play_status_response(uri, playing=True, position=46000),
        ],
        poster=[poster_response(303, "Same Movie")],
    )
    client._get_music_playing_info = _async_return(None)
    client._get_music_playing_info_v2 = _async_return(None)

    info = await client.get_playing_info()
    assert info["position"] == 45000
    assert info["id"] == 303
    assert info["movie_name"] == "Same Movie"
    assert client._movie_info_uri == uri

    # Resume the identical path: no second poster lookup, metadata still
    # belongs to this file and progress continues.
    info = await client.get_playing_info()
    assert info["uri"] == uri
    assert info["position"] == 46000
    assert info["movie_name"] == "Same Movie"
    assert info["id"] == 303
    assert client._movie_info_uri == uri


async def test_status_806_resets_cached_media(monkeypatch):
    client = make_client()

    async def fake_req_json(url, params=None, log_errors=True, timeout=5, max_retries=0):
        return {"status": 806}

    monkeypatch.setattr(client, "_req_json", fake_req_json)
    client._last_media_info = {"uri": "/media/movies/old.mkv", "id": 101}
    client._movie_info = {"movie_name": "Old Movie"}
    client._movie_info_uri = "/media/movies/old.mkv"
    client._last_update = datetime.now(timezone.utc)

    result = await client._get_video_playing_info()

    assert result is None
    assert client._last_update is None
    assert client._last_media_info == {}
    assert client._movie_info == {}
    assert client._movie_info_uri is None


async def test_should_keep_stale_media_bounds():
    client = make_client()

    # Nothing cached: never keep.
    assert client._should_keep_stale_media() is False

    client._last_media_info = {"uri": "/media/movies/old.mkv"}
    client._last_update = datetime.now(timezone.utc)
    assert client._should_keep_stale_media() is True

    client._last_update = datetime.now(timezone.utc) - timedelta(
        seconds=MEDIA_STATUS_GRACE + 5
    )
    assert client._should_keep_stale_media() is False

    # Naive datetimes (music player path) are treated as UTC.
    naive_now = datetime.now(timezone.utc).replace(tzinfo=None)
    client._last_update = naive_now
    assert client._should_keep_stale_media() is True


def _async_return(value):
    async def _stub(*args, **kwargs):
        return value

    return _stub
