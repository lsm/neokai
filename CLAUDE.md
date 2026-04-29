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
make dev                                    # Start dev server on random available port
make dev PORT=8080                          # Start dev server on specific port
make dev PORT=8080 DB_PATH=/tmp/mydb.db    # Isolated DB (avoids lock conflicts)

# Production
make serve-random                 # Production server on random port
make run [PORT=8080]             # Production server (PORT optional)

# Testing
make test-daemon       # Daemon tests (all shards in parallel, with coverage)
make test-web          # Web tests only (vitest run) with coverage

# Daemon test runner (scripts/test-daemon.sh)
./scripts/test-daemon.sh                # All 7 shards in parallel (fast, no coverage)
./scripts/test-daemon.sh --coverage     # All shards with coverage
./scripts/test-daemon.sh 2-handlers     # Run a single shard
./scripts/test-daemon.sh --rerun        # Rerun only previously failing files
./scripts/test-daemon.sh --show-failures # Show failure details from last run

# Run a single test file
cd packages/daemon && bun test tests/unit/some-test.test.ts
cd packages/web && bunx vitest run src/some-test.test.ts
make run-e2e TEST=tests/features/some-test.e2e.ts

# E2E coverage
# Do not add or update e2e tests for ordinary code changes unless the task
# explicitly asks for e2e coverage. Prefer focused unit/component tests for
# scoped UI behavior changes.

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

### Skills System

The Skills system extends agent capabilities with slash commands, plugins, and MCP servers. Skills are configured globally at the application level and can be selectively enabled per room via room-level overrides.

**Data flow:**
```
Skills registry (SQLite) → SkillsManager → QueryOptionsBuilder → SDK session options
```

At session init, `QueryOptionsBuilder.build()` calls `SkillsManager.getEnabledSkills()` and injects enabled skills:
- `plugin` sourceType → adds `{ type: 'local', path }` to `SDKConfig.plugins`
- `mcp_server` sourceType → merges into `Options.mcpServers` (stdio/sse/http variants)

All three sourceTypes are actively injected by `QueryOptionsBuilder`: `plugin` and `builtin` via `buildPluginsFromSkills()` / `buildPluginsFromBuiltinSkills()`, and `mcp_server` via `getMcpServersFromSkills()`.

**Key files:**
- `packages/shared/src/types/skills.ts` — `AppSkill`, discriminated union configs (`BuiltinSkillConfig` / `PluginSkillConfig` / `McpServerSkillConfig`), `SkillValidationStatus`
- `packages/daemon/src/lib/skills-manager.ts` — `SkillsManager`: CRUD, validation, built-in initialization (seeds `chrome-devtools-mcp`, `playwright`, `playwright-interactive` on startup)
- `packages/daemon/src/lib/rpc-handlers/skill-handlers.ts` — RPC handlers: `skill.list`, `skill.get`, `skill.create`, `skill.update`, `skill.delete`, `skill.setEnabled`
- `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts` — `skills.list` and `skills.byRoom` named queries for reactive frontend sync
- `packages/daemon/src/lib/agent/query-options-builder.ts` — `buildPluginsFromSkills()`, `getMcpServersFromSkills()`, `getRoomDisabledSkillIds()` methods; room overrides only disable globally-enabled skills (cannot enable globally-disabled)
- `packages/web/src/lib/skills-store.ts` — `SkillsStore`: signal-based frontend store with LiveQuery subscription (`skills.list`)

See [`docs/features/skills.md`](docs/features/skills.md) for user-facing documentation.

### Space Agent User Message Anatomy

Every Space agent session receives a structured user message composed by
`buildCustomAgentTaskMessage` (`packages/daemon/src/lib/space/agents/custom-agent.ts`)
plus a runtime execution contract appended by the Task Agent Manager. The
message is action-first and workflow-aware:

1. `## Your Task` — task number, title, description, priority
2. `## Runtime Location` — worktree path, derived PR URL (`none yet` when no
   gate has recorded a `pr_url`)
3. `## Your Role in This Workflow` — current node, peers, outbound channels,
   gates writable by this node/agent (omitted outside a workflow)
