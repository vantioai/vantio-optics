# Contributing to Vantio Optics

Vantio Optics is Linux security for AI: see what AI is doing on your Linux systems. This repository holds the public Optics packages.

| Path | Package |
| --- | --- |
| `packages/vantio-cli` | `@vantio/cli` on npm. Published version on 2026-10-21: `0.3.24`. This tree: `0.3.27`. |
| `packages/vantio-agent-sdk-py` | `vantio-agent-sdk` on PyPI. Published version on 2026-10-21: `3.1.1`. This tree: `3.1.3`. |
| `packages/vantio-agent-sdk` | `@vantio/agent-sdk` on npm. Published version on 2026-10-21: `0.2.4`. This tree: `0.2.5`. |
| `packages/vantio-optics-mcp` | `@vantio/optics-mcp` on npm. Published version on 2026-10-21: `0.1.2`. This tree: `0.1.3`. |
| `extensions/vantio-optics` | Editor extension. Not an npm package. |

Phantom Engine stays outside this repository. Do not add enforcement, kernel code, or lab material here. Product page: https://vantio.ai/phantom-engine.

## Development

pnpm is the package manager for the JavaScript workspace. The root `packageManager` field pins the version.

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```

CLI tests require `strace` on the machine. Python tests:

```bash
python3 -m pip install --disable-pip-version-check requests httpx aiohttp urllib3 build
python3 -m unittest discover -s packages/vantio-agent-sdk-py/tests -t packages/vantio-agent-sdk-py -v
```

Run the CLI from source with `node packages/vantio-cli/bin/vantio.js`. That binary is this tree's version, not the npm release.

## Review rules

- Do not add the TypeScript `any` type. Use `unknown` and narrow it.
- Do not put prompts, completions, or other linguistic content into telemetry.
- Do not commit `package-lock.json` or `yarn.lock`.
- Do not add eBPF, kernel probes, `/sys/fs/bpf/` references, or imports from a Phantom Engine repository.

Publishing is documented in [docs/publishing.md](docs/publishing.md). Do not dispatch the publish workflow from a pull request.
