# Milestone 5: Neo Activity Logging and Undo

## Goal

Record every action Neo takes into an activity log, and support undoing the most recent reversible action.

## Scope

- Action logging hooks in tool execution pipeline
- Undo data capture for reversible operations
- `undo_last_action` tool implementation
- Activity log retention policy (auto-prune old entries)

> **Note: Activity logging gap (M1-M4)**: The `neo_activity_log` table is created in M1, but logging hooks are wired in this milestone (M5). This means Neo tools in M2-M4 execute without activity logging during development. This is intentional -- logging is a cross-cutting concern best added once all tools exist. It is not a bug.

## Tasks

### Task 5.1: Activity Logging Infrastructure

**Description**: Add logging hooks that record every Neo tool invocation to the activity log.

**Subtasks**:
1. Create `packages/daemon/src/lib/neo/activity-logger.ts`:
   - `NeoActivityLogger` class wrapping `NeoActivityLogRepository`
   - `logAction(entry)` method: records tool name, input, output, status, target, undoable flag
   - `getRecentActivity(limit, offset)` method: returns paginated activity entries
   - `getLatestUndoable()` method: returns the most recent undoable action
   - `pruneOldEntries()` method: deletes entries older than 30 days AND trims to max 10,000 rows (called on logger init and periodically)
2. Create tool execution wrapper that intercepts MCP tool calls:
   - Before execution: log intent
   - After execution: update log with result/error
   - Capture undo data for reversible operations
3. Define which tools are undoable and what undo data to capture:
   - `toggle_skill`: capture previous enabled state
   - `toggle_mcp_server`: capture previous enabled state
   - `update_app_settings`: capture previous settings values
   - `create_room`: capture room ID for deletion
   - `create_goal`: capture goal ID for deletion
   - `create_task`: capture task ID for deletion
   - `set_goal_status`: capture previous status
   - `set_task_status`: capture previous status
   - `update_room_settings`: capture previous settings values
4. Document intentionally **non-undoable** operations and rationale:
   - `delete_room` / `delete_space`: destructive -- data is permanently deleted, cannot reconstruct
   - `send_message_to_room` / `send_message_to_task`: messages are injected into other agent sessions and may have already been processed/acted upon
   - `start_workflow_run` / `cancel_workflow_run`: workflow runs create cascading side effects (tasks, agent sessions) that cannot be cleanly reversed
   - `approve_gate` / `reject_gate`: gate decisions may have triggered downstream workflow steps
   - `approve_task` / `reject_task`: task review decisions may have triggered agent actions
5. Wire `NeoActivityLogger` into `NeoAgentManager`
6. Add unit tests for logging and undo data capture

**Acceptance Criteria**:
- Every Neo tool invocation is logged with full context
- Undo data is captured for reversible operations
- Failed actions are logged with error details
- Unit tests pass

**Dependencies**: Task 1.1 (activity log table), Task 3.5 (action tools)

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 5.2: Undo Tool Implementation

**Description**: Implement the `undo_last_action` MCP tool that reverses Neo's most recent undoable action.

> **Design decision**: No separate `explain` tool. The LLM already knows its tools and their risk classifications from the system prompt. The system prompt instructs Neo to proactively explain risk levels and confirmation requirements when describing actions to the user. This achieves the same user experience with zero additional code.

**Subtasks**:
1. Add `undo_last_action` tool to the Neo action tools MCP server:
   - Queries `NeoActivityLogger.getLatestUndoable()`
   - Parses undo data and executes the reverse operation
   - Logs the undo itself as an activity entry
2. Implement undo handlers for each undoable operation type:
   - Toggle skill/MCP back to previous state
   - Restore previous settings values
   - Delete created room/goal/task
   - Restore previous goal/task status
   - Restore previous room settings
3. Handle edge cases: nothing to undo, undo target no longer exists, undo already performed
4. Add unit tests for undo logic including edge cases

**Acceptance Criteria**:
- `undo_last_action` reverses the most recent undoable action
- Undo itself is logged in the activity feed
- Edge cases produce clear error messages
- Activity log pruning keeps table bounded (30 days / 10,000 rows max)
- Unit tests pass

**Dependencies**: Task 5.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
