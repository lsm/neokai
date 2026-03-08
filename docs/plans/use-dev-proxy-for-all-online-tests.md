# Plan: Use Dev Proxy for All Online Tests

**Created:** March 2026
**Updated:** March 2026

## Goal

Use Microsoft Dev Proxy for all online tests that don't require real AI API calls. The internal mock SDK has been removed, and Dev Proxy is now the standard approach for offline testing.

### Current Status

**Completed:**
- Task 1: Research Dev Proxy integration ✅
- Task 2: Set up Dev Proxy infrastructure ✅
- Task 3: Create mock response files ✅
- Task 4: Create test helper ✅

**In Progress:**
- Task 5: Convert daemon tests to use Dev Proxy
- Task 6: Validate and measure improvements

### Scope

**Tests now requiring real API or Dev Proxy:**
- `rewind-feature.test.ts`
- `selective-rewind.test.ts`
- `session-resume.test.ts`
- `message-persistence.test.ts`
- `message-delivery-mode-queue.test.ts`
- `agent-session-sdk.test.ts`
- `room-chat-constraints.test.ts`
- `multiturn-conversation.test.ts`
- `sdk-streaming-failures.test.ts`

**Note:** The following test files have been removed (were heavily dependent on mock SDK):
- `agent-pipeline.test.ts` - Removed
- `rpc-message-handlers.test.ts` - Removed

**Tests NOT in scope (will continue using real API):**
- Provider-specific tests: `providers/anthropic-provider.test.ts`, `providers/openai-provider.test.ts`, `providers/github-copilot-provider.test.ts`
- GLM tests: `glm/glm-provider.test.ts`, `glm/glm-sdk-minimal.test.ts`, `glm/model-switching.test.ts`
- Multi-agent room tests that require real AI behavior: `room-multi-agent-flow.test.ts`, `room-planner-two-phase.test.ts`, `room-reviewer-flow.test.ts`

## Background

### Previous Approach (Removed)
The codebase previously used an internal mock SDK (`packages/daemon/tests/helpers/mock-sdk.ts`) that:
- Intercepted the SDK at the `queryRunner.start()` level
- Fed scripted responses through the real message handling pipeline
- Was controlled via `NEOKAI_AGENT_SDK_MOCK=1` environment variable

This approach has been **removed** in favor of Dev Proxy.

### Dev Proxy Approach
[Dev Proxy](https://github.com/dotnet/dev-proxy) is Microsoft's API simulation tool that:
- Intercepts HTTP traffic at the network level (runs as a separate process)
- Mocks API responses via JSON configuration files
- Can simulate errors, throttling, and realistic API behavior
- Has an [Anthropic Claude API sample](https://github.com/pnp/proxy-samples/tree/main/samples/simulate-anthropic)

### Key Benefits
- **Test stability**: No more flaky internal mock state
- **Cost reduction**: Zero API calls during tests
- **Realistic simulation**: Can test error handling, throttling, rate limits
- **Maintainability**: Mock responses are declarative JSON files, not code
- **Cross-language**: Works with any HTTP client (SDK implementation changes won't break mocks)

## Tasks

### Task 1: Research Dev Proxy integration requirements ✅

**Status:** Completed

Documentation created at `docs/dev-proxy-integration.md`.

### Task 2: Set up Dev Proxy infrastructure ✅

**Status:** Completed

Files created:
- `.devproxy/devproxyrc.json` - Main configuration
- `.devproxy/mocks.json` - Initial mock responses
- `scripts/dev-proxy.sh` - Start/stop/status management script
- npm scripts: `test:proxy:start`, `test:proxy:stop`, `test:proxy:status`, `test:proxy:restart`

### Task 3: Create mock response files ✅

**Status:** Completed

Files created in `.devproxy/`:
- `mocks-basic.json` - Basic text responses
- `mocks-tool-use.json` - Tool call scenarios
- `mocks-errors.json` - Error responses
- `mocks-room.json` - Multi-agent scenarios
- `README.md` - Documentation

### Task 4: Create test helper ✅

**Status:** Completed

Files created:
- `packages/daemon/tests/helpers/dev-proxy.ts` - DevProxyController with start/stop/loadMockFile/waitForReady/isRunning
- Updated `packages/daemon/tests/helpers/daemon-server.ts` - Integrated with NEOKAI_USE_DEV_PROXY=1 flag

### Task 5: Convert daemon tests to use Dev Proxy

**Status:** In Progress

1. ✅ Remove mock SDK code from codebase
2. ✅ Update test files to remove IS_MOCK patterns
3. ⏳ Update CI to use Dev Proxy for offline tests
4. ⏳ Validate all tests pass with Dev Proxy

### Task 6: Validate and measure improvements

**Status:** Pending

## Dependencies

- Task 1 must complete before Tasks 2-5
- Task 2 must complete before Tasks 3-4
- Task 3 can run in parallel with Task 4
- Task 5 depends on Tasks 2-4
- Task 6 depends on Task 5

## Notes

### Dev Proxy Installation
```bash
# macOS
brew install dev-proxy

# Linux (CI)
curl -sSL https://aka.ms/devproxy-install | bash
```

### Environment Variables
```bash
# Enable Dev Proxy for tests
NEOKAI_USE_DEV_PROXY=1

# Proxy configuration (set by test helper or CI)
HTTP_PROXY=http://127.0.0.1:8000
HTTPS_PROXY=http://127.0.0.1:8000
NODE_TLS_REJECT_UNAUTHORIZED=0  # If using self-signed certs
NODE_USE_ENV_PROXY=1  # Required for undici (used by SDK)
```
