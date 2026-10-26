# Changelog

This file starts at the versions the public registries served on 2026-10-21. It does not restate earlier releases. A heading under "Current registry releases" is a package version that was already on npm or PyPI at that check. Registry check on 2026-10-26: `@vantio/cli` latest is 0.3.26 and `vantio-agent-sdk` latest is 3.1.2, both published from `vantioai/vantio-open-core`, not from this repository.

Merging a pull request does not publish.

## Current registry releases

### `@vantio/cli` 0.3.24

npm release. The registry `time.modified` value checked on 2026-10-21 was `2026-09-26T04:49:18.489Z`. License MIT. Node.js `>=18.3.0`.

The tarball metadata has registry signatures and no provenance attestation. This repository does not keep a separate changelog file beside the CLI. npm latest on 2026-10-26 is 0.3.26, published from `vantioai/vantio-open-core`, not from this repository. That release also has registry signatures and no provenance attestation.

### `@vantio/agent-sdk` 0.2.4

npm release. The registry `time.modified` value checked on 2026-10-21 was `2026-08-23T01:07:57.890Z`. License MIT. Node.js `>=18.0.0`. The source version matches 0.2.4. This package does not write `~/.vantio/runs`. Node records come from `vantio run` in `@vantio/cli`.

### `@vantio/optics-mcp` 0.1.2

npm release. The registry `time.modified` value checked on 2026-10-21 was `2026-08-23T01:07:59.870Z`. License MIT. Node.js `>=18.3.0`. The source version matches 0.1.2. It reads local run logs and does not enforce.

### `vantio-agent-sdk` 3.1.1

PyPI release. License MIT. Python `>=3.10`.

The package changelog in this tree records 3.1.1 as a publication of the 3.1.0 behavior line, with no SDK behavior change of its own. The 3.1.1 wheel was read on 2026-10-21:

- `vantio.__version__` is `3.1.1`.
- `vantio/_telemetry.py` matches this tree. The ping stays off unless `VANTIO_TELEMETRY=1`. `VANTIO_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` keep it off.
- `vantio/_outcome.py`, `vantio/_process_wrap.py`, and `vantio/sdk.py` match this tree.
- A run log written by the wheel sets `vantio_run_log` to `"1"`, `schema_version` to `2`, `schema_status` to `unstable-pre-1.0`, and `workflow` to `sight_loop`.
- `vantio/_http_observe.py` does not match this tree. This tree is 3.1.2 and that file is larger.

`vantio-agent-sdk==3.0.14` is still on PyPI. It is not the latest release. Pin `==3.1.2` for the current one. 3.1.2 was uploaded from `vantioai/vantio-open-core`, not from this repository.

## Same version in this tree

### `@vantio/cli` 0.3.26

`packages/vantio-cli/package.json`. On npm as 0.3.26. Published from `vantioai/vantio-open-core`, not from this repository.

### `vantio-agent-sdk` 3.1.2

`packages/vantio-agent-sdk-py`. On PyPI as 3.1.2. Uploaded from `vantioai/vantio-open-core`, not from this repository. The package changelog says a recorded call can append a live event and flag a first connection to a destination that is not on the allowlist. That heading does not upload a wheel or sdist.

### Editor extension 0.1.0

`extensions/vantio-optics`. Commands call the `vantio` binary. Not published as an npm package.
