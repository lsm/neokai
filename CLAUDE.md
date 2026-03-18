# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NeoKai is a web UI for Claude Code — a browser-based interface for AI-assisted development. It provides multi-session conversations, model switching, file/git operations, MCP server support, and rewind/checkpoint functionality.

## Tech Stack

- **Runtime**: Bun (1.3.8+)
- **Backend**: Hono (HTTP server) + Claude Agent SDK
- **Frontend**: Preact + Preact Signals + Vite + Tailwind CSS
- **Database**: SQLite
- **Communication**: Custom MessageHub protocol (RPC + pub/sub over WebSocket)
- **Testing**: Bun native tests (daemon/shared/cli), Vitest (web), Playwright (e2e)

## Monorepo Structure

```
packages/
  cli/      # CLI entry point (`kai` command), HTTP server wrapper
  daemon/   # Backend API, agent orchestration, session management
  shared/   # Shared types, MessageHub protocol, provider abstractions
  web/      # Frontend UI (Preact components, hooks, signals)
  e2e/      # End-to-end Playwright tests
```

Packages use `workspace:*` for interdependencies. The `shared` package is imported by both `daemon` and `web`.

Each package's `tsconfig.json` defines path aliases that resolve to source files directly (no build step needed):
- `@neokai/shared` → `packages/shared/src/mod.ts`
- `@neokai/shared/*` → `packages/shared/src/*`
- `@neokai/daemon` → `packages/daemon/main.ts`
- `@neokai/daemon/*` → `packages/daemon/src/*`
- `@/*` → package-local `./src/*`

## Commands

```bash
# Development
make dev WORKSPACE=/path/to/workspace    # Start dev server on random available port

# Production
make serve-random WORKSPACE=/path/to/workspace   # Production server on random port
make run WORKSPACE=/path/to/workspace [PORT=8080] # Production server (PORT optional)

# Testing
make test-daemon       # Daemon tests only (bun test) with coverage
make test-web          # Web tests only (vitest run) with coverage

# Run a single test file
cd packages/daemon && bun test tests/unit/some-test.test.ts
cd packages/web && bunx vitest run src/some-test.test.ts
make run-e2e TEST=tests/features/some-test.e2e.ts

# Quality checks
bun run check             # All checks: lint + typecheck + knip
bun run lint              # Oxlint
bun run lint:fix          # Oxlint with auto-fix
bun run format            # Biome format (write)
bun run format:check      # Biome format (check only)
bun run typecheck         # TypeScript build check

# Build
make build                # Build web production bundle
make compile              # Compile binary for current platform
```

## Code Style

- **Formatter**: Biome — tab indentation, single quotes, semicolons always, trailing commas (ES5), line width 100
- **JSX quotes**: Double quotes in JSX (`jsxQuoteStyle: "double"`), single quotes in JS
- **Linter**: Oxlint — `no-explicit-any` (error), `no-unused-vars` (error), `no-console` (error)
- **Unused exports**: Knip checks for dead exports
- **JSX**: Preact automatic runtime (not React)
- **Console calls are forbidden** in application code. For startup output in entry points, use conditional logging:
  ```ts
  const logInfo = verbose ? console.log : () => {};
  ```
  Test files, setup files, entry points (`main.ts`, `app.ts`), and CLI are exempt (see `.oxlintrc.json` ignorePatterns).

## Environment Configuration

Bun automatically loads `.env` and `.env.local` files at startup (no dotenv package needed). See `packages/daemon/.env.example` for all options.

