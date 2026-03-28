# Milestone 5: Neo Tool Registry (Meta Operations)

## Goal

Implement the meta-level tools: undo support with an explicit reversibility matrix, and the activity feed query tool. The `explain` tool from the original design is dropped — Neo already explains naturally via text responses, and a tool that "pre-simulates" a future turn is not how LLM tool calls work.

## Design Notes

- **Undo depth**: Single-level only ("undo the last action"). Multi-level undo is explicitly out of scope for this iteration.
- **Undo of deletes**: Only restores the immediate object (e.g., undoing `delete_skill` re-creates the skill config). Cascading children (e.g., undoing `delete_room` does NOT restore its goals/tasks/sessions) — the undo data only stores the room metadata, not the full subtree.
- **`get_activity_log` vs `neo.activity_log` RPC**: Both exist and are backed by the same query. The tool is for Neo's own introspection during a conversation ("what did I do recently?"). The RPC endpoint is for the frontend Activity Feed tab. They share the same repository method.

## Tasks

### Task 5.1: Undo Engine with Reversibility Matrix

- **Description**: Implement the undo logic that can reverse Neo's most recent action by reading the `undo_data` stored in the action log. Includes an explicit reversibility matrix documenting every action type.
- **Agent type**: coder
- **Depends on**: Task 4.2, Task 4.3, Task 4.4, Task 4.5
- **Subtasks**:
  1. Create `packages/daemon/src/lib/neo/undo-engine.ts`
  2. **Define the reversibility matrix** as a design document within the code (const map or documented table):

     | Action Type | Reversible? | Undo Behavior | Undo Data Stored |
     |-------------|------------|---------------|-----------------|
     | `create_room` | Yes | Delete the created room | `{ roomId }` |
     | `delete_room` | Partial | Re-create room with stored metadata (goals/tasks/sessions NOT restored) | `{ name, background, instructions }` |
     | `update_room_settings` | Yes | Restore previous values | `{ roomId, previousSettings }` |
     | `create_goal` | Yes | Delete the created goal | `{ goalId }` |
     | `update_goal` | Yes | Restore previous values | `{ goalId, previousValues }` |
     | `set_goal_status` | Yes | Restore previous status | `{ goalId, previousStatus }` |
     | `create_task` | Yes | Delete the created task | `{ taskId }` |
     | `update_task` | Yes | Restore previous values | `{ taskId, previousValues }` |
     | `set_task_status` | Yes | Restore previous status | `{ taskId, previousStatus }` |
     | `create_space` | Yes | Delete the created space | `{ spaceId }` |
     | `delete_space` | Partial | Re-create space with metadata (agents/workflows NOT restored) | `{ name, description, workspacePath }` |
     | `toggle_skill` | Yes | Toggle back | `{ skillId, previousEnabled }` |
     | `toggle_mcp_server` | Yes | Toggle back | `{ serverName, previousEnabled }` |
     | `add_skill` | Yes | Delete the added skill | `{ skillId }` |
     | `delete_skill` | Yes | Re-create with stored config | `{ fullSkillConfig }` |
     | `add_mcp_server` | Yes | Delete the added server | `{ serverName }` |
     | `delete_mcp_server` | Yes | Re-create with stored config | `{ fullServerConfig }` |
     | `update_app_settings` | Yes | Restore previous values | `{ previousValues }` |
     | `send_message_to_room` | **No** | Messages cannot be unsent | N/A |
     | `send_message_to_task` | **No** | Messages cannot be unsent | N/A |
     | `approve_task` / `reject_task` | **No** | Approvals/rejections are final | N/A |
     | `approve_gate` / `reject_gate` | **No** | Gate decisions are final | N/A |
     | `stop_session` | **No** | Cannot restart a stopped session | N/A |
     | `start_workflow_run` | **No** | Cannot un-start a workflow | N/A |
     | `cancel_workflow_run` | **No** | Cannot un-cancel a workflow | N/A |

  3. Implement `NeoUndoEngine` class:
     - Constructor takes all manager/service dependencies needed to reverse actions
     - `undoLastAction(): Promise<{ success: boolean; description: string }>`:
       - Get the most recent non-undone, reversible action from the action log
       - Parse its `undo_data` JSON
       - Execute the reverse operation based on action type (see matrix)
       - Mark the action as `undone` in the log
       - Return description of what was undone
     - `canUndo(actionId: string): boolean` -- check reversibility via the matrix
  4. Write unit tests covering:
     - Undo of create operations (delete the created item)
     - Undo of delete operations (re-create from stored data)
     - Undo of toggle operations (toggle back)
     - Attempting undo of irreversible action returns helpful error message
     - Attempting undo when no actions exist
     - Double-undo prevention (already undone actions)
- **Acceptance criteria**:
  - Reversibility matrix is defined in code as a constant/map
  - Undo correctly reverses create, delete, update, and toggle operations
  - Partial undos (delete_room, delete_space) clearly communicate what was NOT restored
  - Irreversible actions return helpful error messages listing what cannot be undone
  - Action log is updated with `undone` status
  - Unit tests cover all reversible and irreversible action types from the matrix
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 5.2: Meta Tools and Activity Feed Query

- **Description**: Implement the `undo_last_action` tool and the activity feed query tool. (The `explain` tool is dropped — Neo explains naturally via text.)
- **Agent type**: coder
- **Depends on**: Task 5.1
- **Subtasks**:
  1. Create `packages/daemon/src/lib/neo/tools/neo-meta-tools.ts`
  2. Implement handler functions:
     - `undo_last_action()` -- calls `NeoUndoEngine.undoLastAction()`, returns result description
     - `get_activity_log(limit?, offset?)` -- query recent actions from `neo_action_log` for Neo's own introspection. **Note**: This tool and the `neo.activity_log` RPC endpoint (Task 6.1) are both backed by the same `NeoActionLogRepository.getRecent()` method.
  3. Add these tools to the Neo MCP server in `neo-tools-server.ts`
  4. Define Zod schemas and clear tool descriptions
  5. Write unit tests for both meta tools
- **Acceptance criteria**:
  - `undo_last_action` successfully reverses the most recent reversible action
  - `get_activity_log` returns paginated action history
  - All tools are registered on the Neo MCP server
  - Unit tests cover both tools
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`
