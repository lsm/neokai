# Dev Proxy Integration for Claude Agent SDK

This document describes how to configure Dev Proxy to mock the Anthropic API for the NeoKai test suite.

## Overview

Dev Proxy is a Microsoft tool that intercepts HTTP requests and can return mock responses. This allows us to run online tests without calling the real Anthropic API, improving test stability and reducing costs.

**Sample Reference:** [pnp/proxy-samples - simulate-anthropic](https://github.com/pnp/proxy-samples/tree/main/samples/simulate-anthropic)

## How the Claude Agent SDK Makes HTTP Requests

Understanding the SDK's HTTP behavior is crucial for proxy integration:

### Architecture

1. **NeoKai Daemon** calls `query()` from `@anthropic-ai/claude-agent-sdk`
2. **SDK** spawns a **CLI subprocess** (using Node.js or Bun)
3. **CLI subprocess** makes HTTP requests to `api.anthropic.com` using undici (Node.js's built-in HTTP client)
4. The subprocess **inherits environment variables** from the parent process

### Key Code Paths

```
QueryRunner.runQuery()
    └── providerService.applyEnvVarsToProcess()  // Sets process.env before SDK call
    └── query({ options: { env: mergedEnv } })   // SDK spawns subprocess
        └── Subprocess inherits process.env + options.env
            └── Makes HTTP requests to api.anthropic.com
```

**Important Files:**
- `packages/daemon/src/lib/agent/query-runner.ts` - SDK query execution
- `packages/daemon/src/lib/agent/query-options-builder.ts` - Builds SDK options including env vars
- `packages/daemon/src/lib/provider-service.ts` - Process-level env var management

### Known Issues

Per [GitHub Issue #169](https://github.com/anthropics/claude-agent-sdk-typescript/issues/169), there's a known bug where `HTTP_PROXY`/`HTTPS_PROXY` environment variables don't work with undici's ProxyAgent dispatcher.

**Workaround:** Use `NODE_USE_ENV_PROXY=1` environment variable (Node.js 18+) or `--use-env-proxy` flag.

## Environment Variables for Proxy Configuration

### Required Environment Variables

| Variable | Value | Purpose |
|----------|-------|---------|
| `HTTPS_PROXY` | `http://127.0.0.1:8000` | Route HTTPS requests through Dev Proxy |
| `HTTP_PROXY` | `http://127.0.0.1:8000` | Route HTTP requests through Dev Proxy |
| `NODE_USE_ENV_PROXY` | `1` | Enable Node.js to respect proxy env vars |

### Certificate Trust Variables (choose one)

| Variable | Value | Purpose |
|----------|-------|---------|
| `NODE_EXTRA_CA_CERTS` | Path to Dev Proxy CA cert | Trust Dev Proxy's SSL certificate |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `0` | Disable TLS verification (development only!) |

### Optional Variables

| Variable | Value | Purpose |
|----------|-------|---------|
| `NO_PROXY` | `localhost,127.0.0.1` | Bypass proxy for local addresses |

## Dev Proxy Configuration

### Directory Structure

```
tests/dev-proxy/
├── devproxyrc.json    # Main configuration
├── mocks.json         # Mock response definitions
└── certs/             # Dev Proxy certificates (auto-generated)
```

### devproxyrc.json

```json
{
  "$schema": "https://raw.githubusercontent.com/dotnet/dev-proxy/main/schemas/v2.1.0/rc.schema.json",
  "plugins": [
    {
      "name": "MockResponsePlugin",
      "enabled": true,
      "pluginPath": "~appFolder/plugins/DevProxy.Plugins.dll",
      "configSection": "anthropicMocks"
    }
  ],
  "urlsToWatch": [
    "https://api.anthropic.com/*"
  ],
  "anthropicMocks": {
    "$schema": "https://raw.githubusercontent.com/dotnet/dev-proxy/main/schemas/v2.1.0/mockresponseplugin.schema.json",
    "mocksFile": "mocks.json"
  },
  "logLevel": "information",
  "port": 8000
}
```

### mocks.json

```json
{
  "$schema": "https://raw.githubusercontent.com/dotnet/dev-proxy/main/schemas/v2.1.0/mockresponseplugin.mocksfile.schema.json",
  "mocks": [
    {
      "request": {
        "url": "https://api.anthropic.com/v1/messages",
        "method": "POST"
      },
      "response": {
        "statusCode": 200,
        "headers": [
          { "name": "content-type", "value": "application/json" },
          { "name": "anthropic-ratelimit-requests-limit", "value": "50" },
          { "name": "anthropic-ratelimit-requests-remaining", "value": "49" }
        ],
        "body": {
          "id": "msg_test123",
          "type": "message",
          "role": "assistant",
          "content": [
            {
              "type": "text",
              "text": "This is a mock response from Dev Proxy."
            }
          ],
          "model": "claude-sonnet-4-20250514",
          "stop_reason": "end_turn",
          "stop_sequence": null,
          "usage": {
            "input_tokens": 12,
            "output_tokens": 48,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "service_tier": "standard"
          }
        }
      }
    }
  ]
}
```

## Installation

### macOS (Homebrew)

```bash
brew tap dotnet/dev-proxy
brew install dev-proxy
```

### Other Platforms

See [Dev Proxy Setup Guide](https://learn.microsoft.com/en-us/microsoft-cloud/dev/dev-proxy/get-started/set-up)

## Running Dev Proxy

### Start Dev Proxy

```bash
cd tests/dev-proxy
devproxy
```

### Verify Proxy is Working

```bash
curl -ikx http://127.0.0.1:8000 https://api.anthropic.com/v1/messages \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}' \
  -H "content-type: application/json" \
  -H "x-api-key: test-key" \
  -H "anthropic-version: 2023-06-01"
```

## Integration with Tests

### Test Setup

To run tests with Dev Proxy, set the following environment variables:

```bash
# Enable proxy for tests
export HTTPS_PROXY=http://127.0.0.1:8000
export HTTP_PROXY=http://127.0.0.1:8000
export NODE_USE_ENV_PROXY=1

# Trust Dev Proxy's certificate (obtain path from `devproxy --help`)
export NODE_EXTRA_CA_CERTS=~/.proxy/rootCA.pem

# Run tests
NEOKAI_TEST_ONLINE=true bun test packages/daemon/tests/online/
```

### Integration with NeoKai Codebase

The NeoKai daemon applies provider environment variables to `process.env` before SDK query creation via `providerService.applyEnvVarsToProcess()`. The SDK subprocess inherits these variables.

**Current provider env vars** (managed by `ProviderService`):
- `ANTHROPIC_BASE_URL` - API endpoint override
- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` - Authentication
- `ANTHROPIC_DEFAULT_*_MODEL` - Model tier mappings
- `API_TIMEOUT_MS` - Request timeout
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` - Disable telemetry

**To add proxy support**, we need to ensure `HTTP_PROXY` and `HTTPS_PROXY` are:
1. Set in the test environment
2. Not filtered out by `getMergedEnvironmentVars()` (they aren't provider-specific vars)
3. Inherited by the SDK subprocess

## Certificate Management

### Getting Dev Proxy's Certificate

Dev Proxy generates a root CA certificate. Location varies by platform:

- **macOS/Linux:** `~/.proxy/rootCA.pem`
- **Windows:** `%USERPROFILE%\.proxy\rootCA.pem`

### Trusting the Certificate

**Option 1: NODE_EXTRA_CA_CERTS (Recommended)**

```bash
export NODE_EXTRA_CA_CERTS=~/.proxy/rootCA.pem
```

**Option 2: System Trust Store (macOS)**

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.proxy/rootCA.pem
```

**Option 3: Disable TLS Verification (Development Only!)**

```bash
export NODE_TLS_REJECT_UNAUTHORIZED=0
```

⚠️ **Warning:** Option 3 disables TLS verification entirely. Only use in isolated development environments.

## Limitations and Workarounds

### 1. SDK Proxy Bug

The Claude Agent SDK has a [known issue](https://github.com/anthropics/claude-agent-sdk-typescript/issues/169) where proxy environment variables may not work with undici.

**Workaround:** Set `NODE_USE_ENV_PROXY=1` to enable Node.js native proxy support.

### 2. Streaming Responses

Dev Proxy's `MockResponsePlugin` returns static responses. For streaming (SSE) responses, you may need to:

1. Create custom mock files with SSE format
2. Use Dev Proxy's `LatencyPlugin` to simulate streaming delays
3. Consider using a custom plugin for dynamic responses

### 3. Request Matching

Dev Proxy matches requests by URL and method. For different responses based on request body:

1. Use the `body` property in mock configuration
2. Create multiple mock entries with different match conditions
3. Use Dev Proxy's dynamic mock capabilities

## Advanced Configuration

### Simulating Rate Limits

Add the `RateLimitingPlugin` to simulate API rate limits:

```json
{
  "name": "RateLimitingPlugin",
  "enabled": true,
  "pluginPath": "~appFolder/plugins/DevProxy.Plugins.dll",
  "configSection": "rateLimiting"
}
```

### Simulating Latency

Add the `LatencyPlugin` to simulate slow responses:

```json
{
  "name": "LatencyPlugin",
  "enabled": true,
  "pluginPath": "~appFolder/plugins/DevProxy.Plugins.dll",
  "configSection": "latency"
}
```

### Multiple Mock Scenarios

Create different mock files for different test scenarios:

```
tests/dev-proxy/
├── mocks/
│   ├── basic-response.json
│   ├── tool-use-response.json
│   ├── error-response.json
│   └── streaming-response.json
└── devproxyrc.json
```

Switch mocks by updating `mocksFile` in configuration or using presets.

## References

- [Dev Proxy Documentation](https://learn.microsoft.com/en-us/microsoft-cloud/dev/dev-proxy/)
- [MockResponsePlugin Reference](https://learn.microsoft.com/en-us/microsoft-cloud/dev/dev-proxy/technical-reference/mockresponseplugin)
- [Simulate Anthropic API Sample](https://github.com/pnp/proxy-samples/tree/main/samples/simulate-anthropic)
- [Node.js Enterprise Network Configuration](https://nodejs.org/en/learn/http/enterprise-network-configuration)
- [SDK Proxy Issue #169](https://github.com/anthropics/claude-agent-sdk-typescript/issues/169)
