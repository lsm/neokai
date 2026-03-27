# Neo Agent: Global AI System Intelligence with Conversational Interface

## Goal Summary

Introduce "Neo" -- a global AI agent that serves as the user's chief-of-staff for the entire NeoKai system. Neo has full visibility into all rooms, spaces, sessions, goals, tasks, MCP servers, and skills. Users interact with Neo through natural language via a persistent NavRail input and slide-out panel, replacing tedious multi-click UI workflows with conversational interactions.

## High-Level Approach

The implementation follows a bottom-up strategy: build the backend infrastructure first (types, DB, session management, tool registry), then wire up RPC endpoints, then build the frontend UI, and finally add comprehensive tests. Each milestone is designed to be independently testable and shippable.

The Neo agent reuses existing patterns:
- **Agent session**: Reuses `AgentSession` with a new `SessionType` of `'neo'`
- **MCP tools**: Follows the two-layer pattern from `room-agent-tools.ts` and `global-spaces-tools.ts` (testable handlers + MCP server wrapper)
- **RPC handlers**: New `neo-handlers.ts` following existing handler registration patterns
- **LiveQuery**: Reuses the existing LiveQuery engine for real-time message streaming
- **Settings**: Extends `GlobalSettings` with Neo-specific fields (security mode, model)

## Milestones

1. **Shared Types and Database Schema** -- Define Neo types (`NeoSecurityMode`, `NeoActionLog`, origin metadata), add `SessionType: 'neo'`, create DB migration for `neo_action_log` table, extend `GlobalSettings` with Neo settings.

2. **Neo Session Manager** -- Singleton session lifecycle management: create/restore persistent Neo session, session persistence across app restarts, integrate with `DaemonAppContext`.

3. **Neo Tool Registry (Read-Only)** -- System query tools: `list_rooms`, `get_room_status`, `list_spaces`, `get_space_status`, `list_goals`, `list_tasks`, `list_mcp_servers`, `list_skills`, `get_app_settings`, `get_system_info`. Testable handler layer + MCP server wrapper.

4. **Neo Tool Registry (Write Operations)** -- Action tools: room/space/goal/task CRUD, `send_message_to_room`, `approve_task`, `reject_task`, gate operations, skill/MCP management, settings updates. Includes action logging and security tier enforcement.

5. **Neo Tool Registry (Meta Operations)** -- `undo_last_action` with action reversal logic, `explain` tool for confirmation tier. Action log querying for activity feed.

6. **Neo RPC Handlers and Backend Wiring** -- RPC endpoints: `neo.send`, `neo.history`, `neo.clear_session`. LiveQuery for real-time message streaming. Wire Neo session into `DaemonAppContext` and app startup. Origin metadata propagation on messages.

7. **Frontend: NavRail Input and Neo Panel** -- Persistent chat input in NavRail, slide-out Neo panel with chat history, message rendering (text, structured data, action confirmations), Activity Feed tab, keyboard shortcut (Cmd+K), localStorage persistence.

8. **Frontend: Action Confirmation UI and Settings** -- Confirmation card component (Confirm/Cancel buttons, text confirmation), auto-execute indicators, error/retry state. Neo section in Settings (security mode selector, model selector, clear session button).

9. **Frontend: Inline "via Neo" Indicators** -- Origin metadata display: Neo icon/badge on room chat messages initiated by Neo, gate approval indicators in space workflows, task origin in detail views.

10. **Unit and Online Tests** -- Tool handler unit tests, security tier logic tests, origin metadata propagation tests, action logging/undo tests, session persistence tests, full conversation flow online tests.

11. **E2E Tests** -- Playwright tests: NavRail input to panel flow, query/action/security/undo flows, activity feed verification.

## Cross-Milestone Dependencies

- Milestone 2 depends on Milestone 1 (types and DB schema)
- Milestones 3, 4, 5 depend on Milestone 2 (session exists to attach tools)
- Milestone 5 depends on Milestone 4 (undo requires action logging from write tools)
- Milestone 6 depends on Milestones 2-5 (all backend pieces must exist to wire together)
- Milestone 7 depends on Milestone 6 (frontend needs RPC endpoints)
- Milestones 8, 9 depend on Milestone 7 (UI components build on the panel)
- Milestone 10 can start after Milestones 1-6 are complete
- Milestone 11 depends on Milestones 7-9 (needs full UI)

## Estimated Task Count

~35-40 tasks across 11 milestones.
