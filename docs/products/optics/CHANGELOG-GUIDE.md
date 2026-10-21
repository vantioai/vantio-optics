# Changelog guide

This manual is version 1. It is a docs set. It does not bump `@vantio/cli`, `vantio-agent-sdk`, or any other package.

## Which history to read

| You installed | Read |
| --- | --- |
| `@vantio/cli@0.3.24` | The published CLI is 0.3.24. Node pages that do not name a later source version match that package. This tree is 0.3.26. |
| `vantio-agent-sdk==3.1.1` | [PYTHON-GUIDE.md](PYTHON-GUIDE.md) for the current PyPI release. |
| `vantio-agent-sdk==3.0.14` | The 3.0.14 sections of [PYTHON-GUIDE.md](PYTHON-GUIDE.md). That pin is older than PyPI latest. |
| A checkout of this repository | `pyproject.toml` says 3.1.2. That string is source. `pip install` does not install it. |

Package changelogs live next to the packages (`packages/vantio-agent-sdk-py/CHANGELOG.md`). This repository's history starts fresh and does not contain the older release tags. When a changelog line and the published package disagree, the published package wins.

## How to read the Python changelog without over-claiming

`3.0.14` is a packaging-metadata release. SDK behavior relative to 3.0.13 is unchanged. The telemetry gate in that tag sends from `shield()` unless `VANTIO_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`.

`3.0.15` in git is a documentation and gate correction that makes Python telemetry opt-in. Its changelog text says the payload schema is unchanged and also says telemetry stays off unless `VANTIO_TELEMETRY=1`. The gate change is real in that commit. The release was not what PyPI served. Do not tell operators that 3.0.15 is installed.

`3.1.0` records HTTP outcome fields, `ok` aligned to status, socket timing, and the opt-in telemetry gate. PyPI 3.1.1 is that behavior line. CLI 0.3.24 was not rebuilt to match later customer sentences. This tree's Python package is 3.1.2, which is not the PyPI release.

## CLI history that still affects support

`0.3.24` is the current public CLI. It is free, local, and account-free. `vantio login` is not part of the help surface. `vantio logout` only deletes a leftover `config.json`.

Command `--json` output includes `schema_status` `unstable-pre-1.0`. That line means the JSON may change. It does not mean the Node run file contains `schema_status`. The Node run file does not.

## Manual changes

| Manual version | Meaning |
| --- | --- |
| 1 | Public manual under `docs/products/optics/`. Registry check 2026-10-21: CLI 0.3.24 and PyPI Python 3.1.1. This tree is CLI 0.3.26 and Python 3.1.2. |

When a later manual version is cut, it should name the registry versions it was checked against. Keep published versions and source versions in separate columns.

## Words that changed

The product name in this manual is Vantio Optics. Older package summaries contain the phrase Sight Loop. Published Python run files still store `workflow` `sight_loop`. Support should recognize the string and should not use it as the name of the product.

Gate is an internal name for enforcement functions inside Phantom Engine. It is not a current standalone public SKU. This manual does not document it as something to install.
