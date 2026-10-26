# @vantio/optics-mcp

**Vantio Optics** MCP server — read-only **Observe** for AI and editors.

This MCP lists local run logs, inspects traffic metadata, exports proofs, and discovers destinations. It **cannot** enforce policy. When you need to block, redact, or cap spend on the wrapped path, upgrade to **Vantio Phantom Engine**. When you need protection on Linux systems you enroll, Phantom Engine covers both Enforce and Control.

> Blind by design: no prompts or completions. Fence: observe only.

## Install

```bash
# from this repository
pnpm install --filter @vantio/optics-mcp

# npm latest checked 2026-10-26: 0.1.2. This directory is 0.1.3 (not yet published).
npm install -g @vantio/optics-mcp@0.1.2
```

Generate Optics traffic first (optional but recommended):

```bash
npm install -g @vantio/cli@0.3.24
vantio run node your-agent.js
```

## Cursor / Claude Desktop config

```json
{
  "mcpServers": {
    "vantio-optics": {
      "command": "npx",
      "args": ["-y", "@vantio/optics-mcp"]
    }
  }
}
```

Local checkout:

```json
{
  "mcpServers": {
    "vantio-optics": {
      "command": "node",
      "args": [
        "/absolute/path/to/vantio-optics/packages/vantio-optics-mcp/bin/vantio-optics-mcp.js"
      ]
    }
  }
}
```

## Tools (observe only)

| Tool | Purpose |
|------|---------|
| `optics_list_runs` | List `~/.vantio/runs` |
| `optics_get_run` | Load one run (metadata only) |
| `optics_prove` | Markdown Sight Loop proof |
| `optics_discover_local` | Aggregate hosts from local logs |
| `optics_explain` | Optics privacy + fence |
| `optics_upgrade_path` | Ladder → Phantom Engine → Enterprise |

## Upgrade path

1. **Optics** (free, this MCP) — observe only
2. **Phantom Engine** (self-serve, per server: https://vantio.ai/pricing) — Observe, Enforce, and Control in one purchase
3. **Enterprise** (Contact Vantio) — governance add-on

https://vantio.ai/pricing

## License

MIT · Vantio AI, Inc.
