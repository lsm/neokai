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

**Description:** Add a `detectProviderForModel(modelId, preferredProviderId?)` method to `ProviderRegistry` that prefers an explicit provider when available and logs warnings on collisions. Then update `detectProvider` to delegate to it.

**Agent type:** coder

**Important implementation note:** The existing `detectProvider` short-circuits via `for...of` and returns on the first match. The new `detectProviderForModel` must instead **collect all matching providers** before returning, so it can detect and log collisions. When `detectProvider` delegates to the new method (with no preference), the **return value stays the same** (first registered match), but the **internal behavior changes**: it now iterates all providers to check for collisions and logs a warning if multiple providers claim the same model ID. This is an intentional behavioral change needed for collision detection.

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/lib/providers/registry.ts`, add a new method `detectProviderForModel(modelId: string, preferredProviderId?: string)`:
   - Iterate **all** registered providers, collecting those whose `ownsModel(modelId)` returns true.
   - If `preferredProviderId` is provided and exists in the match set, return it.
   - If more than one provider claims the model, log a warning with all colliding provider IDs (e.g., `"Model 'claude-opus-4.6' claimed by multiple providers: anthropic, anthropic-copilot. Using anthropic."`).
   - Return the first match from the collected set (preserving existing ordering for backwards compatibility).
3. Update `detectProvider` to delegate to `detectProviderForModel(modelId)` with no preference. The return value is unchanged, but collision warnings will now fire.
4. Write unit tests in `packages/daemon/tests/unit/providers/provider-registry.test.ts`:
   - Test that `detectProviderForModel('claude-opus-4.6', 'anthropic-copilot')` returns the copilot provider.
   - Test that `detectProviderForModel('claude-opus-4.6')` returns the first registered (anthropic) and logs a collision warning.
   - Test that `detectProviderForModel('gpt-5.3-codex', 'anthropic-codex')` returns the codex provider.
   - Test that `detectProvider('claude-opus-4.6')` still returns the same result as before (backwards-compatible).
5. Run `bun run typecheck` and `bun run lint`.
6. Run `cd packages/daemon && bun test tests/unit/providers/provider-registry.test.ts`.
7. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- `detectProviderForModel` correctly resolves to the preferred provider when specified.
- Collision case logs a warning listing all colliding provider IDs, then returns the first match.
- `detectProvider` delegates to `detectProviderForModel` and returns the same value as before (first match), but now also logs collision warnings.
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
5. **Note:** `getEnvVarsForModel` in `packages/daemon/src/lib/provider-service.ts` (lines 385-406) already accepts an optional `providerId` parameter and uses `registry.get(providerId)` when supplied — no change needed to the method itself. Instead, audit its callers (e.g., `query-runner.ts`, `model-switch-handler.ts`) and ensure they pass `session.config.provider` as the `providerId` argument so the existing logic is actually exercised.
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
