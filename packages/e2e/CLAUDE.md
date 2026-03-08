# E2E Tests

E2E tests are **pure browser-based Playwright tests** simulating real end-user interactions. They must NOT contain direct API calls or internal state access.

## Core Principles

- All test actions must go through the UI: clicks, typing, navigation, keyboard shortcuts
- All assertions must verify visible DOM state: text content, element visibility, CSS classes
- Sessions must be created via the "New Session" button, never via RPC (`session.create`)
- WebSocket disconnection simulation must use `closeWebSocket()` / `restoreWebSocket()` helpers (from `helpers/connection-helpers.ts`), which close the WebSocket via `page.evaluate()` to trigger real browser close events. Do NOT use `page.context().setOffline()` — it blocks new requests but doesn't close existing WebSockets

## Prohibited in test actions/assertions

- `hub.request()`, `hub.event()` — no direct MessageHub RPC calls
- `window.sessionStore`, `window.globalStore`, `window.appState` — no reading internal state for assertions
- `connectionManager.simulateDisconnect()` — use `closeWebSocket()` helper instead
- `page.context().setOffline()` — doesn't close WebSockets, use `closeWebSocket()` helper instead
- `window.__stateChannels` — internal state channel access

## Allowed exceptions (infrastructure only)

- Session cleanup in `afterEach`/teardown via `hub.request('session.delete', ...)` — reliability matters for cleanup
- Session ID extraction in `waitForSessionCreated()` helper — reads signals as fallback for URL-based extraction
- `waitForWebSocketConnected()` — may check hub state as fallback alongside UI indicator
- Global teardown (`global-teardown.ts`) — RPC-based session/worktree cleanup

## Running E2E Tests

```bash
# Self-contained, starts its own server on a random port:
make run-e2e TEST=tests/features/slash-cmd.e2e.ts
make run-e2e                                        # run all tests

# Against a running `make self` server (port 9983):
make self-test TEST=tests/core/navigation-3-column.e2e.ts
```

- `make run-e2e` builds the web bundle, picks a random available port, starts the server, runs tests, then shuts down
- Always run a single E2E test file at a time — too slow to run all together
- If a test scenario can't be triggered through the UI (e.g., token expiry, malformed server responses), it belongs in daemon integration tests, not E2E

## Lock file

- `make self` and `make run` write the port to `tmp/.dev-server-running`
- If that lock file exists and you run tests without `E2E_PORT` or `PLAYWRIGHT_BASE_URL`, tests abort with instructions
- `make run-e2e` sets `E2E_PORT` internally, so the lock file check is skipped

## Test organization

```
tests/
├── core/          # Navigation, session management, layout
├── features/      # Feature-specific (slash commands, MCP, etc.)
├── settings/      # Settings panel tests
├── read-only/     # Non-destructive tests
├── responsive/    # Responsive layout tests
├── serial/        # Tests that must run sequentially
├── smoke/         # Quick smoke tests
├── helpers/       # Shared test helpers
└── fixtures/      # Test fixtures
```

## Helpers

- `connection-helpers.ts` — WebSocket close/restore for disconnection testing
- `wait-helpers.ts` — Event-based waits instead of arbitrary timeouts
- `session-archive-helpers.ts` — Session archive/restore helpers
- `slash-command-helpers.ts` — Slash command interaction helpers
- `settings-modal-helpers.ts` — Settings modal navigation
- `interruption-helpers.ts` — Agent interruption testing
- `mcp-toggle-helpers.ts` — MCP server toggle helpers
