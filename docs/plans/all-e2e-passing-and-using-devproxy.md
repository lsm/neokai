# Plan: All E2E Passing and Using DevProxy

## Goal

Get all e2e tests passing using devproxy where LLM is needed. This improves test stability, reduces cost, and eliminates flakiness from real API calls.

## Background

The CI already separates e2e tests into two categories:
- **no_llm**: UI-only tests that don't require LLM API calls
- **llm**: Tests that send messages and wait for LLM responses

Currently, the LLM tests use real `GLM_API_KEY` in CI, which can be flaky and costly. The goal is to convert these to use devproxy like the daemon online tests do.

## Current Test Categories (from CI discover step)

### LLM Tests (currently use real API)
- core/message-flow
- core/interrupt-button
- core/interrupt-error-bug
- core/context-features
- features/archive
- features/file-operations
- features/rewind-features
- settings/auto-title

### No-LLM Tests (all other tests - ~33 tests)
- smoke/connection-basic, smoke/message-send, smoke/session-creation
- core/connection-resilience, core/message-input, core/model-selection, core/navigation-3-column, core/persistence, core/scroll-behavior, core/session-lifecycle
- features/character-counter, features/draft, features/file-attachment, features/message-operations, features/session-operations, features/slash-cmd, features/thinking-level-selector, features/worktree-isolation
- read-only/home, read-only/ui-components
- responsive/mobile, responsive/tablet
- serial/auth-error-scenarios, serial/error-scenarios, serial/multi-session-concurrent-pages, serial/multi-session-operations, serial/recovery-scenarios, serial/worktree-git-operations
- settings/mcp-servers, settings/settings-modal, settings/tools-modal

## Tasks

### Phase 1: Fix No-LLM E2E Tests

#### Task 1: Fix and verify no-LLM e2e tests pass
**Agent:** coder
**Description:** Run all no-LLM e2e tests, identify any failures, and fix them one by one. This ensures the baseline UI tests work correctly without any LLM dependency.
**Acceptance Criteria:**
- All no-LLM e2e tests pass when run against the binary
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

#### Task 2: Update CI to rename no-LLM job for clarity
**Agent:** coder
**Description:** Update the CI workflow to reflect the no-LLM nature in the job names. The current "e2e" job runs no-LLM tests, but this isn't clearly communicated.
**Acceptance Criteria:**
- CI job renamed to clearly indicate "no-LLM" or "UI-only" tests
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Phase 2: Convert LLM Tests to Use DevProxy

#### Task 3: Configure devproxy for e2e tests in CI
**Agent:** coder
**Description:** Update the CI workflow to start devproxy before running e2e-llm tests and configure the binary to use the devproxy URL. This mirrors how daemon online tests are configured.
**Acceptance Criteria:**
- Devproxy is started in the e2e-llm job before tests run
- Binary is configured to use devproxy via ANTHROPIC_BASE_URL
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

#### Task 4: Update LLM e2e tests to handle mock responses
**Agent:** coder
**Description:** Update each LLM e2e test to handle devproxy mock responses. This may include:
- Adding IS_MOCK check like daemon tests
- Updating assertions to accept mock responses (e.g., "[MOCKED]" prefix)
- Adjusting timeouts if needed

Tests to update (one at a time):
1. core/message-flow
2. core/interrupt-button
3. core/interrupt-error-bug
4. core/context-features
5. features/archive
6. features/file-operations
7. features/rewind-features
8. settings/auto-title

**Acceptance Criteria:**
- Each test passes with devproxy mock responses
- Tests are updated to detect mock mode and adjust assertions accordingly
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

#### Task 5: Verify all e2e tests pass with devproxy
**Agent:** coder
**Description:** Run the full e2e test suite (both no-LLM and LLM with devproxy) to ensure everything passes.
**Acceptance Criteria:**
- All e2e tests pass in CI
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

## Dependencies

- Task 1 must complete before Task 2 (verify baseline works)
- Task 2 can proceed independently
- Task 3 must complete before Task 4 (infrastructure ready)
- Task 4 tasks are sequential (one test at a time as requested)
- Task 5 requires Tasks 1-4 to complete

## Notes

- The daemon online tests already use devproxy successfully - use them as reference
- Devproxy mocks return "[MOCKED] Hello! I'm Claude, an AI assistant." - tests expecting specific responses need updating
- Each LLM test should be fixed one at a time as per goal requirements
