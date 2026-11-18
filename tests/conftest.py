"""Pytest configuration for the Zidoo integration tests.

The integration targets Home Assistant, but the media-switching logic under
test lives in plain async classes. When Home Assistant is not installed in
the environment, minimal, behavior-faithful stand-ins for the handful of HA
symbols imported by the component are registered here so the tests run with
only ``aiohttp``/``yarl`` available. If real Home Assistant is installed it is
used unchanged.
"""

from __future__ import annotations

import sys
import types
from datetime import datetime, timezone
from pathlib import Path
from typing import Generic, TypeVar

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def _install_homeassistant_stubs() -> None:
    try:
        import homeassistant  # noqa: F401

        return  # real Home Assistant wins
    except ModuleNotFoundError:
        pass

    def module(name: str) -> types.ModuleType:
        mod = types.ModuleType(name)
        mod.__path__ = []  # mark as package so submodule imports work
        sys.modules[name] = mod
        return mod

    # homeassistant root + sub-packages
    ha = module("homeassistant")
    components = module("homeassistant.components")
    media_player = module("homeassistant.components.media_player")
    http = module("homeassistant.components.http")
    lovelace = module("homeassistant.components.lovelace")
    lovelace_const = module("homeassistant.components.lovelace.const")
    config_entries = module("homeassistant.config_entries")
    const = module("homeassistant.const")
    core = module("homeassistant.core")
    helpers = module("homeassistant.helpers")
    debounce = module("homeassistant.helpers.debounce")
    update_coordinator = module("homeassistant.helpers.update_coordinator")
    event = module("homeassistant.helpers.event")
    util = module("homeassistant.util")
    util_dt = module("homeassistant.util.dt")

    class MediaPlayerState:
        OFF = "off"
        ON = "on"
        PLAYING = "playing"
        PAUSED = "paused"
        IDLE = "idle"
        STANDBY = "standby"
        BUFFERING = "buffering"
        UNAVAILABLE = "unavailable"

    class MediaType:
        APP = "app"
        MUSIC = "music"
        MOVIE = "movie"
        TVSHOW = "tvshow"
        VIDEO = "video"
        ALBUM = "album"
        ARTIST = "artist"
        PLAYLIST = "playlist"
        TRACK = "track"
        GENRE = "genre"
        CHANNEL = "channel"
        IMAGE = "image"
        SEASON = "season"
        EPISODE = "episode"
        PODCAST = "podcast"
        URL = "url"

    class MediaClass:
        PLAYLIST = "playlist"
        ALBUM = "album"
        ARTIST = "artist"
        EPISODE = "episode"
        MOVIE = "movie"
        TV_SHOW = "tv_show"
        TRACK = "track"
        VIDEO = "video"
        DIRECTORY = "directory"
        IMAGE = "image"
        APP = "app"
        PODCAST = "podcast"
        URL = "url"
        MUSIC = "music"
        GENRE = "genre"
        CHANNEL = "channel"
        SEASON = "season"

    media_player.MediaPlayerState = MediaPlayerState
    media_player.MediaType = MediaType
    media_player.MediaClass = MediaClass

    class StaticPathConfig:
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs

    http.StaticPathConfig = StaticPathConfig
    lovelace_const.LOVELACE_DATA = "lovelace"

    class ConfigEntry:
        def __init__(
            self,
            entry_id="test-entry-id",
            title="Zidoo Test",
            data=None,
            options=None,
        ):
            self.entry_id = entry_id
            self.title = title
            self.data = data or {}
            self.options = options or {}

        def async_on_unload(self, func):
            return func

        async def add_update_listener(self, hass, listener):
            return None

    config_entries.ConfigEntry = ConfigEntry

    const.CONF_UNIQUE_ID = "unique_id"
    const.CONF_HOST = "host"
    const.CONF_MAC = "mac"

    class Platform:
        MEDIA_PLAYER = "media_player"
        REMOTE = "remote"
        SELECT = "select"

    const.Platform = Platform

    class HomeAssistant:
        pass

    core.HomeAssistant = HomeAssistant

    class Debouncer:
        """Minimal stand-in for homeassistant.helpers.debounce.Debouncer."""

        def __init__(
            self,
            hass,
            logger,
            *,
            cooldown=0,
            immediate=True,
            function=None,
        ):
            self.cooldown = cooldown
            self.immediate = immediate
            self.function = function

    debounce.Debouncer = Debouncer

    _CoordinatorDataT = TypeVar("_CoordinatorDataT")

    class DataUpdateCoordinator(Generic[_CoordinatorDataT]):
        """Minimal stand-in for HA's DataUpdateCoordinator.

        Only the surface exercised by the Zidoo coordinator and these tests is
        implemented; the scheduling machinery is omitted.
        """

        def __init__(
            self,
            hass,
            logger,
            *,
            name=None,
            update_interval=None,
            request_refresh_debouncer=None,
        ):
            self.hass = hass
            self.logger = logger
            self.name = name
            self.update_interval = update_interval
            self._debouncer = request_refresh_debouncer

        async def async_config_entry_first_refresh(self):
            return await self._async_update_data()

        async def async_refresh(self):
            return await self._async_update_data()

    update_coordinator.DataUpdateCoordinator = DataUpdateCoordinator

    async def async_call_later(*args, **kwargs):
        return None

    event.async_call_later = async_call_later

    def utcnow() -> datetime:
        return datetime.now(timezone.utc)

    util_dt.utcnow = utcnow

    # Wire up the parent/child relationships.
    ha.components = components
    components.media_player = media_player
    components.http = http
    components.lovelace = lovelace
    lovelace.const = lovelace_const
    ha.config_entries = config_entries
    ha.const = const
    ha.core = core
    ha.helpers = helpers
    helpers.debounce = debounce
    helpers.update_coordinator = update_coordinator
    helpers.event = event
    ha.util = util
    util.dt = util_dt


_install_homeassistant_stubs()
