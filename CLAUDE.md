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
make dev                  # Start dev server on port 9283 (workspace: tmp/workspace)
make dev-random           # Start dev server on random available port

# Testing
make test:daemon       # Daemon tests only (bun test) with coverage
make test:web          # Web tests only (vitest run) with coverage
cd packages/daemon && bun test tests/unit/some-test.test.ts   # Single test
cd packages/web && bunx vitest run src/some-test.test.ts      # Single test
make run-e2e TEST=tests/features/some-test.e2e.ts             # Single E2E test

# Quality checks
bun run check             # All checks: lint + typecheck + knip
bun run lint              # Oxlint
bun run format            # Biome format (write)
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

## Branching Strategy & CI

- **`dev`** (default): Active development. PRs target `dev`. E2E tests run after merge.
- **`main`**: Production-ready. Only accepts PRs from `dev` (enforced by CI). Full test suite on PR.
- Feature branches are created from `dev`.

## Commit Convention

Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`

## Deep Dive

- Package-specific guidance → `packages/*/CLAUDE.md`
- Architecture overview → `docs/ARCHITECTURE.md`
- Room Runtime design → `docs/design/room-runtime-spec.md`
- ADRs → `docs/adr/`
- Implementation plans → `docs/plans/`
