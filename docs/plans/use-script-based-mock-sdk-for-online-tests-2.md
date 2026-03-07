# Plan: Use Script-Based Mock SDK for Online Tests

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
- Most other room tests make real API calls

## Tasks

### Task 1: Audit and categorize online tests (2 tests)

**Agent: general**

Audit all online tests in `packages/daemon/tests/online/` and categorize them into:
- Tests that CAN use mock SDK (RPC handlers, state management, persistence, rewind)
- Tests that SHOULD use mock SDK (quick feature tests)
- Tests that MUST use real API (multi-agent flows, provider-specific behavior)

Create a summary with recommendations for which tests to convert.

**Acceptance Criteria:**
- Document listing all online test files with their category
- Recommendations for conversion priority

### Task 2: Convert room chat tests to mock mode (2 tests)

**Agent: coder**

Convert the following room tests to support mock mode (similar to `room-chat-constraints.test.ts`):
- `room-advanced-scenarios.test.ts`
- Identify any other room tests that don't require multi-agent tool execution

Use `installRoomAutoMock` or `mockControls.setDefaultResponses` to enable mock mode.

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`**

**Acceptance Criteria:**
- Tests pass with `NEOKAI_AGENT_SDK_MOCK=1`
- Tests still work with real API (default mode)
- Timeouts adjusted appropriately for mock vs real mode

### Task 3: Convert feature tests to mock mode (3 tests)

**Agent: coder**

Convert the following feature tests to use mock SDK:
- `auto-title.test.ts` - verify title generation metadata without real API
- `message-persistence.test.ts` - verify DB persistence with mock responses
- `message-delivery-mode-queue.test.ts` - verify queue behavior with mock

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`**

**Acceptance Criteria:**
- Tests pass with mock SDK
- Tests verify the core functionality (state transitions, persistence, etc.)

### Task 4: Convert RPC/state tests to mock mode (2 tests)

**Agent: coder**

Convert RPC/state tests that don't need real AI:
- `rpc-message-handlers.test.ts` - verify message handling with mock
- `rpc-state-sync.test.ts` - verify state synchronization with mock

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`**

**Acceptance Criteria:**
- Tests use mock SDK and verify the harness pipeline

### Task 5: Enhance mock SDK if needed (0-2 tests)

**Agent: coder**

Based on the conversion work, identify any gaps in the mock SDK:
- Add new message builders if needed
- Extend room scripts if needed for specific test scenarios
- Document any limitations

This task is optional depending on findings from Tasks 2-4.

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`**

**Acceptance Criteria:**
- Any enhancements are backwards-compatible
- New features are documented in mock-sdk.ts

### Task 6: Run converted tests and verify (1 test)

**Agent: general**

Run all converted tests to verify they work correctly:
- Run with `NEOKAI_AGENT_SDK_MOCK=1` (mock mode)
- Run without the env var (should fail gracefully or skip)

**Acceptance Criteria:**
- All converted tests pass in mock mode
- Test execution time is significantly reduced compared to real API mode

## Dependencies

- Task 1 must complete before Tasks 2-4 (to know what to convert)
- Tasks 2-4 can run in parallel after Task 1
- Task 5 depends on Tasks 2-4 (may need enhancements)
- Task 6 depends on all conversion tasks

## Notes

- Some room tests (multi-agent flows) require real API for tool execution and cannot be converted
- Provider tests (Anthropic, OpenAI, GLM) should remain API-dependent
- Tests that verify actual AI behavior (e.g., tool selection, response quality) cannot use mock
