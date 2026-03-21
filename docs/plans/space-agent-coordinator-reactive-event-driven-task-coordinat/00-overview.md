# Space Agent Coordinator -- Reactive Event-Driven Task Coordination (Layer 4a)

## Goal

Extend the Space Agent from a request-only assistant into an autonomous coordinator that reacts to task lifecycle events, makes judgment calls, and escalates to the human when uncertain. This is Layer 4a -- everything that can ship without Task Agent (Layer 2+3).

## High-Level Approach

The implementation adds two control loops to the Space system:

1. **SpaceRuntime tick (mechanical, no LLM)** -- Advances workflows on task completion, unblocks tasks when dependencies are satisfied, detects timeouts and stuck tasks. After mechanical processing, emits notifications for events that require judgment.

2. **Space Agent session (LLM-driven, reactive)** -- Receives notifications from SpaceRuntime via `injectMessage()`, makes autonomous decisions within its autonomy level, and escalates to the human when uncertain.

The Space Agent never polls. SpaceRuntime pushes events to it via a `NotificationSink` interface, keeping the two layers cleanly separated and independently testable.

## Architecture Decisions

- **NotificationSink interface** -- SpaceRuntime depends on an interface (not a concrete session) so notifications can be tested without an LLM session. The production implementation calls `sessionFactory.injectMessage()` on the Space Agent session.
- **Autonomy at the Space level** -- New `autonomy_level` column on the `spaces` table (`supervised` | `semi_autonomous`). This mirrors the Room/Mission system's `autonomyLevel` concept.
- **Structured event messages** -- Notifications use a `[TASK_EVENT]` prefix with structured JSON so the Space Agent prompt can parse and reason about them consistently.
- **Two tool layers** -- New coordination tools are added to both `space-agent-tools.ts` (per-space) and `global-spaces-tools.ts` (cross-space), following the existing dual-layer pattern.

## Milestones

1. **Autonomy Level Schema & Types** -- Add `autonomy_level` column to spaces table, update shared types, repository, and manager.
2. **Notification Sink Interface & SpaceRuntime Integration** -- Define the NotificationSink interface, integrate it into SpaceRuntime's tick loop to emit events after mechanical processing.
3. **New Coordination MCP Tools** -- Implement `create_standalone_task`, `get_task_detail`, `retry_task`, `cancel_task`, `reassign_task` in both space-agent-tools and global-spaces-tools.
4. **Space Agent Prompt Updates** -- Update system prompts for space-chat-agent and global-spaces-agent with autonomy instructions, event handling guidance, and escalation rules.
5. **Production NotificationSink Wiring** -- Wire the NotificationSink to the real Space Agent session in provision-global-agent.ts, implementing the injectMessage-based delivery.
6. **Integration Tests & Edge Cases** -- End-to-end integration tests covering the full notification pipeline, autonomy-level-based decision making, and escalation flows.

## Cross-Milestone Dependencies

- Milestone 2 depends on Milestone 1 (SpaceRuntime needs access to autonomy level to decide which events to notify vs. auto-handle).
- Milestone 3 is independent of 1 and 2 (tools are pure CRUD, no notification dependency).
- Milestone 4 depends on Milestone 1 (prompt needs autonomy context) and Milestone 3 (prompt references new tools).
- Milestone 5 depends on Milestones 2 and 4 (wiring requires both the sink interface and updated prompts).
- Milestone 6 depends on all previous milestones.

## Total Estimated Task Count

18 tasks across 6 milestones.
