# Web Search MCP Skill

## Overview

The Web Search MCP skill provides agents with web search capability via a Brave Search MCP server.
It is registered as a built-in opt-in skill at daemon startup (disabled by default).

## Chosen Server: Brave Search MCP

**Package:** `@modelcontextprotocol/server-brave-search`

**Why Brave Search:**
- Official MCP package maintained by the MCP project
- Fast, privacy-focused search API
- Simple API key authentication via `BRAVE_API_KEY` env var
- No complex OAuth flows

**Alternatives considered:**
- **Tavily MCP** (`tavily-mcp`) — good quality results but requires paid plan sooner
- **DuckDuckGo MCP** — no API key required but unofficial, limited results

## Configuration

The skill is registered in `SkillsManager.initializeBuiltins()` as an `mcp_server` type skill.

### app_mcp_servers entry

```
name:        web-search-brave
sourceType:  stdio
command:     npx
args:        ["-y", "@modelcontextprotocol/server-brave-search"]
enabled:     true
```

### Skill entry

```
name:         web-search-mcp
displayName:  Web Search (MCP)
sourceType:   mcp_server
config:       { type: "mcp_server", appMcpServerId: <id of web-search-brave entry> }
enabled:      false   (opt-in)
builtIn:      true
```

## Usage

1. Obtain a Brave Search API key from https://brave.com/search/api/
2. Set `BRAVE_API_KEY` in the daemon environment (`.env` or shell)
3. Enable the skill in the Skills settings UI
4. The MCP server is automatically injected into new session `mcpServers`

## Session Injection

When the skill is enabled, `QueryOptionsBuilder` includes the backing `app_mcp_servers` entry
in the `mcpServers` array passed to the SDK. The SDK then spawns the `npx` process and exposes
the `brave_web_search` tool to the agent.

## Security

- The MCP server runs as a local stdio subprocess — no inbound network exposure
- `BRAVE_API_KEY` is read from the server environment, not stored in the database
- The skill is `builtIn: true` so users cannot delete it, only enable/disable it
