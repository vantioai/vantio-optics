# Changelog

This file starts at the versions the public registries served on 2026-10-21. It does not restate earlier releases. A heading under "Current registry releases" is a package that was already on npm or PyPI. A heading under "In this tree, not on a registry" is source in this repository and is not a release.

Merging a pull request does not publish.

## Current registry releases

### `@vantio/cli` 0.3.24

npm release. The registry `time.modified` value checked on 2026-10-21 was `2026-09-26T04:49:18.489Z`. License MIT. Node.js `>=18.3.0`.

The tarball metadata has registry signatures and no provenance attestation. This repository does not keep a separate changelog file beside the CLI. Do not treat the 0.3.27 source in `packages/vantio-cli` as the npm package. `npm install -g @vantio/cli` installed 0.3.24 at the 2026-10-21 18:19 UTC check; npm latest is now 0.3.26 (from vantio-open-core).

### `@vantio/agent-sdk` 0.2.4

npm release. The registry `time.modified` value checked on 2026-10-21 was `2026-08-23T01:07:57.890Z`. License MIT. Node.js `>=18.0.0`. This tree is 0.2.5. This package does not write `~/.vantio/runs`. Node records come from `vantio run` in `@vantio/cli`.

### `@vantio/optics-mcp` 0.1.2

npm release. The registry `time.modified` value checked on 2026-10-21 was `2026-08-23T01:07:59.870Z`. License MIT. Node.js `>=18.3.0`. This tree is 0.1.3. It reads local run logs and does not enforce.

### `vantio-agent-sdk` 3.1.1

PyPI release. License MIT. Python `>=3.10`.

The package changelog in this tree records 3.1.1 as a publication of the 3.1.0 behavior line, with no SDK behavior change of its own. The 3.1.1 wheel was read on 2026-10-21:

- `vantio.__version__` is `3.1.1`.
- `vantio/_telemetry.py` matches this tree. The ping stays off unless `VANTIO_TELEMETRY=1`. `VANTIO_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` keep it off.
- `vantio/_outcome.py`, `vantio/_process_wrap.py`, and `vantio/sdk.py` match this tree.
- A run log written by the wheel sets `vantio_run_log` to `"1"`, `schema_version` to `2`, `schema_status` to `unstable-pre-1.0`, and `workflow` to `sight_loop`.
- `vantio/_http_observe.py` does not match this tree. This tree is 3.1.3 and that file is larger.

`vantio-agent-sdk==3.0.14` is still on PyPI. It is not the latest release. Pin `==3.1.2` for the current published package.

## In this tree, not on a registry

### `@vantio/cli` 0.3.27

`packages/vantio-cli/package.json`. First release number from this repository. 0.3.26 is live from `vantioai/vantio-open-core`.
CLI copy says 'AI' instead of 'AI agents'; package description updated.

### `@vantio/agent-sdk` 0.2.5

`packages/vantio-agent-sdk/package.json`. First release number from this repository. 0.2.4 is on npm.
Adds LICENSE to the package. No code change from 0.2.4 source.

### `@vantio/optics-mcp` 0.1.3

`packages/vantio-optics-mcp/package.json`. First release number from this repository. 0.1.2 is on npm.
Adds LICENSE; upgrade-path copy names Phantom Engine and Enterprise instead of Gate; server.json description updated.

### `vantio-agent-sdk` 3.1.3

`packages/vantio-agent-sdk-py`. First release number from this repository. 3.1.2 is live from `vantioai/vantio-open-core`. The 3.1.2 package changelog says a recorded call can append a live event and flag a first connection to a destination that is not on the allowlist. That heading does not upload a wheel or sdist.

### Editor extension 0.1.0

`extensions/vantio-optics`. Commands call the `vantio` binary. Not published as an npm package.
