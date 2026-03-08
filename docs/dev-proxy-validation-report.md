# Dev Proxy Integration Validation Report

**Date:** 2026-03-08
**Task:** Validate and measure improvements from Dev Proxy integration
**Scope:** Online tests that were converted to support Dev Proxy

## Executive Summary

The validation process identified a critical issue preventing Dev Proxy mode from working correctly. While the infrastructure is properly set up, the Claude Agent SDK subprocess does not inherit the proxy environment variables, causing tests to fail with timeout errors.

## Converted Test Files (9 files identified)

1. `packages/daemon/tests/online/convo/multiturn-conversation.test.ts`
2. `packages/daemon/tests/online/lifecycle/session-resume.test.ts`
3. `packages/daemon/tests/online/rewind/selective-rewind.test.ts`
4. `packages/daemon/tests/online/rewind/rewind-feature.test.ts`
5. `packages/daemon/tests/online/features/message-persistence.test.ts`
6. `packages/daemon/tests/online/features/message-delivery-mode-queue.test.ts`
7. `packages/daemon/tests/online/room/room-chat-constraints.test.ts`
8. `packages/daemon/tests/online/agent/agent-session-sdk.test.ts`
9. `packages/daemon/tests/online/sdk/sdk-streaming-failures.test.ts`

## Test Results

### Mock SDK Mode (NEOKAI_AGENT_SDK_MOCK=1)

**Status:** Mostly Working
**Results:** 3 out of 4 tests passing in multiturn-conversation.test.ts
**Execution Time:** ~5.8 seconds

```
3 pass
1 fail (test assertion error, not a mock issue)
11 expect() calls
Ran 4 tests across 1 file. [5.80s]
```

**Note:** The failing test has a test bug (expects "idle" to be contained in ["queued", "processing"], which is a logic error unrelated to mocking).

### Dev Proxy Mode (NEOKAI_USE_DEV_PROXY=1)

**Status:** Not Working
**Results:** All tests fail with timeout errors

```
error: Timeout waiting for processing state "idle" after 5000ms
```

## Root Cause Analysis

### Issue Identified: SDK Subprocess Not Inheriting Proxy Environment Variables

The Claude Agent SDK spawns a subprocess to execute queries. While the dev-proxy helper correctly sets proxy environment variables in the parent process:

```typescript
// From dev-proxy.ts
globalThis.process.env.HTTPS_PROXY = proxyUrl;
globalThis.process.env.HTTP_PROXY = proxyUrl;
globalThis.process.env.NODE_USE_ENV_PROXY = '1';
```

The SDK subprocess does not inherit these variables. Evidence:

1. **Dev Proxy logs show no requests**: After running tests, Dev Proxy logs contain only the schema warning, with no intercepted requests.

2. **Tests timeout waiting for "idle" state**: The SDK starts but cannot complete API requests, causing the agent to hang.

3. **Valid OAuth token exists**: The SDK has a valid token (`CLAUDE_CODE_OAUTH_TOKEN` is SET), which allows it to make real API requests instead of using the proxy.

### Contributing Factor

The query options builder in `packages/daemon/src/lib/agent/query-options-builder.ts` builds an `env` object from `globalSettings.env` and `session.config.env`, but proxy variables set in `process.env` are not explicitly included:

```typescript
private getMergedEnvironmentVars(): Record<string, string> | undefined {
    const globalSettings = this.ctx.settingsManager.getGlobalSettings();
    const sessionEnv = this.ctx.session.config.env;

    const providerEnvVars = new Set([
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_API_KEY',
        // ... other provider vars
    ]);

    // Proxy vars (HTTPS_PROXY, HTTP_PROXY, NODE_USE_ENV_PROXY) are NOT in this list
    // But they're also NOT explicitly passed through
}
```

## Fixes Applied

### Health Check Fix

Modified `packages/daemon/tests/helpers/dev-proxy.ts` to use TCP connection check instead of HTTP fetch:

```typescript
// Before (doesn't work with HTTPS proxies)
const checkProxyReady = async (): Promise<boolean> => {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
            method: 'GET',
        });
        return response.status !== 0;
    } catch {
        return false;
    }
};

// After (uses TCP connection)
const checkProxyReady = async (): Promise<boolean> => {
    return new Promise((resolve) => {
        const net = require('net');
        const socket = new net.Socket();
        socket.setTimeout(1000);
        socket.on('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        socket.on('error', () => {
            socket.destroy();
            resolve(false);
        });
        socket.connect(port, '127.0.0.1');
    });
};
```

## API Call Verification

### Dev Proxy Logs Analysis

After running tests with Dev Proxy enabled, the log file contains:

```
 warn    The version of schema does not match the installed Dev Proxy version
```

