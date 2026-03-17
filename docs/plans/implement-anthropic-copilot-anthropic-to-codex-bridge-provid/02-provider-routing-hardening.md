# Milestone 2: Provider Routing Hardening

## Goal

Ensure collision-safe provider routing when model IDs are shared between providers (e.g., `claude-opus-4.6` is claimed by both `anthropic` and `anthropic-copilot`, `gpt-5.3-codex` is claimed by both `anthropic-codex` and `anthropic-copilot`). Make `session.config.provider` the authoritative routing source and never fall through to `detectProvider` ambiguity.

## Scope

- `packages/daemon/src/lib/providers/registry.ts` -- `detectProvider` collision handling
- `packages/daemon/src/lib/provider-service.ts` -- provider-aware routing
- `packages/daemon/src/lib/agent/query-runner.ts` -- explicit provider ID usage
- `packages/daemon/src/lib/agent/model-switch-handler.ts` -- alias-to-provider resolution
- `packages/daemon/src/lib/model-service.ts` -- model info with provider context

---

### Task 2.1: Make detectProvider Provider-Aware with Collision Logging

**Description:** Update `ProviderRegistry.detectProvider` to log warnings when multiple providers claim the same model ID. Add a `detectProviderForModel(modelId, preferredProviderId?)` method that prefers the explicit provider when available.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/lib/providers/registry.ts`, add a new method `detectProviderForModel(modelId: string, preferredProviderId?: string)`:
   - If `preferredProviderId` is provided and that provider claims the model, return it.
   - Otherwise, iterate all providers that claim the model. If more than one, log a warning with the colliding provider IDs.
   - Return the first match (preserving existing behavior for backwards compatibility).
3. Update `detectProvider` to call the new method with no preference (no behavioral change).
4. Write unit tests in `packages/daemon/tests/unit/providers/provider-registry.test.ts`:
   - Test that `detectProviderForModel('claude-opus-4.6', 'anthropic-copilot')` returns the copilot provider.
   - Test that `detectProviderForModel('claude-opus-4.6')` returns the first registered (anthropic).
   - Test that `detectProviderForModel('gpt-5.3-codex', 'anthropic-codex')` returns the codex provider.
5. Run `bun run typecheck` and `bun run lint`.
6. Run `cd packages/daemon && bun test tests/unit/providers/provider-registry.test.ts`.
7. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- `detectProviderForModel` correctly resolves to the preferred provider when specified.
- Collision case logs a warning but still returns a result.
- All existing registry tests pass plus new tests for collision handling.
- `bun run typecheck` and `bun run lint` pass.

**Dependencies:** Task 1.1

---

### Task 2.2: Ensure Provider ID Flows Through Session Create to Query Runner

**Description:** Ensure that when a session is created with a specific provider (via `session.config.provider`), that provider ID is consistently used through the entire flow: session creation -> model switch -> query runner -> env var application.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/lib/rpc-handlers/session-handlers.ts`, in `session.create` handler: if `req.config.provider` is set, verify it is preserved in the created session.
3. In `packages/daemon/src/lib/agent/query-runner.ts`, verify that `explicitProviderId` is correctly sourced from `session.config.provider` (check around line 206).
4. In `packages/daemon/src/lib/agent/model-switch-handler.ts`:
   - When looking up the new provider, use `detectProviderForModel` (from Task 2.1) with the current session's provider as a hint.
   - This prevents switching from `copilot-anthropic-sonnet` to `claude-sonnet-4.6` from losing the Copilot provider context.
5. In `packages/daemon/src/lib/provider-service.ts`, update `getEnvVarsForModel` to use the new `detectProviderForModel` when `providerId` is provided.
6. Write unit tests for the model-switch-handler that cover:
   - Switching between models within the same provider (e.g., copilot opus -> copilot sonnet).
   - Switching between providers (e.g., anthropic sonnet -> copilot sonnet).
7. Run `bun run typecheck` and `bun run lint`.
8. Run relevant daemon unit tests.
9. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- `session.config.provider` is preserved through the entire session lifecycle.
- Switching models via alias correctly resolves the provider from model info.
- `bun run typecheck` and `bun run lint` pass.
- All existing tests pass plus new model-switch routing tests.

**Dependencies:** Task 2.1, Task 1.2

---

### Task 2.3: Provider-Aware Model Resolution in model-service

**Description:** Update `getModelInfo` and `resolveModelAlias` in model-service to support disambiguating models by provider context when the same model ID exists in multiple providers.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/lib/model-service.ts`:
   - Add an optional `providerId` parameter to `getModelInfo(idOrAlias, cacheKey?, providerId?)`.
   - When `providerId` is specified, prefer models whose `provider` field matches.
   - Add the same parameter to `resolveModelAlias`.
3. Update callers that have provider context available:
   - `model-switch-handler.ts` -- pass `session.config.provider` to `getModelInfo` and `resolveModelAlias`.
   - `session-handlers.ts` `session.model.get` -- pass provider from session config.
4. Write unit tests for provider-filtered model resolution.
5. Run `bun run typecheck` and `bun run lint`.
6. Run `cd packages/daemon && bun test tests/unit/` with relevant test files.
7. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- `getModelInfo('claude-sonnet-4.6', 'global', 'anthropic-copilot')` returns the copilot model entry.
- `getModelInfo('claude-sonnet-4.6', 'global')` returns the first match (anthropic, for backward compatibility).
- `bun run typecheck` and `bun run lint` pass.
- All existing tests pass plus new provider-filtered resolution tests.

**Dependencies:** Task 1.1, Task 1.2
