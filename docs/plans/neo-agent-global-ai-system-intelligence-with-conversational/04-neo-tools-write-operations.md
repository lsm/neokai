# Milestone 4: Neo Tool Registry (Write Operations)

## Goal

Implement the write/action tools that allow Neo to make changes across the NeoKai system. Every write action is logged to `neo_action_log` with risk level assessment and security tier enforcement.

## Tasks

### Task 4.1: Security Tier Engine

- **Description**: Implement the security tier logic that determines whether an action should auto-execute, require confirmation, or require explicit phrasing, based on the user's selected security mode.
- **Agent type**: coder
- **Depends on**: Task 1.1
- **Subtasks**:
  1. Create `packages/daemon/src/lib/neo/security-tier.ts`
  2. Define the risk classification map -- a static mapping from tool name to `NeoActionRiskLevel`:
     - **Low risk**: `toggle_skill`, `toggle_mcp_server`, `create_goal`, `update_app_settings`, `update_room_settings`
     - **Medium risk**: `delete_space`, `delete_room` (without active tasks), `cancel_workflow_run`, `send_message_to_room`, `send_message_to_task`, `approve_gate`, `reject_gate`, `add_mcp_server`, `update_mcp_server`, `delete_mcp_server`, `add_skill`, `update_skill`, `delete_skill`
     - **High risk**: `delete_room` (with active tasks), bulk operations, `stop_session`
  3. Implement `determineActionBehavior(toolName: string, riskLevel: NeoActionRiskLevel, securityMode: NeoSecurityMode): 'auto_execute' | 'confirm' | 'require_explicit'`:
     - Conservative: confirm everything (all actions require confirmation)
     - Balanced: auto-execute low, confirm medium, require-explicit high
     - Autonomous: auto-execute everything
  4. **Define `require_explicit` behavior clearly**: Unlike `confirm` (which shows a one-click Confirm/Cancel card), `require_explicit` requires the user to type a confirmation phrase that includes the target name. Example: to delete room "my-project" with active tasks, Neo responds with "This is an irreversible action. To proceed, type: DELETE my-project". The RPC handler validates the exact phrase match. This prevents accidental confirmation of high-risk operations.
  5. Implement `assessRisk(toolName: string, toolInput: Record<string, unknown>): NeoActionRiskLevel` -- context-aware risk assessment (e.g., deleting a room with active tasks is high risk, without is medium)
  6. Write unit tests covering all security mode x risk level combinations (9 total: 3 modes x 3 risk levels), plus `require_explicit` phrase validation
- **Acceptance criteria**:
  - Risk assessment correctly classifies all tools
  - Context-aware risk elevation works (e.g., room with active tasks)
  - All 9 combinations (3 modes x 3 risk levels) are tested
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 4.2: Action Logging Middleware

- **Description**: Create middleware that wraps tool execution with action logging -- recording every Neo action to the `neo_action_log` table before and after execution.
- **Agent type**: coder
- **Depends on**: Task 1.3, Task 4.1
- **Subtasks**:
  1. Create `packages/daemon/src/lib/neo/action-logger.ts`
  2. Implement `NeoActionLogger` class:
     - Constructor takes `NeoActionLogRepository`, `NeoSecurityMode` getter
     - `wrapAction(toolName, toolInput, handler): Promise<ToolResult>`:
       - Assess risk level
       - Determine action behavior based on security tier
       - If `confirm`: create log entry with status `pending_confirmation`, return confirmation prompt instead of executing
       - If `auto_execute`: create log entry, execute handler, update log with result
       - If `require_explicit`: return message explaining the action requires explicit confirmation
     - `confirmAction(actionId: string): Promise<ToolResult>` -- execute a pending action after user confirms
     - `cancelAction(actionId: string): void` -- cancel a pending action
  3. Implement undo data capture: for each action type, define what data to store in `undo_data` to reverse the action (e.g., for `delete_skill`, store the full skill config so it can be re-created)
  4. Write unit tests for the logging middleware
- **Acceptance criteria**:
  - Every action creates a log entry regardless of outcome
  - Confirmation flow works: pending -> confirmed -> executed
  - Cancel flow works: pending -> cancelled
  - Undo data is captured for reversible actions
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 4.3: Room and Goal Write Tools

- **Description**: Implement tool handlers for room and goal write operations, wrapped with action logging.
- **Agent type**: coder
- **Depends on**: Task 4.2, Task 3.1
- **Subtasks**:
  1. Create `packages/daemon/src/lib/neo/tools/neo-room-write-tools.ts`
  2. Implement handlers (each wrapped with `NeoActionLogger.wrapAction`):
     - `create_room(name, background?, instructions?)` -- creates a new room
     - `delete_room(roomId)` -- deletes a room (risk escalation if active tasks)
     - `update_room_settings(roomId, updates)` -- update room background/instructions
     - `create_goal(roomId, title, description?, priority?, missionType?, autonomyLevel?)` -- create goal in a specific room
     - `update_goal(goalId, updates)` -- update goal properties
     - `set_goal_status(goalId, status)` -- change goal status
     - `create_task(roomId, goalId?, title, description, type?, agentType?)` -- create task in a room
     - `update_task(taskId, updates)` -- update task properties
     - `set_task_status(taskId, status)` -- change task status
  3. Each handler stores undo data (e.g., previous state for updates, created ID for creates)
  4. Write unit tests
