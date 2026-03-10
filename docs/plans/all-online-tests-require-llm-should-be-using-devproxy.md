# Plan: All Online Tests Requiring LLM Should Be Using Devproxy

## Goal

Identify all online tests that require LLM but are NOT using devproxy in CI, then update them to use devproxy for stability, efficiency, and cost reduction while maintaining test effectiveness.

## Current State

From the CI matrix in `.github/workflows/main.yml`:
- **Using devproxy (`mock_sdk: true`)**: agent-sdk, components, convo, coordinator, features-1, lifecycle, mcp, rewind, rpc-1, rpc-2, rpc-3, sdk
- **NOT using devproxy**: agent-context, features-2, git, providers-anthropic, providers-openai, providers-copilot, websocket

Analysis shows:
- Tests `agent-context`, `features-2`, `git` already have IS_MOCK support and can use devproxy
- Test `websocket` needs IS_MOCK support added first
- Tests `providers-anthropic`, `providers-openai`, `providers-copilot` are provider-specific and need real API (should remain without devproxy)

## Tasks

### Task 1: Add devproxy to agent-context module (context-command.test.ts)
- **File**: `.github/workflows/main.yml`
- **Change**: Add `mock_sdk: true` to agent-context module configuration
- **Test file**: `packages/daemon/tests/online/agent/context-command.test.ts` already has IS_MOCK support
- **Acceptance Criteria**: CI runs agent-context with devproxy enabled; tests pass with NEOKAI_USE_DEV_PROXY=1

### Task 2: Add devproxy to features-2 module (message-persistence.test.ts)
- **File**: `.github/workflows/main.yml`
- **Change**: Add `mock_sdk: true` to features-2 module configuration
- **Test file**: `packages/daemon/tests/online/features/message-persistence.test.ts` already has IS_MOCK support
- **Acceptance Criteria**: CI runs features-2 with devproxy enabled; tests pass with NEOKAI_USE_DEV_PROXY=1

### Task 3: Add devproxy to git module (archive-session.test.ts)
- **File**: `.github/workflows/main.yml`
- **Change**: Add `mock_sdk: true` to git module configuration
- **Test file**: `packages/daemon/tests/online/git/archive-session.test.ts` already has IS_MOCK support
- **Acceptance Criteria**: CI runs git with devproxy enabled; tests pass with NEOKAI_USE_DEV_PROXY=1

### Task 4: Add devproxy support to websocket module (websocket-protocol.test.ts)
- **File**: `packages/daemon/tests/online/websocket/websocket-protocol.test.ts`
- **Changes**:
  1. Add devproxy documentation comment
  2. Add IS_MOCK constant to detect devproxy mode
  3. Add appropriate timeouts for mock mode
- **CI File**: `.github/workflows/main.yml`
- **Change**: Add `mock_sdk: true` to websocket module configuration
- **Acceptance Criteria**: websocket-protocol.test.ts supports NEOKAI_USE_DEV_PROXY=1; CI runs websocket with devproxy enabled

## Dependencies

- Task 1, 2, 3: No dependencies - can be done in parallel after understanding the pattern
- Task 4: Depends on understanding the IS_MOCK pattern from other tests

## Notes

- Provider-specific tests (providers-anthropic, providers-openai, providers-copilot) should remain WITHOUT devproxy because they specifically test provider functionality that requires real API credentials
- All tests in this plan have been verified to support devproxy or can be easily updated to support it

## Agent Type

All tasks are **coder** tasks as they involve:
1. Updating CI configuration files
2. Adding devproxy support to test files

## Changes Must Be On Feature Branch

All changes must be on a feature branch with a GitHub PR created via `gh pr create`
