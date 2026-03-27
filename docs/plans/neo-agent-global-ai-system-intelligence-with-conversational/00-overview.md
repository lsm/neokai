# Neo Agent: Global AI System Intelligence with Conversational Interface

## Goal

Introduce "Neo" -- a global AI agent that serves as the user's chief-of-staff for the entire NeoKai system. Neo has full visibility into all rooms, spaces, sessions, goals, tasks, MCP servers, and skills. Users interact with Neo through natural language to query system state, manage configuration, orchestrate room/space agents, and execute actions across the system.

## Approach

The implementation follows the established pattern of the Global Spaces Agent (`spaces:global`), which already demonstrates how to provision a singleton agent session with MCP tools, attach a system prompt, and wire it into the daemon lifecycle. Neo extends this pattern to cover the entire system rather than just spaces.

### Key Architectural Decisions

1. **Session model**: Single persistent session (`neo:global`), new `SessionType` value `'neo'`
2. **Tool delivery**: MCP server pattern (same as `global-spaces-tools.ts`) -- tools exposed via `createSdkMcpServer` and attached to the session at provisioning time
3. **Provisioning**: Follows `provisionGlobalSpacesAgent` pattern -- create session on first run, re-attach tools on restart
4. **RPC layer**: New `neo.*` RPC namespace (`neo.send`, `neo.history`, `neo.clearSession`, `neo.getSettings`, `neo.updateSettings`)
5. **Frontend**: NavRail persistent input + slide-out panel with Chat and Activity Feed tabs
6. **Security**: Tiered confirmation system (Conservative/Balanced/Autonomous) with hardcoded tier definitions and user-selectable preference
7. **Origin metadata**: Lightweight `origin` field on messages (`'human' | 'neo' | 'system'`)
8. **Activity logging**: New `neo_activity_log` SQLite table recording every Neo tool invocation

### Relationship to Existing Code

- **SessionManager**: Neo session is created via `sessionManager.createSession()` with type `'neo'`
- **Database**: New tables for activity log; settings stored via `SettingsManager`
- **RPC handlers**: New `neo-handlers.ts` in `rpc-handlers/` directory
- **DaemonAppContext**: New `neoAgent` property exposing Neo's manager
- **Frontend stores**: New `neo-store.ts` with signals for messages, activity, panel state
- **NavRail**: Extended with persistent input bar
- **LiveQuery**: Neo messages streamed via LiveQuery subscriptions

## Milestones

1. **Neo Agent Core Infrastructure** -- SessionType, DB schema, provisioning, basic session lifecycle (create/restore on restart)
2. **Neo System Query Tools** -- Read-only MCP tools for querying rooms, spaces, goals, tasks, skills, MCP servers, settings
3. **Neo Action Tools** -- Write MCP tools for room/space/config operations with security tier enforcement
4. **Neo RPC Layer and Message Streaming** -- `neo.*` RPC handlers, LiveQuery integration, message persistence
5. **Neo Activity Logging and Undo** -- Activity log table, action recording, undo support
6. **Origin Metadata** -- Add `origin` field to messages, propagate through room/space agent sessions
7. **NavRail Neo Input and Panel UI** -- Frontend persistent input, slide-out panel, chat interface, Activity Feed tab
8. **Neo Settings UI** -- Settings section for security mode, model selector, clear session
9. **Inline "via Neo" Indicators** -- Subtle attribution badges in room chat, space views, task lists
10. **Neo Unit and Online Tests** -- Tool handler tests, security tier tests, session persistence tests, conversation flow tests
11. **Neo E2E Tests** -- Playwright tests for NavRail input, panel, query/action flows, security tier, Activity Feed, undo

## Cross-Milestone Dependencies

- M2, M3 depend on M1 (agent must exist before tools can be attached)
- M4 depends on M1 (RPC layer needs session infrastructure)
- M5 depends on M3 (undo needs action tools to be defined)
- M6 is independent of M2-M5 (origin metadata is a data model concern)
- M7 depends on M4 (panel UI needs RPC layer for messaging)
- M8 depends on M1 and M7 (settings UI needs both backend and panel)
- M9 depends on M6 (indicators need origin metadata)
- M10 depends on M1-M5 (tests cover all backend features)
- M11 depends on M7-M9 (E2E tests cover all frontend features)

## Estimated Total Task Count

~33 tasks across 11 milestones.
