# Neo Agent: Global AI System Intelligence with Conversational Interface

## Goal Summary

Introduce "Neo" -- a global AI agent that serves as the user's chief-of-staff for the entire NeoKai system. Neo has full visibility into all rooms, spaces, sessions, goals, tasks, MCP servers, and skills. Users interact with Neo through natural language via a persistent NavRail input and slide-out panel, replacing tedious multi-click UI workflows with conversational interactions.

## High-Level Approach

The implementation follows a bottom-up strategy: build the backend infrastructure first (types, DB, origin metadata, session management, tool registry), then wire up RPC endpoints, then build the frontend UI, and finally add comprehensive tests. Each milestone is designed to be independently testable and shippable.

The Neo agent reuses existing patterns:
- **Session provisioning**: Follows `provisionGlobalSpacesAgent()` pattern from `packages/daemon/src/lib/space/provision-global-agent.ts` — module-level provisioning function (not a service class) that creates/restores a singleton session, attaches MCP tools and system prompt
- **MCP tools**: Follows the two-layer pattern from `room-agent-tools.ts` and `global-spaces-tools.ts` (testable handlers + MCP server wrapper)
- **RPC handlers**: New `neo-handlers.ts` following existing handler registration patterns
- **LiveQuery**: Reuses the existing LiveQuery engine for real-time message streaming; Neo messages are stored in `sdk_messages` table (same as all other sessions) and projected to frontend types via row mappers
- **Settings**: Extends `GlobalSettings` with Neo-specific fields (security mode, model)

## Design Notes

- **Message storage**: Neo messages are stored in the same `sdk_messages` table as all other sessions (filtered by `session_id = 'neo:global'`). No separate `NeoMessage` table. The `NeoMessage` frontend type is derived via row mappers from `sdk_messages` rows.
- **Concurrent messages**: Neo uses a message queue — if a second message arrives while the first is being processed, it is queued and sent after the current turn completes. This matches how the existing room chat sessions handle overlapping turns.
- **`neo.send` is fire-and-forget**: The RPC returns an acknowledgement immediately. The frontend subscribes to `neo.messages` LiveQuery for real-time response streaming.
- **Confirmation flow**: Confirmations are handled exclusively via dedicated `neo.confirm_action` / `neo.cancel_action` RPC endpoints triggered by UI buttons. The `neo.send` handler does NOT parse chat text for "yes"/"no" — this avoids fragile NLP and false positives.
- **Session clear vs action log**: `clearSession` only resets the conversation history (creates a fresh session). The `neo_action_log` table is independent — action history is preserved across session clears and visible in the Activity Feed.
- **Tool count strategy**: We start with the full tool set but monitor LLM performance. If tool count degrades quality, we will consolidate related tools (e.g., one `query_system` tool with a `target` parameter). This is an iterative concern, not a blocker.
- **Error handling**: LLM errors (rate limits, network failures, context overflow) surface as error messages in the Neo chat panel. Context window management uses the SDK's built-in truncation. Cost control and rate limiting are deferred to a future iteration.
- **Mobile**: The NavRail is hidden on mobile (`hidden md:relative`). The Neo input follows the same responsive pattern — hidden on mobile. A mobile-specific entry point (e.g., bottom sheet) is out of scope for this plan.

## Milestones

1. **Shared Types, Database Schema, and Origin Metadata** -- Define Neo types (`NeoSecurityMode`, `NeoActionLog`, origin metadata), add `SessionType: 'neo'`, create DB migration for `neo_action_log` table, extend `GlobalSettings` with Neo settings, implement origin metadata propagation in the message pipeline.

2. **Neo Session Provisioning** -- Singleton session provisioning following the `provisionGlobalSpacesAgent()` pattern: create/restore persistent Neo session, session persistence across app restarts, message queueing for concurrent sends, integrate with `DaemonAppContext`.

3. **Neo Tool Registry (Read-Only)** -- System query tools: `list_rooms`, `get_room_status`, `list_spaces`, `get_space_status`, `list_goals`, `list_tasks`, `list_mcp_servers`, `list_skills`, `get_app_settings`, `get_system_info`. Testable handler layer + MCP server wrapper.

4. **Neo Tool Registry (Write Operations)** -- Action tools: room/space/goal/task CRUD, `send_message_to_room`, `approve_task`, `reject_task`, gate operations, skill/MCP management, settings updates. Includes action logging and security tier enforcement.

5. **Neo Tool Registry (Meta Operations)** -- `undo_last_action` with action reversal logic and explicit reversibility matrix. Action log querying for activity feed.

6. **Neo RPC Handlers and Backend Wiring** -- RPC endpoints: `neo.send` (fire-and-forget), `neo.history`, `neo.clear_session`, `neo.confirm_action`, `neo.cancel_action`. LiveQuery for real-time message streaming (`neo.messages` with row mapper from `sdk_messages`). Wire Neo session into `DaemonAppContext` and app startup.

7. **Frontend: NavRail Input and Neo Panel** -- Persistent chat input in NavRail, slide-out Neo panel with chat history, message rendering (text, structured data, action confirmations), Activity Feed tab, keyboard shortcut (Cmd+K), localStorage persistence.

8. **Frontend: Action Confirmation UI and Settings** -- Confirmation card component (Confirm/Cancel buttons only — no chat-text confirmation), auto-execute indicators, error/retry state. Neo section in Settings (security mode selector, model selector, clear session button).

9. **Frontend: Inline "via Neo" Indicators** -- Origin metadata display: Neo icon/badge on room chat messages initiated by Neo, gate approval indicators in space workflows, task origin in detail views.

10. **Unit and Online Tests** -- Edge-case and integration tests that extend per-milestone coverage: security tier combinatorial tests, action logging lifecycle tests, full conversation flow online tests. Per-milestone tests cover happy paths; Milestone 10 adds edge cases, error scenarios, and coverage thresholds.

11. **E2E Tests** -- Playwright tests: NavRail input to panel flow, query/action/security/undo flows, activity feed verification.

## Cross-Milestone Dependencies

- Milestone 1 includes origin metadata propagation (previously in Milestone 6) — needed by write tools in Milestone 4
- Milestone 2 depends on Milestone 1 (types, DB schema, and origin metadata)
- Milestones 3, 4, 5 depend on Milestone 2 (session exists to attach tools)
- Milestone 4 depends on Milestone 1's origin metadata (write tools use `origin: 'neo'`)
- Milestone 5 depends on Milestone 4 (undo requires action logging from write tools)
- Milestone 6 depends on Milestones 2-5 (all backend pieces must exist to wire together)
- Milestone 7 depends on Milestone 6 (frontend needs RPC endpoints)
- Milestones 8, 9 depend on Milestone 7 (UI components build on the panel)
- Milestone 9 additionally depends on Milestone 1 (origin metadata types) and requires identifying existing frontend components that need modification
- Milestone 10 can start after Milestones 1-6 are complete; focuses on edge cases beyond per-milestone happy-path tests
- Milestone 11 depends on Milestones 7-9 (needs full UI)

## Estimated Task Count

~35-40 tasks across 11 milestones.
