# Milestone 5: Neo Activity Logging and Undo

## Goal

Record every action Neo takes into an activity log, and support undoing the most recent reversible action.

## Scope

- Action logging hooks in tool execution pipeline
- Undo data capture for reversible operations
- `undo_last_action` tool implementation

## Tasks

### Task 5.1: Activity Logging Infrastructure

**Description**: Add logging hooks that record every Neo tool invocation to the activity log.

**Subtasks**:
1. Create `packages/daemon/src/lib/neo/activity-logger.ts`:
   - `NeoActivityLogger` class wrapping `NeoActivityLogRepository`
   - `logAction(entry)` method: records tool name, input, output, status, target, undoable flag
   - `getRecentActivity(limit)` method: returns paginated activity entries
   - `getLatestUndoable()` method: returns the most recent undoable action
2. Create tool execution wrapper that intercepts MCP tool calls:
   - Before execution: log intent
   - After execution: update log with result/error
   - Capture undo data for reversible operations
3. Define which tools are undoable and what undo data to capture:
   - `toggle_skill`: capture previous enabled state
   - `toggle_mcp_server`: capture previous enabled state
   - `update_app_settings`: capture previous settings values
   - `create_goal`: capture goal ID for deletion
   - `create_task`: capture task ID for deletion
   - `set_goal_status`: capture previous status
   - `set_task_status`: capture previous status
4. Wire `NeoActivityLogger` into `NeoAgentManager`
5. Add unit tests for logging and undo data capture

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

**Subtasks**:
1. Add `undo_last_action` tool to the Neo action tools MCP server:
   - Queries `NeoActivityLogger.getLatestUndoable()`
   - Parses undo data and executes the reverse operation
   - Logs the undo itself as an activity entry
2. Implement undo handlers for each undoable operation type:
   - Toggle skill/MCP back to previous state
   - Restore previous settings values
   - Delete created goal/task
   - Restore previous goal/task status
3. Add `explain` meta-tool: Neo describes what it would do without executing
4. Handle edge cases: nothing to undo, undo target no longer exists, undo already performed
5. Add unit tests for undo logic including edge cases

**Acceptance Criteria**:
- `undo_last_action` reverses the most recent undoable action
- Undo itself is logged in the activity feed
- Edge cases produce clear error messages
- `explain` tool returns action description without executing
- Unit tests pass

**Dependencies**: Task 5.1

**Agent type**: coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
