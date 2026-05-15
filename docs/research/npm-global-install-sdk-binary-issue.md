# npm Global Install: SDK Binary Resolution

## Problem

Starting with `@anthropic-ai/claude-agent-sdk@0.2.141`, the SDK no longer ships `cli.js`. Instead, the Claude Code binary is distributed via platform-specific optional packages:

- `@anthropic-ai/claude-agent-sdk-linux-x64`
- `@anthropic-ai/claude-agent-sdk-darwin-arm64`
- etc.

When NeoKai is installed globally (`npm install -g neokai`), the SDK binary is not available at startup. The previous resolution path only triggered on first user query, causing a noticeable delay (download + extraction of ~200 MB binary).

## Solution: Startup Warmup

NeoKai now resolves/downloads the SDK binary at daemon startup via `warmupSDKCliBinary()` in `packages/daemon/src/lib/agent/sdk-cli-resolver.ts`.

### Resolution Priority

1. **node_modules** — binary already installed (dev mode, or global install with optional deps)
2. **Cache** (`~/.neokai/sdk/claude-<version>-<platform>/claude`) — previously downloaded
3. **Download** — fetch platform package from npm registry, verify integrity (SHA-512), extract binary

### Behavior

- Warmup runs during daemon startup, after config/auth init, before WebSocket server binds.
- Non-fatal: daemon continues if download fails.
- `resolveSDKCliPath()` still retries on first query if warmup failed.
- No negative cache from warmup — query path can still succeed later.
- Mutex prevents race between warmup and first query.

### Logging

Startup logs always visible (not gated by `NEOKAI_VERBOSE`):

```
[SDK] Resolving Claude Code binary for @anthropic-ai/claude-agent-sdk-linux-x64 (SDK 0.2.141)
[SDK] Claude Code binary ready from cache: ~/.neokai/sdk/claude-0.2.141-linux-x64/claude (190.7 MB)
```

Or on first download:

```
[SDK] Resolving Claude Code binary for @anthropic-ai/claude-agent-sdk-linux-x64 (SDK 0.2.141)
[SDK] Downloading @anthropic-ai/claude-agent-sdk-linux-x64@0.2.141...
[SDK] Claude Code binary ready: ~/.neokai/sdk/claude-0.2.141-linux-x64/claude (199.9 MB)
```

## Container/Docker Guidance

For containerized deployments, pre-populate the cache to avoid download on every start:

```dockerfile
# In Dockerfile, after npm install -g neokai:
RUN mkdir -p ~/.neokai/sdk && \
    neokai --warmup-sdk || true
```

Or mount a persistent volume at `~/.neokai/sdk/` to cache the binary across container restarts.
