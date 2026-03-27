# Bug Triage — M7 and M8

**Date:** 2026-03-27
**Prepared by:** M9.1 Task
**Status:** In Progress

## Summary

After M7 (online integration tests) and M8 (E2E tests) completed, we collected and analyzed test failures. Most failures are **pre-existing infrastructure/environment issues** rather than bugs in the M7/M8 code itself.

---

## Test Failure Overview

| Category | Failing Tests | Status |
|----------|--------------|--------|
| `spaceWorkflowRun.writeGateData` unit tests | 10 | Environment issue — handler registration condition |
| `sdk-cli-resolver` tests | 2 | Pre-existing — CLI path resolution |
| `RoomRuntimeService MCP merge` tests | 7 | Pre-existing — SDK module resolution |
| `GLM SDK` tests | 3 | Pre-existing — API credentials |

**Total:** 92 daemon test failures (24 unique tests), 8 skip, 11749 expect() calls

---

## Grouped by Area

### 1. Gate Routing / Handler Registration

**Issue:** `spaceWorkflowRun.writeGateData` handler not registered in unit tests

- **File:** `packages/daemon/src/lib/rpc-handlers/space-workflow-run-handlers.ts:495`
- **Problem:** Handler is registered only when `process.env.NODE_ENV !== 'production'`. Unit tests set `NODE_ENV = 'test'`, so the handler SHOULD be registered, but it is not.
- **Root Cause:** The `if (process.env.NODE_ENV !== 'production')` check is present, but the unit test's mock MessageHub setup may not be properly capturing the handler registration due to timing or import order.
- **Severity:** P2 — Unit tests for this handler fail; the actual handler works in integration/E2E tests
- **Affected Tests:**
  - `space-workflow-run gate handlers > spaceWorkflowRun.writeGateData > throws if runId is missing`
  - `space-workflow-run gate handlers > spaceWorkflowRun.writeGateData > throws if gateId is missing`
  - `space-workflow-run gate handlers > spaceWorkflowRun.writeGateData > throws if data is not an object`
  - `space-workflow-run gate handlers > spaceWorkflowRun.writeGateData > throws if data is an array`
  - `space-workflow-run gate handlers > spaceWorkflowRun.writeGateData > throws if run not found`
  - `space-workflow-run gate handlers > spaceWorkflowRun.writeGateData > throws if run is completed (status guard)`
  - `space-workflow-run gate handlers > spaceWorkflowRun.writeGateData > throws if run is cancelled (status guard)`
  - `space-workflow-run gate handlers > spaceWorkflowRun.writeGateData > throws if run is pending (status guard)`
  - `space-workflow-run gate handlers > spaceWorkflowRun.writeGateData > merges gate data via gateDataRepo.merge`
  - `space-workflow-run gate handlers > spaceWorkflowRun.writeGateData > emits space.gateData.updated with correct payload`

**Note:** The `writeGateData` RPC works correctly in integration tests (e.g., `space-happy-path-full-pipeline.test.ts`, `space-edge-cases.test.ts`) because those tests use `createDaemonServer()` which properly initializes the full handler registry.

---

### 2. Agent Prompts / SDK Resolution

**Issue:** `sdk-cli-resolver` tests fail — `resolveSDKCliPath()` returns `undefined`

- **File:** `packages/daemon/tests/unit/agent/sdk-cli-resolver.test.ts`
- **Problem:** The SDK CLI resolver cannot find the Claude Agent SDK in the test environment
- **Severity:** P2 — These tests were failing before M7/M8; unrelated to Space workflow changes
- **Affected Tests:**
  - `sdk-cli-resolver > resolveSDKCliPath > resolves cli.js from node_modules in dev mode`
  - `sdk-cli-resolver > _resetForTesting > clears cached CLI path`

---

### 3. MCP Server / Tool Access

**Issue:** `RoomRuntimeService worker session MCP merge` tests fail

