# Daemon Package

Backend API, agent orchestration, and session management.

## Architecture

The daemon creates a `DaemonApp` context (`src/app.ts`) that wires together all managers:
- **StateManager** (`src/lib/state-manager.ts`) — Centralized session state synchronization
- **SessionManager** (`src/lib/session/session-manager.ts`) — Session lifecycle and metadata
- **SettingsManager** (`src/lib/settings-manager.ts`) — Configuration persistence
- **AuthManager** (`src/lib/auth-manager.ts`) — Authentication (API key or OAuth token)
- **WorktreeManager** (`src/lib/worktree-manager.ts`) — Isolated development contexts via git worktrees

## Key directories

```
src/lib/
├── agent/          # Agent session lifecycle, SDK message handling, rewind, interrupts
├── room/           # Multi-agent room orchestration
│   ├── agents/     # Leader, planner, coder, general agent configs
│   ├── managers/   # RoomManager, GoalManager, TaskManager
│   ├── runtime/    # RoomRuntime orchestrator, message routing, recovery
│   ├── state/      # SessionGroupRepository
│   └── tools/      # Room agent MCP tools
├── providers/      # Multi-provider abstraction (Anthropic, OpenAI, GLM, etc.)
├── session/        # Session state, lifecycle, tools config
├── rpc-handlers/   # RPC command handlers (organized by domain)
├── github/         # GitHub integration and PR review
└── lobby/          # Lobby state
```

## Storage layer

```
src/storage/
├── database.ts           # Main database wrapper
├── reactive-database.ts  # Change event emission
├── live-query.ts         # Live query subscriptions
├── repositories/         # Data access (session, room, goal, task, etc.)
└── schema/               # Schema definitions and migrations
```

## RPC handler pattern

Each handler file exports a `setup*Handlers()` function registered in `rpc-handlers/index.ts`. When adding a new RPC endpoint:
1. Create or extend a handler file in `src/lib/rpc-handlers/`
2. Register it in `index.ts`
3. Add the RPC type to `@neokai/shared` types

## Room Runtime

The Room Runtime implements a **Worker → Leader → Human** loop:
- **Worker** (planner/coder/general) executes tasks
- **Leader** reviews output and provides feedback or marks complete/failed
- **Human** approves, rejects, or provides guidance when escalated

State machine: `awaiting_worker → awaiting_leader → (feedback loop) → awaiting_human | completed | failed`

Design details: `docs/design/room-runtime-spec.md`

## Test organization

```
tests/
├── unit/     # Fast unit tests, preload setup.ts (NODE_ENV=test, clears API keys)
├── online/   # Integration tests (mock SDK by default, real API with NEOKAI_TEST_ONLINE=true)
├── helpers/  # Test utilities
└── fixtures/ # Test data
```

```bash
# Run unit tests
bun test tests/unit/some-test.test.ts

# Run with coverage
make test:daemon
```

Unit test `setup.ts` clears all API keys and suppresses console output to ensure no real API calls.
