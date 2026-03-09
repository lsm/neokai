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

### No-LLM Tests (31 tests)
- smoke/connection-basic, smoke/message-send, smoke/session-creation
- core/connection-resilience, core/message-input, core/model-selection, core/navigation-3-column, core/persistence, core/scroll-behavior, core/session-lifecycle
- features/character-counter, features/draft, features/file-attachment, features/message-operations, features/session-operations, features/slash-cmd, features/thinking-level-selector, features/worktree-isolation
- read-only/home, read-only/ui-components
- responsive/mobile, responsive/tablet
- serial/auth-error-scenarios, serial/error-scenarios, serial/multi-session-concurrent-pages, serial/multi-session-operations, serial/recovery-scenarios, serial/worktree-git-operations
- settings/mcp-servers, settings/settings-modal, settings/tools-modal

## Tasks

### Phase 0: Baseline (Run tests to identify current failures)

#### Task 0: Run no-LLM tests to establish baseline
**Agent:** coder
**Description:** Run all no-LLM e2e tests against the current binary to identify which tests are currently failing. Document the failures as the baseline.
**Method:**
```bash
# Run no-LLM tests (from CI discover step)
cd packages/e2e
bunx playwright test tests/smoke/ tests/core/ tests/features/ tests/read-only/ tests/responsive/ tests/serial/ tests/settings/ --grep-v "message-flow|interrupt-button|interrupt-error-bug|context-features|archive|file-operations|rewind-features|auto-title"
```
**Acceptance Criteria:**
- List of currently failing no-LLM tests documented
- Failure reasons identified (e.g., timeout, assertion error, missing element)
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Phase 1: Fix No-LLM E2E Tests

#### Task 1: Fix and verify no-LLM e2e tests pass
**Agent:** coder
**Description:** Fix the failing no-LLM e2e tests identified in Task 0. Each test should be fixed individually and verified. Use the baseline data to prioritize fixes.
**Method:**
- Start with the simplest failures
- Run each fixed test individually to verify: `make run-e2e TEST=tests/[path].e2e.ts`
**Acceptance Criteria:**
- All 31 no-LLM e2e tests pass when run against the binary
- Each fix verified individually before moving to next
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

#### Task 2: Update CI job name from "e2e" to "e2e-no-llm"
**Agent:** coder
**Description:** Update the CI workflow job name from "e2e" to "e2e-no-llm" to clearly communicate that these are UI-only tests. Also update related artifact names and documentation.
**Specific changes:**
- Rename job: `e2e` → `e2e-no-llm`
- Update artifact names: `e2e-results-*` → `e2e-no-llm-results-*`
- Update job display name: `E2E (${{ matrix.test.name }})` → `E2E No-LLM (${{ matrix.test.name }})`
**Acceptance Criteria:**
- CI job renamed to "e2e-no-llm" in main.yml
- All references updated (artifacts, display names)
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Phase 2: Convert LLM Tests to Use DevProxy

#### Task 3: Configure devproxy for e2e tests in CI
**Agent:** coder
**Description:** Update the CI workflow to start devproxy before running e2e-llm tests and configure the binary to use the devproxy URL. This mirrors how daemon online tests are configured in `main.yml` lines 263-300.
**Specific changes:**
1. Add "Install Dev Proxy" step to e2e-llm job (similar to daemon online tests)
2. Add "Start Dev Proxy" step before tests run
3. Set environment variables:
   - `ANTHROPIC_BASE_URL=http://127.0.0.1:8000`
   - `ANTHROPIC_API_KEY=sk-devproxy-test-key`
   - `ANTHROPIC_AUTH_TOKEN=""` (clear any real token)
4. Add "Stop Dev Proxy" step in `if: always()` to cleanup
**Reference:** See daemon online test configuration in `main.yml` lines 263-314
**Acceptance Criteria:**
- Devproxy is installed and started in e2e-llm job before tests run
- Binary is configured to use devproxy via ANTHROPIC_BASE_URL
- Devproxy is stopped after tests complete
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

