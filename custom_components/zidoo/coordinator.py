"""Update coordinator for Zidoo Media Player integration."""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Final

from homeassistant.components.media_player import MediaPlayerState, MediaType
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_UNIQUE_ID
from homeassistant.core import HomeAssistant
from homeassistant.helpers.debounce import Debouncer
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.util.dt import utcnow

from .const import _LOGGER, CONF_POWERMODE, DOMAIN, EVENT_TURN_ON
from .zidooaio import ZCONTENT_MUSIC, ZCONTENT_VIDEO, ZSTATE_PLAYING, ZidooRC

SCAN_INTERVAL: Final = timedelta(seconds=5)
SCAN_INTERVAL_RAPID: Final = timedelta(seconds=1)


class ZidooCoordinator(DataUpdateCoordinator[None]):
    """Representation of a Zidoo Media Player Coordinator."""

    def __init__(
        self,
        hass: HomeAssistant,
        player: ZidooRC,
        config_entry: ConfigEntry,
    ) -> None:
        """Initialize the Zidoo device."""

        self._player = player
        self._config_entry = config_entry
        self._name = config_entry.title
        self._unique_id = config_entry.entry_id
        self._state = MediaPlayerState.OFF
        self._source = None
        self._source_list = []
        self._media_type = None
        self._media_info = {}
        self._last_update = None
        self._last_state = MediaPlayerState.OFF
        self._audio_output_list = []
        self._last_audio_output = None
        self._audio_tracks = []
        self._subtitle_tracks = []
        self._zoom_modes = {}
        # Identity of the media whose metadata/tracks are currently loaded.
        self._last_media_id = None
        self._last_media_uri = None
        # Identity for which the track/zoom lists were (re)loaded, plus the
        # number of retries while those lists came back empty.
        self._tracks_media_id = None
        self._track_attempts = 0
        self._max_track_attempts = 3

        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=SCAN_INTERVAL,
            request_refresh_debouncer=Debouncer(
                hass, _LOGGER, cooldown=1.0, immediate=False
            ),
        )

    async def async_refresh_audio_outputs(self, force=True):
        """Update audio output list."""
        if not force and not self._audio_output_list:
            audio_outputs = await self.player.load_audio_output_list()
            self._audio_output_list = []
            for key in audio_outputs:
                self._audio_output_list.append(key)

    async def async_refresh_channels(self, force=True):
        """Update source list."""
        if not force and not self._source_list:
            sources = await self.player.load_source_list()
            self._source_list = [ZCONTENT_VIDEO, ZCONTENT_MUSIC]
            for key in sources:
                self._source_list.append(key)

    def _reset_media(self) -> None:
        """Drop all media-bound state (metadata, tracks and zoom)."""
        self._media_info = {}
        self._media_type = MediaType.APP
        self._source = None
        self._audio_tracks = []
        self._subtitle_tracks = []
        self._zoom_modes = {}
        self._last_media_id = None
        self._last_media_uri = None
        self._tracks_media_id = None
        self._track_attempts = 0
        # No position belongs to the current media until a fresh one arrives.
        self._last_update = None

    def _media_changed(self, media_info: dict) -> bool:
        """Return True when the path or media id differs from the loaded one."""
        current_uri = media_info.get("uri")
        current_media_id = media_info.get("id")
        if current_uri is not None:
            return current_uri != self._last_media_uri
        # Some sources do not report a path: fall back to the media id.
        return current_media_id != self._last_media_id

    def _clear_old_media_metadata(self, media_info: dict) -> dict:
        """Remove cached poster/aggregation fields that belong to the old media."""
        stale_keys = (
            "movie_name",
            "tag",
            "date",
            "tmdb_id",
            "imdb_id",
            "episode",
            "episode_name",
            "season",
            "season_name",
            "series_name",
            "type",
        )
        return {
            key: value
            for key, value in media_info.items()
            if key not in stale_keys
        }

    async def _async_refresh_tracks(self, media_id: Any) -> None:
        """Load audio, subtitle and zoom lists for the current media.

        The lists must never be populated from a previous media. They are
        cleared first and only filled with data fetched for this media.
        Transient empty responses are retried a limited number of times.
        """
        if self._tracks_media_id == media_id and self._track_attempts >= self._max_track_attempts:
            return

        self._audio_tracks = []
        self._subtitle_tracks = []
        self._zoom_modes = {}
        self._tracks_media_id = media_id

        audio_tracks = await self.player.get_audio_list(log_errors=False)
        subtitle_tracks = await self.player.get_subtitle_list(log_errors=False)
        zoom_modes = await self.player.get_zoom_list()
        if audio_tracks:
            self._audio_tracks = audio_tracks
        if subtitle_tracks:
            self._subtitle_tracks = subtitle_tracks
        if zoom_modes:
            self._zoom_modes = zoom_modes

        if audio_tracks or subtitle_tracks or zoom_modes:
            # Lists loaded for this media: stop refetching on later polls.
            self._track_attempts = self._max_track_attempts
        else:
            # Transient empty response: retry the next few polls.
            self._track_attempts += 1

    async def _async_update_data(self) -> None:
        """Update data callback."""
        if not self.player.is_connected():
            await self.player.connect()

        # Retrieve the latest data.
        state = MediaPlayerState.OFF
        try:
            if self.player.is_connected():
                state = MediaPlayerState.PAUSED

                await self.async_refresh_audio_outputs(force=False)
                if self._audio_output_list:
                    self._last_audio_output = await self.player.get_audio_output()

                await self.async_refresh_channels(force=False)
                self._source = await self.player.get_source()
                playing_info = await self.player.get_playing_info()
                if playing_info is None or not playing_info:
                    # The request failed (empty response or timeout).
                    if self.player._should_keep_stale_media():
                        # Transient error: keep the last media and state for the
                        # grace period. Its identity is unchanged, so the track
                        # lists are still valid and must not be reassigned.
                        _LOGGER.debug("Keeping zidoo metadata for transient network error.")
                        if self._last_state in (MediaPlayerState.PLAYING, MediaPlayerState.PAUSED):
                            state = self._last_state
                        else:
                            state = MediaPlayerState.IDLE
                    else:
                        # Grace period elapsed: go idle and clear media info.
                        self._reset_media()
                        state = MediaPlayerState.IDLE
                else:
                    if playing_info.get("status") in (ZSTATE_PLAYING, True):
                        state = MediaPlayerState.PLAYING

                    mediatype = playing_info.get("source")
                    media_changed = self._media_changed(playing_info)
                    current_media_id = playing_info.get("id")
                    had_previous_media = (
                        self._last_media_uri is not None
                        or self._last_media_id is not None
                    )

                    if mediatype == "video":
                        item_type = playing_info.get("type")
                        if item_type is not None and item_type == "tv":
                            self._media_type = MediaType.TVSHOW
                        else:
                            self._media_type = MediaType.MOVIE
                        self._source = ZCONTENT_VIDEO

                        if media_changed and had_previous_media:
                            # Converge immediately: the previous media's
                            # metadata, tracks and zoom mode no longer apply.
                            # On the first load there is nothing to scrub.
                            _LOGGER.debug(
                                "Media changed (id %s -> %s); clearing previous media data.",
                                self._last_media_id,
                                current_media_id,
                            )
                            playing_info = self._clear_old_media_metadata(playing_info)
                            self._audio_tracks = []
                            self._subtitle_tracks = []
                            self._zoom_modes = {}
                            self._tracks_media_id = None
                            self._track_attempts = 0
                            # Do not reuse the old media's position timestamp:
                            # wait until this media reports its own position.
                            self._last_update = None

                        self._media_info = playing_info
                        self._last_media_uri = playing_info.get("uri")
                        self._last_media_id = current_media_id

                        # Only (re)fetch tracks for the media currently playing;
                        # empty responses are retried, never back-filled.
                        await self._async_refresh_tracks(current_media_id)

                    elif mediatype:
                        self._media_type = MediaType.MUSIC
                        self._source = ZCONTENT_MUSIC

                        if media_changed and had_previous_media:
                            # Music has no video tracks; drop any stale lists.
                            self._audio_tracks = []
                            self._subtitle_tracks = []
                            self._zoom_modes = {}
                            self._tracks_media_id = None
                            self._track_attempts = 0
                            self._last_update = None

                        self._media_info = playing_info
                        self._last_media_uri = playing_info.get("uri")
                        self._last_media_id = current_media_id
                    else:
                        self._media_type = MediaType.APP
                        self._media_info = playing_info
                        self._last_media_uri = playing_info.get("uri")
                        self._last_media_id = current_media_id

                    # A switched media without a position must not inherit the
                    # previous media's timestamp; stamp only when this media
                    # reports a position of its own (the switch block already
                    # cleared _last_update when needed).
                    if playing_info.get("position"):
                        self._last_update = utcnow()

        except Exception as ex:  # noqa: BLE001
            _LOGGER.debug("update error: {%s}", str(ex))
            return

        if state != self._last_state:
            _LOGGER.debug("%s New state (%s)", self._name, state)
            self._last_state = state
            self.update_interval = (
                SCAN_INTERVAL if state == MediaPlayerState.OFF else SCAN_INTERVAL_RAPID
            )
        self._state = state

    async def async_set_audio_output(self, audio_output: str) -> None:
        """Set audio output."""
        await self._player.set_audio_output(audio_output)

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Turn the media player on."""
        if self._state == MediaPlayerState.OFF:
            # Try 'zidoo.turn_on' event for automaton control
            data = kwargs.get("event_data", {CONF_UNIQUE_ID: self._unique_id})
            self.hass.bus.async_fire(EVENT_TURN_ON, data)
            # Try API and WOL
            await self._player.turn_on()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Turn off media player."""
        if self._state != MediaPlayerState.OFF:
            await self._player.turn_off(
                self._config_entry.options.get(CONF_POWERMODE, False)
            )

    @property
    def player(self):
        """Player Remote Control API Client."""
        return self._player

    @property
    def state(self):
        """State of device."""
        return self._state

    @property
    def media_type(self):
        """Type Current playing media."""
        return self._media_type

    @property
    def media_info(self):
        """Info of current playing media."""
        return self._media_info

    @property
    def audio_output(self):
        """Current audio_output."""
        output_list = self._audio_output_list
        return output_list[self._last_audio_output] if output_list else None

    @property
    def audio_output_list(self):
        """Audio outputs List."""
        return self._audio_output_list

    @property
    def source(self):
        """Current source."""
        return self._source

    @property
    def source_list(self):
        """Source List."""
        return self._source_list

    @property
    def last_updated(self):
        """Last state update."""
        return self._last_update

    @property
    def audio_tracks(self):
        """Audio tracks for the current video."""
        return self._audio_tracks

    @property
    def subtitle_tracks(self):
        """Subtitle tracks for the current video."""
        return self._subtitle_tracks

    @property
    def zoom_modes(self):
        """Zoom modes for the current video."""
        return self._zoom_modes