- **Acceptance criteria**:
  - All room/goal write operations work correctly
  - Action logging captures each operation
  - Undo data is stored for all reversible operations
  - Risk assessment correctly identifies high-risk operations
  - Unit tests cover happy paths and error cases
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 4.4: Space and Workflow Write Tools

- **Description**: Implement tool handlers for space and workflow write operations.
- **Agent type**: coder
- **Depends on**: Task 4.2, Task 3.2
- **Subtasks**:
  1. Create `packages/daemon/src/lib/neo/tools/neo-space-write-tools.ts`
  2. Implement handlers:
     - `create_space(name, description?, workspacePath?)` -- creates a new space
     - `delete_space(spaceId)` -- deletes a space
     - `update_space(spaceId, updates)` -- update space properties
     - `start_workflow_run(spaceId, workflowId)` -- start a workflow run
     - `cancel_workflow_run(runId)` -- cancel an active workflow run
     - `approve_gate(runId, gateId)` -- approve a gate in a workflow
     - `reject_gate(runId, gateId, reason?)` -- reject a gate
  3. Each handler wrapped with action logging
  4. Write unit tests
- **Acceptance criteria**:
  - All space/workflow operations work correctly
  - Gate operations use origin metadata (`origin: 'neo'`)
  - Action logging captures all operations
  - Unit tests cover happy paths and error cases
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 4.5: Configuration Write Tools and Message Tools

- **Description**: Implement tool handlers for skill/MCP/settings management and message sending.
- **Agent type**: coder
- **Depends on**: Task 4.2, Task 3.3
- **Subtasks**:
  1. Create `packages/daemon/src/lib/neo/tools/neo-config-write-tools.ts`
  2. Implement handlers:
     - `add_mcp_server(name, config)` -- register a new MCP server
     - `update_mcp_server(name, config)` -- update MCP server configuration
     - `delete_mcp_server(name)` -- remove an MCP server
     - `toggle_mcp_server(name, enabled)` -- enable/disable an MCP server
     - `add_skill(config)` -- register a new skill
     - `update_skill(skillId, config)` -- update skill configuration
     - `delete_skill(skillId)` -- remove a skill
     - `toggle_skill(skillId, enabled)` -- enable/disable a skill
     - `update_app_settings(updates)` -- update global settings. **Allowlist enforcement**: Only the following fields can be updated via Neo: `neo` (Neo settings), `theme`, `defaultModel`, `defaultProvider`. Security-sensitive fields (`apiKeys`, `oauthTokens`, provider credentials) are rejected by the tool handler. The allowlist is defined and enforced in the tool handler itself (not in SettingsManager).
  3. Create `packages/daemon/src/lib/neo/tools/neo-message-tools.ts`
  4. Implement message handlers:
     - `send_message_to_room(roomId, content)` -- send a message to a room's chat session with `origin: 'neo'`
     - `send_message_to_task(taskId, content)` -- send a message to a task's session with `origin: 'neo'`
     - `approve_task(taskId)` -- approve a task
     - `reject_task(taskId, reason?)` -- reject a task
     - `stop_session(sessionId)` -- stop an active session
     - `pause_schedule(goalId)` -- pause a recurring goal's schedule
     - `resume_schedule(goalId)` -- resume a paused schedule
  5. Write unit tests for both files
- **Acceptance criteria**:
  - All config operations create/update/delete correctly
  - Messages sent with `origin: 'neo'` metadata
  - Settings updates do not allow overwriting security-sensitive fields (API keys)
  - All operations are action-logged
  - Unit tests cover all handlers
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`

### Task 4.6: Write Tools MCP Server Assembly

- **Description**: Assemble all write tool handlers into the Neo MCP server alongside the read tools.
- **Agent type**: coder
- **Depends on**: Task 4.3, Task 4.4, Task 4.5, Task 3.4
- **Subtasks**:
  1. Update `packages/daemon/src/lib/neo/tools/neo-tools-server.ts` to include write tools
  2. Create `createNeoWriteToolsMcpServer(config)` or extend the existing server function
  3. Define Zod schemas for all write tool parameters
  4. Ensure tool descriptions clearly indicate which operations are reversible
  5. Wire the complete tools server into `NeoSessionService`
  6. Write integration test verifying all tools are registered
- **Acceptance criteria**:
  - All read + write tools are registered on the Neo session's MCP server
  - Tool parameter schemas validate correctly
  - Tool descriptions mention risk level and reversibility
  - Changes must be on a feature branch with a GitHub PR created via `gh pr create`
