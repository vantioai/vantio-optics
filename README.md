# Vantio Optics

**Linux security for AI.**

See what AI is doing on your Linux systems. That includes your own AI acting on its own or in swarms, and outside AI with malicious intent coming in.

Optics records destination, process, size, and timing for supported calls. Prompts and completions are not stored. Optics does not block, redact, or enforce. When you need enforcement on Linux systems you enroll, pair Optics with [Phantom Engine](https://vantio.ai/phantom-engine).

Free Optics needs no account and no API key.

## Install

These versions are what the public registries returned on 2026-10-21. Pin them. An unpinned install follows whatever the registry marks latest later.

| Package | Registry | Version | Install |
| --- | --- | --- | --- |
| `@vantio/cli` | npm | 0.3.24 | `npm install -g @vantio/cli@0.3.24` |
| `vantio-agent-sdk` | PyPI | 3.1.1 | `pip install 'vantio-agent-sdk==3.1.1'` |
| `@vantio/agent-sdk` | npm | 0.2.4 | `npm install @vantio/agent-sdk@0.2.4` |
| `@vantio/optics-mcp` | npm | 0.1.2 | `npx -y @vantio/optics-mcp@0.1.2` |

`@vantio/cli` needs Node.js `>=18.3.0`. `vantio-agent-sdk` needs Python `>=3.10`. There is no installer at `https://vantio.ai/install.sh`.

This git tree is ahead of the registries in two places: `@vantio/cli` here is **0.3.26**, and `vantio-agent-sdk` here is **3.1.2**. Those are not the packages the commands above install. Use the registry pins for a published install. Build from this tree only when you mean to run this source.

## Quick start

```bash
npm install -g @vantio/cli@0.3.24
vantio --version
vantio run node agent.js
vantio discover --local
vantio prove --format=md
```

`vantio run` records supported Node calls (`node`, `npx`, `tsx`, `ts-node`) through the Node HTTP stack. It does not by itself record Python.

```bash
pip install 'vantio-agent-sdk==3.1.1'
vantio run python agent.py
```

Without `vantio-agent-sdk` on that interpreter, `vantio run python` does not intercept. You can also call `shield()` from the Python package. The Node package `@vantio/agent-sdk` provides a trace helper. It does not write `~/.vantio/runs`. Node records come from `vantio run`.

`@vantio/optics-mcp` reads local run logs. It has no enforcement tools.

The editor extension in `extensions/vantio-optics` wraps the same CLI commands. It is not an npm package.

## Phantom Engine

Optics is the observe path. [Phantom Engine](https://vantio.ai/phantom-engine) is enforcement and runtime protection for Linux systems you enroll. Optics does not enroll a system and does not apply policy. A call Optics did not record was not observed. That absence is not a block.

## Docs

- [Install and versions](docs/products/optics/INSTALLATION.md)
- [Quickstart](docs/products/optics/QUICKSTART.md)
- [Public manual](docs/products/optics/README.md)
- [Publishing](docs/publishing.md) (manual, disabled)

## Links

- [vantio.ai](https://vantio.ai)
- [vantio.ai/optics](https://vantio.ai/optics)
- [vantio.ai/docs](https://vantio.ai/docs)
- [Phantom Engine](https://vantio.ai/phantom-engine)

## License

MIT. Copyright (c) 2026 Vantio AI, Inc. See [LICENSE](LICENSE).
