# Installation

Free Optics needs no account and no API key. The CLI does not read a saved key from `~/.vantio/config.json` when it starts a run.

## CLI

| Item | Value |
| --- | --- |
| Package | `@vantio/cli` |
| Public version | `0.3.24` (npm latest on 2026-10-21) |
| Source in this commit | `0.3.26`, not the npm package |
| Command | `vantio` |
| Engine | Node.js `>=18.3.0` |
| License | MIT |

```bash
# Example status: illustrative
npm install -g @vantio/cli@0.3.24
vantio --version
```

The package bins `vantio` to `bin/vantio.js`. Works on macOS, Linux, and Windows (WSL) as stated by the CLI README. The run-file mode bits below are Unix modes. The writers do not set a Windows ACL. See [PRIVACY-AND-SECURITY.md](PRIVACY-AND-SECURITY.md).

There is no curl installer at `https://vantio.ai/install.sh`.

`vantio status --check-registry` asks the npm registry for the latest `@vantio/cli` version. Plain `vantio status` does not.

## Python SDK

| Item | Value |
| --- | --- |
| Package | `vantio-agent-sdk` |
| Public version | `3.1.1` (PyPI latest on 2026-10-21) |
| Source in this commit | `3.1.2`, not the PyPI package |
| Interpreter | Python `>=3.10` |
| License | MIT |

```bash
# Example status: illustrative
pip install 'vantio-agent-sdk==3.1.1'
python -c 'import vantio; print(vantio.__version__)'
```

The printed version on a fresh PyPI install is `3.1.1`. If you are working from this git tree, `vantio.__version__` is `3.1.2`. Those are different files for `vantio/_http_observe.py`. Telemetry in the 3.1.1 wheel matches this tree: off unless `VANTIO_TELEMETRY=1`. Read [PYTHON-GUIDE.md](PYTHON-GUIDE.md) before you describe HTTP outcomes.

Pin `==3.1.1` for the current published package. An unpinned `pip install vantio-agent-sdk` resolved to 3.1.1 on the registry check for this manual. It will follow PyPI whenever a later release is published. `vantio-agent-sdk==3.0.14` remains available if you pin that older release.

## Node SDK

| Item | Value |
| --- | --- |
| Package | `@vantio/agent-sdk` |
| Public version | `0.2.4` |
| Engine | Node.js `>=18.0.0` |

```bash
# Example status: illustrative
npm install @vantio/agent-sdk@0.2.4
```

This package does not write `~/.vantio/runs`. Recording for Node is the CLI interceptor started by `vantio run`. Use the Node SDK only when you need its trace helper. Control-plane helpers in that package are outside free Optics and are not documented here.

## Read-only MCP

| Item | Value |
| --- | --- |
| Package | `@vantio/optics-mcp` |
| Public version | `0.1.2` |
| Role | Read local run logs. No enforcement tools. |

```bash
# Example status: illustrative
npx -y @vantio/optics-mcp@0.1.2
```

The npm description text still contains an older product phrase. This manual's name for the product is Vantio Optics. Tools in the 0.1.2 server include `optics_list_runs`, `optics_get_run`, `optics_prove`, `optics_discover_local`, `optics_explain`, and `optics_upgrade_path`. The upgrade tool points at Phantom Engine. This manual does not reproduce Phantom Engine setup.

The MCP reader honors `VANTIO_HOME`. The CLI reader does not. See [RECORD-REFERENCE.md](RECORD-REFERENCE.md).

The package version is 0.1.2. The server constructor in this source tree reports version `0.1.0` on the MCP server object. Use the package version when you talk about what npm installed.

## What install does not do

- It does not start a daemon.
- It does not create a SQLite database.
- It does not enroll a Linux system in Phantom Engine.
- It does not turn on telemetry for the CLI. CLI telemetry stays off until `VANTIO_TELEMETRY=1`.
- It does not change the telemetry gate. Published CLI 0.3.24 and Python 3.1.1 stay off until `VANTIO_TELEMETRY=1`. See [TELEMETRY.md](TELEMETRY.md).

Removal steps: [UPGRADE-ROLLBACK-UNINSTALL.md](UPGRADE-ROLLBACK-UNINSTALL.md).
