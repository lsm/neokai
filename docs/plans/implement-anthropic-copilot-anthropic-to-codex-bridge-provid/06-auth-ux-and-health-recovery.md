# Milestone 6: Auth UX and Health/Recovery

## Goal

Add first-class auth status indicators in the chat UI so users can see at a glance whether their provider is authenticated. Implement health-check polling and graceful degradation when a provider becomes unavailable mid-session.

## Scope

- `packages/web/src/components/SessionStatusBar.tsx` -- Auth status indicator
- `packages/web/src/components/settings/ProvidersSettings.tsx` -- Provider health display
- `packages/daemon/src/lib/rpc-handlers/auth-handlers.ts` -- Auth refresh triggers
- `packages/daemon/src/lib/providers/anthropic-copilot/provider.ts` -- Health check
- `packages/daemon/src/lib/providers/anthropic-to-codex-bridge-provider.ts` -- Health check

---

### Task 6.1: Auth Status Indicator in Chat UI

**Description:** Show a small auth status indicator near the provider badge in the session status bar. When the current session's provider is not authenticated or has an expiring token, show a warning icon with actionable tooltip text.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In `packages/web/src/components/SessionStatusBar.tsx`:
   - After the provider badge (from Task 3.2), add a conditional auth status indicator:
     - Green check: authenticated and healthy.
     - Yellow warning: token expiring soon (`needsRefresh: true`).
     - Red X: not authenticated.
   - On click/hover, show a tooltip with the error message from `getAuthStatus()` and a link to the providers settings page.
3. Fetch the auth status for the current session's provider via the `auth.providers` RPC endpoint on session load and when the provider changes.
4. Cache the result in a signal to avoid excessive polling.
5. Run `bun run typecheck` and `bun run lint`.
6. Run web tests.
7. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- Auth status indicator is visible near the provider badge.
- Unauthenticated state shows red indicator with actionable error message.
- Token-expiring state shows yellow indicator.
- Authenticated state shows green indicator (or no indicator for minimal visual noise).
- Clicking the indicator navigates to provider settings.
- `bun run typecheck` and `bun run lint` pass.

**Dependencies:** Task 3.2

---

### Task 6.2: Graceful Degradation on Provider Unavailability

**Description:** When a provider becomes unavailable mid-session (e.g., token expires, bridge server crashes), display a user-friendly error message in the chat UI instead of raw API errors. Provide actionable recovery options.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. In the daemon's error handling layer (likely `packages/daemon/src/lib/error-manager.ts` or the agent session error handler):
   - Detect provider-specific errors: authentication failures (401/403), bridge server unreachable (ECONNREFUSED), Copilot SDK errors.
   - Map these to a new `ErrorCategory` like `PROVIDER_AUTH_ERROR` or `PROVIDER_UNAVAILABLE`.
3. In the web chat UI error display:
   - When a `PROVIDER_AUTH_ERROR` is received, show a banner with:
     - "Authentication with [Provider Name] has expired. Click here to re-authenticate."
     - A button that opens the provider settings or triggers the OAuth flow.
   - When a `PROVIDER_UNAVAILABLE` error is received, show:
     - "[Provider Name] is temporarily unavailable. You can switch to another provider or try again."
     - A button to switch to the default provider.
4. Add unit tests for error categorization.
5. Run `bun run typecheck` and `bun run lint`.
6. Run relevant daemon and web tests.
7. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- Provider auth errors are categorized and displayed with actionable messages.
- Provider unavailability errors suggest switching to another provider.
- No raw API errors are shown to the user for provider-specific failures.
- Unit tests verify error categorization.
- `bun run typecheck` and `bun run lint` pass.

**Dependencies:** Task 3.2, Task 5.1
