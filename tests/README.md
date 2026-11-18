# Zidoo integration tests

These tests cover the playback-information chain between
`custom_components/zidoo/zidooaio.py` (the API client) and
`custom_components/zidoo/coordinator.py` (the polling coordinator), in
particular the behaviour when the current media changes:

* `test_coordinator_media_switch.py` — switching movies / TV episodes,
  a failed playing-info request inside and after `MEDIA_STATUS_GRACE`,
  same-path resume (pause then continue), and position-timestamp handling.
* `test_zidooaio_stale_media.py` — the client's grace-period handling,
  poster-metadata isolation per video path, and the `806` reset.

The tests use locally constructed playing-info dictionaries and a scriptable
fake player; no real device or network access is required.

## Running

```bash
python -m pytest tests/
```

If Home Assistant is installed it is used directly. Otherwise `conftest.py`
registers minimal stand-ins for the handful of Home Assistant symbols the
component imports, so the suite also runs with only `aiohttp`, `yarl`,
`pytest` and `pytest-asyncio` available.