Credential discovery order (in `packages/daemon/src/lib/config.ts`):
1. Environment variables (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`)
2. `~/.claude/.credentials.json` (Claude Code login)
3. macOS Keychain (Claude Code login)
4. `~/.claude/settings.json` env block (third-party providers)

**Gotcha**: The daemon deletes `process.env.CLAUDECODE` at startup so SDK subprocesses don't refuse to start when the daemon itself runs inside a Claude Code session.

## Architecture

### Backend (daemon)

The daemon creates a `DaemonApp` context (`packages/daemon/src/app.ts`) that wires together:
- **StateManager**: Centralized session state synchronization
- **SessionManager**: Session lifecycle and metadata
- **SettingsManager**: Configuration persistence
- **AuthManager**: Authentication (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN)
- **WorktreeManager**: Isolated development contexts via git worktrees

Key directories in `packages/daemon/src/lib/`:
- `agent/` — Agent session lifecycle and execution
- `providers/` — Multi-provider abstraction (Anthropic, GLM)
- `session/` — Session state and metadata management
- `rpc-handlers/` — RPC command handlers (file ops, git, execution)

### Frontend (web)

Preact with Signals for reactivity. Key patterns:
- Island-based components in `src/islands/`
- Custom hooks in `src/hooks/` (useMessageHub, useSessionActions, useSendMessage, etc.)
- `ChatContainer.tsx` is the main chat UI component

### Communication

MessageHub protocol provides unified RPC + pub/sub over WebSocket between web client and daemon. Defined in `packages/shared/src/message-hub/`.

Three-layer architecture:
1. **MessageHubRouter** — Pure routing layer (no app logic)
2. **MessageHub** — Protocol layer (owns Router and Transport)
3. **WebSocketServerTransport** — I/O layer (uses Router for client management)

Initialization order matters: Router → MessageHub, then Transport → MessageHub.

### Test Organization

- `packages/daemon/tests/unit/` — Unit tests
- `packages/daemon/tests/online/` — Online tests (matrixized by module, mock SDK by default, real API with NEOKAI_TEST_ONLINE=true)
- `packages/e2e/tests/` — Browser automation tests

Unit tests preload `packages/daemon/tests/unit/setup.ts` which sets `NODE_ENV='test'`, clears all API keys (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, GLM_API_KEY, ZHIPU_API_KEY), and suppresses console output. This ensures unit tests never make real API calls.

#### Dev Proxy Mode for Online Tests

Use `NEOKAI_USE_DEV_PROXY=1` for mocked online tests:

```bash
NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/convo/multiturn-conversation.test.ts
```

Behavior when this flag is enabled in `createDaemonServer()`:
- Dev Proxy is required; if unavailable, tests fail fast (no silent fallback)
- `CLAUDE_CODE_OAUTH_TOKEN` is cleared
- `ANTHROPIC_AUTH_TOKEN` is cleared
- `ANTHROPIC_API_KEY` is replaced with a dummy test key
- Dev Proxy is reused across tests in the same process by default (`NEOKAI_DEV_PROXY_REUSE=1`)

This prevents accidental use of real Anthropic credentials in dev-proxy test runs.

To verify requests are mocked, inspect:

```bash
# Optional: persist helper-collected logs
NEOKAI_DEV_PROXY_CAPTURE_LOGS=1 NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/convo/multiturn-conversation.test.ts
tail -n 120 .devproxy/devproxy.log

# Or query live logs from devproxy
devproxy logs --lines 120 --output text
```

Expected lines include:
- `req ... POST http://127.0.0.1:8000/v1/messages?beta=true`
- `mock ... MockResponsePlugin: 200 ...`

#### E2E Test Rules

E2E tests are **pure browser-based Playwright tests** simulating real end-user interactions. They must NOT contain direct API calls or internal state access.

**Core Principles:**
- All test actions must go through the UI: clicks, typing, navigation, keyboard shortcuts
- All assertions must verify visible DOM state: text content, element visibility, CSS classes
- Sessions must be created via the "New Session" button, never via RPC (`session.create`)
- WebSocket disconnection simulation must use `closeWebSocket()` / `restoreWebSocket()` helpers (from `connection-helpers.ts`), which close the WebSocket via `page.evaluate()` to trigger real browser close events. Do NOT use `page.context().setOffline()` - it blocks new requests but doesn't close existing WebSockets

**Prohibited in test actions/assertions:**
- `hub.request()`, `hub.event()` — no direct MessageHub RPC calls
- `window.sessionStore`, `window.globalStore`, `window.appState` — no reading internal state for assertions
- `connectionManager.simulateDisconnect()` — use `closeWebSocket()` helper instead
- `page.context().setOffline()` — doesn't close WebSockets, use `closeWebSocket()` helper instead
- `window.__stateChannels` — internal state channel access

**Allowed exceptions (infrastructure only):**
- Session cleanup in `afterEach`/teardown via `hub.request('session.delete', ...)` — reliability matters for cleanup
- Room create/delete in `beforeEach`/`afterEach` via `hub.request('room.create', ...)` / `hub.request('room.delete', ...)` — accepted infrastructure pattern for test isolation
- Session ID extraction in `waitForSessionCreated()` helper — reads signals as fallback for URL-based extraction
- `waitForWebSocketConnected()` — may check hub state as fallback alongside UI indicator
- Global teardown (`global-teardown.ts`) — RPC-based session/worktree cleanup

---

### Running E2E Tests

**Standard usage — self-contained, starts its own server on a random port:**
```bash
make run-e2e TEST=tests/features/slash-cmd.e2e.ts
make run-e2e                                        # run all tests
```

`make run-e2e` builds the web bundle, picks a random available port, starts the server, runs the tests, then shuts everything down. No pre-running server needed.

**If using `make self` (port 9983) and want to run against that server:**
```bash
make self-test TEST=tests/core/navigation-3-column.e2e.ts
```

**How the lock file works:**
- `make self` and `make run` write the port to `tmp/.dev-server-running`
- If that lock file exists and you run tests without `E2E_PORT` or `PLAYWRIGHT_BASE_URL`, tests abort with instructions — this prevents accidentally starting a second server on a conflicting port
- `make run-e2e` sets `E2E_PORT` internally, so the lock file check is skipped

**Other notes:**
- Always run a single E2E test file at a time — too slow to run all together
- If a test scenario can't be triggered through the UI (e.g., token expiry, malformed server responses), it belongs in daemon integration tests, not E2E

## Branching Strategy & CI

- **`dev`** (default): Active development. PRs target `dev`. E2E tests run after merge.
- **`main`**: Production-ready. Only accepts PRs from `dev` (enforced by CI). Full test suite on PR.
- Feature branches are created from `dev`.

### Credential-Dependent Online Tests — Hard Fail Rule

**Online tests that require real provider credentials must FAIL, not skip, when those credentials are absent or non-functional.**

- Do NOT add `if (!process.env.SOME_TOKEN) { return; }` skip guards in online tests.
- Do NOT silently skip tests because a secret is unset — that masks misconfiguration.
- If a required secret (e.g., `COPILOT_GITHUB_TOKEN`, `GLM_API_KEY`) is not configured in CI, the test must fail. That failure is intentional: it tells the team to configure the secret.
- The CI workflow is the contract. If a test module appears in the matrix, it is expected to pass. Secrets must be provisioned accordingly.

This rule ensures CI always verifies that external API credentials are properly set up and working, not just that the test code compiles.

| Event | Tests Run |
|-------|-----------|
| PR → `dev` | Lint, type check, unit tests, integration tests (fast) |
| Merge to `dev` | All tests including E2E |
| PR → `main` | All tests including E2E |

## Commit Convention

Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`