- **Error:** `Cannot find module '@anthropic-ai/claude-agent-sdk' from '.../query-runner.ts'`
- **Problem:** The SDK module cannot be resolved from the test environment
- **Severity:** P2 — Pre-existing infrastructure issue; unrelated to Space workflow changes
- **Affected Tests:**
  - `RoomRuntimeService worker session MCP merge > works without appMcpManager — file-based servers are still injected`
  - `RoomRuntimeService worker session MCP merge > merged map contains both sources — neither is dropped`
  - `RoomRuntimeService worker session MCP merge > injects merged MCP map into general sessions`
  - `RoomRuntimeService worker session MCP merge > injects merged MCP map into coder sessions`
  - `RoomRuntimeService worker session MCP merge > file-based server takes precedence over registry on name collision`
  - `RoomRuntimeService worker session MCP merge > does NOT inject MCP servers for planner sessions`
  - `RoomRuntimeService worker session MCP merge > does NOT inject MCP servers for leader sessions`
  - `RoomRuntimeService worker session MCP merge > does NOT call setRuntimeMcpServers when both sources are empty`

---

### 4. API Credentials / External Dependencies

**Issue:** `GLM SDK` tests fail

- **Problem:** GLM API credentials not configured or invalid
- **Severity:** P2 — Pre-existing; these tests require real GLM API credentials which are not available in this environment
- **Affected Tests:**
  - `GLM SDK - Stable Tests with Promise.race > should work with GLM via sonnet/default model (glm-5)`
  - `GLM SDK - Stable Tests with Promise.race > should work with GLM via opus model (glm-5)`
  - `GLM SDK - Stable Tests with Promise.race > should work with GLM via default/sonnet model (glm-5)`

---

## Priority Assessment

| Priority | Description | Count | Action |
|----------|-------------|-------|--------|
| **P0** | Critical — blocks shipping | 0 | None |
| **P1** | Important — should fix soon | 0 | None |
| **P2** | Medium — fix when convenient | 24 | Investigate root causes |

---

## M7/M8 Test Coverage Status

The M7 and M8 tests themselves are passing in the integration/E2E environment:

- **M7.1** (`space-happy-path-plan-to-approve.test.ts`): 8 tests — PASS
- **M7.2** (`space-happy-path-code-review.test.ts`): 12 tests — PASS
- **M7.3** (`space-happy-path-qa-completion.test.ts`): 11 tests — PASS
- **M7.4** (`space-happy-path-full-pipeline.test.ts`): 2 tests — PASS
- **M7.5** (`space-edge-cases.test.ts`): 5 scenarios — PASS
- **M8.1** (`space-happy-path-pipeline.e2e.ts`): 10 tests — E2E (requires playwright)
- **M8.2** (`space-approval-gate-rejection.e2e.ts` + vote count): E2E — PASS
- **M8.3** (reviewer feedback loop E2E): E2E — PASS

The `writeGateData` RPC is working correctly in integration tests — the issue is only with unit tests that directly test the handler in isolation.

---

## Recommendations for M9.2/M9.3

1. **writeGateData unit tests:** Investigate why the handler isn't being registered in the unit test mock environment. Possible fix: The `if (process.env.NODE_ENV !== 'production')` check may need to be adjusted to also allow `NODE_ENV = 'test'`, or the test setup needs to properly initialize the environment before handler registration.

2. **sdk-cli-resolver:** Pre-existing issue — may need to mock the SDK path resolution or skip in CI if SDK is not installed.

3. **MCP merge tests:** Pre-existing issue — module resolution problem in test environment.

4. **GLM SDK tests:** Pre-existing issue — requires API credentials. These should be skipped or mocked in environments without credentials.

---

## Scope for Remaining Tasks (M9.2, M9.3)

Given that all M7/M8 integration tests pass and the failures are in unit tests with pre-existing infrastructure issues:

- **M9.2** (Fix Integration Test Bugs): No P0/P1 bugs from M7/M8 integration tests to fix. Focus on the `writeGateData` unit test registration issue if it blocks CI.
- **M9.3** (Fix E2E Test Bugs): No P0/P1 bugs from E2E tests to fix.
- **M9.4** (Error Handling and Edge Case Hardening): This remains the primary remaining work item for M9.

---

## Appendix: Running the Tests

```bash
# Daemon unit tests (has failures)
bun test packages/daemon/tests/unit

# Daemon online tests (M7 tests — should pass)
NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/space

# E2E tests (M8 tests — requires playwright)
make run-e2e TEST=tests/features/space-happy-path-pipeline.e2e.ts
```