#### Task 4a: Update core/message-flow.e2e.ts to use devproxy
**Agent:** coder
**Description:** Update the test to handle devproxy mock responses. Use IS_MOCK pattern from daemon tests. Mock response returns "[MOCKED] Hello! I'm Claude, an AI assistant." - update assertions accordingly.
**Reference:** See `packages/daemon/tests/online/convo/multiturn-conversation.test.ts` for IS_MOCK pattern
**Acceptance Criteria:**
- Test detects mock mode via IS_MOCK environment variable
- Assertions updated to accept mock responses (e.g., check for "[MOCKED]" or any response)
- Test passes with devproxy running
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

#### Task 4b: Update core/interrupt-button.e2e.ts to use devproxy
**Agent:** coder
**Description:** Update the test to handle devproxy mock responses. Note: interrupt tests may rely on timing - mock responses return instantly, so interrupt behavior may need adjustment.
**Acceptance Criteria:**
- Test detects mock mode via IS_MOCK environment variable
- Assertions updated to accept mock responses
- Test passes with devproxy running
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

#### Task 4c: Update core/interrupt-error-bug.e2e.ts to use devproxy
**Agent:** coder
**Description:** Update the test to handle devproxy mock responses.
**Acceptance Criteria:**
- Test detects mock mode via IS_MOCK environment variable
- Assertions updated to accept mock responses
- Test passes with devproxy running
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

#### Task 4d: Update core/context-features.e2e.ts to use devproxy
**Agent:** coder
**Description:** Update the test to handle devproxy mock responses.
**Acceptance Criteria:**
- Test detects mock mode via IS_MOCK environment variable
- Assertions updated to accept mock responses
- Test passes with devproxy running
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

#### Task 4e: Update features/archive.e2e.ts to use devproxy
**Agent:** coder
**Description:** Update the test to handle devproxy mock responses.
**Acceptance Criteria:**
- Test detects mock mode via IS_MOCK environment variable
- Assertions updated to accept mock responses
- Test passes with devproxy running
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

#### Task 4f: Update features/file-operations.e2e.ts to use devproxy
**Agent:** coder
**Description:** Update the test to handle devproxy mock responses.
**Acceptance Criteria:**
- Test detects mock mode via IS_MOCK environment variable
- Assertions updated to accept mock responses
- Test passes with devproxy running
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

#### Task 4g: Update features/rewind-features.e2e.ts to use devproxy
**Agent:** coder
**Description:** Update the test to handle devproxy mock responses.
**Acceptance Criteria:**
- Test detects mock mode via IS_MOCK environment variable
- Assertions updated to accept mock responses
- Test passes with devproxy running
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

#### Task 4h: Update settings/auto-title.e2e.ts to use devproxy
**Agent:** coder
**Description:** Update the test to handle devproxy mock responses.
**Acceptance Criteria:**
- Test detects mock mode via IS_MOCK environment variable
- Assertions updated to accept mock responses
- Test passes with devproxy running
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

#### Task 5: Verify all e2e tests pass with devproxy
**Agent:** coder
**Description:** Run the full e2e test suite (both no-LLM and LLM with devproxy) to ensure everything passes. This is the final validation before completion.
**Acceptance Criteria:**
- All 31 no-LLM tests pass
- All 8 LLM tests pass with devproxy
- All e2e tests pass in CI workflow
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

## Dependencies

- Task 0 must complete first (establish baseline)
- Task 1 depends on Task 0 (fix identified failures)
- Task 2 can proceed independently after Task 1
- Task 3 must complete before Tasks 4a-4h (infrastructure ready)
- Task 4a-4h are sequential (one test at a time as requested)
- Task 5 requires Tasks 1-4h to complete

## Notes

- **IS_MOCK pattern reference:** Daemon tests use `const IS_MOCK = !!process.env.NEOKAI_USE_DEV_PROXY;` to detect mock mode
- **Mock response content:** Devproxy returns "[MOCKED] Hello! I'm Claude, an AI assistant." - tests expecting specific responses need updating
- **Interrupt tests:** Mock responses return instantly - interrupt tests may need timing adjustments
- **CI job naming:** "e2e" → "e2e-no-llm" and "e2e-llm" remains as-is (already descriptive)
