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

## Commands

```bash
# Development
make dev                  # Start dev server on port 9283 (workspace: tmp/workspace)
make dev-random           # Start dev server on random available port

# Testing
make test:daemon       # Daemon tests only (bun test)
make test:web          # Web tests only (vitest run)

# Run a single test file
cd packages/daemon && bun test tests/unit/some-test.test.ts
cd packages/web && bunx vitest run src/some-test.test.ts
cd packages/e2e && bunx playwright test tests/some-test.e2e.ts

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
- **Linter**: Oxlint — `no-explicit-any` (error), `no-unused-vars` (error)
- **Unused exports**: Knip checks for dead exports
- **JSX**: Preact automatic runtime (not React)

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

### Test Organization

- `packages/daemon/tests/unit/` — Unit tests
- `packages/daemon/tests/integration/` — Integration tests (matrixized by module: agent, session, rpc, database, filesystem, websocket, git, components, mcp)
- `packages/daemon/tests/online/` — Tests requiring API credentials
- `packages/e2e/tests/` — Browser automation tests

#### Notes for E2E 
Always run single e2e testing file at a time, it's too slow to run all e2e together because we have so many.

## Branching Strategy

- **`dev`** (default): Active development. PRs target `dev`. E2E tests run after merge.
- **`main`**: Production-ready. Only accepts PRs from `dev`. Full test suite on PR.
- Feature branches are created from `dev`.

## Commit Convention

Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`
