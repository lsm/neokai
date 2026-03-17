# Milestone 7: Test Coverage

## Goal

Add comprehensive test coverage for all changes: unit tests for type changes and routing, updates to the online provider test shards, and E2E tests for provider switching flows.

## Scope

- `packages/daemon/tests/unit/providers/` -- Unit tests
- `packages/daemon/tests/online/providers/` -- Online provider tests
- `packages/e2e/tests/` -- E2E Playwright tests
- `.github/workflows/main.yml` -- CI configuration updates

---

### Task 7.1: Unit Tests for Provider Routing and Type Safety

**Description:** Add comprehensive unit tests covering the widened `Provider` type, collision-safe routing, and provider-aware model resolution. Ensure all existing tests still pass.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/daemon/tests/unit/providers/provider-registry.test.ts`:
   - Add tests for `detectProviderForModel` with collision scenarios (Task 2.1).
   - Test that all five providers are registered by `initializeProviders`.
   - Test that `ownsModel` correctly distinguishes between providers that share model IDs.
3. In `packages/daemon/tests/unit/providers/context-manager.test.ts`:
   - Add tests for creating a provider context with `anthropic-copilot` and `anthropic-codex` provider IDs.
4. Add a new test file `packages/daemon/tests/unit/model-service-provider-routing.test.ts`:
   - Test `getModelInfo` with `providerId` parameter for disambiguation.
   - Test `resolveModelAlias` with `providerId` parameter.
   - Test that the global cache contains models from all available providers.
5. Run `bun run typecheck` and `bun run lint`.
6. Run all unit tests: `cd packages/daemon && bun test tests/unit/ --timeout 60000`.
7. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- All new tests pass.
- All existing tests still pass.
- Coverage includes: collision routing, provider-aware resolution, type safety.
- `bun run typecheck` and `bun run lint` pass.

**Dependencies:** Task 2.1, Task 2.2, Task 2.3

---

### Task 7.2: Update Online Provider Test Shards

**Description:** Update the online tests for both provider shards (`providers-anthropic-copilot` and `providers-anthropic-to-codex-bridge`) to cover the new functionality: error envelopes, token usage, provider-aware session creation.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/daemon/tests/online/providers/anthropic-to-copilot-bridge-provider.test.ts`:
   - Add a test that creates a session with explicit `config.provider: 'anthropic-copilot'` and verifies the session uses the copilot backend.
   - Add a test that verifies error responses use Anthropic JSON error envelopes.
   - Add a test that verifies non-zero token usage in the response.
3. In `packages/daemon/tests/online/providers/anthropic-to-codex-bridge-provider.test.ts`:
   - Add a test that creates a session with explicit `config.provider: 'anthropic-codex'` and verifies the session uses the codex backend.
   - Add a test that verifies error responses use Anthropic JSON error envelopes.
   - Add a test that verifies non-zero token usage in the response.
4. Ensure all tests follow the "hard fail" rule: no skip guards for missing credentials.
5. Run `bun run typecheck` and `bun run lint`.
6. Verify CI workflow configuration in `.github/workflows/main.yml` still has both shards and the correct test paths.
7. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- Online tests for both providers cover: explicit provider creation, error envelopes, token usage.
- No skip guards -- tests fail if credentials are missing.
- CI workflow configuration is correct for both shards.
- `bun run typecheck` and `bun run lint` pass.

**Dependencies:** Task 4.2, Task 4.3, Task 5.1, Task 5.2

---

### Task 7.3: E2E Tests for Provider Switching

**Description:** Add Playwright E2E tests that verify the user can switch between providers via the model picker UI. These tests must be pure browser-based interactions following the E2E test rules in CLAUDE.md.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Create a new test file `packages/e2e/tests/features/provider-model-switching.e2e.ts`.
3. Test scenarios (all via UI interactions, no RPC calls):
   - Create a new session -- verify the model name is visible in the session status bar.
   - Open the model picker dropdown -- verify models are grouped by provider with provider headers.
   - Switch to a model from a different provider (if multiple providers are available) -- verify the provider badge updates.
   - Verify the session continues working after provider switch (send a message, verify response).
4. Since E2E tests require real providers, guard the provider-switching test with a check for whether multiple providers show models in the picker. If only one provider is available, skip the cross-provider switch but still test the model picker rendering.
5. Follow all E2E test rules from CLAUDE.md:
   - All actions through the UI (clicks, typing).
   - All assertions on visible DOM state.
   - No direct RPC calls or internal state access.
6. Run `bun run typecheck` and `bun run lint`.
7. Run the test: `make run-e2e TEST=tests/features/provider-model-switching.e2e.ts`.
8. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- E2E test verifies model picker displays provider groups.
- E2E test verifies provider badge updates on model switch.
- E2E test follows all CLAUDE.md E2E rules.
- Test runs successfully via `make run-e2e`.
- `bun run typecheck` and `bun run lint` pass.

**Dependencies:** Task 3.1, Task 3.2