4. `## Previous Work on This Goal` — bulleted summaries from prior tasks
5. `## Project Context` — `space.backgroundContext`
6. `## Standing Instructions` — `space.instructions` then
   `workflow.instructions`, merged under one heading

Slot prompts in `built-in-workflows.ts` (and any user-authored workflow) must
contain only **behavioral** instruction — what the agent does, how to use
tools, and any required step-by-step checklists. Do not re-state peers,
channel targets, gate IDs, or "X is my reviewer" chrome: that context is
injected centrally by the builder. Re-adding it creates drift when the
workflow graph is edited later.

A dev-mode warning is logged when the final user message exceeds 4 KB so
future prompt bloat surfaces during development without failing sessions.

### Test Organization

- `packages/daemon/tests/unit/` — Unit tests
- `packages/daemon/tests/online/` — Online tests (matrixized by module, mock SDK by default, real API with NEOKAI_TEST_ONLINE=true)
- `packages/e2e/tests/` — Browser automation tests

Unit tests preload `packages/daemon/tests/unit/setup.ts` which sets `NODE_ENV='test'`, clears all API keys (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, GLM_API_KEY, ZHIPU_API_KEY), and suppresses console output. This ensures unit tests never make real API calls.

#### Database Configuration for Tests

**⚠️ Important: Database Lock Conflicts**

The daemon uses a file-based SQLite database with a PID lock file (`~/.neokai/data/daemon.db.lock`). Running multiple daemons with the same database path will fail with:

```
Another NeoKai daemon is already running with this database (PID XXXX).
```

**Starting a dev server in a worktree (agents must do this):**

When working in a worktree, always start the dev server with an isolated `DB_PATH` so it does not conflict with any already-running production or development daemon:

```bash
# In the worktree root — picks a random port, uses an isolated DB
make dev PORT=8383 DB_PATH=/tmp/neokai-$(basename $PWD).db

# Or with a fully random temp path
make dev DB_PATH=$(mktemp -u /tmp/neokai-XXXXXX.db)
```

Never run `make dev` without `DB_PATH` in a worktree — it will fail with "Another NeoKai daemon is already running" if the main daemon is active.

**For testing scenarios that start a dev server:**
- Pass `DB_PATH=<path>` to `make dev` or `make run`
- This prevents conflicts with any running production daemon instance
- Example: `make dev PORT=8484 DB_PATH=/tmp/test-db.db`

**For E2E tests:**
- E2E tests use `make run-e2e` which handles database isolation automatically (uses temp directories)
- Do NOT run a separate `make dev` or `make run` while E2E tests are running

**In-memory database (preferred for unit tests):**
- Unit tests should use in-memory SQLite databases where possible
- This avoids filesystem conflicts and improves test speed
- See `packages/daemon/tests/unit/helpers/` for test database helpers

**Real filesystem database (for integration tests):**
- Use temporary directories (e.g., `/tmp/neokai-test-XXXXXX`)
- Clean up after tests complete
- E2E tests already follow this pattern via `e2e/` test isolation

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

## Space Runtime

### Space tool surface

Every session whose `session.context.spaceId` is set — **not just** the Space chat agent — is attached to the `space-agent-tools` MCP server at startup. This means worker sessions, coder sessions, room_chat sessions opened in a Space, and any ad-hoc sessions created with a Space as their context can all query Space state, read/write gate data, signal tasks, etc.

- **Wiring:** `SpaceRuntimeService.attachSpaceToolsToMemberSession(session)` runs for each member session (from `session.created` event + startup backfill). It uses `AgentSession.mergeRuntimeMcpServers({ 'space-agent-tools': … })` so other runtime-attached MCP servers (room tools, db-query, task-agent glue) are preserved.
- **Not re-attached here:** `space_chat` sessions (`setupSpaceAgentSession` already attaches) and `space_task_agent` sessions (TaskAgentManager attaches them during config build — attaching again afterwards would race with its `setRuntimeMcpServers`).
- **Permissions:** All gating (writer auth, autonomy level) happens inside the tool handlers themselves, so widening the surface is safe.
- **No `myAgentName` for ordinary members:** gate writer-authorization for member sessions falls through to the autonomy path, matching the existing contract.

