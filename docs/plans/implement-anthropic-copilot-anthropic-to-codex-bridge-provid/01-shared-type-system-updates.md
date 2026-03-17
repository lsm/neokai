# Milestone 1: Shared Type System Updates

## Goal

Widen the `Provider` type union in `packages/shared/src/types.ts` to include `anthropic-copilot` and `anthropic-codex`. Update all downstream type references, remove unsafe `as any` casts, and ensure the build passes.

## Scope

- `packages/shared/src/types.ts` -- Provider type union
- `packages/shared/src/provider/auth-types.ts` -- Auth types for new providers
- `packages/daemon/src/lib/agent/model-switch-handler.ts` -- Remove `as any` and `as 'anthropic' | 'glm'` casts
- `packages/daemon/src/lib/provider-service.ts` -- Update `getProviderApiKey` to handle new providers
- `packages/web/src/hooks/useModelSwitcher.ts` -- Add `PROVIDER_LABELS` entries
- All files with unsafe `Provider` casts

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
3. In `packages/daemon/src/lib/agent/model-switch-handler.ts`, remove the `as any` cast on line 160 and the `as 'anthropic' | 'glm'` cast on line 169. Use the proper `Provider` type.
4. In `packages/daemon/src/lib/provider-service.ts`, update `getProviderApiKey` to handle `'anthropic-copilot'` and `'anthropic-codex'` cases (can return `undefined` for now since auth is handled internally by those providers).
5. In `packages/daemon/src/lib/provider-service.ts`, ensure `toLegacyProviderInfo` handles the new provider IDs.
6. Search for any other `provider.id as Provider` or `provider.id as any` patterns and fix them.
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

### Task 1.3: Update Web UI Provider Labels and Family Icons

**Description:** Add provider labels and model family icons for `anthropic-copilot` and `anthropic-codex` in the web package, and ensure the `FAMILY_ORDER` sorting includes all model families from these providers.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/web/src/hooks/useModelSwitcher.ts`:
   - Add `'anthropic-codex': 'Codex'` to `PROVIDER_LABELS`.
   - Verify `'anthropic-copilot': 'Copilot'` already exists.
   - Confirm `FAMILY_ORDER` has entries for `gpt` and `gemini` (used by copilot models).
3. Run `bun run typecheck` to confirm clean build.
4. Run `bun run lint`.
5. Run web tests: `cd packages/web && bunx vitest run src/hooks/__tests__/useModelSwitcher.test.ts`.
6. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- `PROVIDER_LABELS` has entries for all five providers.
- `FAMILY_ORDER` covers all model families used by both new providers.
- `bun run typecheck` and `bun run lint` pass.
- Existing web tests pass.

**Dependencies:** Task 1.1
