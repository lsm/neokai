# Milestone 5: Neo Tool Registry (Meta Operations)

## Goal

Implement the meta-level tools: undo support and the explain tool. These provide Neo with self-awareness about its own actions and the ability to reverse them.

## Tasks

### Task 5.1: Undo Engine

- **Description**: Implement the undo logic that can reverse Neo's most recent actions by reading the `undo_data` stored in the action log.
- **Agent type**: coder
- **Depends on**: Task 4.2, Task 4.3, Task 4.4, Task 4.5
- **Subtasks**:
  1. Create `packages/daemon/src/lib/neo/undo-engine.ts`
  2. Implement `NeoUndoEngine` class:
     - Constructor takes all manager/service dependencies needed to reverse actions
     - `undoLastAction(): Promise<{ success: boolean; description: string }>`:
       - Get the most recent non-undone action from the action log
       - Parse its `undo_data` JSON
       - Execute the reverse operation based on `action_type`:
         - `create_*` -> delete the created resource
         - `delete_*` -> re-create with stored data
         - `update_*` -> restore previous values
         - `toggle_*` -> toggle back to previous state
         - `send_message_*` -> not reversible (return error message)
         - `approve_*` / `reject_*` -> not easily reversible (return error message)
       - Mark the action as `undone` in the log
       - Return description of what was undone
     - `canUndo(actionId: string): boolean` -- check if an action is reversible
  3. Define which action types are reversible vs. irreversible
  4. Write unit tests covering:
     - Undo of create operations (delete the created item)
     - Undo of delete operations (re-create from stored data)
     - Undo of toggle operations (toggle back)
     - Attempting undo of irreversible action returns error
     - Attempting undo when no actions exist
- **Acceptance criteria**:
  - Undo correctly reverses create, delete, update, and toggle operations
  - Irreversible actions are clearly identified and return helpful error messages
  - Action log is updated with `undone` status
  - Unit tests cover all reversible and irreversible action types
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 5.2: Meta Tools and Activity Feed Query

- **Description**: Implement the `undo_last_action` and `explain` tools, plus the activity feed query tool for the UI.
- **Agent type**: coder
- **Depends on**: Task 5.1
- **Subtasks**:
  1. Create `packages/daemon/src/lib/neo/tools/neo-meta-tools.ts`
  2. Implement handler functions:
     - `undo_last_action()` -- calls `NeoUndoEngine.undoLastAction()`, returns result description
     - `explain(action_description)` -- Neo describes what it would do for a given request, without executing. Returns structured explanation: action type, target, risk level, reversibility
     - `get_activity_log(limit?, offset?)` -- query recent actions from `neo_action_log` for the activity feed
  3. Add these tools to the Neo MCP server in `neo-tools-server.ts`
  4. Define Zod schemas and clear tool descriptions
  5. Write unit tests for all meta tools
- **Acceptance criteria**:
  - `undo_last_action` successfully reverses the most recent reversible action
  - `explain` provides clear, structured explanations without side effects
  - `get_activity_log` returns paginated action history
  - All tools are registered on the Neo MCP server
  - Unit tests cover all meta tools
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`