### LiveQuery: `messages.bySession`

SDK messages for a session are published as a LiveQuery under the name `messages.bySession` in `packages/daemon/src/lib/rpc-handlers/live-query-handlers.ts`. The frontend `SessionStore` subscribes via `hub.request('liveQuery.subscribe', { queryName: 'messages.bySession', params: [sessionId, limit], subscriptionId })` and applies the resulting snapshot + delta stream — no per-message RPC fetch and no `state.sdkMessages.delta` event listening. Optimistic user echo is preserved via `pendingLocalMessageUuids` until the snapshot/delta includes the user's message.

---

## Mission System

The Mission System (Goal V2) extends the room's goal tracking with structured, automated workflows. Use the following terminology consistently across code, tests, and documentation.

### Mission Types

| Type | `missionType` value | Description |
|------|-------------------|-------------|
| One-shot | `one_shot` | Single-run goal with no metrics or schedule; the default. |
| Measurable | `measurable` | Tracks progress toward numeric KPIs via `structuredMetrics`. |
| Recurring | `recurring` | Runs on a cron schedule; creates a new execution each run. |

### Autonomy Levels

| Level | `autonomyLevel` value | Description |
|-------|----------------------|-------------|
| Supervised | `supervised` | Worker submits PRs for human review before merging. Default. |
| Semi-autonomous | `semi_autonomous` | Tasks auto-complete without human review at workflow completion. |

### Key Terminology

- **Mission** — The V2 term for a `RoomGoal`; use "mission" in UI copy and new API names. The DB table is still `goals` for backward compatibility.
- **Execution** — A single run of a recurring mission. Stored in `mission_executions` with a monotonically increasing `executionNumber`.
- **Metric** — A `MissionMetric` struct `{name, target, current, unit?}` in `structuredMetrics`. Measurable missions track one or more metrics.
- **Execution ID** — A UUID stored in the session group's metadata (`executionId`) that links worker/leader sessions to a specific execution record.
- **Schedule** — A cron expression plus timezone stored in `goal.schedule.expression` / `goal.schedule.timezone`. Use `@daily`, `@weekly`, or a 5-field cron string.

### Key Files

- `packages/daemon/src/lib/room/managers/goal-manager.ts` — Core `GoalManager`: CRUD, metric recording, execution management, scheduler tick.
- `packages/daemon/src/storage/repositories/goal-repository.ts` — SQLite persistence for goals and V2 columns.
- `packages/daemon/src/lib/room/runtime/cron-utils.ts` — Cron parsing, next-run computation, and catch-up detection.
- `packages/daemon/src/lib/rpc-handlers/goal-handlers.ts` — RPC handlers: `goal.create`, `goal.list`, `goal.update`, `goal.delete`, `goal.listExecutions`, etc.
- `packages/web/src/components/room/GoalsEditor.tsx` — Mission list UI, create/edit form with type-specific fields, metric progress bars, execution history.
- `packages/web/src/lib/room-store.ts` — `RoomStore.listExecutions()` — fetches execution history via `goal.listExecutions` RPC.

### DB Tables

- `goals` — Stores all missions with V2 columns: `mission_type`, `autonomy_level`, `schedule`, `next_run_at`, `structured_metrics`, `consecutive_failures`, `replan_count`.
- `mission_executions` — One row per execution run: `id`, `goal_id`, `execution_number`, `status`, `started_at`, `completed_at`, `result_summary`, `task_ids`.
- `mission_metric_history` — Time-series metric snapshots: `goal_id`, `metric_name`, `value`, `recorded_at`.

---

## Branching Strategy & CI

- **`dev`** (default): Active development. PRs target `dev`. Releases go directly from `dev` via version tags. E2E tests run after merge.
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
| Merge to `dev` | Lint, type check, unit tests, integration tests |
| `workflow_dispatch` | All tests including E2E |

## Commit Convention

Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`
