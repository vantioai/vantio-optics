# Vantio Optics MCP

Part of **Vantio Optics** (observe and explain through the Model Context Protocol).

Package: [`@vantio/optics-mcp`](../packages/vantio-optics-mcp/)

## What it is

A **read-only** MCP server so editors can:

- List and inspect local Optics run logs (`~/.vantio/runs`)
- Export Markdown proofs (no prompts/completions)
- Discover LLM hosts from local logs
- Explain Optics and the upgrade ladder to Phantom Engine / Enterprise

## What it is not

- Not Vantio Phantom Engine Enforce — cannot block, redact, or turn policy on
- Not Phantom Engine protection for Linux systems — no kernel-level tools
- Not a content store — blind by design

Agents that outgrow observe call `optics_upgrade_path` and move to Phantom Engine or Enterprise.

## Quick start

```bash
cd packages/vantio-optics-mcp
pnpm install
pnpm test
node bin/vantio-optics-mcp.js   # stdio MCP
```

Or: `npx -y @vantio/optics-mcp@0.1.3` (this tree). npm latest on 2026-10-21 was 0.1.2.

## Cursor / Claude Desktop

```json
{
  "mcpServers": {
    "vantio-optics": {
      "command": "npx",
      "args": ["-y", "@vantio/optics-mcp@0.1.3"]
    }
  }
}
```

Local checkout — point `command` at `node` and `args` at  
`…/packages/vantio-optics-mcp/bin/vantio-optics-mcp.js`.

## Tools

| Tool | Purpose |
|------|---------|
| `optics_list_runs` | List `~/.vantio/runs` |
| `optics_get_run` | One run (metadata only) |
| `optics_prove` | Markdown Optics proof |
| `optics_discover_local` | Hosts from local logs |
| `optics_explain` | Optics privacy + fence |
| `optics_upgrade_path` | Ladder → Phantom Engine → Enterprise |

Full package notes: [packages/vantio-optics-mcp/README.md](../packages/vantio-optics-mcp/README.md).
