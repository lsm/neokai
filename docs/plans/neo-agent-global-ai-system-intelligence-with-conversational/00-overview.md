# Neo Agent: Global AI System Intelligence with Conversational Interface

## Goal

Introduce "Neo" -- a global AI agent that serves as the user's chief-of-staff for the entire NeoKai system. Neo has full visibility into all rooms, spaces, sessions, goals, tasks, MCP servers, and skills. Users interact with Neo through natural language to query system state, manage configuration, orchestrate room/space agents, and execute actions across the system.

## Approach

The implementation follows the established pattern of the Global Spaces Agent (`spaces:global`), which already demonstrates how to provision a singleton agent session with MCP tools, attach a system prompt, and wire it into the daemon lifecycle. Neo extends this pattern to cover the entire system rather than just spaces.

### Key Architectural Decisions

1. **Session model**: Single persistent session (`neo:global`), new `SessionType` value `'neo'`, with health monitoring and auto-recovery on crash/corruption
2. **Tool delivery**: MCP server pattern (same as `global-spaces-tools.ts`) -- tools exposed via `createSdkMcpServer` and attached to the session at provisioning time
3. **Tool reuse**: Space-related tools delegate to existing `global-spaces-tools.ts` handlers rather than reimplementing -- Neo wraps the same handler functions with its own security tier layer
4. **Provisioning**: Follows `provisionGlobalSpacesAgent` pattern -- create session on first run, re-attach tools on restart
5. **RPC layer**: New `neo.*` RPC namespace (`neo.send`, `neo.history`, `neo.clearSession`, `neo.getSettings`, `neo.updateSettings`)
6. **Frontend**: NavRail icon button (not text input -- rail is only 64px/`w-16`) that opens a slide-out panel with Chat and Activity Feed tabs; text input lives inside the panel
7. **Security / Confirmation protocol**: Tiered confirmation system (Conservative/Balanced/Autonomous). Confirmation uses a two-message LLM pattern: the tool returns a `{ confirmationRequired, pendingActionId, description }` result, the LLM renders it as a confirmation message, the user replies "yes"/"no", and the LLM calls a `confirm_action` / `cancel_action` tool to proceed. No SDK session pause required.
8. **Origin metadata**: Lightweight `origin` field on messages (`'human' | 'neo' | 'system'`). Origin is single-hop only -- downstream messages from room agents acting on Neo-originated messages do NOT inherit the origin. This keeps the model simple; full provenance chains are a future concern.
9. **Activity logging**: New `neo_activity_log` SQLite table recording every Neo tool invocation, with a retention policy (auto-prune entries older than 30 days, capped at 10,000 rows)
10. **Settings storage**: Neo settings stored via existing `SettingsManager` under namespaced keys: `neo.securityMode` (default `'balanced'`), `neo.model` (default `null` = app primary model). No separate table needed.
11. **Keyboard shortcut**: `Cmd+J` (Mac) / `Ctrl+J` (Win) to toggle Neo panel -- avoids conflict with Cmd+K used by VS Code, Slack, browser address bars

### Relationship to Existing Code

- **SessionManager**: Neo session is created via `sessionManager.createSession()` with type `'neo'`
- **Database**: New `neo_activity_log` table for activity log; settings stored via `SettingsManager` (no separate `neo_settings` table)
- **RPC handlers**: New `neo-handlers.ts` in `rpc-handlers/` directory
- **DaemonAppContext**: New `neoAgent` property exposing Neo's manager
- **Frontend stores**: New `neo-store.ts` with signals for messages, activity, panel state
- **NavRail**: Extended with Neo icon button (opens panel)
- **LiveQuery**: Neo messages streamed via LiveQuery subscriptions

## Milestones

1. **Neo Agent Core Infrastructure** -- SessionType, DB schema, provisioning, basic session lifecycle (create/restore on restart)
2. **Neo System Query Tools** -- Read-only MCP tools for querying rooms, spaces, goals, tasks, skills, MCP servers, settings
3. **Neo Action Tools** -- Write MCP tools for room/space/config operations with security tier enforcement
4. **Neo RPC Layer and Message Streaming** -- `neo.*` RPC handlers, LiveQuery integration, message persistence
5. **Neo Activity Logging and Undo** -- Activity log table, action recording, undo support
6. **Origin Metadata** -- Add `origin` field to messages, propagate through room/space agent sessions
7. **NavRail Neo Input and Panel UI** -- Frontend icon button in NavRail, slide-out panel with text input, chat interface, Activity Feed tab
8. **Neo Settings UI** -- Settings section for security mode, model selector, clear session
9. **Inline "via Neo" Indicators** -- Subtle attribution badges in room chat, space views, task lists
10. **Neo Unit and Online Tests** -- Gap coverage: online conversation flow tests, cross-system integration tests (earlier milestones already include unit tests per task)
11. **Neo E2E Tests** -- Playwright tests for NavRail button, panel, query/action flows, security tier, Activity Feed, undo

### Test Strategy

Each milestone task includes unit tests as subtasks (not deferred). Milestones 10 and 11 provide **gap coverage** only:
- M10: Online conversation flow tests (multi-turn flows with mocked SDK), cross-system integration tests, session persistence tests. These require multiple milestones to be complete before they can exercise full flows.
- M11: E2E Playwright tests that exercise the full user journey through the browser UI. These inherently depend on all frontend milestones.

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