**No intercepted requests found**, confirming that the SDK is not routing requests through the proxy.

### Manual Verification

Manual test with curl confirms Dev Proxy works correctly:

```bash
HTTPS_PROXY=http://127.0.0.1:8000 curl -X POST https://api.anthropic.com/v1/messages ...
# Returns: {"id": "msg_mock123", "text": "[MOCKED BY DEV PROXY] ..."}
```

## Performance Comparison

| Mode | Status | Avg Time | Notes |
|------|--------|----------|-------|
| Mock SDK (`NEOKAI_AGENT_SDK_MOCK=1`) | Working | ~5.8s | 3/4 tests pass (1 test bug) |
| Dev Proxy (`NEOKAI_USE_DEV_PROXY=1`) | Not Working | N/A | All tests timeout |

## Recommendations

### 1. Critical: Fix SDK Proxy Environment Variable Inheritance

**Option A: Explicitly Pass Proxy Variables to SDK**

Modify `packages/daemon/src/lib/agent/query-options-builder.ts` to explicitly include proxy variables in the SDK options:

```typescript
private getMergedEnvironmentVars(): Record<string, string> | undefined {
    const mergedEnv: Record<string, string> = {};

    // Existing logic for globalSettings.env and sessionEnv...

    // Explicitly include proxy environment variables
    if (process.env.HTTPS_PROXY) {
        mergedEnv.HTTPS_PROXY = process.env.HTTPS_PROXY;
    }
    if (process.env.HTTP_PROXY) {
        mergedEnv.HTTP_PROXY = process.env.HTTP_PROXY;
    }
    if (process.env.NODE_USE_ENV_PROXY) {
        mergedEnv.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY;
    }
    if (process.env.NODE_EXTRA_CA_CERTS) {
        mergedEnv.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;
    }

    return Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined;
}
```

**Option B: Use SDK's Proxy Configuration**

If the Claude Agent SDK supports explicit proxy configuration, use that instead of environment variables.

### 2. Fix Schema Version Warning

Update `.devproxy/mocks.json` to use the correct schema version:

```json
{
  "$schema": "https://raw.githubusercontent.com/dotnet/dev-proxy/main/schemas/v2.2.0/mockresponseplugin.mocksfile.schema.json",
  ...
}
```

### 3. Add Proxy Environment Variable Logging

Add debug logging to verify proxy environment variables are set correctly before SDK calls:

```typescript
// In query-options-builder.ts, before calling SDK
if (process.env.NEOKAI_USE_DEV_PROXY === '1') {
    console.log('[DEV PROXY] HTTPS_PROXY:', process.env.HTTPS_PROXY);
    console.log('[DEV PROXY] HTTP_PROXY:', process.env.HTTP_PROXY);
    console.log('[DEV PROXY] NODE_USE_ENV_PROXY:', process.env.NODE_USE_ENV_PROXY);
}
```

### 4. Test With Invalid Credentials

To verify the proxy is being used, run tests with cleared credentials:

```bash
# Clear ANTHROPIC_API_KEY but keep OAuth token (proxy should intercept)
unset ANTHROPIC_API_KEY
NEOKAI_USE_DEV_PROXY=1 bun test ...
```

If tests still work, the proxy is intercepting requests. If they fail with auth errors, requests are bypassing the proxy.

## Limitations and Caveats

1. **SDK Subprocess Behavior**: The Claude Agent SDK's subprocess spawning behavior may not inherit environment variables as expected. This is a fundamental issue that may require SDK-level changes.

2. **Proxy with Bun Runtime**: The SDK uses Bun as the runtime. Bun's subprocess handling may differ from Node.js, affecting environment variable inheritance.

3. **Undici Proxy Support**: Per GitHub Issue #169, undici (Node.js's HTTP client) has known issues with proxy environment variables. The `NODE_USE_ENV_PROXY=1` workaround may not work with all versions.

4. **Test Isolation**: Each test starts and stops Dev Proxy, which adds overhead. Consider using a global Dev Proxy instance for test suites.

## Conclusion

The Dev Proxy integration infrastructure is correctly implemented, but a critical issue prevents it from working: the Claude Agent SDK subprocess does not inherit proxy environment variables. This must be resolved before Dev Proxy can be used for online testing.

**Next Steps:**
1. Implement Option A (explicitly pass proxy variables to SDK)
2. Test with cleared credentials to verify proxy interception
3. Re-run validation tests
4. Document CI execution time improvements once working

## Files Modified

1. `packages/daemon/tests/helpers/dev-proxy.ts` - Health check fix (TCP connection)
2. `.devproxy/devproxyrc.json` - Schema version updated to v2.2.0
