# Plan: Use Script-Based Mock SDK for Online Tests

**Created:** March 2026

## Goal

Extend the use of the existing script-based mock SDK for online tests, particularly for time-consuming room feature tests. Where possible, convert API-dependent tests to use mock mode to improve test stability, reduce execution time, and lower API costs. For tests that require real API calls (e.g., multi-agent room flows), keep them as API-dependent but explore enhancements to the mock SDK that could support them in the future.

## Background

The codebase already has a comprehensive mock SDK (`packages/daemon/tests/helpers/mock-sdk.ts`) that provides:
- Message builders (`sdkAssistantText`, `sdkToolResult`, etc.)
- Pre-built scenarios (`simpleTextResponse`, `toolUseResponse`, etc.)
- Room-specific scripts (`plannerFull`, `coder`, `leader`, `chat`)
- Auto-mock installer (`installRoomAutoMock`)

Currently:
- `agent-pipeline.test.ts` uses mock SDK (always)
- `room-chat-constraints.test.ts` supports mock mode via `NEOKAI_AGENT_SDK_MOCK=1`
- `message-persistence.test.ts` already supports mock mode
- `message-delivery-mode-queue.test.ts` already supports mock mode
- `rpc-message-handlers.test.ts` already supports mock mode
- Most other room tests make real API calls

## Tasks

### Task 1: Audit and categorize online tests

**Agent: general**

Audit all online tests in `packages/daemon/tests/online/` and categorize them into:
- Tests that CAN use mock SDK (RPC handlers, state management, persistence, rewind)
- Tests that SHOULD use mock SDK (quick feature tests)
- Tests that MUST use real API (multi-agent flows, provider-specific behavior)

Create a summary with recommendations for which tests to convert.

**Acceptance Criteria:**
- Document listing all online test files with their category
- Recommendations for conversion priority with specific file names

### Task 2: Convert room chat tests to mock mode

**Agent: coder**

Convert the following room tests to support mock mode (similar to `room-chat-constraints.test.ts`):
- `room-advanced-scenarios.test.ts` - verify room scenario handling (no multi-agent)
- Any other room tests from Task 1 that don't require multi-agent tool execution

Use `installRoomAutoMock` or `mockControls.setDefaultResponses` to enable mock mode.

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`**

**Acceptance Criteria:**
- Tests pass with `NEOKAI_AGENT_SDK_MOCK=1` with timeout ≤30s
- Tests still work with real API (default mode)
- Mock timeout ≤5s, real API timeout ≥60s

### Task 3: Convert remaining feature tests to mock mode

**Agent: coder**

Convert any feature tests identified in Task 1 that aren't already supporting mock:
- `auto-title.test.ts` - verify title generation metadata without real API
- Other tests identified in audit

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`**

**Acceptance Criteria:**
- Tests pass with mock SDK with timeout ≤30s
- Tests verify the core functionality (state transitions, persistence, etc.)

### Task 4: Enhance mock SDK if needed

**Agent: coder**

Based on the conversion work, identify any gaps in the mock SDK:
- Add new message builders if needed
- Extend room scripts if needed for specific test scenarios
- Document any limitations

This task is optional depending on findings from Tasks 1-3.

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`**

**Acceptance Criteria:**
- Any enhancements are backwards-compatible
- New features are documented in mock-sdk.ts

### Task 5: Update CI to run tests in mock mode by default

**Agent: coder**

Update CI configuration to run converted tests in mock mode by default:
- Modify test runner scripts to set `NEOKAI_AGENT_SDK_MOCK=1` for appropriate tests
- Ensure API-dependent tests still run with real API (perhaps on a separate schedule or with explicit flag)
- Document which tests require real API

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`**

**Acceptance Criteria:**
- CI runs most online tests in mock mode
- Execution time reduction ≥50% for converted tests
- No regression in test coverage

### Task 6: Verify and measure improvements

**Agent: general**

Run all converted tests to verify they work correctly:
- Run with `NEOKAI_AGENT_SDK_MOCK=1` (mock mode) - all should pass
- Run without the env var - tests that can't use mock should skip or fail gracefully
- Measure execution time improvement

**Acceptance Criteria:**
- All converted tests pass in mock mode
- Test execution time reduced by ≥50% (e.g., from 120s to ≤60s per test)
- API costs reduced for CI runs

## Dependencies

- Task 1 must complete before Tasks 2-3 (to know what to convert)
- Tasks 2-4 can run in parallel after Task 1
- Task 5 depends on Tasks 2-4 (CI changes after tests are ready)
- Task 6 depends on all conversion tasks

## Notes

- Some room tests (multi-agent flows) require real API for tool execution and cannot be converted
- Provider tests (Anthropic, OpenAI, GLM) should remain API-dependent
- Tests that verify actual AI behavior (e.g., tool selection, response quality) cannot use mock
