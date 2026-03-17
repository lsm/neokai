# Milestone 1: Shared Type System Updates

## Goal

Widen the `Provider` type union in `packages/shared/src/types.ts` to include `anthropic-copilot` and `anthropic-codex`. Update all downstream type references, remove unsafe `as any` casts, and ensure the build passes.

## Scope

- `packages/shared/src/types.ts` -- Provider type union
- `packages/daemon/src/lib/agent/model-switch-handler.ts` -- Remove `as any` and `as 'anthropic' | 'glm'` casts
- `packages/daemon/src/lib/session/session-lifecycle.ts` -- Remove `as 'anthropic' | 'glm' | 'minimax'` cast (line 733)
- `packages/daemon/src/lib/provider-service.ts` -- Update `getProviderApiKey` to handle new providers
- `packages/web/src/hooks/useModelSwitcher.ts` -- Add `PROVIDER_LABELS` entries
- All files with unsafe `Provider` casts

> **Note on dual `Provider` types:** The codebase has two types named `Provider`:
> 1. `packages/shared/src/types.ts` line 188: `type Provider = 'anthropic' | 'glm' | 'minimax'` (narrow string union used in `SessionConfig.provider`) — **this is what Task 1.1 widens.**
> 2. `packages/shared/src/provider/types.ts` line 112: `interface Provider { id: ProviderId; ... }` (provider interface where `ProviderId = string`) — **this already accepts any string and needs no change.**

---

### Task 1.1: Widen Provider Type Union

**Description:** Add `'anthropic-copilot'` and `'anthropic-codex'` to the `Provider` type union in `packages/shared/src/types.ts`. Update the JSDoc comment to document each provider.

**Agent type:** coder

**Subtasks:**
1. Read `packages/shared/src/types.ts` and locate the `Provider` type (line 188).
2. Add `'anthropic-copilot' | 'anthropic-codex'` to the union.
3. Update the JSDoc comment above the type to document all five providers.
4. Run `bun run typecheck` to identify all type errors caused by the widened union.
5. Fix any switch/exhaustive-check errors in shared package code.
6. Run `bun run typecheck` again to confirm clean build.
7. Run `bun run lint` to confirm no lint issues.
8. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- `Provider` type includes all five providers: `'anthropic' | 'glm' | 'minimax' | 'anthropic-copilot' | 'anthropic-codex'`.
- `bun run typecheck` passes with zero errors.
- `bun run lint` passes.
- No `as any` casts related to provider type remain in the shared package.

**Dependencies:** None

---

### Task 1.2: Remove Unsafe Provider Casts in Daemon

**Description:** Remove all `as any` and `as 'anthropic' | 'glm'` casts when assigning `session.config.provider` throughout the daemon package. The widened `Provider` type should make these unnecessary.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Search for `as any` and `as 'anthropic'` patterns in `packages/daemon/src/` related to provider assignment.
3. In `packages/daemon/src/lib/agent/model-switch-handler.ts`, remove the `as any` casts on lines 160, 169, 195, 204 and the `as 'anthropic' | 'glm'` casts. Use the proper widened `Provider` type.
4. In `packages/daemon/src/lib/session/session-lifecycle.ts`, remove the `as 'anthropic' | 'glm' | 'minimax'` cast on line 733. The widened `Provider` union now includes all providers, making this cast unnecessary.
5. In `packages/daemon/src/lib/provider-service.ts`, update `getProviderApiKey` to handle `'anthropic-copilot'` and `'anthropic-codex'` cases (can return `undefined` for now since auth is handled internally by those providers).
6. In `packages/daemon/src/lib/provider-service.ts`, ensure `toLegacyProviderInfo` handles the new provider IDs.
7. Search for any other `provider.id as Provider` or `provider.id as any` patterns and fix them.
7. Run `bun run typecheck` to confirm clean build.
8. Run `bun run lint` to confirm no lint issues.
9. Run daemon unit tests: `cd packages/daemon && bun test tests/unit/providers/ --timeout 60000`.
10. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- Zero `as any` or `as 'anthropic' | 'glm'` casts related to provider assignment in the daemon package.
- `bun run typecheck` passes.
- `bun run lint` passes.
- All existing daemon provider unit tests pass.

**Dependencies:** Task 1.1

---

### Task 1.3: Update Web UI Provider Labels

**Description:** Add the missing `'anthropic-codex': 'Codex'` entry to `PROVIDER_LABELS` in the web package. (`'anthropic-copilot': 'Copilot'` already exists at line 79, and `FAMILY_ORDER` already contains `gpt` and `gemini` at lines 69-70 — no changes needed for those.)

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/web/src/hooks/useModelSwitcher.ts`:
   - Add `'anthropic-codex': 'Codex'` to `PROVIDER_LABELS` (the only missing entry).
3. Run `bun run typecheck` to confirm clean build.
4. Run `bun run lint`.
5. Run web tests: `cd packages/web && bunx vitest run src/hooks/__tests__/useModelSwitcher.test.ts`.
6. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- `PROVIDER_LABELS` has entries for all five providers (anthropic, glm, minimax, anthropic-copilot, anthropic-codex).
- `bun run typecheck` and `bun run lint` pass.
- Existing web tests pass.

**Dependencies:** Task 1.1
