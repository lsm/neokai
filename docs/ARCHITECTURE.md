# Architecture Map

## Package Dependency Flow

```
cli → daemon → shared ← web
               e2e (independent, browser-only)
```

- `shared` is the base layer: types, MessageHub protocol, provider abstractions
- `daemon` imports `shared`, never `web`
- `web` imports `shared`, never `daemon` (communicates via MessageHub RPC)
- `cli` wraps `daemon` with HTTP server
- `e2e` tests interact only through the browser

## Key Entry Points

| Package | Entry | Purpose |
|---------|-------|---------|
| cli | `packages/cli/src/index.ts` | CLI startup, HTTP server |
| daemon | `packages/daemon/src/app.ts` | DaemonApp context bootstrap |
| web | `packages/web/src/index.ts` | Preact app initialization |
| shared | `packages/shared/src/mod.ts` | Shared exports barrel |

## Core Subsystems

| Subsystem | Location | Entry File | Description |
|-----------|----------|------------|-------------|
| Agent | `daemon/src/lib/agent/` | `agent-session.ts` | Single-agent session lifecycle, SDK message handling |
| Room Runtime | `daemon/src/lib/room/runtime/` | `room-runtime.ts` | Multi-agent task orchestration (Worker → Leader → Human) |
| Room Managers | `daemon/src/lib/room/managers/` | `room-manager.ts` | Room, goal, task CRUD |
| MessageHub | `shared/src/message-hub/` | `hub.ts` | RPC + pub/sub over WebSocket |
| State | `daemon/src/lib/state-manager.ts` | - | Centralized session state sync to clients |
| RPC Handlers | `daemon/src/lib/rpc-handlers/` | `index.ts` | All RPC endpoint registrations |
| Providers | `daemon/src/lib/providers/` | `factory.ts` | Multi-model provider abstraction |
| Storage | `daemon/src/storage/` | `database.ts` | SQLite, repositories, live queries |
| Session | `daemon/src/lib/session/` | `session-manager.ts` | Session lifecycle and metadata |

## Data Flow

```
1. User action in web → useMessageHub hook → RPC call over WebSocket
2. WebSocket → MessageHubRouter → RPC handler in daemon
3. Handler → business logic (managers, agent) → state update → DB write
4. State update → MessageHub event broadcast → WebSocket → web subscriber
5. Subscriber → Preact Signal/StateChannel update → UI re-render
```

## MessageHub Three-Layer Architecture

```
MessageHubRouter (pure routing, no app logic)
    ↕
MessageHub (protocol layer, owns Router + Transport)
    ↕
WebSocketServerTransport (I/O layer, uses Router for client management)
```

Initialization order: Router → MessageHub, then Transport → MessageHub.

## Room Runtime State Machine

```
awaiting_worker → awaiting_leader → (feedback loop) → awaiting_human | completed | failed
       ↑                  |
       └──── feedback ─────┘
```

- Worker (planner/coder/general) executes tasks
- Leader reviews and provides feedback or completes/fails
- Human approves, rejects, or provides guidance when escalated
- Design: `docs/design/room-runtime-spec.md`

## When Modifying

| Task | Where to look |
|------|---------------|
| Adding RPC endpoint | `daemon/src/lib/rpc-handlers/` — add handler, register in `index.ts`, add types to `shared` |
| Adding UI component | `web/src/components/` — follow island/component pattern, see `packages/web/CLAUDE.md` |
| Changing shared types | `shared/src/` — check both daemon and web consumers |
| Adding E2E test | `e2e/tests/` — must use UI only, see `packages/e2e/CLAUDE.md` |
| Adding provider | `daemon/src/lib/providers/` — implement provider interface, register in factory |
| Adding room agent tool | `daemon/src/lib/room/tools/room-agent-tools.ts` — add handler + MCP tool definition |
| Modifying DB schema | `daemon/src/storage/schema/` — add migration, update repositories |
