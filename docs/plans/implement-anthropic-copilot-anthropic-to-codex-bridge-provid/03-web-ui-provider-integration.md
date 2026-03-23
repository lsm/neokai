# Milestone 3: Web UI Provider Integration

## Goal

Make both providers fully selectable in the UI. Support create, resume, switch, and multi-session flows with provider-grouped model display, provider indicators, and availability indicators.

## Scope

- `packages/web/src/hooks/useModelSwitcher.ts` -- Provider grouping in model list
- `packages/web/src/components/SessionStatusBar.tsx` -- Provider indicator
- `packages/web/src/components/settings/ProvidersSettings.tsx` -- Auth status display
- `packages/web/src/islands/MainContent.tsx` -- Session creation with provider
- Model picker dropdown (wherever implemented)

---

### Task 3.1: Provider-Grouped Model Picker

**Description:** Update the model picker dropdown to group models by provider, showing a provider header above each group. Include availability indicators (green/gray dot) next to each provider group header. Ensure cross-provider model switching works.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/web/src/hooks/useModelSwitcher.ts`:
   - Modify model sorting to group by provider first, then by family order within each provider group.
   - Export a helper function `groupModelsByProvider(models: ModelInfo[]): Map<string, ModelInfo[]>` for UI consumption.
3. In `packages/web/src/components/SessionStatusBar.tsx`:
   - Locate the model picker dropdown rendering.
   - Render provider group headers using `getProviderLabel()`.
   - Add a visual separator between provider groups.
   - Show a green/gray availability dot in the provider group header based on whether the provider has authenticated.
4. **Cross-provider model switching requires an RPC interface change.** Currently `session.model.switch` only sends `{ sessionId, model: newModelId }` (see `packages/web/src/hooks/useModelSwitcher.ts` lines 195-202), and the daemon's `ModelSwitchHandler.switchModel()` infers provider from the alias via `modelInfo?.provider`. To support explicit cross-provider switching:
   - In `packages/shared/`, update the `session.model.switch` RPC request type to include an optional `provider?: Provider` field.
   - In `packages/daemon/src/lib/agent/model-switch-handler.ts`, update `switchModel()` to accept and prefer the explicit `provider` parameter when present (falling back to alias inference if absent, for backwards compatibility).
   - In `packages/web/src/hooks/useModelSwitcher.ts`, when the selected model's `provider` field differs from the current session's provider, include `provider` in the `session.model.switch` RPC call.
   - This is a non-trivial interface change that touches shared types, daemon handler, and web client. It depends on Task 2.2 (provider ID flow) being complete.
5. Run `bun run typecheck` and `bun run lint`.
6. Run web tests: `cd packages/web && bunx vitest run`.
7. Write a test in `packages/web/src/hooks/__tests__/useModelSwitcher.test.ts` for the `groupModelsByProvider` helper.
8. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- Models are visually grouped by provider in the dropdown.
- Provider label is shown as group header.
- Selecting a model from a different provider triggers a cross-provider model switch.
- `bun run typecheck` and `bun run lint` pass.
- New and existing web tests pass.

**Dependencies:** Task 1.3, Task 2.2

---

### Task 3.2: Provider Indicator in Session Status Bar

**Description:** Show the current provider name/icon in the session status bar next to the model name, so users can see at a glance which provider backend is active. This is important because the same model ID (e.g., `claude-opus-4.6`) can come from different providers.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/web/src/components/SessionStatusBar.tsx`:
   - After the model name display, add a provider badge showing the provider label (e.g., "Copilot", "Codex", "Anthropic").
   - Use a subtle chip/badge style that does not visually dominate but is clearly visible.
   - Color-code by provider: Anthropic (default/no badge), Copilot (GitHub-style), Codex (OpenAI-style).
3. Pass the model's `provider` field from `currentModelInfo` to the badge component.
4. Run `bun run typecheck` and `bun run lint`.
5. Run web tests: `cd packages/web && bunx vitest run src/components/__tests__/SessionStatusBar.test.tsx`.
6. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- Provider badge is visible next to model name in the session status bar.
- Badge correctly shows the provider for the current session's model.
- Anthropic provider shows minimal or no badge (it is the default).
- `bun run typecheck` and `bun run lint` pass.
- Tests pass.

**Dependencies:** Task 1.3

---

### Task 3.3: Provider-Aware Session Creation

**Description:** When creating a new session via the UI, allow the user to select a model from any available provider. Ensure the session's `config.provider` is set based on the selected model's provider field.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Find the session creation flow in the web codebase (likely in `packages/web/src/islands/MainContent.tsx` or a create-session component).
3. If the session creation UI has a model selector, ensure it uses the provider-grouped model list from Task 3.1.
4. When calling `session.create`, include `config.provider` derived from the selected model's `provider` field.
5. If the session creation flow does not have an explicit model selector (it uses the default model), ensure the default model's provider is set correctly.
6. Run `bun run typecheck` and `bun run lint`.
7. Run web tests.
8. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- Sessions created with a Copilot model have `config.provider: 'anthropic-copilot'`.
- Sessions created with a Codex model have `config.provider: 'anthropic-codex'`.
- Default session creation still works with `'anthropic'` provider.
- `bun run typecheck` and `bun run lint` pass.

**Dependencies:** Task 3.1
